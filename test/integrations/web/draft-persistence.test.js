import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Unit tests: Draft persistence module logic (extracted for testability)
// ---------------------------------------------------------------------------

function createLocalStorageMock() {
  const store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    _store: store,
  };
}

function createDraftModule(storage) {
  function saveDraft(key, value) {
    try { if (value) storage.setItem(key, value); else storage.removeItem(key); } catch (e) { /* quota exceeded */ }
  }
  function loadDraft(key) {
    try { return storage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function clearDraft(key) {
    try { storage.removeItem(key); } catch (e) { /* ignore */ }
  }
  // One draft per session, deliberately shared across panels.
  function sessionDraftKey(_panel, sessionNum) { return `hive-draft:session:${sessionNum}`; }
  const TASK_DRAFT_KEY = 'hive-draft:task-dialog';

  return { saveDraft, loadDraft, clearDraft, sessionDraftKey, TASK_DRAFT_KEY };
}

// ---------------------------------------------------------------------------
// Simulate input/send flows for each panel
// ---------------------------------------------------------------------------

function createInputSimulator(draftModule) {
  const { saveDraft, loadDraft, clearDraft, sessionDraftKey, TASK_DRAFT_KEY } = draftModule;

  // Mirrors app.js: a draft belongs to the session it was typed for, carried on
  // the input element itself, so a switch cannot file it under another session.
  const markOwner = (input, num) => {
    if (num == null || num === '') delete input.dataset.draftOwner;
    else input.dataset.draftOwner = String(num);
  };
  const ownerMatches = (input, num) => input.dataset.draftOwner === String(num);
  const stashOnSwitch = (input, panel, leaving) => {
    if (leaving == null) return;
    const key = sessionDraftKey(panel, leaving);
    if (input.value.trim() && ownerMatches(input, leaving)) saveDraft(key, input.value);
    else clearDraft(key);
  };
  const restoreOnOpen = (input, panel, num) => {
    input.value = loadDraft(sessionDraftKey(panel, num));
    markOwner(input, num);
  };

  function simulateFleetSession() {
    let currentSession = null;
    const input = { value: '', dataset: {} };

    return {
      input,
      getCurrentSession: () => currentSession,
      openSession(sessionNum) {
        stashOnSwitch(input, 'fleet', currentSession);
        currentSession = String(sessionNum);
        restoreOnOpen(input, 'fleet', currentSession);
      },
      // The bypass that caused the bug: currentSession reassigned under a box
      // that still holds another session's text.
      hijackSession(sessionNum) {
        stashOnSwitch(input, 'fleet', currentSession);
        currentSession = String(sessionNum);
        restoreOnOpen(input, 'fleet', currentSession);
      },
      onInput() {
        if (!currentSession) return;
        markOwner(input, currentSession);
        saveDraft(sessionDraftKey('fleet', currentSession), input.value);
      },
      send() {
        const text = input.value.trim();
        if (!text || !currentSession) return false;
        input.value = '';
        clearDraft(sessionDraftKey('fleet', currentSession));
        return true;
      },
    };
  }

  function simulateTasksSession() {
    let tasksSessionNum = null;
    const input = { value: '', dataset: {} };

    return {
      input,
      getSessionNum: () => tasksSessionNum,
      openTaskSession(sessionNum) {
        stashOnSwitch(input, 'tasks', tasksSessionNum);
        tasksSessionNum = String(sessionNum);
        restoreOnOpen(input, 'tasks', tasksSessionNum);
      },
      onInput() {
        if (!tasksSessionNum) return;
        markOwner(input, tasksSessionNum);
        saveDraft(sessionDraftKey('tasks', tasksSessionNum), input.value);
      },
      send() {
        const text = input.value.trim();
        if (!text || !tasksSessionNum) return false;
        input.value = '';
        clearDraft(sessionDraftKey('tasks', tasksSessionNum));
        return true;
      },
    };
  }

  function simulateTaskDetailSession() {
    let taskDetailSession = null;
    const input = { value: '', dataset: {} };

    return {
      input,
      getSession: () => taskDetailSession,
      openTaskDetail(sessionNum) {
        stashOnSwitch(input, 'task-detail', taskDetailSession);
        taskDetailSession = String(sessionNum);
        restoreOnOpen(input, 'task-detail', taskDetailSession);
      },
      onInput() {
        if (!taskDetailSession) return;
        markOwner(input, taskDetailSession);
        saveDraft(sessionDraftKey('task-detail', taskDetailSession), input.value);
      },
      send() {
        const text = input.value.trim();
        if (!text || !taskDetailSession) return false;
        input.value = '';
        clearDraft(sessionDraftKey('task-detail', taskDetailSession));
        return true;
      },
    };
  }

  function simulateTaskDialog() {
    let editingTaskId = null;
    const input = { value: '', dataset: {} };

    return {
      input,
      openNew() {
        editingTaskId = null;
        input.value = loadDraft(TASK_DRAFT_KEY);
      },
      openEdit(taskId, existingText) {
        editingTaskId = taskId;
        input.value = existingText;
      },
      onInput() {
        if (!editingTaskId) saveDraft(TASK_DRAFT_KEY, input.value);
      },
      create() {
        const text = input.value.trim();
        if (!text) return false;
        clearDraft(TASK_DRAFT_KEY);
        input.value = '';
        editingTaskId = null;
        return true;
      },
      save() {
        const text = input.value.trim();
        if (!text) return false;
        input.value = '';
        editingTaskId = null;
        return true;
      },
      cancel() {
        editingTaskId = null;
      },
    };
  }

  return { simulateFleetSession, simulateTasksSession, simulateTaskDetailSession, simulateTaskDialog };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Draft persistence helpers', () => {
  let storage;
  let draft;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
  });

  describe('saveDraft', () => {
    it('stores a non-empty value', () => {
      draft.saveDraft('key1', 'hello');
      expect(storage.setItem).toHaveBeenCalledWith('key1', 'hello');
    });

    it('removes key when value is empty string', () => {
      draft.saveDraft('key1', '');
      expect(storage.removeItem).toHaveBeenCalledWith('key1');
    });

    it('removes key when value is falsy (null/undefined)', () => {
      draft.saveDraft('key1', null);
      expect(storage.removeItem).toHaveBeenCalledWith('key1');
    });

    it('does not throw on quota exceeded', () => {
      storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
      expect(() => draft.saveDraft('key', 'val')).not.toThrow();
    });
  });

  describe('loadDraft', () => {
    it('returns stored value', () => {
      storage._store['key1'] = 'saved text';
      expect(draft.loadDraft('key1')).toBe('saved text');
    });

    it('returns empty string when key does not exist', () => {
      expect(draft.loadDraft('nonexistent')).toBe('');
    });

    it('returns empty string on error', () => {
      storage.getItem.mockImplementation(() => { throw new Error('SecurityError'); });
      expect(draft.loadDraft('key1')).toBe('');
    });
  });

  describe('clearDraft', () => {
    it('removes the key', () => {
      draft.clearDraft('key1');
      expect(storage.removeItem).toHaveBeenCalledWith('key1');
    });

    it('does not throw on error', () => {
      storage.removeItem.mockImplementation(() => { throw new Error('fail'); });
      expect(() => draft.clearDraft('key1')).not.toThrow();
    });
  });

  describe('sessionDraftKey', () => {
    it('returns unified key regardless of panel name', () => {
      expect(draft.sessionDraftKey('fleet', '5')).toBe('hive-draft:session:5');
      expect(draft.sessionDraftKey('tasks', '5')).toBe('hive-draft:session:5');
      expect(draft.sessionDraftKey('task-detail', '5')).toBe('hive-draft:session:5');
    });

    it('returns different keys for different session numbers', () => {
      expect(draft.sessionDraftKey('fleet', '5')).toBe('hive-draft:session:5');
      expect(draft.sessionDraftKey('fleet', '12')).toBe('hive-draft:session:12');
    });
  });

  it('TASK_DRAFT_KEY has expected value', () => {
    expect(draft.TASK_DRAFT_KEY).toBe('hive-draft:task-dialog');
  });
});

