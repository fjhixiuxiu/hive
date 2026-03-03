import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmux = require('../../src/core/tmux');
const sessionManager = require('../../src/core/session-manager');

// Spy on tmux functions
let execSpy, hasSessionSpy, listSessionsSpy, killSessionSpy;

beforeEach(() => {
  execSpy = vi.spyOn(tmux, 'exec').mockResolvedValue('');
  hasSessionSpy = vi.spyOn(tmux, 'hasSession').mockResolvedValue(false);
  listSessionsSpy = vi.spyOn(tmux, 'listSessions').mockResolvedValue([]);
  killSessionSpy = vi.spyOn(tmux, 'killSession').mockResolvedValue(true);
});

// ── parseWidth ──────────────────────────────────────────

describe('parseWidth', () => {
  it('parses percentage string', () => {
    expect(sessionManager.parseWidth('50%', 200)).toBe(100);
  });

  it('parses 75% of 200', () => {
    expect(sessionManager.parseWidth('75%', 200)).toBe(150);
  });

  it('rounds percentage results', () => {
    expect(sessionManager.parseWidth('33%', 200)).toBe(66);
  });

  it('returns absolute number as-is', () => {
    expect(sessionManager.parseWidth(120, 200)).toBe(120);
  });

  it('parses numeric string', () => {
    expect(sessionManager.parseWidth('100', 200)).toBe(100);
  });

  it('returns totalCols for unparseable input', () => {
    expect(sessionManager.parseWidth('abc', 200)).toBe(200);
  });
});

// ── isTmuxAvailable ────────────────────────────────────

describe('isTmuxAvailable', () => {
  it('returns true when tmux -V succeeds', async () => {
    execSpy.mockResolvedValueOnce('tmux 3.4');
    expect(await sessionManager.isTmuxAvailable()).toBe(true);
  });

  it('returns false when tmux -V fails', async () => {
    execSpy.mockResolvedValueOnce(null);
    expect(await sessionManager.isTmuxAvailable()).toBe(false);
  });
});

// ── applyGlobalOptions ─────────────────────────────────

describe('applyGlobalOptions', () => {
  it('sets all required options with defaults', async () => {
    await sessionManager.applyGlobalOptions();
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('tmux set-option -g default-command "env -u CLAUDECODE bash --login"');
    expect(calls).toContain('tmux set-option -g pane-base-index 1');
    expect(calls).toContain('tmux set-option -g base-index 1');
    expect(calls).toContain('tmux set-option -g mouse on');
    expect(calls).toContain('tmux set-option -g history-limit 50000');
  });

  it('uses custom defaultCommand from tmuxConfig', async () => {
    await sessionManager.applyGlobalOptions({ defaultCommand: 'zsh --login' });
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContain('tmux set-option -g default-command "zsh --login"');
  });
});

// ── createSession ──────────────────────────────────────

describe('createSession', () => {
  it('creates session with correct new-session -x -y flags', async () => {
    await sessionManager.createSession('1', '/repo/dir', { panes: 3 }, { cols: 200, rows: 50 });

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe('tmux new-session -d -s "1" -x 200 -y 50 -c "/repo/dir"');
  });

  it('splits into 3 panes for default layout', async () => {
    await sessionManager.createSession('2', '/repo', { panes: 3 }, { cols: 200, rows: 50 });

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux split-window -h -t "2" -c "/repo"');
    expect(calls).toContainEqual('tmux split-window -v -t "2:.2" -c "/repo"');
  });

  it('applies main-vertical layout', async () => {
    await sessionManager.createSession('3', '/repo', { panes: 3 }, { cols: 200, rows: 50 });

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux select-layout -t "3" main-vertical');
  });

  it('resizes Claude pane to 50% of cols', async () => {
    await sessionManager.createSession('4', '/repo', { panes: 3, claudePaneWidth: '50%' }, { cols: 200, rows: 50 });

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux resize-pane -t "4:.1" -x 100');
  });

  it('skips existing session', async () => {
    hasSessionSpy.mockResolvedValueOnce(true);
    const result = await sessionManager.createSession('5', '/repo', {}, {});

    expect(result).toEqual({ created: false, skipped: true });
    // Only hasSession was called, no new-session
    expect(execSpy).not.toHaveBeenCalledWith(expect.stringContaining('new-session'));
  });

  it('returns created: true for new session', async () => {
    const result = await sessionManager.createSession('6', '/repo', {}, {});
    expect(result).toEqual({ created: true, skipped: false });
  });

  // 2-pane layout
  it('creates 2-pane layout without vertical split', async () => {
    await sessionManager.createSession('7', '/repo', { panes: 2 }, { cols: 200, rows: 50 });

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux split-window -h -t "7" -c "/repo"');
    // No vertical split
    expect(calls).not.toContainEqual(expect.stringContaining('split-window -v'));
  });

  // 1-pane layout
  it('creates 1-pane layout without any splits', async () => {
    await sessionManager.createSession('8', '/repo', { panes: 1 }, { cols: 200, rows: 50 });

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).not.toContainEqual(expect.stringContaining('split-window'));
    // No layout or resize needed for single pane
    expect(calls).not.toContainEqual(expect.stringContaining('select-layout'));
    expect(calls).not.toContainEqual(expect.stringContaining('resize-pane'));
  });

  it('uses default size when not specified', async () => {
    await sessionManager.createSession('9', '/repo', {}, {});

    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe('tmux new-session -d -s "9" -x 200 -y 50 -c "/repo"');
  });
});

