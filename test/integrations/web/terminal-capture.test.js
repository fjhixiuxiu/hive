import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';
import { capturePaneAnsi } from '../../../src/integrations/web/ws-helpers.js';

// ---------------------------------------------------------------------------
// Terminal capture cost, and the poller leak behind it.
//
// Every 2s poll used to replay a 500-line scrollback window (~70KB) and the
// client repainted by writing the whole thing, so xterm's 5000-line buffer
// filled with repeated snapshots of one screen within a minute. Polls now
// capture the visible pane only (~8KB); the scrollback ships once, on the first
// paint after subscribing.
//
// Underneath that, `terminal:subscribe` leaked an interval on every session
// open: the guard that clears an existing subscription ran *before* the awaits,
// so two subscribes racing on one socket both saw an empty map, both built an
// interval, and the second `set` dropped the first one's handle without
// clearing it. openSession sends two subscribes (switchTab plus its own rAF),
// so this leaked once per open and the orphans captured panes until the socket
// closed.
// ---------------------------------------------------------------------------

function fakeNode(geometry = '120 40') {
  const calls = [];
  return {
    calls,
    exec: vi.fn(async (cmd) => {
      calls.push(cmd);
      if (cmd.includes('display-message')) return geometry;
      return 'pane contents\n';
    }),
  };
}

