import { describe, it, expect, vi } from 'vitest';

import createMessageHandler from '../../../src/integrations/web/ws-handlers.js';

/**
 * `task:create` — the Project Manager and Track fields.
 *
 * A dashboard-created task used to get `source: null`, and that one null is
 * what excluded it from every PM behaviour: `_getSourcePm` returned null so
 * routing fell back to a global boolean, and both condition sets filter on
 * `t.source === 'pm:<name>'`. Picking a PM sets that source; Track supplies
 * the `sourceKey` those condition sets additionally require.
 */

function makeDeps({ pms = [], githubRepo = 'nukulb/hive' } = {}) {
  const createTaskSpy = vi.fn((text, mode, targetSession, designation, meta) => ({
    id: 't1',
    text,
    mode,
    targetSession,
    designation,
    status: 'queued',
    source: meta?.source || null,
    sourceKey: meta?.sourceKey || null,
    actionContext: meta?.actionContext || null,
    sourcePR: meta?.pr || null,
  }));

  const taskQueue = { createTask: createTaskSpy, tasks: new Map(), _saveState: () => {} };
  const seedChecklistSpy = vi.fn();
  const pmManager = { getAll: () => pms, seedChecklist: seedChecklistSpy };

  const sent = [];
  const ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };

  const handle = createMessageHandler({
    config: { sessions: { claudePane: 1, namePrefix: '' }, github: { repo: githubRepo } },
    taskQueue,
    pmManager,
    router: { getNode: () => null },
    broadcast: () => {},
    checkPermission: () => true,
    resolveSession: async () => null,
    clearTermSub: () => {},
    clearConsoleSub: () => {},
    termSubs: new Map(),
    consoleSubs: new Map(),
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

  const create = (extra) =>
    handle(
      ws,
      { type: 'task:create', text: 'Review it', mode: 'auto', ...extra },
      { login: 'jeff' },
    );
  const meta = () => createTaskSpy.mock.calls[0]?.[4];

  return { handle, create, meta, ws, sent, createTaskSpy, seedChecklistSpy };
}

const HUMAN_REVIEWS = {
  id: 'p1',
  name: 'Human Reviews',
  designation: 'Code Review',
  checklistTemplate: null,
};
const PR_CONDITIONS = {
  id: 'p4',
  name: 'Watches PRs',
  designation: 'Code Review',
  completionConditions: [{ type: 'github-pr-state', states: ['merged'] }],
};
const JIRA_CONDITIONS = {
  id: 'p5',
  name: 'Watches JIRA',
  completionConditions: [{ type: 'jira-status', statuses: ['Done'] }],
};
const PR_WATCH = { id: 'p2', name: 'PR Watch', designation: 'Solution Verification' };

describe('task:create — Project Manager', () => {
  it('sets source to pm:<name>, which is what _getSourcePm resolves on', async () => {
    const { create, meta } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: 'Human Reviews' });
    expect(meta().source).toBe('pm:Human Reviews');
  });

  it('leaves source undefined when no PM is picked', async () => {
    const { create, meta } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({});
    expect(meta().source).toBeUndefined();
  });

  it('trims the name so a padded value still resolves', async () => {
    const { create, meta } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: '  Human Reviews  ' });
    expect(meta().source).toBe('pm:Human Reviews');
  });

  it('refuses an unknown PM rather than storing an orphan source', async () => {
    // `pm:Ghost` would resolve to nothing forever — no routing, no conditions,
    // and nothing on the task saying so.
    const { create, sent, createTaskSpy } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: 'Ghost' });
    expect(createTaskSpy).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'error' });
    expect(sent.at(-1).message).toContain('Ghost');
  });

  it('picks the named PM out of several', async () => {
    const { create, meta } = makeDeps({ pms: [HUMAN_REVIEWS, PR_WATCH] });
    await create({ pm: 'PR Watch' });
    expect(meta().source).toBe('pm:PR Watch');
  });

  it('seeds the PM checklist, exactly as its own poll loop would', async () => {
    const { create, seedChecklistSpy } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: 'Human Reviews' });
    expect(seedChecklistSpy).toHaveBeenCalledTimes(1);
    expect(seedChecklistSpy.mock.calls[0][0]).toBe(HUMAN_REVIEWS);
  });

  it('does not seed a checklist when no PM is picked', async () => {
    const { create, seedChecklistSpy } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({});
    expect(seedChecklistSpy).not.toHaveBeenCalled();
  });

  it('never writes the PM seenKeys — that would permanently suppress its own poll', async () => {
    // Dedupe already suppresses the PM's duplicate and expires on its own;
    // a seen key would not.
    const pm = { ...HUMAN_REVIEWS, seenKeys: [] };
    const { create } = makeDeps({ pms: [pm] });
    await create({ pm: 'Human Reviews', track: 'nukulb/hive#349' });
    expect(pm.seenKeys).toEqual([]);
  });
});