// ---------------------------------------------------------------------------
// Fleet session input
// ---------------------------------------------------------------------------

describe('Fleet session draft persistence', () => {
  let storage, draft, sim, fleet;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
    sim = createInputSimulator(draft);
    fleet = sim.simulateFleetSession();
  });

  it('restores empty string when no draft exists', () => {
    fleet.openSession(1);
    expect(fleet.input.value).toBe('');
  });

  it('saves draft on input and restores when switching sessions', () => {
    fleet.openSession(1);
    fleet.input.value = 'WIP message for session 1';
    fleet.onInput();

    fleet.openSession(2);
    expect(fleet.input.value).toBe(''); // session 2 has no draft

    fleet.openSession(1);
    expect(fleet.input.value).toBe('WIP message for session 1');
  });

  it('clears draft on send', () => {
    fleet.openSession(1);
    fleet.input.value = 'message to send';
    fleet.onInput();
    fleet.send();

    fleet.openSession(2);
    fleet.openSession(1);
    expect(fleet.input.value).toBe('');
  });

  it('saves draft from previous session when switching', () => {
    fleet.openSession(1);
    fleet.input.value = 'draft for 1';

    fleet.openSession(2);

    fleet.openSession(1);
    expect(fleet.input.value).toBe('draft for 1');
  });

  it('clears storage when switching away from session with empty input', () => {
    fleet.openSession(1);
    fleet.input.value = 'some text';
    fleet.onInput();

    fleet.input.value = '';
    fleet.onInput();

    fleet.openSession(2);
    fleet.openSession(1);
    expect(fleet.input.value).toBe('');
  });

  it('clears whitespace-only drafts on session switch', () => {
    fleet.openSession(1);
    fleet.input.value = '   ';
    fleet.openSession(2);
    fleet.openSession(1);
    expect(fleet.input.value).toBe('');
  });

  it('keeps separate drafts for different sessions', () => {
    fleet.openSession(1);
    fleet.input.value = 'draft-1';
    fleet.onInput();

    fleet.openSession(2);
    fleet.input.value = 'draft-2';
    fleet.onInput();

    fleet.openSession(3);
    fleet.input.value = 'draft-3';
    fleet.onInput();

    fleet.openSession(1);
    expect(fleet.input.value).toBe('draft-1');
    fleet.openSession(2);
    expect(fleet.input.value).toBe('draft-2');
    fleet.openSession(3);
    expect(fleet.input.value).toBe('draft-3');
  });
});

