import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
// The stores hive persists inside the repo checkout. The suite runs in that same
// checkout — the pre-commit hook runs it wherever you commit, including a
// directory a fleet is running from — so a test that touches one of these is
// changing a real hive's state. Shared with store-guard.setup.js, which refuses
// such a write as it happens and names the test; this is the backstop.
import { REPO_ROOT, STORES } from './store-guard.js';

const require = createRequire(import.meta.url);
const { setupPath } = require('../../src/integrations/web/ws-helpers.js');

function fingerprint(p) {
  if (!fs.existsSync(p)) return 'absent';
  if (fs.statSync(p).isDirectory()) {
    return fs
      .readdirSync(p)
      .sort()
      .map((name) => `${name}=${fingerprint(path.join(p, name))}`)
      .join(',');
  }
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

const snapshot = () =>
  Object.fromEntries(STORES.map((s) => [s, fingerprint(path.join(REPO_ROOT, s))]));

// Own the `.hive-setup.json` sentinel for the whole run.
//
// `sendInitialState` short-circuits with `setup:required` unless this file
// exists, and the console-session boot block is behind the same check, so any
// suite that boots the web server needs it present. Two suites do
// (designation-defs-order, serve-index) and each used to create-if-missing
// and delete-if-created. `grep -rl setupPath test/` is the current list — prefer
// that to this comment, which has already drifted once: it named
// boot-side-effects, a suite from #306 that does not exist on this branch.
// Run in parallel workers that races: the first to finish
// deletes the file while the second is still booting servers against it, and the
// loser sees `setup:required` — which fails as a confusing assertion about
// workflow defs or side effects rather than about setup state.
//
// Creating it once here, before any worker starts, removes the race. Suites keep
// their own create-if-missing guards; those now no-op and never own the delete.
//
// It also fails the run when a test changed one of the STORES. A test that builds
// a TaskQueue without stubbing fs reads the developer's .hive-state.json and saves
// its own tasks back into it, and nothing else in the suite would notice.
export default function setup() {
  let created = false;
  if (!fs.existsSync(setupPath)) {
    fs.writeFileSync(setupPath, '{}');
    created = true;
  }
  const before = snapshot();

  return () => {
    // Only clean up what we made — a real dev environment's setup file must survive.
    if (created) {
      try {
        fs.unlinkSync(setupPath);
      } catch {
        /* already gone */
      }
    }
    const after = snapshot();
    const changed = STORES.filter((s) => before[s] !== after[s]);
    if (changed.length) {
      throw new Error(
        `The test run changed ${changed.join(', ')} in ${REPO_ROOT} — a real hive's ` +
          "stores. A test wrote to one instead of a stub or a temp dir; stub fs for the store's " +
          'path, as the other TaskQueue suites do.',
      );
    }
  };
}
