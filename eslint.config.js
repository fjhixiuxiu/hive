'use strict';

/**
 * Vocabulary enforcement.
 *
 * This config deliberately turns on NO general style or correctness rules. hive
 * has 34,000 lines written without a linter, and switching on `recommended`
 * would bury the one thing this is here to catch under thousands of findings
 * nobody asked for. Everything below is about a single failure mode.
 *
 * The failure mode: a word compared against but never produced. Three shipped
 * defects had exactly this shape —
 *
 *   task.status === 'done'          // the queue writes 'completed'
 *   t.status === 'in-progress'      // a Nectar status, never a hive one
 *   state === 'waiting'             // no such session state exists
 *
 * — and none of them could fail a test, throw, or log. The branch simply never
 * ran, and it looked complete in the diff. A typo in `TaskStatus.COMPLTED` is a
 * crash on the line that made it; a typo in `'compltjed'` is silence.
 *
 * So: comparing `.status` or `.state` against a bare string literal is an error,
 * and the fix is always to import the constant from src/core/vocab.js.
 *
 * Why lint rather than a test: the guard tests in test/core/vocab.test.js used a
 * hand-maintained list of files to scan, which goes stale the moment somebody
 * adds a module — the new file is unguarded and nothing says so. A lint rule has
 * no list. It sees every file, including the ones that do not exist yet, and it
 * reports at the line rather than in a test summary.
 */

// The words hive's own vocabularies own. Kept in sync with src/core/vocab.js by
// test/core/vocab.test.js, which fails if this list and the enums disagree.
const TASK_STATUSES = ['queued', 'dispatched', 'snoozed', 'completed', 'failed', 'cancelled'];
const SESSION_STATES = ['idle', 'working', 'off', 'blocked'];
// 'pending' is also a CI state, but pr-status.js reads it off `v`, which is not
// in STATE_IDENTIFIERS, so the two don't meet. CI code that names its variable
// `state` or `status` will trip this and needs a disable comment, as the GitHub
// check-run vocabulary in pr-status.js already has.
const APPROVAL_STATUSES = ['pending', 'approved', 'denied'];

// Words that were compared against but have never been produced anywhere in
// hive. These are not vocabulary — they are the bugs themselves, kept here so
// they cannot come back.
const NEVER_PRODUCED = ['done', 'in-progress', 'waiting'];

const anyOf = (words) => `/^(${words.join('|')})$/`;

// Variables the codebase assigns a state to before comparing it, where the
// property name is no longer in the expression: `const currState = s.state`.
const STATE_IDENTIFIERS = ['state', 'currState', 'currentState', 'prevState', 'status'];

const OP = 'BinaryExpression[operator=/^[!=]==$/]';

/**
 * Match `<anything>.status === 'queued'` and its `!==` and reversed forms.
 *
 * Scoped to the property name so that other vocabularies sharing a word are
 * untouched: a GitHub check run's `check.status === 'completed'` and a pull
 * request's `pr.state === 'closed'` are different languages that happen to
 * borrow a term.
 */
function onProperty(property, words) {
  const lit = `Literal[value=${anyOf(words)}]`;
  return [
    `${OP}[left.type="MemberExpression"][left.property.name="${property}"] > ${lit}`,
    `${OP}[right.type="MemberExpression"][right.property.name="${property}"] > ${lit}`,
  ];
}

/** Match `currState === 'idle'`, where the property name is already gone. */
function onIdentifier(words) {
  const lit = `Literal[value=${anyOf(words)}]`;
  return STATE_IDENTIFIERS.map(
    (name) => `${OP}[left.type="Identifier"][left.name="${name}"] > ${lit}`,
  );
}

/**
 * Match `switch (task.status) { case 'queued': }`.
 *
 * A `switch` dispatches on the vocabulary exactly as `===` does, but a case label
 * is a SwitchCase node, not a BinaryExpression — so every selector above is blind
 * to it. Review flagged this shape as unpopulated and worth a selector "if it ever
 * appears". It then appeared: telegram/commands.js carried
 * `switch (state) { case 'idle': … }` in a file the vocab tests already guarded.
 * It was fixed at the test tier on #343; this closes it here too, so the lint rule
 * and the test guards agree about what they catch.
 */
function onSwitchProperty(property, words) {
  return (
    `SwitchStatement[discriminant.type="MemberExpression"]` +
    `[discriminant.property.name="${property}"] > SwitchCase[test.value=${anyOf(words)}]`
  );
}

/** Match `switch (state) { case 'idle': }` — the form that actually shipped. */
function onSwitchIdentifier(words) {
  return STATE_IDENTIFIERS.map(
    (name) =>
      `SwitchStatement[discriminant.type="Identifier"][discriminant.name="${name}"]` +
      ` > SwitchCase[test.value=${anyOf(words)}]`,
  );
}

const VOCAB_MESSAGE =
  'Compare against the constant, not the string. Import { TaskStatus }, ' +
  '{ SessionState } or { ApprovalStatus } from src/core/vocab.js. A mistyped constant crashes on the ' +
  'line that made it; a mistyped literal is a branch that silently never runs.';

const DEAD_MESSAGE =
  'This word has never been produced anywhere in hive, so the comparison can ' +
  'never be true. Three shipped defects had this exact shape. See ' +
  'docs/vocabulary.md.';

// Each selector is emitted exactly once: property-scoped forms differ by
// property, identifier forms differ by word list. ESLint rejects duplicates.
const restricted = [
  ...[
    ...onProperty('status', TASK_STATUSES),
    ...onProperty('state', SESSION_STATES),
    ...onProperty('status', APPROVAL_STATUSES),
    ...onIdentifier([...TASK_STATUSES, ...SESSION_STATES, ...APPROVAL_STATUSES]),
    onSwitchProperty('status', TASK_STATUSES),
    onSwitchProperty('state', SESSION_STATES),
    onSwitchProperty('status', APPROVAL_STATUSES),
    ...onSwitchIdentifier([...TASK_STATUSES, ...SESSION_STATES, ...APPROVAL_STATUSES]),
  ].map((selector) => ({ selector, message: VOCAB_MESSAGE })),

  ...[
    ...onProperty('status', NEVER_PRODUCED),
    ...onProperty('state', NEVER_PRODUCED),
    ...onIdentifier(NEVER_PRODUCED),
    onSwitchProperty('status', NEVER_PRODUCED),
    onSwitchProperty('state', NEVER_PRODUCED),
    ...onSwitchIdentifier(NEVER_PRODUCED),
  ].map((selector) => ({ selector, message: DEAD_MESSAGE })),
];

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      '.playwright-mcp/**',
      // Gitignored, so prettier already skips it, but flat-config eslint does not
      // read .gitignore. Agent worktrees under .claude/worktrees/ are whole
      // checkouts of other branches, and linting them fails every commit here.
      '.claude/**',
      // Browser code with no module system — it cannot require() vocab.js, so
      // it cannot obey these rules yet. Sharing the vocabulary with the client
      // is a client/server contract problem and wants its own change.
      'src/integrations/web/public/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
    },
    rules: {
      'no-restricted-syntax': ['error', ...restricted],
    },
  },
  {
    // The repo is CommonJS by default (no "type" in package.json). These are
    // the parts that are not.
    files: ['**/*.mjs', 'test/**/*.js', 'vitest.config.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    // Tests name these literals deliberately — to assert the vocabulary
    // rejects them, and to pin the words that must never come back.
    files: ['test/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
