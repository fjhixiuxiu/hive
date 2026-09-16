import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setupPath } = require('../../src/integrations/web/ws-helpers.js');

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
export default function setup() {
  let created = false;
  if (!fs.existsSync(setupPath)) {
    fs.writeFileSync(setupPath, '{}');
    created = true;
  }
  // Only clean up what we made — a real dev environment's setup file must survive.
  return () => {
    if (created) {
      try {
        fs.unlinkSync(setupPath);
      } catch {
        /* already gone */
      }
    }
  };
}
