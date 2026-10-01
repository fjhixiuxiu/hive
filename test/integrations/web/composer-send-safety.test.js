import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// What a send's result may do to a composer.
//
// Observed 2026-09-27: an ask to S:19 timed out while the fleet composer was
// showing S:20 with a half-typed draft. The ask:done handler wrote its one shared
// `lastSentMessage` into whatever box was on screen — S:19's prompt over S:20's
// draft — by assigning .value, which also wiped the undo history. The text had
// reached S:19 anyway; a timeout only means the reply was late.
//
// The rules under test:
//   1. every edit hive makes to a composer is undoable (execCommand insertText);
//   2. a result only acts on the session its send was for (tracked by id);
//   3. delivered text is never written back; undelivered text goes to its own
//      session only, and never over anything.
//
// The block is lifted out of app.js rather than restated, so a change there that
// breaks a rule cannot pass this.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(APP_JS, 'utf8');

function sendSafetySource() {
  const start = source.indexOf('  function setComposerText(el, text) {');
  const settle = source.indexOf('  function settleSend(msg, verb) {');
  if (start < 0 || settle < 0) throw new Error('could not find the send-safety block in app.js');
  const end = source.indexOf('\n  }\n', settle);
  return source.slice(start, end + 4);
}

// A textarea whose undo history behaves like a browser's: execCommand edits push
// onto it, assigning .value wipes it.
function makeTextarea(owner, value = '') {
  const el = {
    _value: value,
    _undo: [],
    dataset: owner == null ? {} : { draftOwner: String(owner) },
    listeners: [],
    get value() {
      return this._value;
    },
    set value(v) {
      this._value = v;
      this._undo = [];
    },
    focus: vi.fn(function () {
      doc.activeElement = this;
    }),
    blur: vi.fn(function () {
      if (doc.activeElement === this) doc.activeElement = doc.body;
    }),
    select() {},
    addEventListener(type, fn) {
      if (type === 'input') this.listeners.push(fn);
    },
  };
  return el;
}

let doc;
function makeDocument({ execCommandWorks = true } = {}) {
  const body = { focus() {} };
  doc = {
    body,
    activeElement: body,
    execCommand: vi.fn((cmd, _ui, text) => {
      const el = doc.activeElement;
      if (!execCommandWorks || !el || !('_undo' in el)) return false;
      el._undo.push(el._value);
      el._value = cmd === 'insertText' ? text : '';
      el.listeners.forEach((fn) => fn());
      return true;
    }),
  };
  return doc;
}

function lift({ execCommandWorks = true } = {}) {
  const document = makeDocument({ execCommandWorks });
  const store = {};
  const showToast = vi.fn();
  const deps = {
    document,
    showToast,
    draftOwnerMatches: (el, s) => !!el && el.dataset.draftOwner === String(s),
    sessionDraftKey: (_p, s) => `hive-draft:session:${s}`,
    loadDraft: (k) => store[k] || '',
    saveDraft: vi.fn((k, v) => {
      if (v) store[k] = v;
      else delete store[k];
    }),
  };
  const names = Object.keys(deps);
  const api = new Function(
    ...names,
    `${sendSafetySource()}\nreturn { setComposerText, trackSend, takeSend, restoreUnsent, settleSend, pendingSends };`,
  )(...names.map((n) => deps[n]));
  return { ...api, ...deps, store };
}

describe('setComposerText — hive edits are undoable', () => {
  it('replaces the text through execCommand, so the old text is on the undo stack', () => {
    const { setComposerText } = lift();
    const box = makeTextarea(20, 'my draft');
    setComposerText(box, 'something else');
    expect(box.value).toBe('something else');
    expect(box._undo).toEqual(['my draft']);
  });

  it('clears through execCommand too (the clear after every send is undoable)', () => {
    const { setComposerText } = lift();
    const box = makeTextarea(20, 'sent text');
    doc.activeElement = box;
    setComposerText(box, '');
    expect(box.value).toBe('');
    expect(box._undo).toEqual(['sent text']);
    expect(doc.execCommand).toHaveBeenCalledWith('delete', false);
  });

  it('hands focus back to whatever had it', () => {
    const { setComposerText } = lift();
    const box = makeTextarea(19);
    const other = makeTextarea(20);
    doc.activeElement = other;
    setComposerText(box, 'x');
    expect(doc.activeElement).toBe(other);
  });

  it('still sets the text where execCommand is unavailable', () => {
    const { setComposerText } = lift({ execCommandWorks: false });
    const box = makeTextarea(20, 'a');
    setComposerText(box, 'b');
    expect(box.value).toBe('b');
  });
});

