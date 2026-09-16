import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmux = require('../../src/core/tmux');
const sessionManager = require('../../src/core/session-manager');

// Regression tests for the tmux socket-replacement bug.
//
// `tmux new-session` is one of the few commands allowed to START a server. When
// a client cannot reach the server it concludes the server is dead, unlinks the
// socket, and starts a replacement — the original server keeps running with
// every session intact but with no socket to accept on.
//
// The trigger in production: the tmux server stalls (CPU starvation under load),
// hive's 10s poll fans out dozens of tmux clients that pile into the socket's
// listen backlog, the backlog fills, and connect() starts returning
// ECONNREFUSED. Auto-dispatch then ran `new-session` into exactly that window.
//
// The bug was that createSession's guard could not tell those states apart:
//   hasSession() ran `tmux has-session ... 2>/dev/null` and mapped EVERY
//   failure to false, so "I couldn't reach the server" and "that session isn't
//   there" both meant "go ahead and spawn".
//
// Reproduced on tmux 3.6a: stall a server, fill its backlog, then run
// new-session — it returns rc=0 and a second server appears on the same socket.

const P = tmux.SESSION_PROBE;

describe('classifyProbe (tmux 3.6a has-session outcomes)', () => {
  it('rc 0 means the session exists', () => {
    expect(tmux.classifyProbe({ code: 0, stderr: '' })).toBe(P.EXISTS);
  });

  it('"can\'t find session" means the server answered and the session is absent', () => {
    expect(tmux.classifyProbe({ code: 1, stderr: "can't find session: 7" })).toBe(P.ABSENT);
  });

  it('a missing socket file means there is no server', () => {
    expect(
      tmux.classifyProbe({
        code: 1,
        stderr: 'error connecting to /private/tmp/tmux-502/default (No such file or directory)',
      }),
    ).toBe(P.NO_SERVER);
  });

  it('"no server running" also means there is no server', () => {
    expect(
      tmux.classifyProbe({ code: 1, stderr: 'no server running on /tmp/tmux-502/default' }),
    ).toBe(P.NO_SERVER);
  });

  it('connection refused means the server is alive but unreachable', () => {
    expect(
      tmux.classifyProbe({
        code: 1,
        stderr: 'error connecting to /private/tmp/tmux-502/default (Connection refused)',
      }),
    ).toBe(P.UNREACHABLE);
  });

  it('MEASURED: a backlog-saturated live server is indistinguishable from no server', () => {
    // Captured from a real stalled tmux 3.6a server (backlog filled with 160
    // hanging clients): rc=1 and this exact stderr — byte for byte what tmux
    // emits when no server has ever run. This is why the NO_SERVER branch of
    // createSession must consult the process table and the socket file rather
    // than trusting the message.
    expect(
      tmux.classifyProbe({
        code: 1,
        stderr: 'no server running on /private/tmp/tmux-502/hiveverify60217',
      }),
    ).toBe(P.NO_SERVER);
  });

  it('a hung client (timeout) is unreachable, not absent', () => {
    expect(tmux.classifyProbe({ code: null, stderr: '', timedOut: true })).toBe(P.UNREACHABLE);
  });

  it('fails safe: an unrecognised error is unreachable, never absent', () => {
    // Guessing ABSENT here is what strands the fleet, so unknown must not spawn.
    expect(tmux.classifyProbe({ code: 1, stderr: 'something nobody has seen before' })).toBe(
      P.UNREACHABLE,
    );
    expect(tmux.classifyProbe({})).toBe(P.UNREACHABLE);
  });
});