describe('task:create — Track', () => {
  it('sets the sourceKey both condition sets require', async () => {
    const { create, meta } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: 'Human Reviews', track: 'nukulb/hive#349' });
    expect(meta().sourceKey).toBe('nukulb/hive#349');
  });

  it('resolves a bare #N against config.github.repo', async () => {
    const { create, meta } = makeDeps({ pms: [], githubRepo: 'acme/tools' });
    await create({ track: '#12' });
    expect(meta().sourceKey).toBe('acme/tools#12');
  });

  it('attaches the github-pr actionContext the action buttons read', async () => {
    const { create, meta } = makeDeps();
    await create({ track: 'https://github.com/nukulb/hive/pull/349' });
    expect(meta().actionContext).toEqual({ type: 'github-pr', repo: 'nukulb/hive', prNumber: 349 });
    expect(meta().pr).toBe(349);
  });

  it('accepts a JIRA key, and gives the task no actionContext', async () => {
    // There is no JIRA action type, so the task carries the key alone — which
    // is all a `jira-status` completion condition reads.
    const { create, meta, sent } = makeDeps();
    await create({ track: 'DEV-43333' });
    expect(meta().sourceKey).toBe('DEV-43333');
    expect(sent.at(-1).task.actionContext).toBeNull();
  });

  it('leaves sourceKey undefined when Track is blank — the per-task opt-out', async () => {
    // A PM task with no sourceKey is routed and prioritised by its PM and
    // touched by no PR machinery. That is the point of the field.
    const { create, meta, sent } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: 'Human Reviews' });
    expect(meta().source).toBe('pm:Human Reviews');
    expect(meta().sourceKey).toBeUndefined();
    expect(sent.at(-1).task.actionContext).toBeNull();
  });

  it('refuses an unparseable Track instead of dropping it', async () => {
    // Dropping it would read as "attached" on screen and never nudge.
    const { create, sent, createTaskSpy } = makeDeps();
    await create({ track: 'sometime next week' });
    expect(createTaskSpy).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'error' });
    expect(sent.at(-1).message).toContain('Track');
  });

  it('refuses repo#N with no owner rather than storing a key GitHub would 404 on', async () => {
    const { create, createTaskSpy } = makeDeps({ githubRepo: '' });
    await create({ track: 'hive#349' });
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  it('works without a PM — Track and PM are independent choices', async () => {
    const { create, meta } = makeDeps();
    await create({ track: 'nukulb/hive#349' });
    expect(meta().source).toBeUndefined();
    expect(meta().sourceKey).toBe('nukulb/hive#349');
  });
});

describe('task:create — Track must be readable by the chosen PM', () => {
  it('refuses a JIRA key on a PM whose conditions key on a PR', async () => {
    // _parsePRFromKey returns null for a JIRA key, so the condition `continue`s
    // and the task silently never fires — the task looks tracked and is not.
    const { create, sent, createTaskSpy } = makeDeps({ pms: [PR_CONDITIONS] });
    await create({ pm: 'Watches PRs', track: 'DEV-43333' });
    expect(createTaskSpy).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: 'error' });
    expect(sent.at(-1).message).toContain('pull requests');
  });

  it('refuses a PR on a PM whose conditions key on a JIRA issue', async () => {
    const { create, sent, createTaskSpy } = makeDeps({ pms: [JIRA_CONDITIONS] });
    await create({ pm: 'Watches JIRA', track: 'nukulb/hive#349' });
    expect(createTaskSpy).not.toHaveBeenCalled();
    expect(sent.at(-1).message).toContain('JIRA issues');
  });

  it('allows the matching direction', async () => {
    const { create, meta } = makeDeps({ pms: [PR_CONDITIONS] });
    await create({ pm: 'Watches PRs', track: 'nukulb/hive#349' });
    expect(meta().sourceKey).toBe('nukulb/hive#349');
  });

  it('allows any Track on a PM with no conditions — nothing to contradict', async () => {
    const { create, meta } = makeDeps({ pms: [HUMAN_REVIEWS] });
    await create({ pm: 'Human Reviews', track: 'DEV-43333' });
    expect(meta().sourceKey).toBe('DEV-43333');
  });

  it('allows a mismatched-looking Track when no PM is chosen', async () => {
    const { create, meta } = makeDeps({ pms: [PR_CONDITIONS] });
    await create({ track: 'DEV-43333' });
    expect(meta().sourceKey).toBe('DEV-43333');
  });
});

describe('task:create — unchanged for clients that send neither field', () => {
  it('still forwards the fields it always forwarded', async () => {
    const { create, meta } = makeDeps();
    await create({ title: 'T', assignee: 'jeff', requireHumanClose: true, queuePosition: 2 });
    expect(meta()).toMatchObject({
      createdBy: 'jeff',
      title: 'T',
      assignee: 'jeff',
      requireHumanClose: true,
      queuePosition: 2,
    });
  });

  it('tolerates a non-string pm/track without erroring', async () => {
    const { create, createTaskSpy } = makeDeps();
    await create({ pm: null, track: null });
    expect(createTaskSpy).toHaveBeenCalledTimes(1);
  });
});