describe('settleSend — a result only touches its own session', () => {
  let t;
  beforeEach(() => {
    t = lift();
  });

  it('the reported case: S:19 times out while S:20 is being typed — nothing is written', () => {
    const box = makeTextarea(19);
    const id = t.trackSend(19, 'prompt for 19', box);
    // Switched to S:20 and started typing.
    box.value = 'half-typed for 20';
    box.dataset.draftOwner = '20';

    t.settleSend(
      { session: 19, id, success: false, delivered: true, error: 'Timed out after 300s.' },
      'Ask',
    );

    expect(box.value).toBe('half-typed for 20');
    expect(t.saveDraft).not.toHaveBeenCalled();
    expect(t.showToast).toHaveBeenCalledWith(
      'Session 19 still working',
      'Timed out after 300s.',
      'info',
    );
    expect(t.pendingSends.size).toBe(0);
  });

  it('a timeout writes nothing even when the box is still S:19 and empty', () => {
    const box = makeTextarea(19);
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, id, success: false, delivered: true }, 'Ask');
    expect(box.value).toBe('');
    expect(t.saveDraft).not.toHaveBeenCalled();
  });

  it("undelivered, box moved to S:20: goes to S:19's saved draft, S:20 untouched", () => {
    const box = makeTextarea(20, 'half-typed for 20');
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend(
      { session: 19, id, success: false, delivered: false, error: 'Claude is not running.' },
      'Ask',
    );

    expect(box.value).toBe('half-typed for 20');
    expect(t.store['hive-draft:session:19']).toBe('prompt for 19');
    expect(t.store['hive-draft:session:20']).toBeUndefined();
    expect(t.showToast.mock.calls[0][1]).toContain("saved as session 19's draft");
  });

  it('undelivered, box still S:19 and empty: back in the box, undoably', () => {
    const box = makeTextarea(19);
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, id, success: false, delivered: false }, 'Tell');
    expect(box.value).toBe('prompt for 19');
    expect(box._undo).toEqual(['']);
  });

  it('undelivered, box still S:19 but holding new text: overwrites nothing', () => {
    const box = makeTextarea(19, 'new thought');
    t.store['hive-draft:session:19'] = 'new thought';
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, id, success: false, delivered: false }, 'Ask');
    expect(box.value).toBe('new thought');
    expect(t.store['hive-draft:session:19']).toBe('new thought');
    expect(t.showToast.mock.calls[0][1]).toContain('history');
  });

  it('undelivered, S:19 already has a saved draft: the draft is kept', () => {
    const box = makeTextarea(20);
    t.store['hive-draft:session:19'] = 'older S:19 draft';
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, id, success: false, delivered: false }, 'Ask');
    expect(t.store['hive-draft:session:19']).toBe('older S:19 draft');
    expect(box.value).toBe('');
  });

  it("two sends in flight: S:19's failure restores S:19's text, not the later S:20 send", () => {
    const box = makeTextarea(19);
    const id19 = t.trackSend(19, 'prompt for 19', box);
    box.dataset.draftOwner = '20';
    t.trackSend(20, 'prompt for 20', box);
    box.dataset.draftOwner = '19';

    t.settleSend({ session: 19, id: id19, success: false, delivered: false }, 'Ask');
    expect(box.value).toBe('prompt for 19');
  });

  it('a result with no id (slash command, plan comment, older server) never touches a composer', () => {
    const box = makeTextarea(19);
    t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, success: false, delivered: false, error: 'x' }, 'Tell');
    expect(box.value).toBe('');
    expect(t.saveDraft).not.toHaveBeenCalled();
  });

  it('delivery unknown (the server threw): error toast, nothing written', () => {
    const box = makeTextarea(19);
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, id, success: false, error: 'boom' }, 'Ask');
    expect(box.value).toBe('');
    expect(t.saveDraft).not.toHaveBeenCalled();
    expect(t.showToast).toHaveBeenCalledWith('Session 19: Ask failed', 'boom', 'error');
  });

  it('success clears the tracked send and writes nothing', () => {
    const box = makeTextarea(19);
    const id = t.trackSend(19, 'prompt for 19', box);
    t.settleSend({ session: 19, id, success: true, delivered: true }, 'Tell');
    expect(t.pendingSends.size).toBe(0);
    expect(box.value).toBe('');
    expect(t.showToast).not.toHaveBeenCalled();
  });
});

describe('app.js wiring', () => {
  it('no composer text is assigned directly outside of opening a session', () => {
    // Session boundaries are the sanctioned .value writes (restoreDraftOnOpen,
    // closeSession): undo must never carry text across sessions. Any other
    // direct write is an edit the user cannot take back.
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(
        ({ line }) =>
          /\b(msgInput|tsMsgInput|quickInput)\.value\s*=[^=]/.test(line) &&
          !line.includes('// session boundary:'),
      );
    expect(offenders).toEqual([]);
  });

  it('ask:done / tell:done go through settleSend and no shared last-sent message remains', () => {
    expect(source).not.toMatch(/lastSentMessage/);
    expect(source).not.toMatch(/tsPendingSession/);
    const ask = source.slice(
      source.indexOf("case 'ask:done':"),
      source.indexOf("case 'tell:done':"),
    );
    const tell = source.slice(
      source.indexOf("case 'tell:done':"),
      source.indexOf("case 'console:status':"),
    );
    expect(ask).toContain("settleSend(msg, 'Ask')");
    expect(tell).toContain("settleSend(msg, 'Tell')");
  });

  it('every composer send carries a tracked id', () => {
    for (const fn of [
      'sendMessage',
      'sendTasksMessage',
      'sendTaskDetailMessage',
      'quickSendMessage',
    ]) {
      const start = source.indexOf(`  function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n  }\n', start));
      expect(body, fn).toContain('trackSend(');
      for (const send of body.match(/ws\.send\(JSON\.stringify\(\{ type: [^}]*\}\)\)/g) || []) {
        expect(send, `${fn}: ${send}`).toMatch(/\bid\b/);
      }
    }
  });
});
