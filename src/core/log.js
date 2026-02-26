/**
 * Simple timestamped logger. Drop-in replacement for console.log/warn/error.
 *
 * Usage:
 *   const log = require('./log');
 *   log.info('hello');        // 2026-02-26T11:30:00.123Z [INFO] hello
 *   log.warn('uh oh');        // 2026-02-26T11:30:00.123Z [WARN] uh oh
 *   log.error('bad', err);    // 2026-02-26T11:30:00.123Z [ERROR] bad Error: ...
 */

function ts() {
  return new Date().toISOString();
}

const log = {
  info(...args) {
    console.log(`${ts()} [INFO]`, ...args);
  },
  warn(...args) {
    console.warn(`${ts()} [WARN]`, ...args);
  },
  error(...args) {
    console.error(`${ts()} [ERROR]`, ...args);
  },
};

module.exports = log;