describe('parseServerList', () => {
  // Columns: pid pgid ppid args. A tmux server daemonises with setsid, so it
  // leads its own process group (pid === pgid) and sits under init.
  const PS = [
    '27258 27258     1 tmux new-session -d -s 1 -n work',
    '77665 77665     1 tmux new-session -d -s 10 -x 200 -y 50 -c /Users/j/Coding/webplatform10',
    ' 2178  2170  2170 tmux list-sessions',
    '86213 86200     1 tmux list-sessions',
    '  501   501     1 /usr/sbin/cupsd -l',
  ].join('\n');

  it('finds both servers when a socket replacement has happened', () => {
    const servers = tmux.parseServerList(PS);
    expect(servers.map((s) => s.pid)).toEqual([27258, 77665]);
  });

  it('ignores tmux clients that still have a live parent', () => {
    expect(tmux.parseServerList(PS).find((s) => s.pid === 2178)).toBeUndefined();
  });

  it('ignores ORPHANED tmux clients — ppid 1 alone is not a server', () => {
    // Regression: 160 hung `tmux list-sessions` clients were reparented to init
    // when their shell exited, and an earlier ppid-only filter counted all of
    // them as servers ("found 130 tmux servers"). They keep the shell's process
    // group, so pgid !== pid tells them apart.
    expect(tmux.parseServerList(PS).find((s) => s.pid === 86213)).toBeUndefined();
  });

  it('ignores non-tmux processes', () => {
    expect(tmux.parseServerList(PS).find((s) => s.pid === 501)).toBeUndefined();
  });

  it('ignores servers on an explicit -L/-S socket (different socket path)', () => {
    const out = [
      '111 111     1 tmux -L probe new-session -d -s t1',
      '222 222     1 tmux -S /tmp/other new-session -d -s t2',
      '333 333     1 tmux new-session -d -s 1',
    ].join('\n');
    expect(tmux.parseServerList(out).map((s) => s.pid)).toEqual([333]);
  });

  it('finds a server started by absolute path, not just the bare name', () => {
    // `ps -o args=` echoes argv[0] verbatim, so a server started as
    // /opt/homebrew/bin/tmux reports the resolved path. An anchor requiring the
    // bare name missed it, listServers returned 0, and the NO_SERVER branch read
    // that as "no server exists" — then spawned over the live one.
    const out = [
      '27258 27258     1 /opt/homebrew/bin/tmux new-session -d -s 1',
      '77665 77665     1 /usr/local/bin/tmux new-session -d -s 10',
    ].join('\n');
    expect(tmux.parseServerList(out).map((s) => s.pid)).toEqual([27258, 77665]);
  });

  it('still excludes path-launched clients and explicit-socket servers', () => {
    const out = [
      '111 110   110 /opt/homebrew/bin/tmux list-sessions',
      '222 222     1 /opt/homebrew/bin/tmux -L probe new-session -d -s t1',
      '333 333     1 /opt/homebrew/bin/tmux new-session -d -s 1',
    ].join('\n');
    expect(tmux.parseServerList(out).map((s) => s.pid)).toEqual([333]);
  });

  it('does not match a process whose name merely ends in tmux', () => {
    const out = ['444 444     1 /usr/bin/not-tmux new-session -d -s 1'].join('\n');
    expect(tmux.parseServerList(out)).toEqual([]);
  });

  it('returns empty when ps produced nothing', () => {
    expect(tmux.parseServerList(null)).toEqual([]);
    expect(tmux.parseServerList('')).toEqual([]);
  });
});

describe('probeSession against the real tmux binary', () => {
  // has-session cannot start a server, so this is safe to run against the
  // developer's own tmux without any risk to a running fleet.
  it('classifies a session that does not exist', async () => {
    const probe = await tmux.probeSession('hive-nonexistent-probe-target');
    // ABSENT when the dev box has a tmux server up, NO_SERVER when it doesn't.
    // Never UNREACHABLE, and never EXISTS.
    expect([P.ABSENT, P.NO_SERVER]).toContain(probe);
  });
});

