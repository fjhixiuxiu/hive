// setupFiles: runs in every test worker before each test file. See
// store-guard.js for why.
import { afterEach, expect } from 'vitest';
import { createRequire } from 'module';
import {
  guardStoreWrites,
  assertNoStoreWrites,
  trackTaskQueue,
  cancelPendingSaves,
} from './store-guard.js';

const require = createRequire(import.meta.url);
const violations = [];
const pendingSaves = new Set();

guardStoreWrites(require('fs'), {
  violations,
  currentTest: () => {
    try {
      return expect.getState().currentTestName || null;
    } catch {
      return null;
    }
  },
});

trackTaskQueue(require('../../src/core/taskqueue'), pendingSaves);
const esm = await import('../../src/core/taskqueue.js');
trackTaskQueue(esm.default || esm, pendingSaves);

afterEach(() => {
  cancelPendingSaves(pendingSaves);
  assertNoStoreWrites(violations);
});