describe('capturePaneAnsi', () => {
  it('pulls scrollback only when history is requested', async () => {
    const node = fakeNode();
    await capturePaneAnsi(node, 'sess:1', { history: true });

    const capture = node.calls.find((c) => c.includes('capture-pane'));
    expect(capture).toContain('-S -500');
  });

  it('captures the visible pane by default', async () => {
    // The whole point: this is the shape that runs every 2s, forever.
    const node = fakeNode();
    await capturePaneAnsi(node, 'sess:1');

    const capture = node.calls.find((c) => c.includes('capture-pane'));
    expect(capture).not.toContain('-S');
  });

  it('captures the visible pane when history is explicitly false', async () => {
    const node = fakeNode();
    await capturePaneAnsi(node, 'sess:1', { history: false });

    expect(node.calls.find((c) => c.includes('capture-pane'))).not.toContain('-S');
  });

  it('targets the requested pane in both commands', async () => {
    const node = fakeNode();
    await capturePaneAnsi(node, 'mysession:2', { history: true });

    expect(node.calls.every((c) => c.includes('"mysession:2"'))).toBe(true);
  });

  it('reads both pane dimensions from one display-message', async () => {
    const node = fakeNode('120 40');
    const { cols, rows } = await capturePaneAnsi(node, 'sess:1');

    expect({ cols, rows }).toEqual({ cols: 120, rows: 40 });
    expect(node.calls.filter((c) => c.includes('display-message'))).toHaveLength(1);
  });

  it('tolerates surrounding whitespace from tmux', async () => {
    const { cols, rows } = await capturePaneAnsi(fakeNode('  80   24  \n'), 'sess:1');
    expect({ cols, rows }).toEqual({ cols: 80, rows: 24 });
  });

  // rows feeds livePaint's anchoring, so a bad parse must land on 0 — the value
  // livePaint treats as "unknown" — rather than NaN, which would produce an
  // invalid cursor-position escape.
  it.each([
    ['empty output', ''],
    ['null output', null],
    ['non-numeric output', 'not a size'],
  ])('reports zero dimensions on %s', async (_label, geometry) => {
    const { cols, rows } = await capturePaneAnsi(fakeNode(geometry), 'sess:1');

    expect(cols).toBe(0);
    expect(rows).toBe(0);
    expect(Number.isNaN(rows)).toBe(false);
  });

  it('reports zero dimensions when display-message returns undefined', async () => {
    const node = {
      exec: vi.fn(async (cmd) => (cmd.includes('display-message') ? undefined : 'contents')),
    };
    const { cols, rows } = await capturePaneAnsi(node, 'sess:1');

    expect({ cols, rows }).toEqual({ cols: 0, rows: 0 });
    expect(Number.isNaN(rows)).toBe(false);
  });

  it('reports a width with no height as a zero height', async () => {
    const { cols, rows } = await capturePaneAnsi(fakeNode('120'), 'sess:1');
    expect({ cols, rows }).toEqual({ cols: 120, rows: 0 });
  });

  it('returns an empty string when the pane capture yields nothing', async () => {
    const node = { exec: vi.fn(async (cmd) => (cmd.includes('display-message') ? '80 24' : null)) };
    const { content } = await capturePaneAnsi(node, 'sess:1');

    expect(content).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('terminal:subscribe — one poller per socket', () => {
  let termSubs, consoleSubs, node, handle, ws;

  function clearTermSub(target) {
    const sub = termSubs.get(target);
    if (sub) {
      sub.cancelled = true;
      clearInterval(sub.interval);
      termSubs.delete(target);
    }
  }

  function clearConsoleSub(target) {
    const sub = consoleSubs.get(target);
    if (sub) {
      sub.cancelled = true;
      clearInterval(sub.interval);
      consoleSubs.delete(target);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    termSubs = new Map();
    consoleSubs = new Map();
    node = fakeNode();
    ws = { readyState: 1, send: vi.fn() };

    handle = createMessageHandler({
      config: { sessions: { claudePane: 1 } },
      taskQueue: { getUser: () => ({ permissions: ['admin'] }), hasPermission: () => true },
      pmManager: null,
      router: { getNode: () => node },
      broadcast: () => {},
      checkPermission: () => true,
      resolveSession: async (msg) => ({ name: `session-${msg.session}`, nodeId: 'local' }),
      clearTermSub,
      clearConsoleSub,
      termSubs,
      consoleSubs,
      clearCardSub: () => {},
      clearAllCardSubs: () => {},
      cardTermSubs: new Map(),
      sendFleetStatus: async () => {},
      broadcastFleetStatus: async () => {},
      sendInitialState: async () => {},
      _previewCache: new Map(),
      commands: new Map(),
      clients: new Set(),
      wsUser: new WeakMap(),
      workers: new Map(),
      mcpClients: new Map(),
      voiceAgent: null,
    });
  });

  afterEach(() => {
    for (const target of [...termSubs.keys()]) clearTermSub(target);
    vi.useRealTimers();
  });

  const subscribe = () =>
    handle(ws, { type: 'terminal:subscribe', session: '3' }, { login: 'tester' });

  it('keeps exactly one live poller when two subscribes race on one socket', async () => {
    // Both land before either finishes its awaits — the openSession shape.
    await Promise.all([subscribe(), subscribe()]);

    expect(termSubs.size).toBe(1);

    const captures = () =>
      node.calls.filter((c) => c.includes('capture-pane') && !c.includes('-S')).length;
    const before = captures();
    await vi.advanceTimersByTimeAsync(2000);

    // One poller, so exactly one visible capture per tick. Before the fix the
    // orphaned interval kept polling too and this was 2.
    expect(captures() - before).toBe(1);
  });

  it('stops the orphaned poller rather than just dropping its handle', async () => {
    await Promise.all([subscribe(), subscribe()]);
    const survivor = termSubs.get(ws);

    clearTermSub(ws);
    const after = node.calls.length;
    await vi.advanceTimersByTimeAsync(6000);

    // Nothing captures once the surviving subscription is cleared. A leaked
    // interval would keep going here until the socket closed.
    expect(node.calls.length).toBe(after);
    expect(survivor.cancelled).toBe(true);
  });

  it('replaces the poller on a later re-subscribe', async () => {
    await subscribe();
    const first = termSubs.get(ws);

    await subscribe();
    const second = termSubs.get(ws);

    expect(termSubs.size).toBe(1);
    expect(first.cancelled).toBe(true);
    expect(second).not.toBe(first);
    expect(second.cancelled).toBe(false);
  });

  // The clear at the TOP of the case is not redundant with the one after the
  // awaits, and no test above can tell them apart: the post-await clear alone
  // already cancels the old sub before the new `set`, so every leak test here
  // still passes with the top clear deleted.
  //
  // What the top clear actually buys is timing. Between it and the `set` sit
  // `await resolveSession` and `await capturePaneAnsi`. Without it, switching
  // from session A to session B leaves A's interval running through that whole
  // window — so A keeps capturing its pane and sending frames to a client that is
  // already showing B. Slow on a remote node, and visible as A's output flashing
  // into B's terminal.
  it('stops the previous session polling as soon as a switch begins, not after it resolves', async () => {
    let releaseB;
    const bResolved = new Promise((r) => (releaseB = r));
    const switching = createMessageHandler({
      config: { sessions: { claudePane: 1 } },
      taskQueue: { getUser: () => ({ permissions: ['admin'] }), hasPermission: () => true },
      pmManager: null,
      router: { getNode: () => node },
      broadcast: () => {},
      checkPermission: () => true,
      // Session A resolves at once; session B is held open so the await window
      // can be observed.
      resolveSession: async (msg) => {
        if (msg.session === 'B') await bResolved;
        return { name: `session-${msg.session}`, nodeId: 'local' };
      },
      clearTermSub,
      clearConsoleSub,
      termSubs,
      consoleSubs,
      clearCardSub: () => {},
      clearAllCardSubs: () => {},
      cardTermSubs: new Map(),
      sendFleetStatus: async () => {},
      broadcastFleetStatus: async () => {},
      sendInitialState: async () => {},
      _previewCache: new Map(),
      commands: new Map(),
      clients: new Set(),
      wsUser: new WeakMap(),
      workers: new Map(),
      mcpClients: new Map(),
      voiceAgent: null,
    });

    await switching(ws, { type: 'terminal:subscribe', session: 'A' }, { login: 'tester' });
    await vi.advanceTimersByTimeAsync(2000); // A is live and polling

    // Begin the switch to B, but do not let it resolve.
    const toB = switching(ws, { type: 'terminal:subscribe', session: 'B' }, { login: 'tester' });

    const capturesOfA = () =>
      node.calls.filter((c) => c.includes('capture-pane') && c.includes('session-A')).length;
    const before = capturesOfA();
    await vi.advanceTimersByTimeAsync(6000); // three of A's ticks, while B is pending

    // A must be silent for the whole window. With the top clear removed this is 3.
    expect(capturesOfA() - before).toBe(0);

    releaseB();
    await toB;
    expect(termSubs.size).toBe(1);
  });

  it('ships scrollback on the first paint and marks it full', async () => {
    await subscribe();

    const first = JSON.parse(ws.send.mock.calls[0][0]);
    expect(first.type).toBe('terminal:data');
    expect(first.full).toBe(true);
    expect(first.rows).toBe(40);
    expect(node.calls.some((c) => c.includes('capture-pane') && c.includes('-S -500'))).toBe(true);
  });

  it('polls without scrollback and without the full marker', async () => {
    await subscribe();
    node.calls.length = 0;
    ws.send.mockClear();
    // The first paint seeded lastSentContent as null, so the first poll always
    // sends — which is what makes the client's live repaint path run at all.
    await vi.advanceTimersByTimeAsync(2000);

    const polls = ws.send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(polls).toHaveLength(1);
    expect(polls[0].full).toBeUndefined();
    expect(polls[0].rows).toBe(40);
    expect(node.calls.every((c) => !c.includes('-S -500'))).toBe(true);
  });

  it('sends nothing while the pane is unchanged', async () => {
    await subscribe();
    await vi.advanceTimersByTimeAsync(2000); // first poll always sends
    ws.send.mockClear();

    await vi.advanceTimersByTimeAsync(6000); // three more, all identical

    expect(ws.send).not.toHaveBeenCalled();
  });
});
