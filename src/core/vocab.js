/**
 * The words hive uses for task status and session state, and the rules about
 * them.
 *
 * Task status was 17 bare string literals spread across 11 files — `'queued'`
 * and `'dispatched'` alone account for ~90 comparison sites. Nothing enumerated
 * the legal set and nothing enumerated the legal transitions, so a status that
 * was never written simply never matched an `===` and the branch went quiet.
 *
 * That is not hypothetical. `mcp:complete_task` tested `task.status === 'done'`
 * to reattach an agent's summary after the idle watcher won the completion
 * race. The queue writes `'completed'`; `'done'` is not a status hive has ever
 * had. The branch was dead from the day it was written, and every summary that
 * hit that race was dropped. No test failed, because nothing could.
 *
 * Import the constants rather than typing the strings. A typo in
 * `TaskStatus.COMPLTED` is a crash on the line that made it; a typo in
 * `'compltjed'` is a branch that silently never runs.
 *
 * docs/task-state-machine.md carries the reasoning, who makes each move, and
 * the plan for tightening enforcement. Its transition table is verified against
 * this file by test/core/vocab.test.js.
 */

const log = require('./log');

/**
 * Every status a task can hold.
 *
 * - `queued`     — waiting for a session. The only status auto-dispatch picks up.
 * - `dispatched` — handed to a session and believed to be in progress.
 * - `snoozed`    — deliberately held out of the queue until `snoozedUntil`.
 * - `completed`  — finished. Resumable.
 * - `failed`     — ended in an error. Resumable.
 * - `cancelled`  — abandoned. Terminal; nothing resumes or dispatches it.
 */
