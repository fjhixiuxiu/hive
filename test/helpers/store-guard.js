// Keep tests away from the checkout's real hive stores.
//
// global-setup.js notices AFTER a run that a store changed, but not which test
// changed it — and the write that did it is usually a TaskQueue save on a 5s
// debounce, firing after the test that scheduled it had already restored fs.
// (Measured 2026-10-09: 170 TaskQueues across 19 files still held a pending
// save at the end of their file, with fs unstubbed.) This module closes that
// from both ends, in every worker:
//
//  - guardStoreWrites(fs): any real write to a store — the file, its .tmp, or
//    anything under .hive-plans/ — is refused and recorded with the test that
//    was running and the stack that did it. assertNoStoreWrites() turns the
//    record into a failure on that test.
//  - trackTaskQueue / cancelPendingSaves: a TaskQueue's pending debounced save
//    is cancelled when the test that scheduled it ends.
//
// Imported by test/helpers/store-guard.setup.js (setupFiles) and by
// global-setup.js, which shares STORES so the two can never disagree.
import path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const STORES = [
  '.hive-state.json',
  '.hive-knowledge.json',
  '.hive-meetings.json',
  '.hive-plans',
];

// Stores that are directories. Their writes land inside them, never in a
// ".tmp" sibling, so only the file stores get the sibling match.
const STORE_DIRS = new Set(['.hive-plans']);

const STORE_PATHS = STORES.map((s) => ({ abs: path.join(REPO_ROOT, s), dir: STORE_DIRS.has(s) }));

/** True for a store file, its sibling temp files (".tmp"), or anything inside a store directory. */
export function isStorePath(p) {
  if (typeof p !== 'string' && !(p instanceof URL)) return false;
  const abs = path.resolve(p instanceof URL ? fileURLToPath(p) : p);
  return STORE_PATHS.some((s) =>
    s.dir
      ? abs === s.abs || abs.startsWith(s.abs + path.sep)
      : abs === s.abs || abs.startsWith(s.abs + '.'),
  );
}

// Ops that create or change a path, by which arguments name a destination.
// renameSync's source is checked separately: renaming a .tmp that was never
// written (write stubbed, rename not) fails with ENOENT on its own and changes
// nothing — hundreds of those happen per run and are not violations.
const SYNC_TARGET_ARGS = {
  writeFileSync: [0],
  appendFileSync: [0],
  copyFileSync: [1],
  mkdirSync: [0],
  rmSync: [0],
  unlinkSync: [0],
  renameSync: [1],
};
const ASYNC_TARGET_ARGS = {
  writeFile: [0],
  appendFile: [0],
  copyFile: [1],
  mkdir: [0],
  rm: [0],
  unlink: [0],
  rename: [1],
};

export class StoreWriteError extends Error {}

/**
 * Wrap `fs` so real writes to a store throw and are recorded in `violations`.
 * `currentTest()` names the running test for the record. Returns an uninstall
 * function. Safe with vi.spyOn: a spy installed later wraps (or replaces) the
 * guard, and restoring the spy restores the guard.
 */
export function guardStoreWrites(fs, { violations, currentTest = () => null }) {
  const originals = [];
  const refuse = (op, target) => {
    const err = new StoreWriteError(
      `${op} on the checkout's real store ${path.relative(REPO_ROOT, String(target))} — ` +
        `stub fs (or point the store at a temp dir) in the test that did this.`,
    );
    violations.push({ op, target: String(target), test: currentTest(), stack: err.stack });
    return err;
  };
  const sourceExists = (fs, src) => {
    try {
      return fs.existsSync(src);
    } catch {
      return false;
    }
  };
  const wrap = (holder, name, argIdx, kind) => {
    const orig = holder[name];
    if (typeof orig !== 'function') return;
    originals.push([holder, name, orig]);
    holder[name] = function guarded(...args) {
      const target = argIdx.map((i) => args[i]).find(isStorePath);
      const isRename = name === 'renameSync' || name === 'rename';
      if (target && !(isRename && !sourceExists(fs, args[0]))) {
        const err = refuse(`${kind}${name}`, target);
        if (kind === 'promises.') return Promise.reject(err);
        const cb = args[args.length - 1];
        if (kind === 'cb.' && typeof cb === 'function') return void process.nextTick(cb, err);
        throw err;
      }
      return orig.apply(this, args);
    };
  };
  for (const [name, idx] of Object.entries(SYNC_TARGET_ARGS)) wrap(fs, name, idx, '');
  for (const [name, idx] of Object.entries(ASYNC_TARGET_ARGS)) {
    wrap(fs, name, idx, 'cb.');
    wrap(fs.promises, name, idx, 'promises.');
  }
  return () => {
    for (const [holder, name, orig] of originals.reverse()) holder[name] = orig;
  };
}

/** Throw once for everything recorded since the last call, then clear it. */
export function assertNoStoreWrites(violations) {
  if (!violations.length) return;
  const lines = violations.map(
    (v) =>
      `  ${v.op} ${path.relative(REPO_ROOT, v.target)} during "${v.test || '(between tests)'}"\n${v.stack}`,
  );
  violations.length = 0;
  throw new StoreWriteError(
    `A test tried to write the checkout's real hive store:\n${lines.join('\n')}`,
  );
}

/**
 * Record every TaskQueue that schedules a debounced save, so the save can be
 * cancelled when the test ends. Patches the prototype once per module instance
 * (tests reach TaskQueue through require and through vitest's import graph,
 * which are separate copies).
 */
export function trackTaskQueue(TaskQueue, registry) {
  const proto = TaskQueue && TaskQueue.prototype;
  if (!proto || typeof proto._debounceSave !== 'function' || proto.__saveTracked) return;
  proto.__saveTracked = true;
  const debounce = proto._debounceSave;
  proto._debounceSave = function (...args) {
    registry.add(this);
    return debounce.apply(this, args);
  };
}

/** Cancel every tracked TaskQueue's pending save. Returns how many were cancelled. */
export function cancelPendingSaves(registry) {
  let cancelled = 0;
  for (const tq of registry) {
    if (tq._saveTimer) {
      clearTimeout(tq._saveTimer);
      tq._saveTimer = null;
      cancelled++;
    }
  }
  registry.clear();
  return cancelled;
}
