# Vocabulary

How hive keeps one meaning per word, and why it is enforced by a linter rather
than by review.

## The failure this exists to prevent

A word compared against but never produced.

```js
task.status === 'done'; // the queue writes 'completed'
t.status === 'in-progress'; // a Nectar status, never a hive one
state === 'waiting'; // no such session state exists
```

All three shipped. None of them could fail a test, throw, or log. The branch
simply never ran, and it looked complete in the diff.

That is the whole asymmetry: a typo in `TaskStatus.COMPLTED` is a crash on the
line that made it. A typo in `'compltjed'` is silence. One is found in seconds;
the other was found months later, by someone enumerating the vocabulary and
asking whether every use of it agreed.

What each one cost:

| Comparison                      | What it broke                                          |
| ------------------------------- | ------------------------------------------------------ |
| `task.status === 'done'`        | Every agent summary lost to the completion race        |
| `t.status === 'in-progress'`    | Two duplicate-task guards in the PM that never matched |
| `watcher.lastState → 'waiting'` | Standup reported "0 blocked" to every fleet, always    |

The first one **had a test, and the test passed** — the test double wrote
`'done'` too. The mock and the implementation disagreed about a word, and
nothing in the codebase was capable of noticing.

## The rule

Comparing `.status` or `.state` against a bare string literal is a lint error.
Import the constant from `src/core/vocab.js`.

```js
const { TaskStatus, SessionState } = require('./vocab');

if (task.status === TaskStatus.DISPATCHED) { ... }   // yes
if (task.status === 'dispatched') { ... }            // no — lint error

switch (state) {
  case SessionState.IDLE: ...                        // yes
  case 'idle': ...                                   // no — lint error
}
```

`switch` case labels are caught as well as comparisons. They are a different
syntax node — a `SwitchCase`, not a `BinaryExpression` — so a rule written only
against comparisons cannot see them. That gap was real rather than theoretical:
`telegram/commands.js` shipped `switch (state) { case 'idle': … }` in a file the
guard tests already covered.

`src/core/vocab.js` owns:

- `TaskStatus` — the six statuses a task can hold
- `TASK_TRANSITIONS` — which moves are legal, and `transitionTask()`, the only
  assignment to `task.status` in the codebase
- `SessionState` — `idle` / `working` / `off`
- `ApprovalStatus` — `pending` / `approved` / `denied`

See [task-state-machine.md](./task-state-machine.md) for the transitions and the
plan for tightening their enforcement.

## Why a lint rule, not a test

The first version of this guard was a test that scanned a hand-maintained list
of files. It worked, and it was quietly broken by design: the list goes stale
the moment somebody adds a module, and the new file is unguarded with nothing to
say so.

A lint rule has no list. It sees every file, including the ones that do not
exist yet, it reports at the line rather than in a test summary, and it shows up
in the editor before the commit.

`eslint.config.js` turns on **no** general style or correctness rules. hive has
34,000 lines written without a linter and switching on `recommended` would bury
this under thousands of findings nobody asked for. The config is about one
failure mode.

## Words from other vocabularies

Other systems use these words for their own purposes, and those are not hive's
words. The rule is scoped to the property name so most of them never match:
`pr.state === 'closed'`, `audioContext.state === 'running'`, and the GitHub
search filter are all untouched.

Where a genuine collision exists, suppress it at the site with the reason:

```js
// 'completed' here is GitHub's check-run status, not hive's task status.
// Different vocabulary, same word — it must not be folded into TaskStatus.
// eslint-disable-next-line no-restricted-syntax -- GitHub check-run status
if (c.status === 'completed') state = normaliseState(c.conclusion);
```

There is exactly one of these in the tree. ESLint reports unused disable
directives, so a suppression that stops being needed shows up as a warning
rather than lingering.

## Where this is not enforced

`src/integrations/web/public/` is ignored. It is browser code with no module
system — it cannot `require()` `vocab.js`, so it cannot obey the rule. It still
holds around fifty literal comparisons. Sharing the vocabulary with the client
is a client/server contract problem and wants its own change, probably alongside
the WebSocket action surface.

`test/**` is ignored too: tests name these literals deliberately, to assert the
vocabulary rejects them and to pin the words that must never come back.

## The lint rule and the enum are checked against each other

An ESLint selector is a string and cannot import an enum, so
`eslint.config.js` restates the word lists. That is a second statement of the
vocabulary — the exact thing this document is about.

`test/core/vocab.test.js` parses the selectors out of the config and fails if
they and `vocab.js` disagree in either direction. Removing a state from the lint
config fails the suite; adding a status without teaching the linter fails it
too.

## Running it

```bash
npm run lint      # just the vocabulary rules
npm test          # lint runs first, via pretest, then the suite
```

`npm test` runs lint because that is what CI and `.githooks/pre-commit` both
call. A guard that only runs when someone remembers to run it is documentation.

## Adding a vocabulary

When a new set of words appears — a mode, a phase, a kind — the shape is the
same one that found five defects this week:

1. **One canonical definition.** An enum in `vocab.js`, frozen, with the legal
   values and (where there are rules about order) the legal moves between them.
2. **A test asserting every other surface agrees with it.** The lint rule for
   comparisons; a test for whatever a selector cannot express — a registry that
   must match, a document that must not drift, a set of instructions that must
   not name a tool that does not exist.

The second half is the one that matters. An enum on its own is a suggestion.
