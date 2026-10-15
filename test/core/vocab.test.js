import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const {
  TaskStatus,
  TASK_STATUSES,
  INITIAL_TASK_STATUSES,
  ACTIVE_TASK_STATUSES,
  TASK_TRANSITIONS,
  SessionState,
  SESSION_STATES,
  ApprovalStatus,
  APPROVAL_STATUSES,
  isSessionState,
  assertSessionState,
  isTaskStatus,
  isActiveTaskStatus,
  assertTaskStatus,
  canTransitionTask,
  transitionTask,
} = require('../../src/core/vocab');
const log = require('../../src/core/log');

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Source with comment-only lines removed, so the guards below read code rather
 * than prose. A comment explaining why `lastState` was wrong must not register
 * as someone still reading `lastState`. Trailing comments stay on their line,
 * so a violation cannot hide behind one.
 */
const codeOnly = (rel) =>
  read(rel)
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('task vocabulary', () => {
  describe('the enum', () => {
    it('is frozen', () => {
      expect(Object.isFrozen(TaskStatus)).toBe(true);
      expect(Object.isFrozen(TASK_STATUSES)).toBe(true);
      expect(Object.isFrozen(TASK_TRANSITIONS)).toBe(true);
    });

    it('has no duplicate values', () => {
      expect(TASK_STATUSES).toEqual([...new Set(TASK_STATUSES)]);
    });

    it('recognises exactly its own values', () => {
      for (const status of TASK_STATUSES) expect(isTaskStatus(status)).toBe(true);
      for (const notStatus of ['done', 'in-progress', 'pending', 'open', '', null, undefined, 0]) {
        expect(isTaskStatus(notStatus)).toBe(false);
      }
    });

    it('treats queued and dispatched as active, and nothing else', () => {
      expect(ACTIVE_TASK_STATUSES).toEqual([TaskStatus.QUEUED, TaskStatus.DISPATCHED]);
      for (const status of TASK_STATUSES) {
        expect(isActiveTaskStatus(status)).toBe(ACTIVE_TASK_STATUSES.includes(status));
      }
    });

    it('keeps approval status separate from task status', () => {
      // 'pending' is an approval status, not a task status. Conflating the two
      // is how a comparison ends up never matching.
      expect(APPROVAL_STATUSES).toContain(ApprovalStatus.PENDING);
      for (const approval of APPROVAL_STATUSES) expect(isTaskStatus(approval)).toBe(false);
    });
  });

  describe('session state', () => {
    it('is frozen and has no duplicates', () => {
      expect(Object.isFrozen(SessionState)).toBe(true);
      expect(SESSION_STATES).toEqual([...new Set(SESSION_STATES)]);
    });

    it('is exactly idle, working, off, blocked', () => {
      expect([...SESSION_STATES].sort()).toEqual(['blocked', 'idle', 'off', 'working']);
    });

    it('has no "waiting" member', () => {
      // Two call sites in the voice integration compared against 'waiting'.
      // A session waiting on an approval is still `idle` to the detector; the
      // watcher tracks waiting separately, in its detectedWaiting set.
      expect(isSessionState('waiting')).toBe(false);
      expect(() => assertSessionState('waiting')).toThrow(/Invalid session state: "waiting"/);
    });

    it('recognises exactly its own values', () => {
      for (const state of SESSION_STATES) expect(isSessionState(state)).toBe(true);
      for (const notState of ['waiting', 'error', 'closed', '', null, undefined, 0]) {
        expect(isSessionState(notState)).toBe(false);
      }
    });

    it('does not overlap task status', () => {
      for (const state of SESSION_STATES) expect(isTaskStatus(state)).toBe(false);
      for (const status of TASK_STATUSES) expect(isSessionState(status)).toBe(false);
    });

    it('names the legal values when it throws', () => {
      expect(() => assertSessionState('nope')).toThrow(/idle, working, off, blocked/);
      expect(() => assertSessionState('nope', 'state for session 4')).toThrow(
        /Invalid state for session 4/,
      );
    });
  });

  describe('assertTaskStatus', () => {
    it('returns the value for a real status', () => {
      expect(assertTaskStatus(TaskStatus.QUEUED)).toBe('queued');
    });

    it('throws on a status hive never writes', () => {
      expect(() => assertTaskStatus('done')).toThrow(/Invalid task status: "done"/);
      expect(() => assertTaskStatus('in-progress')).toThrow(/Invalid task status/);
    });

    it('names the legal values in the error, so the fix is obvious', () => {
      expect(() => assertTaskStatus('nope')).toThrow(
        /queued, dispatched, snoozed, completed, failed, cancelled/,
      );
    });

    it('uses the caller-supplied context in the message', () => {
      expect(() => assertTaskStatus('nope', 'status for task 7')).toThrow(
        /Invalid status for task 7/,
      );
    });

    it('rejects non-strings', () => {
      for (const bad of [null, undefined, 42, {}, ['queued']]) {
        expect(() => assertTaskStatus(bad)).toThrow(/Invalid task status/);
      }
    });
  });

  describe('the transition table', () => {
    it('covers every status', () => {
      expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    });

    it('only ever transitions to a real status', () => {
      for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
        for (const to of targets) {
          expect(isTaskStatus(to), `${from} → ${to}`).toBe(true);
        }
      }
    });

    it('lists no duplicates', () => {
      for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
        expect(targets, from).toEqual([...new Set(targets)]);
      }
    });

    it('allows the transitions TaskQueue actually makes', () => {
      const legal = [
        [TaskStatus.QUEUED, TaskStatus.DISPATCHED], // _dispatchTask
        [TaskStatus.QUEUED, TaskStatus.SNOOZED], // snoozeTask
        [TaskStatus.QUEUED, TaskStatus.CANCELLED], // cancelTask
        [TaskStatus.QUEUED, TaskStatus.COMPLETED], // PM auto-completion
        [TaskStatus.DISPATCHED, TaskStatus.QUEUED], // requeueTask
        [TaskStatus.DISPATCHED, TaskStatus.COMPLETED], // completeTask
        [TaskStatus.DISPATCHED, TaskStatus.FAILED], // failTask
        [TaskStatus.DISPATCHED, TaskStatus.CANCELLED], // cancelTask
        [TaskStatus.SNOOZED, TaskStatus.QUEUED], // unsnoozeTask / _wakeTask
        [TaskStatus.SNOOZED, TaskStatus.CANCELLED], // cancelTask
        [TaskStatus.COMPLETED, TaskStatus.DISPATCHED], // resumeTask
        [TaskStatus.FAILED, TaskStatus.DISPATCHED], // resumeTask
      ];
      for (const [from, to] of legal) {
        expect(canTransitionTask(from, to), `${from} → ${to}`).toBe(true);
      }
    });

    it('refuses the transitions it should', () => {
      const illegal = [
        [TaskStatus.QUEUED, TaskStatus.FAILED], // failTask requires dispatched
        [TaskStatus.SNOOZED, TaskStatus.DISPATCHED], // wakes to queued, never straight out
        [TaskStatus.CANCELLED, TaskStatus.QUEUED], // cancelled is terminal
        [TaskStatus.CANCELLED, TaskStatus.DISPATCHED],
        [TaskStatus.COMPLETED, TaskStatus.QUEUED], // resume goes to dispatched
        [TaskStatus.COMPLETED, TaskStatus.FAILED],
      ];
      for (const [from, to] of illegal) {
        expect(canTransitionTask(from, to), `${from} → ${to}`).toBe(false);
      }
    });

    it('is false for unknown statuses rather than throwing', () => {
      expect(canTransitionTask('done', TaskStatus.QUEUED)).toBe(false);
      expect(canTransitionTask(TaskStatus.QUEUED, 'done')).toBe(false);
      expect(canTransitionTask(undefined, undefined)).toBe(false);
    });

    it('agrees that a task can be created in an initial status', () => {
      expect(INITIAL_TASK_STATUSES).toEqual([TaskStatus.QUEUED, TaskStatus.DISPATCHED]);
      for (const status of INITIAL_TASK_STATUSES) expect(isTaskStatus(status)).toBe(true);
    });
  });

  describe('transitionTask', () => {
    const setStatus = (task, next) => transitionTask(task, next);

    afterEach(() => vi.restoreAllMocks());

    it('assigns a legal transition without complaint', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const task = { id: '1', status: TaskStatus.QUEUED };
      setStatus(task, TaskStatus.DISPATCHED);
      expect(task.status).toBe(TaskStatus.DISPATCHED);
      expect(warn).not.toHaveBeenCalled();
    });

    it('throws on a status that does not exist, naming the task', () => {
      const task = { id: '7', status: TaskStatus.DISPATCHED };
      expect(() => setStatus(task, 'done')).toThrow(/Invalid status for task 7/);
      expect(task.status).toBe(TaskStatus.DISPATCHED); // unchanged
    });

    it('warns but still assigns on an unmapped transition', () => {
      // Deliberately permissive: the table is derived from taskqueue.js, so a
      // surprise means the table is stale, and throwing would take the fleet
      // down over bookkeeping.
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const task = { id: '3', status: TaskStatus.CANCELLED };
      setStatus(task, TaskStatus.DISPATCHED);
      expect(task.status).toBe(TaskStatus.DISPATCHED);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /\[vocab\] unexpected transition for task 3: cancelled → dispatched/,
      );
    });

    it('does not warn when the status is unchanged', () => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const task = { id: '4', status: TaskStatus.COMPLETED };
      setStatus(task, TaskStatus.COMPLETED);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  // Bare-literal comparisons are caught by the lint rule in eslint.config.js,
  // not here. That matters: this used to be a hand-maintained list of files to
  // scan, which goes stale the moment somebody adds a module — the new file is
  // unguarded and nothing says so. The lint rule has no list.
  //
  // What stays here is what a selector cannot express.
  describe('the codebase uses the vocabulary', () => {
    const GUARDED = [
      'src/core/taskqueue.js',
      'src/core/pm.js',
      'src/core/pm-sources.js',
      'src/integrations/github/bot.js',
      'src/integrations/slack/bot.js',
      'src/integrations/voice/index.js',
      'src/integrations/voice/standup.js',
      'src/integrations/web/ws-handlers.js',
    ];

    for (const file of GUARDED) {
      it(`${file} never assigns task.status directly`, () => {
        // vocab.transitionTask owns the only assignment in the codebase.
        const hits = [...read(file).matchAll(/^.*\btask\.status\s*=\s*(?!==).*$/gm)].map((m) =>
          m[0].trim(),
        );
        expect(hits).toEqual([]);
      });
    }

    const STATE_GUARDED = [
      'src/core/tmux.js',
      'src/core/pm.js',
      'src/core/taskqueue.js',
      'src/core/relay.js',
      'src/core/watcher.js',
      'src/integrations/web/ws-handlers.js',
      'src/integrations/telegram/commands.js',
      'src/integrations/voice/standup.js',
      'src/integrations/voice/index.js',
    ];

    // A `switch (state)` dispatches on the vocabulary exactly as `===` does, but
    // its case labels are a different syntactic shape and the comparison guard
    // above cannot see them. telegram/commands.js was in STATE_GUARDED and still
    // carried `case 'idle':` for exactly that reason — guarded file, unguarded
    // shape. Same blind spot the lint rule in #347 has, since it matches
    // BinaryExpression nodes and a case label is not one.
    const stateCasePattern = new RegExp(
      `\\bcase\\s+'(?:${[...SESSION_STATES, 'waiting'].join('|')})'\\s*:`,
      'g',
    );

    for (const file of STATE_GUARDED) {
      it(`${file} switches on session-state constants, not case literals`, () => {
        const hits = [...codeOnly(file).matchAll(stateCasePattern)].map((m) => m[0]);
        expect(hits).toEqual([]);
      });
    }
    it('nothing reads watcher.lastState, which does not exist', () => {
      // The watcher's map is prevStates. Reading lastState returned undefined
      // forever, and optional chaining made it silent.
      for (const file of STATE_GUARDED) {
        expect(codeOnly(file), file).not.toContain('lastState');
      }
      expect(read('src/core/watcher.js')).toContain('this.prevStates');
    });

    it('detectState returns constants, not literals', () => {
      const src = read('src/core/tmux.js');
      expect([...src.matchAll(/return '(?:idle|working|off)'/g)].map((m) => m[0])).toEqual([]);
      expect(src).toContain("require('./vocab')");
    });

    it('taskqueue.js routes every lifecycle write through transitionTask', () => {
      const src = read('src/core/taskqueue.js');
      // requeue, cancel, snooze, unsnooze, wake, resume, complete, fail, dispatch,
      // defer. `defer` is #323's, converted to the vocabulary when main merged in —
      // it arrived writing `task.status = 'queued'` directly, which the assignment
      // guard above rejected. That is this guard pair working as intended: a new
      // lifecycle method cannot join taskqueue.js without going through the table.
      expect(src.match(/transitionTask\(task,/g) || []).toHaveLength(10);
    });

    it('vocab.js holds the only assignment to task.status', () => {
      const assignments = [...read('src/core/vocab.js').matchAll(/\btask\.status\s*=\s*(?!==)/g)];
      expect(assignments).toHaveLength(1);
      expect(read('src/core/vocab.js')).toContain('assertTaskStatus(next,');
    });
  });

  // The lint rule hardcodes the words it bans, because an ESLint selector is a
  // string and cannot import an enum. That is a second statement of the
  // vocabulary — exactly the thing this whole effort exists to catch — so it is
  // checked against the first.
  describe('the lint rule bans exactly the vocabulary', () => {
    const config = require('../../eslint.config.js');
    const block = config.find((c) => c.rules && c.rules['no-restricted-syntax']);
    const entries = block.rules['no-restricted-syntax'].slice(1);

    // Both selector shapes carry a word list: `Literal[value=…]` for comparisons,
    // and `SwitchCase[test.value=…]` for case labels. Parsing only the first would
    // leave the switch selectors outside this parity check — a statement of the
    // vocabulary this test exists to catch, invisible to it.
    const WORD_LIST = /(?:Literal\[value|SwitchCase\[test\.value)=\/\^\(([^)]+)\)\$\/\]/;
    const bannedWords = new Set();
    for (const entry of entries) {
      const m = entry.selector.match(WORD_LIST);
      if (m) for (const w of m[1].split('|')) bannedWords.add(w);
    }

    it('has a parseable set of restricted selectors', () => {
      expect(entries.length).toBeGreaterThan(0);
      expect(bannedWords.size).toBeGreaterThan(0);
    });

    it('parses a word list out of every selector, switch cases included', () => {
      // A selector the parser cannot read is one whose words escape the parity
      // checks below entirely.
      const unparsed = entries.filter((e) => !WORD_LIST.test(e.selector)).map((e) => e.selector);
      expect(unparsed).toEqual([]);
      expect(entries.some((e) => e.selector.includes('SwitchCase'))).toBe(true);
    });

    it('bans every task status', () => {
      const missing = TASK_STATUSES.filter((s) => !bannedWords.has(s));
      expect(missing).toEqual([]);
    });

    it('bans every session state', () => {
      const missing = SESSION_STATES.filter((s) => !bannedWords.has(s));
      expect(missing).toEqual([]);
    });

    it('bans every approval status', () => {
      const missing = APPROVAL_STATUSES.filter((s) => !bannedWords.has(s));
      expect(missing).toEqual([]);
    });

    it('bans the words that were never produced, so they cannot return', () => {
      for (const dead of ['done', 'in-progress', 'waiting']) {
        expect(bannedWords.has(dead), dead).toBe(true);
        // And they are still not vocabulary.
        expect(isTaskStatus(dead) || isSessionState(dead)).toBe(false);
      }
    });

    it('bans nothing that is not one of those', () => {
      const known = new Set([
        ...TASK_STATUSES,
        ...SESSION_STATES,
        ...APPROVAL_STATUSES,
        'done',
        'in-progress',
        'waiting',
      ]);
      const extra = [...bannedWords].filter((w) => !known.has(w));
      expect(extra).toEqual([]);
    });
  });

  // The parity checks above prove the config names the right WORDS. They cannot
  // prove the selectors match the right SYNTAX — a selector with a perfect word
  // list and a wrong node type bans nothing. So these run the real linter over
  // planted code. Review flagged `switch` case labels as uncaught by the
  // BinaryExpression-only rule; the shape then shipped in telegram/commands.js.
  describe('the lint rule catches case labels, not just comparisons', () => {
    const { ESLint } = require('eslint');
    // Lint as a non-test file: the config turns the rule off under test/**.
    const lint = async (code) => {
      const eslint = new ESLint({ cwd: repoRoot });
      const [result] = await eslint.lintText(code, { filePath: 'src/_vocab_probe.js' });
      return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
    };

    it('flags a switch on a session-state identifier — the shape that shipped', async () => {
      const hits = await lint(`function t(state) { switch (state) { case 'idle': return 1; } }`);
      expect(hits).toHaveLength(1);
      expect(hits[0].message).toMatch(/Compare against the constant/);
    });

    it('flags a switch on a .status property', async () => {
      const hits = await lint(
        `function t(task) { switch (task.status) { case 'queued': return 1; } }`,
      );
      expect(hits).toHaveLength(1);
    });

    it('gives a never-produced word its own message in a case label', async () => {
      const hits = await lint(`function t(state) { switch (state) { case 'waiting': return 1; } }`);
      expect(hits).toHaveLength(1);
      expect(hits[0].message).toMatch(/never been produced/);
    });

    it('leaves a foreign vocabulary alone — pr.state is not a session state', async () => {
      expect(
        await lint(`function t(pr) { switch (pr.state) { case 'closed': return 1; } }`),
      ).toEqual([]);
    });

    it('leaves an unrelated property alone even when the word matches', async () => {
      expect(await lint(`function t(x) { switch (x.kind) { case 'queued': return 1; } }`)).toEqual(
        [],
      );
    });

    it('flags an approval status compared as a string, and leaves a CI state alone', async () => {
      const hits = await lint(`function t(a) { return a.status === 'pending'; }`);
      expect(hits).toHaveLength(1);
      expect(hits[0].message).toMatch(/ApprovalStatus/);
      // pr-status.js reads CI states off a local, not a .status property.
      expect(await lint(`function t(v) { return v === 'pending'; }`)).toEqual([]);
    });

    it('flags an approval status once it has been copied into a local', async () => {
      const compared = await lint(
        `function t(a) { const status = a.status; return status === 'denied'; }`,
      );
      expect(compared).toHaveLength(1);
      expect(compared[0].message).toMatch(/ApprovalStatus/);
      const switched = await lint(
        `function t(a) { const status = a.status; switch (status) { case 'approved': return 1; } }`,
      );
      expect(switched).toHaveLength(1);
    });

    it('accepts the constant form', async () => {
      expect(
        await lint(
          `const { SessionState } = require('./vocab');\n` +
            `function t(state) { switch (state) { case SessionState.IDLE: return 1; } }`,
        ),
      ).toEqual([]);
    });
  });

  // docs/task-state-machine.md prints the transition table for people. A table
  // that can drift from the code is worth less than no table, because people
  // believe it — so the doc is parsed and compared, not trusted.
  describe('docs/task-state-machine.md matches the code', () => {
    const doc = read('docs/task-state-machine.md');

    const documented = (() => {
      const block = doc.match(
        /<!-- transitions:start[^>]*-->\s*```\n([\s\S]*?)```\s*<!-- transitions:end -->/,
      );
      if (!block) return null;
      const table = {};
      for (const line of block[1].trim().split('\n')) {
        const [from, targets] = line.split('->').map((s) => s.trim());
        table[from] = targets.split(',').map((s) => s.trim());
      }
      return table;
    })();

    it('has a parseable transitions block', () => {
      expect(documented).not.toBeNull();
    });

    it('documents every status, and only real ones', () => {
      expect(Object.keys(documented).sort()).toEqual([...TASK_STATUSES].sort());
    });

    it('documents exactly the transitions the code allows', () => {
      for (const from of TASK_STATUSES) {
        expect([...documented[from]].sort(), `documented targets for "${from}"`).toEqual(
          [...TASK_TRANSITIONS[from]].sort(),
        );
      }
    });

    it('names the enforcement helper it describes', () => {
      // If transitionTask is ever renamed, the prose goes stale silently.
      expect(doc).toContain('transitionTask');
      expect(doc).toContain('TASK_TRANSITIONS');
    });
  });

  // pr-status.js is deliberately absent from GUARDED above: its
  // `check.status === 'completed'` is a GitHub check-run status, a different
  // vocabulary that happens to share a word. This test pins that reasoning so
  // nobody "fixes" it into hive's enum.
  it('does not claim GitHub check-run statuses', () => {
    expect(read('src/core/pr-status.js')).toContain("c.status === 'completed'");
  });
});
