// Wiring test: setSessionContext canonicalizes every incoming PR shape to a
// full GitHub URL, so downstream readers (chip renderers, extractPRs,
// taskPrFor) never need to handle the shapes hive itself writes
// (taskqueue.js:1511 writes "PR #${prNum}" on branch:changed).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { createMockConfig, createMockWatcher, createMockNode } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const fs = require('fs');
const fleetModule = require('../../src/core/fleet');
const relayModule = require('../../src/core/relay');
const logModule = require('../../src/core/log');
const sessionManagerModule = require('../../src/core/session-manager');
const TaskQueue = require('../../src/core/taskqueue');
const NodeRouter = require('../../src/core/node-router');

function setup() {
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw new Error('ENOENT');
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
  vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
  vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
  vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
  vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
  vi.spyOn(logModule, 'info').mockImplementation(() => {});
  vi.spyOn(logModule, 'error').mockImplementation(() => {});
  vi.spyOn(logModule, 'warn').mockImplementation(() => {});
  vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux in test'));

  const config = createMockConfig({ github: { repo: 'mavencare/webplatform' } });
  const watcher = createMockWatcher();
  const router = new NodeRouter();
  router.addNode(createMockNode());
  const tq = new TaskQueue(config, watcher, router);
  return { tq };
}

describe('setSessionContext canonicalizes ctx.pr on write', () => {
  let tq;
  beforeEach(() => {
    ({ tq } = setup());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a full URL passes through unchanged', () => {
    const ctx = tq.setSessionContext(1, {
      pr: 'https://github.com/mavencare/webplatform/pull/33017',
    });
    expect(ctx.pr).toBe('https://github.com/mavencare/webplatform/pull/33017');
  });

  it('taskqueue-style "PR #N" write becomes a URL (was: unparseable, showed nothing)', () => {
    // Regression: taskqueue.js:1511 writes updates.pr = `PR #${data.pr.prNum}`
    // on branch:changed. Before canonicalize-on-write, downstream parsePrList
    // returned [] and the chip disappeared entirely.
    const ctx = tq.setSessionContext(1, { pr: 'PR #31333' });
    expect(ctx.pr).toBe('https://github.com/mavencare/webplatform/pull/31333');
  });

  it('bare "#N" and "N" become URLs via config.github.repo', () => {
    expect(tq.setSessionContext(1, { pr: '#123' }).pr).toBe(
      'https://github.com/mavencare/webplatform/pull/123',
    );
    expect(tq.setSessionContext(2, { pr: '456' }).pr).toBe(
      'https://github.com/mavencare/webplatform/pull/456',
    );
  });

  it('"owner/repo#N" becomes a URL', () => {
    const ctx = tq.setSessionContext(1, { pr: 'mavencare/devops#111' });
    expect(ctx.pr).toBe('https://github.com/mavencare/devops/pull/111');
  });

  it('"repo#N" resolves owner from config.github.repo', () => {
    const ctx = tq.setSessionContext(1, { pr: 'webplatform#31333' });
    expect(ctx.pr).toBe('https://github.com/mavencare/webplatform/pull/31333');
  });

  it('comma-separated multi-value canonicalizes each token', () => {
    const ctx = tq.setSessionContext(1, { pr: 'PR #1, mavencare/devops#2, #3' });
    expect(ctx.pr).toBe(
      'https://github.com/mavencare/webplatform/pull/1, ' +
        'https://github.com/mavencare/devops/pull/2, ' +
        'https://github.com/mavencare/webplatform/pull/3',
    );
  });

  it('leaves non-string values alone (defense against legacy state)', () => {
    // A legacy state file could still have an array — coerce would trip the
    // parseTokens path. We leave arrays alone here (frontend ctxJoin handles it).
    const ctx = tq.setSessionContext(1, { pr: ['a', 'b'] });
    expect(ctx.pr).toEqual(['a', 'b']);
  });

  it('does not touch non-pr keys (branch, jira, plan, slackThread)', () => {
    const ctx = tq.setSessionContext(1, {
      pr: 'PR #1',
      branch: 'feat/foo',
      jira: 'DEV-1234, DEV-5678',
      plan: '/tmp/plan.md',
      slackThread: 'C123:456',
    });
    expect(ctx.pr).toBe('https://github.com/mavencare/webplatform/pull/1');
    expect(ctx.branch).toBe('feat/foo');
    expect(ctx.jira).toBe('DEV-1234, DEV-5678');
    expect(ctx.plan).toBe('/tmp/plan.md');
    expect(ctx.slackThread).toBe('C123:456');
  });

  it('hands back a raw token when no shape matches (does not silently drop)', () => {
    const ctx = tq.setSessionContext(1, { pr: 'some free-text note' });
    expect(ctx.pr).toBe('some free-text note');
  });
});