// ── startClaude ────────────────────────────────────────

describe('startClaude', () => {
  it('sends claude command to the correct pane', async () => {
    await sessionManager.startClaude('1', 1);
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux send-keys -t "1:.1" "claude --continue" Enter');
  });

  it('uses custom claude command', async () => {
    await sessionManager.startClaude('2', 1, 'claude --resume');
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux send-keys -t "2:.1" "claude --resume" Enter');
  });

  it('uses custom pane index', async () => {
    await sessionManager.startClaude('3', 2);
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual('tmux send-keys -t "3:.2" "claude --continue" Enter');
  });
});

// ── createAllSessions ──────────────────────────────────

describe('createAllSessions', () => {
  it('creates sessions from legacy config (sessions.roles)', async () => {
    const config = {
      sessions: {
        roles: { 1: 'Reviews', 2: 'Ideas' },
        repoDir: (n) => `/ai-dev/webplatform${n}`,
      },
    };

    const results = await sessionManager.createAllSessions(config);
    expect(results.created).toEqual([1, 2]);
    expect(results.skipped).toEqual([]);
    expect(results.failed).toEqual([]);

    // Verify new-session calls for each session
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls).toContainEqual(expect.stringContaining('-s "1"'));
    expect(calls).toContainEqual(expect.stringContaining('-s "2"'));
  });

  it('skips existing sessions in legacy config', async () => {
    hasSessionSpy.mockImplementation(async (name) => name === '1');

    const config = {
      sessions: {
        roles: { 1: 'Reviews', 2: 'Ideas' },
        repoDir: (n) => `/ai-dev/wp${n}`,
      },
    };

    const results = await sessionManager.createAllSessions(config);
    expect(results.created).toEqual([2]);
    expect(results.skipped).toEqual([1]);
  });

  it('creates sessions from tmux.repos config', async () => {
    const config = {
      sessions: {
        roles: {},
        repoDir: () => '/default',
      },
      tmux: {
        defaultSize: { cols: 180, rows: 40 },
        repos: [
          { dir: '/repo/a', startSlot: 1, agents: 2 },
          { dir: '/repo/b', startSlot: 5, agents: 1 },
        ],
      },
    };

    const results = await sessionManager.createAllSessions(config);
    expect(results.created).toEqual([1, 2, 5]);

    // Verify correct repo dirs
    const calls = execSpy.mock.calls.map(c => c[0]);
    const newSessionCalls = calls.filter(c => c.includes('new-session'));
    expect(newSessionCalls[0]).toContain('-c "/repo/a"');
    expect(newSessionCalls[1]).toContain('-c "/repo/a"');
    expect(newSessionCalls[2]).toContain('-c "/repo/b"');
    // Verify custom size
    expect(newSessionCalls[0]).toContain('-x 180 -y 40');
  });

  it('uses default size when tmux.defaultSize not set', async () => {
    const config = {
      sessions: {
        roles: { 1: 'R' },
        repoDir: () => '/repo',
      },
    };

    await sessionManager.createAllSessions(config);
    const calls = execSpy.mock.calls.map(c => c[0]);
    expect(calls[0]).toContain('-x 200 -y 50');
  });

  it('records failed sessions', async () => {
    execSpy.mockImplementation(async (cmd) => {
      if (cmd.includes('new-session') && cmd.includes('-s "2"')) {
        throw new Error('tmux error');
      }
      return '';
    });

    const config = {
      sessions: {
        roles: { 1: 'A', 2: 'B' },
        repoDir: (n) => `/repo${n}`,
      },
    };

    const results = await sessionManager.createAllSessions(config);
    expect(results.created).toEqual([1]);
    expect(results.failed).toEqual([{ num: 2, error: expect.stringContaining('tmux error') }]);
  });
});

