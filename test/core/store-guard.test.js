import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import {
  REPO_ROOT,
  STORES,
  isStorePath,
  guardStoreWrites,
  assertNoStoreWrites,
  trackTaskQueue,
  cancelPendingSaves,
  StoreWriteError,
} from '../helpers/store-guard.js';
import { createMockConfig, createMockWatcher } from '../helpers/mocks.js';

const require = createRequire(import.meta.url);
const NodeRouter = require('../../src/core/node-router');
const store = (name) => path.join(REPO_ROOT, name);

// A stand-in fs: every op records its call; existsSync answers from `present`.
function fakeFs(present = new Set()) {
  const calls = [];
  const op = (name) => vi.fn((...a) => calls.push([name, ...a]));
  const names = [
    'writeFileSync',
    'appendFileSync',
    'copyFileSync',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'renameSync',
  ];
  const asyncNames = ['writeFile', 'appendFile', 'copyFile', 'mkdir', 'rm', 'unlink', 'rename'];
  const fs = { calls, existsSync: (p) => present.has(p), promises: {} };
  for (const n of names) fs[n] = op(n);
  for (const n of asyncNames) {
    fs[n] = op(n);
    fs.promises[n] = vi.fn(async (...a) => calls.push([`promises.${n}`, ...a]));
  }
  return fs;
}

describe('isStorePath', () => {
  it('matches each store, its temp siblings, and anything inside .hive-plans', () => {
    for (const s of STORES) expect(isStorePath(store(s)), s).toBe(true);
    expect(isStorePath(store('.hive-state.json.tmp'))).toBe(true);
    expect(isStorePath(store('.hive-plans/abc/plan.html'))).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isStorePath(path.join(os.tmpdir(), '.hive-state.json'))).toBe(false);
    expect(isStorePath(store('.hive-state.jsonfoo'))).toBe(false);
    // .hive-plans is a directory: only what is inside it is a store write.
    expect(isStorePath(store('.hive-plans.tmp'))).toBe(false);
    expect(isStorePath(store('.hive-plansfoo/plan.html'))).toBe(false);
    expect(isStorePath(store('.hive-setup.json'))).toBe(false);
    expect(isStorePath(store('src/core/taskqueue.js'))).toBe(false);
    expect(isStorePath(undefined)).toBe(false);
    expect(isStorePath(42)).toBe(false);
  });
});

describe('guardStoreWrites', () => {
  it('refuses a real write to a store, records the test, and never reaches fs', () => {
    const fs = fakeFs();
    const violations = [];
    guardStoreWrites(fs, { violations, currentTest: () => 'the culprit' });

    expect(() => fs.writeFileSync(store('.hive-state.json.tmp'), '{}')).toThrow(StoreWriteError);
    expect(fs.calls).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ op: 'writeFileSync', test: 'the culprit' });
    expect(violations[0].stack).toMatch(/store-guard\.test\.js/);
  });

  it('lets writes anywhere else through', () => {
    const fs = fakeFs();
    const violations = [];
    guardStoreWrites(fs, { violations });
    const elsewhere = path.join(os.tmpdir(), 'x.json');

    fs.writeFileSync(elsewhere, '{}');
    fs.mkdirSync(path.join(os.tmpdir(), 'd'));

    expect(fs.calls.map((c) => c[0])).toEqual(['writeFileSync', 'mkdirSync']);
    expect(violations).toEqual([]);
  });

  it('lets through the rename of a .tmp that was never written — it changes nothing', () => {
    // The common case: writeFileSync stubbed, renameSync not. Hundreds per run.
    const fs = fakeFs(new Set());
    const violations = [];
    guardStoreWrites(fs, { violations });

    fs.renameSync(store('.hive-state.json.tmp'), store('.hive-state.json'));

    expect(fs.calls).toHaveLength(1);
    expect(violations).toEqual([]);
  });

  it('refuses the rename when the .tmp really exists — that would replace the store', () => {
    const tmp = path.join(os.tmpdir(), 'state.tmp');
    const fs = fakeFs(new Set([tmp]));
    const violations = [];
    guardStoreWrites(fs, { violations });

    expect(() => fs.renameSync(tmp, store('.hive-state.json'))).toThrow(StoreWriteError);
    expect(violations).toHaveLength(1);
  });

  it('refuses the async forms too: callback and promise', async () => {
    const fs = fakeFs();
    const violations = [];
    guardStoreWrites(fs, { violations });

    const cbErr = await new Promise((r) => fs.writeFile(store('.hive-state.json'), '{}', r));
    expect(cbErr).toBeInstanceOf(StoreWriteError);
    await expect(fs.promises.writeFile(store('.hive-plans/p.html'), 'x')).rejects.toThrow(
      StoreWriteError,
    );
    expect(fs.calls).toEqual([]);
    expect(violations).toHaveLength(2);
  });

  it('uninstalls cleanly', () => {
    const fs = fakeFs();
    const orig = fs.writeFileSync;
    const uninstall = guardStoreWrites(fs, { violations: [] });
    expect(fs.writeFileSync).not.toBe(orig);
    uninstall();
    expect(fs.writeFileSync).toBe(orig);
  });
});