describe('_loadState heals legacy ctx shapes on restart', () => {
  // These tests seed the state file BEFORE constructing TaskQueue (which
  // calls `_loadState()` in its ctor), so the read hits the canonicalization
  // pass.
  function setupWithState(stateJson) {
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      if (String(p).endsWith('.hive-state.json')) return stateJson;
      throw new Error('ENOENT');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
    vi.spyOn(fleetModule, 'getFleetStatus').mockResolvedValue([]);
    vi.spyOn(fleetModule, 'findSession').mockResolvedValue(null);
    vi.spyOn(fleetModule, 'invalidateCache').mockImplementation(() => {});
    vi.spyOn(relayModule, 'tell').mockResolvedValue({ success: true });
    vi.spyOn(logModule, 'info').mockImplementation(() => {});
    vi.spyOn(logModule, 'error').mockImplementation(() => {});
    vi.spyOn(logModule, 'warn').mockImplementation(() => {});
    vi.spyOn(sessionManagerModule, 'createSession').mockRejectedValue(new Error('no tmux'));

    const config = createMockConfig({ github: { repo: 'mavencare/webplatform' } });
    const watcher = createMockWatcher();
    const router = new NodeRouter();
    router.addNode(createMockNode());
    return new TaskQueue(config, watcher, router);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a "PR #N" left over from taskqueue.js:1511 becomes a URL on load', () => {
    const tq = setupWithState(
      JSON.stringify({
        sessionContext: {
          1: { pr: 'PR #33563', branch: 'eric/foo' },
          15: { pr: '#32647' },
          4: { pr: 'https://github.com/mavencare/webplatform/pull/33374' },
        },
      }),
    );
    expect(tq.getSessionContext(1).pr).toBe('https://github.com/mavencare/webplatform/pull/33563');
    expect(tq.getSessionContext(15).pr).toBe('https://github.com/mavencare/webplatform/pull/32647');
    expect(tq.getSessionContext(4).pr).toBe('https://github.com/mavencare/webplatform/pull/33374');
    expect(tq.getSessionContext(1).branch).toBe('eric/foo');
  });

  it('array-shaped ctx.jira from dc83441 flattens on load', () => {
    const tq = setupWithState(
      JSON.stringify({
        sessionContext: { 2: { jira: ['DEV-1', 'DEV-2', 'OPS-42'] } },
      }),
    );
    expect(tq.getSessionContext(2).jira).toBe('DEV-1, DEV-2, OPS-42');
  });

  it('array-shaped ctx.pr from dc83441 canonicalizes each entry into a comma-joined URL string', () => {
    const tq = setupWithState(
      JSON.stringify({
        sessionContext: {
          3: { pr: ['PR #1', 'https://github.com/mavencare/devops/pull/2'] },
        },
      }),
    );
    expect(tq.getSessionContext(3).pr).toBe(
      'https://github.com/mavencare/webplatform/pull/1, ' +
        'https://github.com/mavencare/devops/pull/2',
    );
  });
});