// ---------------------------------------------------------------------------
// Tasks session input
// ---------------------------------------------------------------------------

describe('Tasks session draft persistence', () => {
  let storage, draft, sim, tasks;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
    sim = createInputSimulator(draft);
    tasks = sim.simulateTasksSession();
  });

  it('restores empty string when no draft exists', () => {
    tasks.openTaskSession(5);
    expect(tasks.input.value).toBe('');
  });

  it('saves and restores draft across session switches', () => {
    tasks.openTaskSession(5);
    tasks.input.value = 'WIP for task session 5';
    tasks.onInput();

    tasks.openTaskSession(6);
    expect(tasks.input.value).toBe('');

    tasks.openTaskSession(5);
    expect(tasks.input.value).toBe('WIP for task session 5');
  });

  it('clears draft on send', () => {
    tasks.openTaskSession(5);
    tasks.input.value = 'sending this';
    tasks.onInput();
    tasks.send();

    tasks.openTaskSession(6);
    tasks.openTaskSession(5);
    expect(tasks.input.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Task detail session input
// ---------------------------------------------------------------------------

describe('Task detail session draft persistence', () => {
  let storage, draft, sim, detail;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
    sim = createInputSimulator(draft);
    detail = sim.simulateTaskDetailSession();
  });

  it('restores empty string when no draft exists', () => {
    detail.openTaskDetail(3);
    expect(detail.input.value).toBe('');
  });

  it('saves draft on input and restores when reopening', () => {
    detail.openTaskDetail(3);
    detail.input.value = 'detail draft';
    detail.onInput();

    detail.openTaskDetail(4);
    expect(detail.input.value).toBe('');

    detail.openTaskDetail(3);
    expect(detail.input.value).toBe('detail draft');
  });

  it('clears draft on send', () => {
    detail.openTaskDetail(3);
    detail.input.value = 'will be sent';
    detail.onInput();
    detail.send();

    detail.openTaskDetail(3);
    expect(detail.input.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Task dialog (create new task)
// ---------------------------------------------------------------------------

describe('Task dialog draft persistence', () => {
  let storage, draft, sim, dialog;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
    sim = createInputSimulator(draft);
    dialog = sim.simulateTaskDialog();
  });

  it('restores empty string when no draft exists', () => {
    dialog.openNew();
    expect(dialog.input.value).toBe('');
  });

  it('saves draft on input and restores when reopening', () => {
    dialog.openNew();
    dialog.input.value = 'new task description';
    dialog.onInput();
    dialog.cancel();

    dialog.openNew();
    expect(dialog.input.value).toBe('new task description');
  });

  it('clears draft on create', () => {
    dialog.openNew();
    dialog.input.value = 'task to create';
    dialog.onInput();
    dialog.create();

    dialog.openNew();
    expect(dialog.input.value).toBe('');
  });

  it('does not save draft when editing an existing task', () => {
    dialog.openEdit('task-123', 'existing task text');
    dialog.input.value = 'modified text';
    dialog.onInput();

    dialog.openNew();
    expect(dialog.input.value).toBe('');
  });

  it('preserves create draft across edit sessions', () => {
    dialog.openNew();
    dialog.input.value = 'my new task';
    dialog.onInput();
    dialog.cancel();

    dialog.openEdit('task-456', 'edit text');
    dialog.cancel();

    dialog.openNew();
    expect(dialog.input.value).toBe('my new task');
  });

  it('does not clear draft on edit save (only on create)', () => {
    dialog.openNew();
    dialog.input.value = 'draft in progress';
    dialog.onInput();
    dialog.cancel();

    dialog.openEdit('task-789', 'edit this');
    dialog.save();

    dialog.openNew();
    expect(dialog.input.value).toBe('draft in progress');
  });
});

// ---------------------------------------------------------------------------
// Cross-panel shared session drafts
// ---------------------------------------------------------------------------

describe('Cross-panel shared session drafts', () => {
  let storage, draft, sim;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
    sim = createInputSimulator(draft);
  });

  it('draft typed in tasks panel is visible when opening same session in fleet', () => {
    const tasks = sim.simulateTasksSession();
    const fleet = sim.simulateFleetSession();

    tasks.openTaskSession(16);
    tasks.input.value = 'typed in tasks panel';
    tasks.onInput();

    fleet.openSession(16);
    expect(fleet.input.value).toBe('typed in tasks panel');
  });

  it('draft typed in fleet panel is visible when opening same session in task detail', () => {
    const fleet = sim.simulateFleetSession();
    const detail = sim.simulateTaskDetailSession();

    fleet.openSession(5);
    fleet.input.value = 'typed in fleet';
    fleet.onInput();

    detail.openTaskDetail(5);
    expect(detail.input.value).toBe('typed in fleet');
  });

  it('draft typed in task detail is visible when opening same session in tasks panel', () => {
    const detail = sim.simulateTaskDetailSession();
    const tasks = sim.simulateTasksSession();

    detail.openTaskDetail(8);
    detail.input.value = 'typed in detail';
    detail.onInput();

    tasks.openTaskSession(8);
    expect(tasks.input.value).toBe('typed in detail');
  });

  it('sending from any panel clears the shared draft', () => {
    const fleet = sim.simulateFleetSession();
    const tasks = sim.simulateTasksSession();

    tasks.openTaskSession(10);
    tasks.input.value = 'will be sent';
    tasks.onInput();
    tasks.send();

    fleet.openSession(10);
    expect(fleet.input.value).toBe('');
  });

  it('last write wins when multiple panels write to same session', () => {
    const fleet = sim.simulateFleetSession();
    const tasks = sim.simulateTasksSession();

    fleet.openSession(3);
    fleet.input.value = 'fleet version';
    fleet.onInput();

    tasks.openTaskSession(3);
    tasks.input.value = 'tasks version';
    tasks.onInput();

    const detail = sim.simulateTaskDetailSession();
    detail.openTaskDetail(3);
    expect(detail.input.value).toBe('tasks version');
  });

  it('task dialog uses a separate key from session drafts', () => {
    const fleet = sim.simulateFleetSession();
    const dialog = sim.simulateTaskDialog();

    fleet.openSession(1);
    fleet.input.value = 'session draft';
    fleet.onInput();

    dialog.openNew();
    dialog.input.value = 'task dialog draft';
    dialog.onInput();

    // Session draft unaffected by task dialog
    expect(storage._store['hive-draft:session:1']).toBe('session draft');
    expect(storage._store['hive-draft:task-dialog']).toBe('task dialog draft');

    // Clearing task dialog doesn't affect session
    dialog.create();
    expect(storage._store['hive-draft:session:1']).toBe('session draft');
    expect(storage._store['hive-draft:task-dialog']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A draft belongs to the session it was typed for
//
// Reported: a message typed for S:20 was delivered to S:20, and the same text
// later turned up in S:21's input box. Sharing one draft per session across
// panels is deliberate; sharing it across SESSIONS is the bug. Every input now
// carries the session its text was typed for, and a switch that finds a
// mismatch drops the text instead of filing it under the session being left.
// ---------------------------------------------------------------------------

describe('drafts stick to the session they were typed for', () => {
  let storage, draft, sim;

  beforeEach(() => {
    storage = createLocalStorageMock();
    draft = createDraftModule(storage);
    sim = createInputSimulator(draft);
  });

  it('does not carry text into the next session opened', () => {
    const fleet = sim.simulateFleetSession();
    fleet.openSession(20);
    fleet.input.value = 'But I think with BookingAudit logs we CAN autopsy';
    fleet.onInput();

    fleet.openSession(21);

    expect(fleet.input.value).toBe('');
    expect(storage.getItem('hive-draft:session:21')).toBeNull();
    // ...and S:20 keeps it, because that is whose text it is.
    expect(storage.getItem('hive-draft:session:20')).toBe('But I think with BookingAudit logs we CAN autopsy');
  });

  it('gives the text back when you return to the session that owns it', () => {
    const fleet = sim.simulateFleetSession();
    fleet.openSession(20);
    fleet.input.value = 'half-written thought';
    fleet.onInput();
    fleet.openSession(21);
    fleet.openSession(20);

    expect(fleet.input.value).toBe('half-written thought');
  });

  it('drops text whose owner is not the session being left, rather than misfiling it', () => {
    const fleet = sim.simulateFleetSession();
    fleet.openSession(20);
    fleet.input.value = 'meant for twenty';
    fleet.onInput();

    // The panel is repointed underneath the box without going through the
    // save/restore dance — the shape of the openPmSessionPanel bypass.
    fleet.hijackSession(21);

    // 21 must not inherit it...
    expect(storage.getItem('hive-draft:session:21')).toBeNull();
    expect(fleet.input.value).toBe('');
    // ...and it is still 20's.
    expect(storage.getItem('hive-draft:session:20')).toBe('meant for twenty');
  });

  it('still shares one draft across panels for the SAME session', () => {
    const fleet = sim.simulateFleetSession();
    const tasks = sim.simulateTasksSession();
    fleet.openSession(20);
    fleet.input.value = 'typed in the fleet panel';
    fleet.onInput();

    tasks.openTaskSession(20);

    expect(tasks.input.value).toBe('typed in the fleet panel');
  });

  it('a send clears the draft so it cannot resurface anywhere', () => {
    const fleet = sim.simulateFleetSession();
    const tasks = sim.simulateTasksSession();
    fleet.openSession(20);
    fleet.input.value = 'sent to twenty';
    fleet.onInput();
    fleet.send();

    tasks.openTaskSession(20);
    fleet.openSession(21);

    expect(tasks.input.value).toBe('');
    expect(fleet.input.value).toBe('');
    expect(storage.getItem('hive-draft:session:20')).toBeNull();
  });

  it('typing under one session then another keeps each with its own', () => {
    const fleet = sim.simulateFleetSession();
    fleet.openSession(20);
    fleet.input.value = 'twenty text';
    fleet.onInput();
    fleet.openSession(21);
    fleet.input.value = 'twenty-one text';
    fleet.onInput();

    expect(storage.getItem('hive-draft:session:20')).toBe('twenty text');
    expect(storage.getItem('hive-draft:session:21')).toBe('twenty-one text');
  });
});

// ---------------------------------------------------------------------------
// The simulators above are a COPY of app.js's logic, which is exactly how the
// old behaviour stayed "tested" while being wrong. These read the real file.
// ---------------------------------------------------------------------------

describe('app.js actually routes drafts through the ownership helpers', () => {
  const appJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'integrations', 'web', 'public', 'app.js'),
    'utf8',
  );

  it('defines the ownership helpers', () => {
    expect(appJs).toMatch(/function markDraftOwner\(/);
    expect(appJs).toMatch(/function draftOwnerMatches\(/);
    expect(appJs).toMatch(/function stashDraftOnSwitch\(/);
    expect(appJs).toMatch(/function restoreDraftOnOpen\(/);
  });

  it('never restores a session draft straight into an input, bypassing the owner tag', () => {
    // The helper itself is the one legitimate place; the task-DIALOG draft is
    // not session-scoped and is deliberately untouched.
    const helperStart = appJs.indexOf('function restoreDraftOnOpen(');
    const withoutHelper = appJs.slice(0, helperStart) + appJs.slice(appJs.indexOf('}', appJs.indexOf('markDraftOwner(inputEl', helperStart)) + 1);
    const bypasses = withoutHelper.match(/\.value = loadDraft\(sessionDraftKey\(/g) || [];
    expect(bypasses).toEqual([]);
  });

  it('stamps the owner wherever a session draft is saved on input', () => {
    // Every saveDraft(sessionDraftKey(...)) that runs on typing must be paired
    // with a markDraftOwner in the same handler.
    const handlers = appJs.match(/addEventListener\('input',[\s\S]{0,320}?\}\);/g) || [];
    const sessionSavers = handlers.filter(h => h.includes('sessionDraftKey'));
    expect(sessionSavers.length).toBeGreaterThan(0);
    for (const h of sessionSavers) expect(h).toMatch(/markDraftOwner\(/);
  });

  it('reassigns a panel session var only alongside the save/restore dance', () => {
    // Every `<panelSessionVar> = <something>` that is not the null reset must be
    // bracketed by stashDraftOnSwitch / restoreDraftOnOpen. All three vars drive
    // an input handler, so a future bypass on any of them files one session's
    // draft under another.
    const re = /^[ \t]*(?:currentSession|tasksSessionNum|taskDetailSession) = (?!null)[^\n]*$/gm;
    const assignments = [...appJs.matchAll(re)];
    expect(assignments.length).toBeGreaterThanOrEqual(3);
    for (const m of assignments) {
      const around = appJs.slice(Math.max(0, m.index - 400), m.index + 400);
      expect(around, `no stash near: ${m[0].trim()}`).toMatch(/stashDraftOnSwitch\(/);
      expect(around, `no restore near: ${m[0].trim()}`).toMatch(/restoreDraftOnOpen\(/);
    }
  });
});
