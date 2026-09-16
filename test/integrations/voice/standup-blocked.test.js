import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const StandupReport = require('../../../src/integrations/voice/standup');
const { TaskStatus } = require('../../../src/core/vocab');

/**
 * The standup report's "blocked sessions" line.
 *
 * It read `watcher.lastState` — a map the watcher does not have, its map is
 * called `prevStates` — and compared against the state `'waiting'`, which
 * nothing in hive produces: a session sitting on an approval prompt is still
 * `idle` to the detector. Two independent reasons the line could never print,
 * and optional chaining kept both silent.
 *
 * The watcher records waiting sessions in `detectedWaiting`.
 */
function makeTaskQueue(tasks = []) {
  return { tasks: new Map(tasks.map((t, i) => [String(i), t])) };
}

describe('standup blocked sessions', () => {
  it('reports the sessions the watcher marked as waiting', async () => {
    const report = await new StandupReport().generate(
      makeTaskQueue([{ status: TaskStatus.QUEUED, text: 'something' }]),
      { detectedWaiting: new Set([3, 7]), sessionActivity: new Map() },
    );

    expect(report).toContain('2 sessions are blocked and waiting for input');
    expect(report).toContain('sessions 3, 7');
  });

  it('says nothing about blocked sessions when none are waiting', async () => {
    const report = await new StandupReport().generate(
      makeTaskQueue([{ status: TaskStatus.QUEUED, text: 'something' }]),
      { detectedWaiting: new Set(), sessionActivity: new Map() },
    );

    expect(report).not.toContain('blocked');
  });

  it('survives a watcher that is absent or has no detectedWaiting', async () => {
    for (const watcher of [null, undefined, {}, { sessionActivity: new Map() }]) {
      const report = await new StandupReport().generate(
        makeTaskQueue([{ status: TaskStatus.QUEUED, text: 'x' }]),
        watcher,
      );
      expect(report).not.toContain('blocked');
    }
  });

  it('counts waiting sessions independently of task status', async () => {
    // A blocked session usually still has a dispatched task. The two facts are
    // tracked separately and the report must not conflate them.
    const report = await new StandupReport().generate(
      makeTaskQueue([
        { status: TaskStatus.DISPATCHED, text: 'in flight', assignedTo: 3 },
        { status: TaskStatus.DISPATCHED, text: 'also in flight', assignedTo: 9 },
      ]),
      { detectedWaiting: new Set([3]), sessionActivity: new Map() },
    );

    expect(report).toContain('working on 2 tasks');
    expect(report).toContain('1 sessions are blocked');
    expect(report).toContain('sessions 3.');
  });
});