const TaskStatus = Object.freeze({
  QUEUED: 'queued',
  DISPATCHED: 'dispatched',
  SNOOZED: 'snoozed',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TASK_STATUSES = Object.freeze(Object.values(TaskStatus));

/**
 * The statuses a task can be created in: queued by the normal path, or
 * dispatched directly when a task is created for a specific session.
 */
const INITIAL_TASK_STATUSES = Object.freeze([TaskStatus.QUEUED, TaskStatus.DISPATCHED]);

/**
 * "Active" — the task still occupies the queue or a session, so a second task
 * for the same work would be a duplicate. Spelled out as
 * `(status === 'queued' || status === 'dispatched')` at call sites across the PM,
 * the GitHub bot and the web handlers; naming it keeps those in step.
 */
const ACTIVE_TASK_STATUSES = Object.freeze([TaskStatus.QUEUED, TaskStatus.DISPATCHED]);

/**
 * Legal status transitions, derived from what TaskQueue actually does rather
 * than from what it arguably should do. Each key is a current status; the array
 * is every status it can move to.
 *
 *   queued     → dispatched  (_dispatchTask)
 *              → snoozed     (snoozeTask)
 *              → cancelled   (cancelTask)
 *              → completed   (PM auto-completion. completeTask refuses a task
 *                             that was never dispatched, so pm.js closes a
 *                             queued one by setting the status itself.)
 *   dispatched → queued      (requeueTask, and snoozeTask via requeue)
 *              → completed   (completeTask, approveComplete)
 *              → failed      (failTask)
 *              → cancelled   (cancelTask)
 *   snoozed    → queued      (unsnoozeTask, _wakeTask)
 *              → cancelled   (cancelTask)
 *   completed  → dispatched  (resumeTask)
 *   failed     → dispatched  (resumeTask)
 *   cancelled  → cancelled   (cancelTask only refuses completed and failed, so
 *                             re-cancelling is a no-op that lands here)
 *
 * Note what is absent: nothing returns from `cancelled` to the queue, and
 * nothing reaches `completed` except from `dispatched`.
 *
 * ⚠️ A self-transition is NOT governed by this table. `transitionTask`
 * short-circuits its check when `prev === next`, so a same-status move never
 * consults the table and never warns — whether or not it is listed here. The
 * `cancelled → cancelled` row above is therefore documentation of a move the
 * code really makes, not the thing that permits it. `queued → queued` (deferring
 * an already-queued task) is the same shape and is deliberately NOT listed,
 * because listing it would imply the table is what allows it.
 */
const TASK_TRANSITIONS = Object.freeze({
  [TaskStatus.QUEUED]: Object.freeze([
    TaskStatus.DISPATCHED,
    TaskStatus.SNOOZED,
    TaskStatus.CANCELLED,
    TaskStatus.COMPLETED,
  ]),
  [TaskStatus.DISPATCHED]: Object.freeze([
    TaskStatus.QUEUED,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
  [TaskStatus.SNOOZED]: Object.freeze([TaskStatus.QUEUED, TaskStatus.CANCELLED]),
  [TaskStatus.COMPLETED]: Object.freeze([TaskStatus.DISPATCHED]),
  [TaskStatus.FAILED]: Object.freeze([TaskStatus.DISPATCHED]),
  [TaskStatus.CANCELLED]: Object.freeze([TaskStatus.CANCELLED]),
});

/**
 * What a tmux session's Claude pane is doing.
 *
 * Produced by tmux.detectState() from a pane capture, cached per session in
 * `config.cache.stateDir`, and consumed by the watcher, the task queue, the
 * relay, the dashboard and the bots.
 *
 * There is no 'waiting' member, though two call sites in the voice integration
 * looked for one. A session waiting on an approval or a question is still
 * `idle` to the detector; the watcher tracks that separately in its
 * `detectedWaiting` set, because it is a fact about the pane's *content*, not
 * about whether Claude is running.
 */
const SessionState = Object.freeze({
  IDLE: 'idle', // Claude is running and sitting at the prompt
  WORKING: 'working', // Claude is mid-turn
  OFF: 'off', // no Claude in the pane
});

const SESSION_STATES = Object.freeze(Object.values(SessionState));

/** Status of a completion awaiting a human, when requireHumanClose is set. */
const ApprovalStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
});

const APPROVAL_STATUSES = Object.freeze(Object.values(ApprovalStatus));

/**
 * Move a task to a new status. The single write path for `task.status`.
 *
 * An unrecognised status throws — that is always a bug, and a loud one beats a
 * comparison that silently never matches. An unrecognised *transition* only
 * warns: TASK_TRANSITIONS was derived from the code rather than designed ahead
 * of it, so a surprise means the table is behind, and taking the fleet down
 * over a bookkeeping disagreement would be worse than the drift it reports.
 *
 * Lives here rather than on TaskQueue because the PM also closes tasks
 * directly: completeTask refuses anything that was never dispatched, so a
 * queued task the PM auto-completes has to be written from outside the queue.
 * Both callers go through this.
 */
function transitionTask(task, next) {
  assertTaskStatus(next, `status for task ${task.id}`);
  const prev = task.status;
  if (prev !== next && !canTransitionTask(prev, next)) {
    log.warn(
      `[vocab] unexpected transition for task ${task.id}: ${prev} → ${next} ` +
        '(not in TASK_TRANSITIONS — the table may be behind the code)',
    );
  }
  task.status = next;
  return task;
}

function isTaskStatus(value) {
  return TASK_STATUSES.includes(value);
}

function isSessionState(value) {
  return SESSION_STATES.includes(value);
}

/**
 * Throw if `value` is not a session state.
 *
 * ⚠️ Nothing calls this today, and the description it used to carry — that it
 * guards states entering hive from outside the process, namely the state cache
 * an external daemon may write (see docs/setup-guide.md) — described an
 * intention rather than the code. `fleet.readState` is that boundary and does
 * not validate; it trims the file and returns it.
 *
 * Wiring this in as-is would be wrong, which is why it is not wired in: it
 * THROWS, and the writer is an optional shell daemon hive does not control, so
 * a daemon writing garbage would take down a poll rather than degrade. The
 * boundary check that belongs there is `isSessionState` plus a fall back to
 * live detection — the same "do not trust the cache" direction #345 took when
 * it stopped hive writing to that file at all. That is a behaviour change and
 * wants its own PR and its own test, not a drive-by in a refactor.
 *
 * Kept because the throwing form is the right shape for a genuine
 * programming-error boundary, and `assertTaskStatus` next to it has callers.
 */
function assertSessionState(value, context = 'session state') {
  if (!isSessionState(value)) {
    throw new Error(
      `Invalid ${context}: ${JSON.stringify(value)}. ` +
        `Expected one of: ${SESSION_STATES.join(', ')}`,
    );
  }
  return value;
}

function isActiveTaskStatus(value) {
  return ACTIVE_TASK_STATUSES.includes(value);
}

/**
 * Throw if `value` is not a task status.
 *
 * Used on writes, where an unrecognised value is always a bug — a typo, a
 * status invented in one place and never taught to the others, or a value
 * arriving from state on disk that this version no longer understands.
 *
 * @param {*} value
 * @param {string} [context] - what was being set, for the error message
 */
function assertTaskStatus(value, context = 'task status') {
  if (!isTaskStatus(value)) {
    throw new Error(
      `Invalid ${context}: ${JSON.stringify(value)}. ` +
        `Expected one of: ${TASK_STATUSES.join(', ')}`,
    );
  }
  return value;
}

/**
 * Whether `from → to` is a transition the queue is known to make.
 *
 * Unknown statuses are not transitions, so this returns false rather than
 * throwing — callers that care about validity should assert separately.
 */
function canTransitionTask(from, to) {
  if (!isTaskStatus(from) || !isTaskStatus(to)) return false;
  return TASK_TRANSITIONS[from].includes(to);
}

module.exports = {
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
};