describe('assertNoStoreWrites', () => {
  it('fails naming the test and the stack, then clears', () => {
    const violations = [
      {
        op: 'renameSync',
        target: store('.hive-state.json'),
        test: 'parks a PR',
        stack: 'Error\n  at x',
      },
    ];
    expect(() => assertNoStoreWrites(violations)).toThrow(
      /renameSync \.hive-state\.json during "parks a PR"/,
    );
    expect(violations).toEqual([]);
    expect(() => assertNoStoreWrites(violations)).not.toThrow();
  });
});

describe('pending TaskQueue saves', () => {
  it('cancels a save left pending, so it cannot fire after fs is restored', () => {
    vi.useFakeTimers();
    try {
      class FakeQueue {
        _debounceSave() {
          if (this._saveTimer) return;
          this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.saved = true;
          }, 5000);
        }
      }
      const registry = new Set();
      trackTaskQueue(FakeQueue, registry);
      const q = new FakeQueue();
      q._debounceSave();

      expect(cancelPendingSaves(registry)).toBe(1);
      vi.advanceTimersByTime(10000);
      expect(q.saved).toBeUndefined();
      expect(registry.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The setup file is what makes this live for every suite; prove it is loaded.
describe('store-guard.setup.js is active in this worker', () => {
  it('guards the real fs', () => {
    expect(require('fs').writeFileSync.name).toBe('guarded');
    expect(require('fs').promises.rename.name).toBe('guarded');
  });

  it('tracks both copies of TaskQueue', async () => {
    expect(require('../../src/core/taskqueue').prototype.__saveTracked).toBe(true);
    const esm = await import('../../src/core/taskqueue.js');
    expect((esm.default || esm).prototype.__saveTracked).toBe(true);
  });
});

// End to end against the real TaskQueue: if its save handle is renamed or
// reshaped, cancelPendingSaves silently stops cancelling, and only this fails.
// The two tests run in order — the first leaves a save pending, and the setup
// file's afterEach must cancel it before the second runs.
describe('a real TaskQueue save left pending is cancelled when its test ends', () => {
  let leaked;

  it('leaves a debounced save pending, with fs stubbed', () => {
    const fs = require('fs');
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    try {
      const TaskQueue = require('../../src/core/taskqueue');
      leaked = new TaskQueue(createMockConfig(), createMockWatcher(), new NodeRouter());
      leaked._debounceSave();
      expect(leaked._saveTimer).toBeTruthy();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it('finds it cancelled in the next test', () => {
    expect(leaked).toBeDefined();
    expect(leaked._saveTimer).toBeNull();
  });
});
