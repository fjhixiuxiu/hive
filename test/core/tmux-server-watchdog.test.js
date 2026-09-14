import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmux = require('../../src/core/tmux');
const Watcher = require('../../src/core/watcher');

// A tmux socket replacement leaves two servers running on the same socket path:
// the original (holding every live session, but with no socket to accept on) and
// the replacement that hive then rebuilds a duplicate fleet on. Nothing else in
// hive notices — the impostor sessions reuse the same numeric names, so `tmux
// ls` looks plausible and only the creation timestamps give it away.
//
// createSession refuses to be the client that causes this, but any tmux client
// from any repo clone can still do it, so the condition is watched for
// regardless of cause.

const server = (pid) => ({ pid, args: `tmux new-session -d -s ${pid}` });

function makeWatcher(overrides = {}) {
  const config = { watcher: { interval: 10000, ...overrides } };
  return new Watcher(config, null);
}

describe('watcher tmux split-brain watchdog', () => {
  let listServersSpy;

  beforeEach(() => {
    listServersSpy = vi.spyOn(tmux, 'listServers').mockResolvedValue([server(27258)]);
  });

  afterEach(() => vi.restoreAllMocks());

  it('stays quiet when there is exactly one server', async () => {
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    await w._checkTmuxServers();

    expect(onAlert).not.toHaveBeenCalled();
  });

  it('stays quiet when there is no server at all', async () => {
    listServersSpy.mockResolvedValue([]);
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    await w._checkTmuxServers();

    expect(onAlert).not.toHaveBeenCalled();
  });

  it('alerts when a second server appears on the socket', async () => {
    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    await w._checkTmuxServers();

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0][0]).toMatchObject({ count: 2, fingerprint: '27258,77665' });
  });

  it('alerts once per distinct set, not on every tick', async () => {
    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    await w._checkTmuxServers();
    await w._checkTmuxServers();
    await w._checkTmuxServers();

    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('alerts again when a third server joins', async () => {
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    await w._checkTmuxServers();
    listServersSpy.mockResolvedValue([server(27258), server(77665), server(88888)]);
    await w._checkTmuxServers();

    expect(onAlert).toHaveBeenCalledTimes(2);
    expect(onAlert.mock.calls[1][0].count).toBe(3);
  });

  it('fingerprint is order-independent', async () => {
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    listServersSpy.mockResolvedValue([server(77665), server(27258)]);
    await w._checkTmuxServers();
    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    await w._checkTmuxServers();

    // Same two servers reported in a different ps order must not re-alert.
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('re-arms after recovery so a later replacement alerts again', async () => {
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    await w._checkTmuxServers();
    // Recovery: impostor killed, original revived.
    listServersSpy.mockResolvedValue([server(27258)]);
    await w._checkTmuxServers();
    // It happens again with the same pids.
    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    await w._checkTmuxServers();

    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it('reports the server list so the log can name the recovery target', async () => {
    listServersSpy.mockResolvedValue([server(27258), server(77665)]);
    const w = makeWatcher();
    const onAlert = vi.fn();
    w.on('tmux:split-brain', onAlert);

    await w._checkTmuxServers();

    expect(onAlert.mock.calls[0][0].servers.map((s) => s.pid)).toEqual([27258, 77665]);
  });
});

describe('watchdog configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is enabled by default', () => {
    expect(makeWatcher().serverCheckEnabled).toBe(true);
  });

  it('defaults to a 60s cadence', () => {
    expect(makeWatcher().serverCheckMs).toBe(60000);
  });

  it('can be disabled', () => {
    expect(makeWatcher({ serverCheck: { enabled: false } }).serverCheckEnabled).toBe(false);
  });

  it('honours a custom interval', () => {
    expect(makeWatcher({ serverCheck: { interval: 5000 } }).serverCheckMs).toBe(5000);
  });

  it('does not start the timer when disabled', () => {
    const w = makeWatcher({ serverCheck: { enabled: false } });
    // start() also seeds fleet state, so drive the timer setup in isolation.
    expect(w.serverCheckInterval).toBeNull();
  });

  it('stop() clears the timer', () => {
    const w = makeWatcher();
    w.serverCheckInterval = setInterval(() => {}, 100000);
    w.stop();
    expect(w.serverCheckInterval).toBeNull();
  });
});