// ── destroyAllSessions ─────────────────────────────────

describe('destroyAllSessions', () => {
  it('kills sessions matching pattern', async () => {
    listSessionsSpy.mockResolvedValueOnce([
      { name: '1-Reviews' },
      { name: '2-Ideas' },
      { name: 'hive-server' },
    ]);

    const config = { sessions: { pattern: /^\d+/ } };
    const results = await sessionManager.destroyAllSessions(config);

    expect(results.killed).toEqual(['1-Reviews', '2-Ideas']);
    expect(killSessionSpy).toHaveBeenCalledWith('1-Reviews');
    expect(killSessionSpy).toHaveBeenCalledWith('2-Ideas');
    // hive-server doesn't match /^\d+/
    expect(killSessionSpy).not.toHaveBeenCalledWith('hive-server');
  });

  it('skips non-matching sessions', async () => {
    listSessionsSpy.mockResolvedValueOnce([
      { name: 'dev-session' },
      { name: 'my-project' },
    ]);

    const config = { sessions: { pattern: /^\d+/ } };
    const results = await sessionManager.destroyAllSessions(config);

    expect(results.killed).toEqual([]);
    expect(killSessionSpy).not.toHaveBeenCalled();
  });

  it('records failed kills', async () => {
    listSessionsSpy.mockResolvedValueOnce([
      { name: '1-Reviews' },
      { name: '2-Ideas' },
    ]);
    killSessionSpy.mockImplementation(async (name) => {
      if (name === '2-Ideas') return false;
      return true;
    });

    const config = { sessions: { pattern: /^\d+/ } };
    const results = await sessionManager.destroyAllSessions(config);

    expect(results.killed).toEqual(['1-Reviews']);
    expect(results.failed).toEqual([{ name: '2-Ideas', error: 'killSession returned false' }]);
  });

  it('handles empty session list', async () => {
    const config = { sessions: { pattern: /^\d+/ } };
    const results = await sessionManager.destroyAllSessions(config);

    expect(results.killed).toEqual([]);
    expect(results.failed).toEqual([]);
  });

  it('filters by path when repoBase is set', async () => {
    listSessionsSpy.mockResolvedValueOnce([
      { name: '1-Reviews', path: '/home/user/dev/session-1' },
      { name: '2-Ideas', path: '/tmp/other-repo-2' },
      { name: '3-Urgent', path: '/home/user/dev/session-3' },
    ]);

    const config = { sessions: { repoBase: '/home/user/dev/session-', pattern: /^\d+/ } };
    const results = await sessionManager.destroyAllSessions(config);

    expect(results.killed).toEqual(['1-Reviews', '3-Urgent']);
    expect(killSessionSpy).not.toHaveBeenCalledWith('2-Ideas');
  });

  it('falls back to pattern when repoBase is null', async () => {
    listSessionsSpy.mockResolvedValueOnce([
      { name: '1-Reviews', path: '/some/path' },
      { name: 'hive-server', path: '/some/path' },
    ]);

    const config = { sessions: { repoBase: null, pattern: /^\d+/ } };
    const results = await sessionManager.destroyAllSessions(config);

    expect(results.killed).toEqual(['1-Reviews']);
    expect(killSessionSpy).not.toHaveBeenCalledWith('hive-server');
  });
});
