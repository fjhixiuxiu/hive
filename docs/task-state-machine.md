# Task state machine

The statuses a task can hold, the moves between them, and how strictly hive
enforces them today. The vocabulary itself lives in `src/core/vocab.js`; this
document is the reasoning around it and the plan for tightening it.

## Why

Task status used to be a bare string literal at ~90 sites across 11 files.
Nothing enumerated the legal values and nothing enumerated the legal
transitions, so a status that was never written simply never matched an `===`
and the branch went quiet. No test could fail, because there was nothing to
compare against.

Two branches were dead in the tree before anyone noticed:

- `mcp:complete_task` tested `task.status === 'done'` when reattaching an
  agent's summary after the idle watcher won the completion race. The queue
  writes `completed`. Every summary that hit that race was dropped.
- The PM tested `t.status === 'in-progress'` on hive tasks. That is a _Nectar_
  task status (`pm-sources.js` sets it on their API when claiming a task), never
  a hive one.

The first bug had a test, and it passed: the test double in
`mcp-nameprefix.test.js` also wrote `'done'`. The mock and the implementation
disagreed on a word and nothing in the codebase could notice.

## The states

| Status       | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `queued`     | Waiting for a session. The only status auto-dispatch picks up. |
| `dispatched` | Handed to a session and believed to be in progress.            |
| `snoozed`    | Deliberately held out of the queue until `snoozedUntil`.       |
| `completed`  | Finished. Resumable.                                           |
| `failed`     | Ended in an error. Resumable.                                  |
| `cancelled`  | Abandoned. Terminal — nothing resumes or dispatches it.        |

A task is created `queued`, or `dispatched` when created for a specific session.

## The transitions

<!-- transitions:start — verified against TASK_TRANSITIONS by test/core/vocab.test.js -->

```
queued     -> dispatched, snoozed, cancelled, completed
dispatched -> queued, completed, failed, cancelled
snoozed    -> queued, cancelled
completed  -> dispatched
failed     -> dispatched
cancelled  -> cancelled
```

<!-- transitions:end -->

That block is not decoration: `vocab.test.js` parses it and fails if it disagrees
with `TASK_TRANSITIONS` in either direction. A table that can drift from the code
is worth less than no table, because people believe it.

Who makes each move:

- `queued → dispatched` — `_dispatchTask`
- `queued → snoozed` — `snoozeTask`
- `queued → cancelled` — `cancelTask`
- `queued → completed` — PM auto-completion. `completeTask` refuses a task that
  was never dispatched, so `pm.js` closes a queued one itself.
- `dispatched → queued` — `requeueTask` (and `snoozeTask`, which requeues first)
- `dispatched → completed` — `completeTask`, `approveComplete`
- `dispatched → failed` — `failTask`
- `dispatched → cancelled` — `cancelTask`
- `snoozed → queued` — `unsnoozeTask`, `_wakeTask`
- `snoozed → cancelled` — `cancelTask`
- `completed → dispatched`, `failed → dispatched` — `resumeTask`
- `cancelled → cancelled` — `cancelTask` only refuses `completed` and `failed`,
  so re-cancelling lands here as a no-op

Note what is absent: nothing returns from `cancelled` to the queue, and nothing
reaches `completed` from anywhere but `queued` or `dispatched`.

## How it is enforced

`vocab.transitionTask(task, next)` is the only assignment to `task.status` in
the codebase.

- **An unrecognised status throws.** That is always a bug, and a crash on the
  line that made it beats a comparison that silently never matches.
- **An unmapped transition warns.** See below.

`vocab.test.js` also scans the adopting server modules — the list is `GUARDED` in
that file, and it is the only place the set is written down — and fails on any
bare status literal, any direct `task.status =`, or any lifecycle write that
skips `transitionTask`. Constants only help while people use them, and this
decays one `=== 'queued'` at a time.

## Why it warns instead of throwing

The table was _derived from_ `taskqueue.js`, not designed ahead of it. It
describes what hive does; it is not yet an authority on what hive may do.

That caution was vindicated immediately. The first draft of the table said
`queued → completed` was illegal — and `pm.js` had been doing it all along,
because `completeTask` refuses anything never dispatched. Had the table been
authoritative on day one, it would have broken PM auto-completion on the
strength of a reading of the code that was an hour old.

So: taking the fleet down over a bookkeeping disagreement would be worse than
the drift it reports. A warning that fires is a signal the table is behind the
code, and the table is what gets fixed.

## Plan for tightening

Three steps. Each promotes only when the previous one has earned it — the
signal matters more than the schedule.

**1. Describe (current).** The table records reality. `transitionTask` warns on a
surprise. Adopted across the server modules; `public/app.js` still uses literals.

**2. Enforce.** Flip the warn to a throw.
_Signal to promote:_ no `[vocab] unexpected transition` warnings in production
logs over a sustained period of normal fleet operation. Until that holds, a
throw is just a crash waiting on a path nobody has walked yet.

**3. Collapse the guards into the table.** Every lifecycle method currently
restates its table row as its own guard — `completeTask` checks
`status !== 'dispatched'` while the table separately says
`dispatched → completed`. Nine methods, nine duplicated rules. They agree today;
nothing keeps them agreeing, and duplication stating one fact twice is what put
`'done'` in the tree. Replace each guard with
`canTransitionTask(task.status, NEXT)`.
_Signal to promote:_ step 2 has shipped and held. The table has to be
trustworthy before it can be the only statement of the rule.

A formal state-machine library (XState and friends) is **not** the goal. Six
states and twelve edges do not justify a dependency, an actor model, or a
rewrite of `TaskQueue`. The value here is one enumerated set, one write path,
and one statement of each rule.

## Not covered

- **`src/integrations/web/public/app.js`** has ~50 literal status comparisons and
  cannot `require()` anything — it is browser code with no module system.
  Sharing this vocabulary with the client is a client/server contract problem
  and belongs with the WebSocket action surface.
- **`src/core/pr-status.js`** keeps `check.status === 'completed'`. That is a
  GitHub check-run status — a different vocabulary that happens to share a word.
  A test pins that reasoning so nobody later folds it into hive's enum.
- **Approval status** (`pending` / `approved` / `denied`) is enumerated in
  `vocab.js` as `ApprovalStatus` but has no transition table; it is a three-state
  field with no interesting moves.
