const { exec: cpExec } = require('child_process');
const { promisify } = require('util');
const { writeFileSync, unlinkSync, existsSync: fsExistsSync } = require('fs');
const execAsync = promisify(cpExec);

/**
 * Execute a command asynchronously and return trimmed stdout, or null on failure.
 */
async function exec(cmd, opts = {}) {
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf8', timeout: 10000, ...opts });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Like exec, but reports *why* a command failed instead of collapsing every
 * failure to null. Used wherever the failure reason changes what we do next —
 * see probeSession, where "session missing" and "server unreachable" look
 * identical to exec but must not be treated the same.
 */
async function execRaw(cmd, opts = {}) {
  try {
    const { stdout, stderr } = await execAsync(cmd, { encoding: 'utf8', timeout: 10000, ...opts });
    return {
      code: 0,
      stdout: (stdout || '').trim(),
      stderr: (stderr || '').trim(),
      timedOut: false,
    };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : null,
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
      // execAsync kills the child on timeout; a hung tmux client means the
      // server accepted the connection but never answered.
      timedOut: Boolean(err.killed),
    };
  }
}

/**
 * List all tmux sessions, returns array of { name, lastActivity, path }.
 */
async function listSessions() {
  // Get session paths via list-sessions
  const sessOut = await exec("tmux list-sessions -F '#{session_name}|#{session_path}' 2>/dev/null");
  const pathMap = new Map();
  if (sessOut) {
    for (const line of sessOut.split('\n').filter(Boolean)) {
      const sep = line.indexOf('|');
      if (sep > 0) pathMap.set(line.slice(0, sep), line.slice(sep + 1));
    }
  }

  // Use list-windows to get window_activity (last output time), which is more
  // accurate than session_activity (last input time)
  const out = await exec(
    "tmux list-windows -a -F '#{session_name}|#{window_activity}' 2>/dev/null",
  );
  if (!out) return [];
  // Sessions with multiple windows: take the most recent window_activity
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, ts] = line.split('|');
    const ms = ts ? parseInt(ts) * 1000 : null;
    const prev = map.get(name);
    if (!prev || (ms && (!prev.lastActivity || ms > prev.lastActivity))) {
      map.set(name, { name, lastActivity: ms, path: pathMap.get(name) || null });
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const na = parseInt(a.name),
      nb = parseInt(b.name);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Capture pane content.
 * @param {string} target - tmux target (e.g. "6-branch:.1")
 * @param {object} opts
 * @param {number} opts.lines - number of scrollback lines (default: visible only)
 */
async function capturePane(target, { lines } = {}) {
  const scrollback = lines ? `-S -${lines}` : '';
  const out = await exec(`tmux capture-pane -t "${target}" -p ${scrollback} 2>/dev/null`);
  return out || '';
}

/**
 * Send keys to a tmux pane.
 * @param {string} target - tmux target
 * @param {string} keys - text to send
 * @param {boolean} enter - whether to press Enter after
 */
async function sendKeys(target, keys, enter = true) {
  // Normalize line endings, preserve newlines (paste-buffer handles them natively)
  const cleaned = keys.replace(/\r\n/g, '\n').trim();
  if (!cleaned && !enter) return;

  const isMultiLine = cleaned && cleaned.includes('\n');

  if (cleaned) {
    // Write to temp file + tmux load-buffer/paste-buffer to avoid all shell
    // escaping issues with quotes, backticks, $, !, etc.
    //
    // -p enables bracketed paste mode (ESC[200~ … ESC[201~). Without it,
    // tmux streams the buffer as raw keystrokes — every embedded \n arrives
    // as an Enter key event, and any TUI doing paste-burst heuristics (Claude
    // Code does) strips those Enters while keeping the text, collapsing a
    // multi-line message into one line. PR #57 ("preserve newlines") relied
    // on paste-buffer "handling newlines natively" — true at the byte level,
    // false in a TUI context unless bracketed paste is on. tmux's -p is a
    // no-op for apps that haven't requested bracketed paste, so it's safe
    // unconditionally.
    const tmpFile = `/tmp/hive-sendkeys-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpFile, cleaned, 'utf8');
      const r = await exec(
        `tmux load-buffer "${tmpFile}" && tmux paste-buffer -t "${target}" -d -p`,
      );
      if (r === null) {
        throw new Error(`tmux paste failed for target=${target}, len=${cleaned.length}`);
      }
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {}
    }
  }
  if (enter) {
    // For multi-line pastes, wait for the TUI to process the pasted content
    // before sending Enter — otherwise Enter can get swallowed
    if (isMultiLine) {
      await new Promise((r) => setTimeout(r, 150));
    }
    await exec(`tmux send-keys -t "${target}" Enter`);
    // Safety: send a second Enter after a delay for multi-line pastes.
    // Claude Code's TUI sometimes swallows the first Enter while still
    // rendering/processing large pasted text.
    if (isMultiLine) {
      await new Promise((r) => setTimeout(r, 300));
      await exec(`tmux send-keys -t "${target}" Enter`);
    }
  }
}

/**
 * Build an exact-match tmux session target.
 *
 * tmux resolves an ambiguous `-t <name>` target by prefix, so a bare `-t 3`
 * matches a session named "30" when no exact "3" exists. The `=` prefix forces
 * exact-name matching. Always use these helpers (never interpolate a bare
 * session name into a `-t` target) — the prefix ambiguity wedged the
 * auto-dispatcher into an endless "create session 3" loop, let killSession("3")
 * kill "30", and leaked keystrokes into the wrong session's pane.
 *
 * @param {string|number} name - session name
 * @returns {string} e.g. "=3"
 */
function sessionTarget(name) {
  return `=${name}`;
}

/**
 * Build an exact-match tmux pane target ("=<session>:.<pane>"). See sessionTarget.
 * @param {string|number} name - session name
 * @param {number} pane - pane index
 * @returns {string} e.g. "=3:.1"
 */
function paneTarget(name, pane) {
  return `=${name}:.${pane}`;
}

/**
 * Outcomes of probeSession. The distinction that matters is ABSENT vs
 * UNREACHABLE: only one of them means it is safe to run `tmux new-session`.
 */
const SESSION_PROBE = {
  EXISTS: 'EXISTS', // server answered, session is there
  ABSENT: 'ABSENT', // server answered, session is not there
  NO_SERVER: 'NO_SERVER', // no socket to connect to
  UNREACHABLE: 'UNREACHABLE', // socket exists but the server did not answer
};

/**
 * Ask tmux about a session, distinguishing "the session isn't there" from
 * "I couldn't reach the server". Both exit 1, and the old hasSession threw the
 * difference away with 2>/dev/null — which is how a stalled server got its
 * socket replaced. See createSession for why that mattered.
 *
 * Verified against tmux 3.6a:
 *   rc=0                                                  → EXISTS
 *   "can't find session: 7"                               → ABSENT
 *   "error connecting to /tmp/... (No such file or dir)"  → NO_SERVER
 *   "...(Connection refused)" / hang                      → UNREACHABLE
 *
 * Anything unrecognised is treated as UNREACHABLE: the failure mode of guessing
 * ABSENT is stranding the whole fleet, so unknown states must not spawn.
 */
function classifyProbe({ code, stderr, timedOut } = {}) {
  if (code === 0) return SESSION_PROBE.EXISTS;
  if (timedOut) return SESSION_PROBE.UNREACHABLE;
  const err = stderr || '';
  if (/can't find session/i.test(err)) return SESSION_PROBE.ABSENT;
  if (/no server running|No such file or directory/i.test(err)) return SESSION_PROBE.NO_SERVER;
  return SESSION_PROBE.UNREACHABLE;
}

async function probeSession(name) {
  return classifyProbe(await execRaw(`tmux has-session -t "${sessionTarget(name)}"`));
}

/**
 * Check if a tmux session exists.
 */
async function hasSession(name) {
  return (await probeSession(name)) === SESSION_PROBE.EXISTS;
}

/**
 * List running tmux *server* processes on the default socket.
 *
 * tmux daemonises its server, so a server is reparented to init (ppid 1) and
 * keeps the argv of whatever first started it (e.g. `tmux new-session -d -s 1`).
 * Clients are children of their invoker and short-lived. Servers on an explicit
 * socket (-L/-S) belong to a different socket path and are ignored.
 *
 * More than one entry here means a socket replacement has already happened and
 * some fleet is stranded.
 */
function parseServerList(psOutput) {
  if (!psOutput) return [];
  const servers = [];
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(tmux\b.*)$/);
    if (!m) continue;
    const [, pid, pgid, ppid, args] = m;
    // tmux daemonises its server with setsid, so the server leads its own
    // process group (pid === pgid) and is reparented to init.
    //
    // ppid === 1 alone is NOT sufficient: a backgrounded tmux *client* whose
    // shell has exited is also reparented to init while keeping its shell's
    // process group. Measured — 160 hung `tmux list-sessions` clients were
    // orphaned to ppid 1 and every one of them had pgid !== pid.
    if (pid !== pgid || ppid !== '1') continue;
    if (/\s-[LS]\s+\S+/.test(args)) continue;
    servers.push({ pid: Number(pid), args });
  }
  return servers;
}

async function listServers() {
  return parseServerList(await exec('ps -A -o pid=,pgid=,ppid=,args='));
}

/**
 * Path of the default tmux socket, mirroring tmux's own resolution:
 * $TMUX_TMPDIR (else /tmp) + /tmux-<uid>/default.
 */
function socketPath() {
  const base = process.env.TMUX_TMPDIR || '/tmp';
  return `${base}/tmux-${typeof process.getuid === 'function' ? process.getuid() : ''}/default`;
}

/**
 * Whether the default tmux socket file is present.
 *
 * This is the discriminator the error text cannot give us. Measured on tmux
 * 3.6a: a server whose listen backlog has filled makes clients report
 * "no server running on <path>" — byte for byte what they report when no server
 * has ever run. Socket present + server process alive therefore means "alive but
 * not accepting", while socket absent + server alive means "stranded".
 */
function socketExists() {
  try {
    return fsExistsSync(socketPath());
  } catch {
    return false;
  }
}

/**
 * Recreate the socket of a server that was stranded when its socket got
 * unlinked. From man tmux: "If the socket is accidentally removed, the SIGUSR1
 * signal may be sent to the tmux server process to recreate it."
 *
 * Only acts when there is exactly one candidate and the socket really is gone.
 * Zero servers means a fresh spawn is correct; more than one means a replacement
 * has already happened and picking the wrong one would strand the other fleet —
 * that needs a human. A socket that still exists means the server is alive and
 * simply not accepting, where SIGUSR1 is not the answer.
 *
 * @returns {Promise<{revived: boolean, servers: object[], socketPresent: boolean}>}
 */
async function reviveStrandedServer() {
  const servers = await listServers();
  const socketPresent = socketExists();
  if (servers.length !== 1 || socketPresent) return { revived: false, servers, socketPresent };
  try {
    process.kill(servers[0].pid, 'SIGUSR1');
  } catch {
    return { revived: false, servers, socketPresent };
  }
  return { revived: true, servers, socketPresent };
}

/**
 * Check if a line is a Claude Code TUI separator (a box-drawing horizontal rule
 * repeated across the pane). The normal input box uses solid ─/━, but permission
 * prompts (edit/tool approvals) render their divider with the dashed variants
 * (╌ U+254C and friends). Missing those made any session parked on an approval
 * prompt look separator-less, so detectState fell through to 'off' — hive
 * reported a live, waiting-for-approval session as dead.
 */
function isSeparator(line) {
  const trimmed = line.trim();
  // ─ ━ (solid), ╌ ╍ (double-dash), ┄ ┅ ┈ ┉ (triple/quadruple-dash) horizontals.
  return trimmed.length >= 10 && /^[─━╌╍┄┅┈┉]+$/.test(trimmed);
}

/**
 * Detect Claude's state from a pane capture.
 *
 * Uses the Claude Code TUI structure: the bottom-most separator line (────)
 * divides content/prompt from the status bar below. We find that separator,
 * then check the lines above it for idle/off patterns.
 *
 * TUI layout when idle (prompt between separators):
 *   [content]
 *   ──────────────    ← 2nd separator (prompt top)
 *   ❯ [input]        ← prompt line (may have typed text)
 *   ──────────────    ← 1st separator from bottom (prompt bottom / status bar top)
 *   Model: ...        ← status bar (ignored)
 *   cwd: ...
 *
 * TUI layout when idle (permission/choice prompt below separator):
 *   [content]
 *   ──────────────    ← separator
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *   2. No
 *   Esc to cancel
 *
 * TUI layout when working:
 *   [tool output]
 *   ──────────────    ← 1st separator from bottom
 *   Model: ...        ← status bar (ignored)
 *
 * @param {string} paneContent - raw pane capture text
 * @param {object} config - hive config with idlePatterns/offPatterns
 * @returns {'idle'|'working'|'off'}
 */
// Interactive prompt patterns safe to check below the separator.
// These only appear in permission/choice prompts, never in the status bar.
// (Note: shift+tab appears in the status bar so is intentionally excluded.)
const INTERACTIVE_PATTERNS = [
  /Do you want to proceed/,
  /Esc to cancel/,
  /Enter to select/,
  /^\s*❯/,
];

// Active Claude status indicators — the ❯ prompt is visible but not usable.
// Active lines use ellipsis (Doodling…, Doing...), completed lines don't (Sautéed for 14m).
const ACTIVE_STATUS_RE = /[⏺✢✳✻☵⚡]\s+\S+(?:…|\.{3})/;

// Incomplete checklist detection: Claude stopped mid-task with failures.
// When a checklist has completed items (✓) AND failed items (✗), Claude
// gave up instead of continuing — the task is not done, so treat as working.
const CHECKLIST_PASS_RE = /^\s*[✓✔]/;
const CHECKLIST_FAIL_RE = /^\s*[✗✘]/;

function hasFailedChecklist(lines) {
  let hasPass = false;
  let hasFail = false;
  for (const line of lines) {
    if (CHECKLIST_PASS_RE.test(line)) hasPass = true;
    if (CHECKLIST_FAIL_RE.test(line)) hasFail = true;
    if (hasPass && hasFail) return true;
  }
  return false;
}

function detectState(paneContent, config) {
  const lines = paneContent.split('\n');
  const state = _classifyState(lines, config);

  // If idle but a visible checklist has failures, Claude stopped mid-task.
  // Report as 'working' so hive doesn't auto-complete the task.
  if (state === 'idle' && hasFailedChecklist(lines)) {
    return 'working';
  }

  return state;
}

function _classifyState(lines, config) {
  // Find the bottom-most separator — everything below it is the status bar.
  let separatorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSeparator(lines[i])) {
      separatorIdx = i;
      break;
    }
  }

  // Check below separator for interactive prompts (permission/choice menus).
  // Newer Claude Code renders these below the separator instead of above it.
  if (separatorIdx >= 0) {
    for (let i = separatorIdx + 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      for (const pat of INTERACTIVE_PATTERNS) {
        if (pat.test(raw)) return 'idle';
      }
    }
  }

  // Determine which lines to check: above the separator, or all lines as fallback
  const checkLines =
    separatorIdx >= 0 ? lines.slice(Math.max(0, separatorIdx - 5), separatorIdx) : lines;

  // Check for active Claude status (Doodling…, Doing…, Churning...) before idle.
  // When Claude is working, the ❯ prompt is visible but not interactive.
  for (const line of checkLines) {
    if (ACTIVE_STATUS_RE.test(line)) return 'working';
  }

  // Scan upward from the bottom of the check region
  let checked = 0;
  for (let i = checkLines.length - 1; i >= 0 && checked < 6; i--) {
    const raw = checkLines[i];
    if (!raw.trim()) continue;
    if (isSeparator(raw)) continue; // skip 2nd separator (above prompt)
    checked++;

    // Check raw line (catches Unicode like ❯)
    for (const pat of config.idlePatterns) {
      if (pat.test(raw)) return 'idle';
    }
    for (const pat of config.offPatterns) {
      if (pat.test(raw)) return 'off';
    }

    // Strip non-printable for ASCII-based checks
    const clean = raw.replace(/[^\x20-\x7E]/g, '').trim();
    if (!clean) continue; // Unicode-only non-separator line

    for (const pat of config.idlePatterns) {
      if (pat.test(clean)) return 'idle';
    }
    for (const pat of config.offPatterns) {
      if (pat.test(clean)) return 'off';
    }

    // Real content that isn't idle/off → working
    if (separatorIdx < 0) return 'off'; // No TUI separator → Claude not running
    return 'working';
  }

  return 'off';
}

/**
 * Get git info for a repo directory.
 * @returns {{ branch, staged, modified, untracked }}
 */
async function gitInfo(repoDir) {
  // Single shell command instead of 4 separate process spawns
  const out = await exec(
    `cd "${repoDir}" 2>/dev/null && echo "$(git branch --show-current 2>/dev/null)" && echo "$(git diff --cached --shortstat 2>/dev/null | sed -E 's/^ *([0-9]+) file.*/\\1/')" && echo "$(git diff --shortstat 2>/dev/null | sed -E 's/^ *([0-9]+) file.*/\\1/')" && echo "$(git ls-files --others --exclude-standard 2>/dev/null | wc -l)"`,
  );
  if (!out) return { branch: '', staged: 0, modified: 0, untracked: 0 };
  const lines = out.split('\n');
  return {
    branch: (lines[0] || '').trim(),
    staged: parseInt(lines[1]) || 0,
    modified: parseInt(lines[2]) || 0,
    untracked: parseInt(lines[3]) || 0,
  };
}

/**
 * Kill a tmux session.
 */
async function killSession(name) {
  return (await exec(`tmux kill-session -t "${sessionTarget(name)}" 2>/dev/null`)) !== null;
}

// Claude Code TUI chrome patterns (status bars, prompt, UI elements)
const TUI_CHROME = [
  /\$[\d.]+/, // cost: $186.73
  /bypass permissions/,
  /shift\+tab/,
  /ctrl-g to edit/,
  /ctrl\+o to expand/,
  /no JIRA ticket/i,
  /^\s*>\s*$/, // bare prompt ">"
  /^\s*copy\s*$/, // TUI "copy" button
  /-- INSERT --/,
  /Cogitated for/, // "Cogitated for 1m 19s"
  /Baked for/, // "Baked for 3m 23s"
  /^\s*\d+\s*tokens/, // token count
  /^\s*CI\s+(no build|PASS|FAIL)/i, // CI status line
  /^\s*approve,?\s*(next|merge)/i, // "approve, next"
  /^Waiting/, // "Waitingpr diff..." tool calls
  /^Explore\(/, // "Explore(..." tool calls
  /^Reading\(/, // "Reading(..." tool calls
];

/**
 * Strip Claude Code TUI chrome from pane content.
 * Removes status bars, prompts, and UI elements from top and bottom.
 * Returns cleaned content string.
 */
function stripTUIChrome(content, config) {
  if (!content) return '';
  const lines = content.split('\n');

  function isChrome(line) {
    const clean = line.replace(/[^\x20-\x7E]/g, '').trim();
    if (!clean) return true;
    // Config patterns
    if (config) {
      for (const pat of config.idlePatterns || []) {
        if (pat.test(clean)) return true;
      }
      for (const pat of config.offPatterns || []) {
        if (pat.test(clean)) return true;
      }
    }
    // Built-in patterns
    for (const pat of TUI_CHROME) {
      if (pat.test(clean)) return true;
    }
    return false;
  }

  // Strip from bottom
  let end = lines.length;
  while (end > 0 && isChrome(lines[end - 1])) end--;

  // Strip from top
  let start = 0;
  while (start < end && isChrome(lines[start])) start++;

  return lines
    .slice(start, end)
    .map((l) => l.replace(/[^\x20-\x7E]/g, '').trimEnd())
    .join('\n')
    .trim();
}

module.exports = {
  exec,
  execRaw,
  listSessions,
  probeSession,
  classifyProbe,
  SESSION_PROBE,
  listServers,
  parseServerList,
  socketPath,
  socketExists,
  reviveStrandedServer,
  capturePane,
  sendKeys,
  sessionTarget,
  paneTarget,
  hasSession,
  detectState,
  ACTIVE_STATUS_RE,
  gitInfo,
  killSession,
  stripTUIChrome,
};