describe('createSession spawn guard', () => {
  let execSpy, probeSpy, reviveSpy;

  beforeEach(() => {
    execSpy = vi.spyOn(tmux, 'exec').mockResolvedValue('');
    probeSpy = vi.spyOn(tmux, 'probeSession').mockResolvedValue(P.ABSENT);
    reviveSpy = vi
      .spyOn(tmux, 'reviveStrandedServer')
      .mockResolvedValue({ revived: false, servers: [], socketPresent: false });
  });

  afterEach(() => vi.restoreAllMocks());

  const newSessionCalls = () =>
    execSpy.mock.calls.map((c) => c[0]).filter((c) => c.includes('new-session'));

  it('spawns normally when the server is up and the session is absent', async () => {
    const result = await sessionManager.createSession('7', '/repo', { panes: 1 }, {});
    expect(result).toEqual({ created: true, skipped: false });
    expect(newSessionCalls()).toHaveLength(1);
  });

  it('REFUSES to spawn when the server is unreachable', async () => {
    // The core regression: this is the state that used to look like "absent".
    probeSpy.mockResolvedValue(P.UNREACHABLE);

    await expect(sessionManager.createSession('7', '/repo', { panes: 1 }, {})).rejects.toThrow(
      /not responding/,
    );
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('throws rather than returning, so callers cannot fall through to startClaude', async () => {
    // Every createSession caller ignores the return value and immediately calls
    // startClaude; a soft return would have it type into a session that is not
    // there. Their existing try/catch turns this into a logged retry.
    probeSpy.mockResolvedValue(P.UNREACHABLE);
    const err = await sessionManager.createSession('7', '/repo', {}, {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it('skips when the session already exists', async () => {
    probeSpy.mockResolvedValue(P.EXISTS);
    const result = await sessionManager.createSession('7', '/repo', {}, {});
    expect(result).toEqual({ created: false, skipped: true });
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('spawns when there is genuinely no server (no server process, no socket)', async () => {
    probeSpy.mockResolvedValue(P.NO_SERVER);
    reviveSpy.mockResolvedValue({ revived: false, servers: [], socketPresent: false });

    const result = await sessionManager.createSession('7', '/repo', { panes: 1 }, {});
    expect(result).toEqual({ created: true, skipped: false });
    expect(newSessionCalls()).toHaveLength(1);
  });

  it('REFUSES when a live server holds the socket but is not accepting', async () => {
    // The production window, and the case tmux mislabels as "no server running":
    // server process alive, socket present, backlog saturated. Spawning here is
    // exactly what replaced the socket on 2026-08-29.
    probeSpy.mockResolvedValue(P.NO_SERVER);
    reviveSpy.mockResolvedValue({
      revived: false,
      servers: [{ pid: 27258, args: 'tmux new-session -d -s 1 -n work' }],
      socketPresent: true,
    });

    await expect(sessionManager.createSession('7', '/repo', {}, {})).rejects.toThrow(
      /alive but not accepting/,
    );
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('revives a stranded server instead of spawning past it', async () => {
    // Socket gone but a server still alive = the fleet is stranded. SIGUSR1 is
    // the fix; spawning here is what makes the strand permanent.
    probeSpy.mockResolvedValueOnce(P.NO_SERVER).mockResolvedValueOnce(P.ABSENT);
    reviveSpy.mockResolvedValue({
      revived: true,
      servers: [{ pid: 27258, args: 'tmux new-session' }],
      socketPresent: false,
    });

    const result = await sessionManager.createSession('7', '/repo', { panes: 1 }, {});

    expect(reviveSpy).toHaveBeenCalled();
    expect(result).toEqual({ created: true, skipped: false });
  });

  it('skips the spawn when the revived server already had that session', async () => {
    probeSpy.mockResolvedValueOnce(P.NO_SERVER).mockResolvedValueOnce(P.EXISTS);
    reviveSpy.mockResolvedValue({
      revived: true,
      servers: [{ pid: 27258, args: 'tmux new-session' }],
      socketPresent: false,
    });

    const result = await sessionManager.createSession('7', '/repo', {}, {});

    expect(result).toEqual({ created: false, skipped: true });
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('refuses when two servers already exist (socket already replaced)', async () => {
    probeSpy.mockResolvedValue(P.NO_SERVER);
    reviveSpy.mockResolvedValue({
      revived: false,
      socketPresent: true,
      servers: [
        { pid: 27258, args: 'tmux new-session' },
        { pid: 77665, args: 'tmux new-session' },
      ],
    });

    await expect(sessionManager.createSession('7', '/repo', {}, {})).rejects.toThrow(
      /2 tmux servers/,
    );
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('refuses when the revive did not restore a reachable server', async () => {
    probeSpy.mockResolvedValueOnce(P.NO_SERVER).mockResolvedValueOnce(P.UNREACHABLE);
    reviveSpy.mockResolvedValue({
      revived: true,
      servers: [{ pid: 27258, args: 'tmux new-session' }],
      socketPresent: false,
    });

    await expect(sessionManager.createSession('7', '/repo', {}, {})).rejects.toThrow(
      /did not restore a reachable server/,
    );
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('refuses when SIGUSR1 to the one stranded server failed', async () => {
    // One server, socket gone, and the signal threw — so we never learned
    // whether it is still holding sessions. Every other NO_SERVER shape is
    // handled above; this one used to fall through to `new-session`, which is
    // exactly the socket replacement the guard exists to prevent.
    probeSpy.mockResolvedValue(P.NO_SERVER);
    reviveSpy.mockResolvedValue({
      revived: false,
      servers: [{ pid: 27258, args: 'tmux new-session' }],
      socketPresent: false,
    });

    await expect(sessionManager.createSession('7', '/repo', {}, {})).rejects.toThrow(
      /failed to signal stranded tmux server 27258/,
    );
    expect(newSessionCalls()).toHaveLength(0);
  });

  it('still spawns when there is genuinely no server to strand', async () => {
    // The one NO_SERVER shape that must keep spawning: nothing is running, so
    // starting a server cannot displace anyone. Guards the new throw above from
    // widening into the healthy cold-start path.
    probeSpy.mockResolvedValue(P.NO_SERVER);
    reviveSpy.mockResolvedValue({ revived: false, servers: [], socketPresent: false });

    await sessionManager.createSession('7', '/repo', {}, {});
    expect(newSessionCalls()).toHaveLength(1);
  });
});

describe('socketPath / socketExists', () => {
  const origTmpdir = process.env.TMUX_TMPDIR;
  afterEach(() => {
    if (origTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = origTmpdir;
  });

  it('mirrors tmux resolution: $TMUX_TMPDIR/tmux-<uid>/default', () => {
    process.env.TMUX_TMPDIR = '/custom/tmp';
    expect(tmux.socketPath()).toBe(`/custom/tmp/tmux-${process.getuid()}/default`);
  });

  it('falls back to /tmp when TMUX_TMPDIR is unset', () => {
    delete process.env.TMUX_TMPDIR;
    expect(tmux.socketPath()).toBe(`/tmp/tmux-${process.getuid()}/default`);
  });

  it('reports false for a socket directory that does not exist', () => {
    process.env.TMUX_TMPDIR = '/nonexistent-tmux-tmpdir-for-test';
    expect(tmux.socketExists()).toBe(false);
  });
});

describe('hasSession', () => {
  it('stays false for a session that does not exist', async () => {
    // Behaviour preserved across the probeSession refactor. Safe against a real
    // fleet: has-session cannot start a server.
    expect(await tmux.hasSession('hive-nonexistent-probe-target')).toBe(false);
  });
});
