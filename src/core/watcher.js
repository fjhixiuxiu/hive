const EventEmitter = require('events');
const fleet = require('./fleet');
const tmux = require('./tmux');
const log = require('./log');
const { SessionState } = require('./vocab');

// Lines that look like Claude presenting choices to the user
const OPTION_PATTERN = /^[-\u2013\u2022]\s+.{5,}/;
const NUMBERED_OPTION_PATTERN = /^\d+[.)]\s+.{5,}/;

/**
 * Watches fleet sessions for state changes and emits events.
 *
 * Events:
 *   'session:idle'          - { session, name, num }  -- Claude finished working
 *   'session:working'       - { session, name, num }  -- Claude started working
 *   'ci:changed'            - { session, name, num, from, to, pr }  -- CI result changed
 *   'review:changed'        - { session, name, num, from, to, pr }  -- PR review changed
 *   'approval:requested'    - { session, name, num, prompt }  -- Claude needs permission
 */

// Patterns that UNAMBIGUOUSLY indicate a retryable API error — specific enough that
// they don't show up in ordinary prose, so they match anywhere in the pane.
const API_ERROR_PATTERNS = [
  // HTTP status codes (Anthropic API)
  /API Error:?\s*\(?\s*(408|429|500|502|503|504|529)\b/,
  /usage limit reached/i, // quota message ("Usage limit reached. Resets at …") — no "API Error" prefix
  /Internal server error/i,
  /timeout_error/i,
  // Timeout / streaming
  /Request timed out/i,
  /Stream (idle )?timeout/i,
  /partial response received/i,
  // Network / connection
  /Connection error/i,
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN)\b/,
  /socket hang up/i,
  /fetch failed/i,
  /Unable to connect to (the )?API/i,
  /Check your (internet )?connection/i,
  // TLS handshake / record errors — transient. The Python ssl bracketed
  // message is the canonical shape (e.g. "API Error: [SSL: SSLV3_ALERT_BAD_RECORD_MAC]
  // ssl/tls alert bad record mac (_ssl.c:2548)"). The `SSL: <UPPER_SNAKE>` form
  // doesn't appear in ordinary prose, so it's safe to match anywhere.
  /\bSSL: [A-Z][A-Z0-9_]+/,
  /\bssl\/tls alert\b/i,
  /\bTLS\/SSL connection (has been )?closed\b/i,
  // Catch-all for any Python ssl module error. The "(_ssl.c:NNNN)" suffix is
  // appended by CPython's ssl.c on every TLS error and doesn't appear in
  // ordinary prose. This subsumes the more specific patterns above but we
  // keep them anyway as documentation of what we've actually seen.
  /\(_ssl\.c:\d+\)/,
  // Anthropic's structured JSON error envelope — fires even when the error
  // body is otherwise empty (e.g. message=""), which is what S:20 hit:
  //   API Error: {"type":"error","error":{"type":"api_error","message":""}}
  // The exact substring `"type":"api_error"` won't appear in ordinary prose.
  /"type"\s*:\s*"api_error"/,
  // Claude Code's auto-mode safety classifier (claude-opus-4-7) errored out.
  // Fixture from S:12:
  //   Error: claude-opus-4-7 is temporarily unavailable, so auto mode cannot
  //   determine the safety of Bash right now. Wait briefly and then try this
  //   action again.
  // The exact phrase "auto mode cannot determine the safety" is unique to this
  // specific Claude-Code error path and not something that shows up in prose.
  /auto mode cannot determine the safety/i,
];

// These phrases ALSO occur in normal prose — notably when Claude *explains* that it
// hit a rate limit ("the stale rate-limit-era queue draining"). Matching them bare
// made the watcher read Claude's own recovery message as a live error and spam
// "retry" in a feedback loop. So they only count when on an actual "API Error" line.
const API_ERROR_LINE_RE = /API Error/i;
const API_ERROR_PHRASES = [
  /overloaded/i,
  /rate.?limit/i,
  /capacity/i,
  /temporarily limiting requests/i,
  // Claude Code's other wording for the same streaming abort already covered by
  // /partial response received/ — the server closed the stream mid-response.
  // Real fixture from S:24:
  //   API Error: The response stopped arriving. The response above may be incomplete.
  // It carries no status code, so before this it fell through as non-retryable and
  // the session sat idle.
  //
  // Gated rather than unambiguous, deliberately. This is the most prose-shaped
  // phrase in either list — unlike `SSL: <UPPER_SNAKE>`, `(_ssl.c:NNNN)` or
  // `"type":"api_error"`, it is an ordinary English sentence Claude could write
  // while narrating an error it already recovered from. That matters most in
  // THIS repo, where the phrase sits in a source comment and a test fixture, so
  // a session working on the watcher can put it in its own pane.
  //
  // The real error always carries "API Error" on the same line, so requiring it
  // costs nothing and removes the narration risk. RETRY_SUBMITTED_RE bounds
  // duplicates per occurrence but does NOT bound a loop: a retry that provokes a
  // fresh narration below the `> retry` line re-arms the check.
  /response stopped arriving/i,
];

function lineHasRetryableError(line) {
  if (API_ERROR_PATTERNS.some((p) => p.test(line))) return true;
  if (API_ERROR_LINE_RE.test(line)) return API_ERROR_PHRASES.some((p) => p.test(line));
  return false;
}

// Claude Code's tasks-block panel — when visible it eats ~9 lines (header + up
// to 5 task rows + summary + blank lines) on top of the ~5-line input/status
// footer, pushing any "API Error" line ~15-20 lines from the bottom of the
// visible pane. The narrow scan window below (NARROW_SLICE_LINES) is sized for
// the common no-panel case; when the panel is detected we widen the scan
// (WIDE_SLICE_LINES) to include the error above it.
//
// The panel has TWO rendering modes we need to detect:
//   (A) Idle / Sautéed mode — opens with an "N tasks (X done, Y in progress,
//       Z open)" header, followed by bare ◼/◻ task rows.
//   (B) Working mode with sub-tasks — opens with a spinner line ("· Running …"),
//       then a `⎿` continuation marker and indented ✔/◼/◻ rows.
// Both modes close with a "+N pending, N completed" summary line, which is the
// most reliable common signal (that exact "+digits pending, digits completed"
// shape doesn't appear in ordinary prose). Detecting EITHER the header OR the
// summary covers both modes.
const TASKS_PANEL_HEADER_RE = /^\s*\d+\s+tasks?\s*\(\d+\s+done\b/i;
const TASKS_PANEL_SUMMARY_RE = /\+\d+\s+pending,\s+\d+\s+completed\b/i;
const NARROW_SLICE_LINES = 15;
const WIDE_SLICE_LINES = 30;

// A `retry` user-prompt line already sitting in the pane. Claude Code renders
// submitted user messages with a `>` or `❯` prefix, so a line like `❯ retry`
// (or `> retry`) below the most recent API Error means a retry was already
// submitted — by us on a prior poll, or by the user manually. Don't send
// another one or we generate a stray-retry loop after Claude has recovered
// (the original error text can still linger in the slice window while Claude's
// substantive response is being typed). Real fixture from S:7:
//   API Error: [SSL: SSLV3_ALERT_BAD_RECORD_MAC] ...
//   ✻ Cooked for 1m 15s
//   ❯ retry           <- already sent
//   ⏺ Good news: ...  <- Claude's response (still streaming or just finished)
const RETRY_SUBMITTED_RE = /^\s*[>❯]\s+retry\s*$/i;

// Persistent auto-retry for transient API errors (rate limits, 5xx, overload).
// No attempt cap — keep retrying until the error clears or the session resumes
// real work. The wait between attempts grows exponentially (15s, 30s, 1m, 2m, 4m)
// and is capped at 5m so a long server throttle (e.g. HTTP 529 "temporarily
// limiting requests") doesn't hammer the API.
const ERROR_RETRY_BASE = 15000; // 15s before the first retry
const ERROR_RETRY_MAX_DELAY = 300000; // cap exponential backoff at 5 min

// Patterns to extract a reset time from rate limit messages
// Matches: "Resets at 2:00 PM", "resets at 14:00", "Resets at 2:00 PM EDT"
const RESET_TIME_PATTERNS = [
  /[Rr]esets?\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s+[A-Z]{2,4})?)/,
  /[Tt]ry\s+again\s+(?:in|after)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i,
];

/**
 * Parse a reset time string into a future timestamp.
 * Returns epoch ms if parseable and in the future, or 0 if not.
 */
function parseResetTime(lines) {
  for (const line of lines) {
    for (const pat of RESET_TIME_PATTERNS) {
      const m = line.match(pat);
      if (!m) continue;

      // "Resets at 2:00 PM" — absolute time today
      if (pat === RESET_TIME_PATTERNS[0]) {
        const timeStr = m[1].trim();
        // Parse "2:00 PM" or "14:00" style
        const today = new Date();
        const parts = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
        if (!parts) continue;
        let hours = parseInt(parts[1]);
        const mins = parseInt(parts[2]);
        const ampm = parts[3];
        if (ampm) {
          if (ampm.toUpperCase() === 'PM' && hours !== 12) hours += 12;
          if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
        }
        const target = new Date(today);
        target.setHours(hours, mins, 0, 0);
        // If time already passed today, it might mean tomorrow — but more likely
        // it's a stale message. Return 0 to use normal retry delay.
        if (target.getTime() > Date.now()) return target.getTime();
      }

      // "try again in 30 minutes" — relative duration
      if (pat === RESET_TIME_PATTERNS[1]) {
        const amount = parseInt(m[1]);
        const unit = m[2].toLowerCase();
        let ms = 0;
        if (unit.startsWith('sec')) ms = amount * 1000;
        else if (unit.startsWith('min')) ms = amount * 60 * 1000;
        else if (unit.startsWith('hour') || unit.startsWith('hr')) ms = amount * 60 * 60 * 1000;
        if (ms > 0) return Date.now() + ms;
      }
    }
  }
  return 0;
}

// Patterns that indicate Claude is asking for permission
const APPROVAL_PATTERNS = [
  /Do you want to proceed/i,
  /Allow this action/i,
  /\(y\/n\)/i,
  /Press y to confirm/i,
  /\[Y\/n\]/i,
  /approve,?\s*deny/i,
];

// Patterns that indicate Claude is asking the user a question
const QUESTION_PATTERNS = [
  /^\s*❯\s+/, // selection cursor (AskUserQuestion UI)
  /^\s*>\s+\S/, // alternate selection cursor
  /^\s*\?\s+.{5,}/, // ? prefix on question line
  /Other$/, // "Other" option always present in AskUserQuestion
];

// Lines that look like questions but are actually Claude UI tips/chrome
const QUESTION_IGNORE = [/\?\s+for shortcuts/, /\?\s+for help/, /Try "/];

class Watcher extends EventEmitter {
  constructor(config, router) {
    super();
    this.config = config;
    this.router = router;
    this.interval = null;
    this.approvalInterval = null;
    this.prevStates = new Map(); // num -> 'idle'|'working'|'off'
    this.notifiedIdle = new Set(); // nums we've already emitted idle for
    this.pendingIdle = new Map(); // num -> count of consecutive idle polls (confirm at 5)
    this.seenWorking = new Set(); // nums that have been observed working at least once
    this._pendingWorking = new Map(); // num -> count of consecutive working polls
    this.prevCI = new Map(); // num -> CI result string
    this.prevReview = new Map(); // num -> review status string
    this.prevBranch = new Map(); // num -> branch name
    this.detectedWaiting = new Set(); // session nums waiting for user (approvals or questions)
    this.sessionActivity = new Map(); // num -> timestamp of last meaningful activity
    this.errorRetries = new Map(); // num -> { count, lastRetryAt }
    // Auto-retry of transient API errors types "retry" into the session on its own.
    // It's on by default; set watcher.errorRetry.enabled = false to opt out entirely.
    this.errorRetryEnabled = config.watcher?.errorRetry?.enabled !== false;
    this._prevFleetNums = null; // last poll's set of fleet session nums (drop/add diagnostics)
    this.serverCheckInterval = null;
    this._lastServerAlert = null; // pid fingerprint of the last split-brain we alerted on
    // Watch for a second tmux server appearing on the default socket. On by
    // default; set watcher.serverCheck.enabled = false to opt out.
    this.serverCheckEnabled = config.watcher?.serverCheck?.enabled !== false;
    this.serverCheckMs = config.watcher?.serverCheck?.interval || 60000;
  }

  /**
   * Pre-populate seenWorking for sessions with dispatched tasks.
   * After restart, sessions won't be actively working (Claude doesn't auto-resume),
   * so we just seed seenWorking. notifiedIdle is still set for all idle sessions
   * in _seed(), meaning tasks won't complete until the session actually works again.
   */
  seedWorkingFromTasks(sessionNums) {
    for (const num of sessionNums) {
      this.seenWorking.add(num);
    }
    if (sessionNums.length) {
      log.info(`[watcher] seeded seenWorking from dispatched tasks: [${sessionNums.join(', ')}]`);
    }
  }

  async start() {
    if (this.interval) return;

    // Seed initial states (no notifications on startup)
    await this._seed();

    this.interval = setInterval(() => {
      this._poll().catch((err) => log.error('Watcher poll error:', err.message));
    }, this.config.watcher.interval);
    // Approval detection: poll working sessions every 10s
    this.approvalInterval = setInterval(() => {
      this._checkApprovals().catch((err) => log.error('Approval check error:', err.message));
    }, 10000);
    if (this.serverCheckEnabled) {
      this.serverCheckInterval = setInterval(() => {
        this._checkTmuxServers().catch((err) => log.error('tmux server check error:', err.message));
      }, this.serverCheckMs);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.approvalInterval) {
      clearInterval(this.approvalInterval);
      this.approvalInterval = null;
    }
    if (this.serverCheckInterval) {
      clearInterval(this.serverCheckInterval);
      this.serverCheckInterval = null;
    }
  }

  /**
   * Detect a tmux socket replacement: two servers running on the same socket.
   *
   * When a client cannot reach the tmux server it assumes the server died,
   * unlinks the socket and starts a replacement. The original server keeps
   * running with every session intact but with no socket to accept on, and hive
   * starts rebuilding a duplicate fleet on the new server. Nothing else in hive
   * notices — `tmux ls` looks plausible because the impostor sessions reuse the
   * same numeric names.
   *
   * createSession refuses to be the client that does this, but any tmux client
   * from any repo clone (a manual-QA run, tmuxinator, start-hive.sh, a plain
   * shell) can still trigger it, so the condition is worth watching for
   * regardless of who caused it.
   *
   * Recovery is `tmux kill-server` on the impostor followed by SIGUSR1 to the
   * original, which recreates its socket with no session loss.
   */
  async _checkTmuxServers() {
    const servers = await tmux.listServers();
    if (servers.length <= 1) {
      this._lastServerAlert = null;
      return;
    }
    // Alert once per distinct set of servers, not every tick.
    const fingerprint = servers
      .map((s) => s.pid)
      .sort((a, b) => a - b)
      .join(',');
    if (fingerprint === this._lastServerAlert) return;
    this._lastServerAlert = fingerprint;

    log.error(
      `[watcher] ${servers.length} tmux servers are running on the default socket (pids ${fingerprint}) — ` +
        `the socket was replaced and one fleet is stranded. Recover with: tmux kill-server (kills the impostor), ` +
        `then kill -USR1 <original-pid> to recreate its socket.`,
    );
    this.emit('tmux:split-brain', { servers, count: servers.length, fingerprint });
  }

  async _seed() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    for (const s of sessions) {
      this.prevStates.set(s.num, s.state);
      // Mark all idle sessions as notified — no idle notifications on startup.
      // After restart, Claude doesn't auto-resume work, so sessions with
      // dispatched tasks are just sitting idle. They need a real working→idle
      // cycle before completion fires.
      if (s.state === SessionState.IDLE) this.notifiedIdle.add(s.num);
      if (s.pr) this.prevCI.set(s.num, s.pr.ciResult);
      if (s.branch) this.prevBranch.set(s.num, s.branch);
    }
    // Seed git info for all sessions (runs once, in background)
    for (const s of sessions) {
      const node = this.router.nodeFor(s.name);
      if (node && fleet.refreshGitInfo)
        fleet.refreshGitInfo(this.config, node, s.name, s.nodeId).catch(() => {});
    }

    // One-time scan: retry any session stalled on an API error from before restart.
    // Not gated on state — _checkAndRetryErrors decides via the error text + spinner.
    for (const s of sessions) {
      const retried = await this._checkAndRetryErrors(s);
      if (retried) {
        this.notifiedIdle.delete(s.num);
        this.seenWorking.add(s.num);
        log.info(`[watcher] session ${s.num}: startup retry — removed from notifiedIdle`);
      }
    }
  }

  async _poll() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);

    // Diagnostic: log when the fleet snapshot gains/loses sessions. A session that
    // drops out (e.g. under load / slow tmux capture) silently stops being polled —
    // and so stops being eligible for error-retry — without any other trace.
    const fleetNums = new Set(sessions.map((s) => s.num));
    if (this._prevFleetNums) {
      const dropped = [...this._prevFleetNums].filter((n) => !fleetNums.has(n));
      const added = [...fleetNums].filter((n) => !this._prevFleetNums.has(n));
      if (dropped.length || added.length) {
        log.info(
          `[watcher] fleet membership changed (${fleetNums.size} sessions)` +
            `${dropped.length ? ` — dropped: ${dropped.join(',')}` : ''}` +
            `${added.length ? ` — added: ${added.join(',')}` : ''}`,
        );
      }
    }
    this._prevFleetNums = fleetNums;

    for (const s of sessions) {
      const prevState = this.prevStates.get(s.num);
      const currState = s.state;

      // Log state transitions for debugging false idle notifications
      if (prevState && prevState !== currState) {
        log.info(`[watcher] session ${s.num}: ${prevState} → ${currState}`);
      }

      // Track sessions that have been observed working at least once.
      // Require 2 consecutive working polls to avoid false positives from
      // momentary state detection glitches.
      if (currState === SessionState.WORKING) {
        const wc = (this._pendingWorking.get(s.num) || 0) + 1;
        if (wc >= 2) {
          this.seenWorking.add(s.num);
          this._pendingWorking.delete(s.num);
          // Genuine work resumed (2 consecutive polls, not a brief retry flicker)
          // → the error cleared, so drop the retry budget and let backoff reset.
          this.errorRetries.delete(s.num);
        } else {
          this._pendingWorking.set(s.num, wc);
        }
      } else {
        this._pendingWorking.delete(s.num);
      }

      // State-independent API-error recovery. We deliberately do NOT gate this on the
      // idle/working verdict — that verdict rests on a 3-line capture we don't fully
      // trust. _checkAndRetryErrors keys off the error text plus the absence of an
      // active spinner in a 15-line capture, so a session stalled on an API error gets
      // nudged even if detectState misreads it as 'working'. The seenWorking /
      // detectedWaiting gates now live INSIDE it (so a skipped-but-erroring session is
      // logged, not silently dropped).
      {
        const retried = await this._checkAndRetryErrors(s);
        if (retried) {
          this.notifiedIdle.delete(s.num);
          this.pendingIdle.delete(s.num);
          this.prevStates.set(s.num, currState);
          continue; // stalled on (or recovering from) an API error — skip normal handling
        }
      }

      // Detect idle with confirmation: require FIVE consecutive idle polls
      // to avoid false positives from brief idle flickers between tool calls.
      // Also skip if session is waiting for user answer (approval or question).
      // Only notify for sessions that have been seen working at least once.
      if (
        currState === SessionState.IDLE &&
        !this.notifiedIdle.has(s.num) &&
        this.seenWorking.has(s.num)
      ) {
        if (this.detectedWaiting.has(s.num)) {
          // Session is waiting for user answer — do NOT count toward idle
          this.pendingIdle.delete(s.num);
        } else {
          const count = (this.pendingIdle.get(s.num) || 0) + 1;
          if (count >= 5) {
            // API-error stalls are handled by the state-independent check above, so
            // reaching here means the session is genuinely idle (no error, no spinner).
            // Fifth consecutive poll showing idle — confirmed idle
            log.info(`[watcher] session ${s.num}: idle confirmed (5 polls)`);
            this.pendingIdle.delete(s.num);
            this.notifiedIdle.add(s.num);
            // Capture terminal preview so the feed entry can show context
            let preview = '';
            let ansiSnapshot = '';
            let paneCols = 0;
            try {
              const node = this.router.nodeFor(s.name);
              if (node) {
                // Refresh git info now that session finished work
                if (fleet.refreshGitInfo)
                  fleet.refreshGitInfo(this.config, node, s.name, s.nodeId).catch(() => {});
                preview = await fleet.peekSession(this.config, node, s.name);
                // Also capture ANSI version + pane width for task snapshot display
                const paneTarget = tmux.paneTarget(s.name, this.config.sessions.claudePane);
                ansiSnapshot =
                  (await node.exec(
                    `tmux capture-pane -e -p -S -500 -t "${paneTarget}" 2>/dev/null`,
                  )) || '';
                const colsStr = await node.exec(
                  `tmux display-message -p -t "${paneTarget}" "#{pane_width}" 2>/dev/null`,
                );
                paneCols = parseInt(colsStr) || 0;
              }
            } catch {}
            this.sessionActivity.set(s.num, Date.now());
            this.emit('session:idle', {
              session: s,
              name: s.name,
              num: s.num,
              preview,
              ansiSnapshot,
              paneCols,
            });
          } else {
            this.pendingIdle.set(s.num, count);
          }
        }
      }

      // Clear pending/notified flags when session leaves idle
      if (currState !== SessionState.IDLE) {
        this.notifiedIdle.delete(s.num);
        this.pendingIdle.delete(s.num);
      }

      // State transition: idle/off -> working
      if (prevState !== SessionState.WORKING && currState === SessionState.WORKING) {
        this.sessionActivity.set(s.num, Date.now());
        this.emit('session:working', { session: s, name: s.name, num: s.num });
      }

      this.prevStates.set(s.num, currState);

      // CI change
      if (s.pr) {
        const prevCI = this.prevCI.get(s.num);
        const currCI = s.pr.ciResult;
        if (prevCI && currCI && prevCI !== currCI) {
          this.emit('ci:changed', {
            session: s,
            name: s.name,
            num: s.num,
            from: prevCI,
            to: currCI,
            pr: s.pr.prNum,
          });
        }
        this.prevCI.set(s.num, currCI);

        // Review change
        const prevReview = this.prevReview.get(s.num);
        const currReview = s.pr.review;
        if (prevReview && currReview && prevReview !== currReview) {
          this.emit('review:changed', {
            session: s,
            name: s.name,
            num: s.num,
            from: prevReview,
            to: currReview,
            pr: s.pr.prNum,
          });
        }
        this.prevReview.set(s.num, currReview);
      }

      // Branch change detection
      const prevBranch = this.prevBranch.get(s.num);
      const currBranch = s.branch;
      if (currBranch && prevBranch && prevBranch !== currBranch) {
        this.emit('branch:changed', {
          session: s,
          name: s.name,
          num: s.num,
          from: prevBranch,
          to: currBranch,
          pr: s.pr || null,
        });
      }
      if (currBranch) this.prevBranch.set(s.num, currBranch);

      // Clear waiting flag when session starts working. (The error-retry budget is
      // cleared only on *confirmed* working above, so a brief retry-induced flicker
      // doesn't reset the exponential backoff.)
      if (currState === SessionState.WORKING && prevState !== SessionState.WORKING) {
        this.detectedWaiting.delete(s.num);
      }
    }

    // Clean up stale entries for sessions that no longer exist
    const currentNums = new Set(sessions.map((s) => s.num));
    for (const num of this.sessionActivity.keys()) {
      if (!currentNums.has(num)) this.sessionActivity.delete(num);
    }

    // Emit poll event with all session states for task completion checks
    this.emit('poll', sessions);
  }

  /**
   * Check if a session went idle due to an API error and auto-retry.
   * Returns true if a retry was sent (caller should skip idle confirmation).
   */
  async _checkAndRetryErrors(s) {
    if (!this.errorRetryEnabled) return false;

    const node = this.router.nodeFor(s.name);
    if (!node) return false;

    const retry = this.errorRetries.get(s.num) || { count: 0, lastRetryAt: 0, retryAfter: 0 };

    // Capture the pane and look for a retryable error FIRST, so the gates below only
    // act (or log a hold-off reason) for sessions that actually show one.
    //
    // NOTE on the post-capture slice: tmux's `-S -15` ("start 15 lines BEFORE
    // the visible top") plus a default-height pane (~54 lines) returns ~69
    // total lines. Without slicing we matched OLD API errors still resident in
    // scrollback long after they'd scrolled out of view, firing endless
    // false-positive retries (S:26 hit this loud and clear: an SSL error from
    // earlier in the conversation kept resurfacing every poll until the user
    // manually nuked the spurious "retry" prompts).
    //
    // Slice WIDTH is conditional: the default 15-line window keeps the
    // false-positive guard tight, but Claude Code's tasks-block panel pushes
    // the API Error line up by ~9 lines, putting it outside a 15-line slice
    // even though it's plainly on screen (Session 5 sat in "Sautéed for 12m
    // 41s" with no retry because of this). When we detect the panel inside
    // the narrow window, we widen to 30 just for that poll. S:26's old SSL
    // error sat ~40+ lines deep, outside both windows.
    const paneTarget = tmux.paneTarget(s.name, this.config.sessions.claudePane);
    const content = await node.capturePane(paneTarget, { lines: 15 });
    if (!content) return false;

    const allLines = content.split('\n');
    const narrow = allLines.slice(-NARROW_SLICE_LINES);
    const tasksPanelVisible = narrow.some(
      (l) => TASKS_PANEL_HEADER_RE.test(l) || TASKS_PANEL_SUMMARY_RE.test(l),
    );
    const lines = tasksPanelVisible ? allLines.slice(-WIDE_SLICE_LINES) : narrow;

    // Track the LATEST index of each marker so we can answer "was a retry
    // submitted AFTER the most recent error?" — the stray-retry guard below.
    let lastErrorIdx = -1;
    let lastRetrySubmittedIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lineHasRetryableError(lines[i])) lastErrorIdx = i;
      if (RETRY_SUBMITTED_RE.test(lines[i])) lastRetrySubmittedIdx = i;
    }
    const hasError = lastErrorIdx >= 0;

    // Error gone — the session recovered (a retry took, or it cleared on its own).
    // Drop the budget so a future error starts a fresh backoff, then let normal
    // idle handling resume.
    if (!hasError) {
      if (this.errorRetries.has(s.num)) {
        log.info(
          `[watcher] session ${s.num}: API error cleared after ${retry.count} retr${retry.count === 1 ? 'y' : 'ies'}`,
        );
        this.errorRetries.delete(s.num);
      }
      return false;
    }

    // A `retry` line is already in the pane below the most recent error — a
    // retry was already submitted (by us on a prior poll, or by the user).
    // Don't send another, even if our backoff window has elapsed. Claude is
    // either still streaming the response or just finished; the original error
    // text lingering in the slice would otherwise trigger a stray duplicate.
    // Stay in recovery (return true) so normal idle handling doesn't fire either.
    if (lastRetrySubmittedIdx > lastErrorIdx) {
      log.info(
        `[watcher] session ${s.num}: retry already submitted in pane after API error — skipping (no duplicate)`,
      );
      return true;
    }

    // ── A retryable error IS present. Decide whether to nudge; log any hold-off
    //    reason so a genuinely-stuck session is never silently skipped. ──

    // A retryable error in the pane is itself proof claude ran and made an API
    // call — it can't produce that output otherwise. So promote seenWorking
    // unconditionally when we see one. The original gate (intended to skip
    // sessions where the pane is just stale text and claude isn't running) was
    // deadlocking: a session whose first observed event was an API error stayed
    // permanently un-retried because no working→idle transition could ever fire
    // (the retry that would cause one was the very thing the gate blocked).
    if (!this.seenWorking.has(s.num)) {
      log.info(
        `[watcher] session ${s.num}: promoting seenWorking on retryable error (was never marked working)`,
      );
      this.seenWorking.add(s.num);
    }
    // A retryable API error means Claude stalled on an API *call*, not on a user prompt —
    // so a lingering detectedWaiting flag (e.g. from an already-answered AskUserQuestion)
    // is stale. Clear it and fall through to retry, rather than deadlocking: the flag
    // otherwise only clears on a working transition the stuck session can never reach
    // (the retry that would get it there is the very thing the flag is blocking).
    if (this.detectedWaiting.has(s.num)) {
      log.info(
        `[watcher] session ${s.num}: clearing stale detectedWaiting — retryable error present (Claude not awaiting user)`,
      );
      this.detectedWaiting.delete(s.num);
    }
    // Claude is actively working / self-retrying (spinner with an ellipsis, e.g.
    // "✻ Retrying…") — leave it alone. Common and benign, so not logged (too noisy).
    if (tmux.ACTIVE_STATUS_RE.test(content)) return false;

    // Honor a parsed reset time, then the exponential backoff window, before re-sending.
    if (retry.retryAfter && Date.now() < retry.retryAfter) return true; // waiting for reset
    const backoff = Math.min(ERROR_RETRY_BASE * 2 ** retry.count, ERROR_RETRY_MAX_DELAY);
    if (!retry.retryAfter && retry.lastRetryAt && Date.now() - retry.lastRetryAt < backoff) {
      return true; // still inside the backoff window — stay in recovery, don't confirm idle
    }

    // Check for a reset time in the error output
    const resetAt = parseResetTime(lines);
    if (resetAt && Date.now() < resetAt) {
      // Schedule retry for after reset — don't send yet
      retry.retryAfter = resetAt;
      this.errorRetries.set(s.num, retry);
      const waitMins = Math.ceil((resetAt - Date.now()) / 60000);
      log.info(
        `[watcher] session ${s.num}: rate limit detected, will retry after reset (${waitMins}m)`,
      );
      this.emit('session:error-retry', {
        session: s,
        name: s.name,
        num: s.num,
        retryCount: retry.count,
        retryAfter: resetAt,
        waitMins,
      });
      return true;
    }

    // Send retry now
    retry.count++;
    retry.lastRetryAt = Date.now();
    retry.retryAfter = 0;
    this.errorRetries.set(s.num, retry);

    const nextWait = Math.round(
      Math.min(ERROR_RETRY_BASE * 2 ** retry.count, ERROR_RETRY_MAX_DELAY) / 1000,
    );
    log.info(
      `[watcher] session ${s.num}: API error detected, sending retry (attempt ${retry.count}, next wait ≤${nextWait}s)`,
    );

    try {
      await node.sendKeys(paneTarget, 'retry', true);
    } catch (err) {
      log.error(`[watcher] session ${s.num}: retry send failed: ${err.message}`);
      return false;
    }

    this.emit('session:error-retry', {
      session: s,
      name: s.name,
      num: s.num,
      retryCount: retry.count,
    });

    return true;
  }

  async _checkApprovals() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    for (const s of sessions) {
      if (this.detectedWaiting.has(s.num)) continue;
      // Only check working sessions — idle sessions are at the prompt, not asking questions
      if (s.state !== SessionState.WORKING) continue;

      const node = this.router.nodeFor(s.name);
      if (!node) continue;

      // Capture last 8 lines and check for permission/question patterns
      const paneTarget = tmux.paneTarget(s.name, this.config.sessions.claudePane);
      const content = await node.capturePane(paneTarget, { lines: 8 });
      if (!content) continue;

      const lines = content
        .split('\n')
        .map((l) => l.replace(/[^\x20-\x7E]/g, '').trim())
        .filter(Boolean);
      let isWaiting = false;
      let prompt = '';

      // Check for approval patterns
      for (const line of lines) {
        for (const pat of APPROVAL_PATTERNS) {
          if (pat.test(line)) {
            isWaiting = true;
            prompt = line;
            break;
          }
        }
        if (isWaiting) break;
      }

      // Check for question patterns (multiple option-like lines or question indicators)
      if (!isWaiting) {
        let optionCount = 0;
        for (const line of lines) {
          if (OPTION_PATTERN.test(line) || NUMBERED_OPTION_PATTERN.test(line)) optionCount++;
          for (const pat of QUESTION_PATTERNS) {
            if (pat.test(line)) {
              // Skip known UI chrome that looks like questions
              let ignored = false;
              for (const ign of QUESTION_IGNORE) {
                if (ign.test(line)) {
                  ignored = true;
                  break;
                }
              }
              if (ignored) break;
              isWaiting = true;
              prompt = line;
              break;
            }
          }
          if (isWaiting) break;
        }
        // 2+ option-like lines = likely a question with choices
        if (!isWaiting && optionCount >= 2) {
          isWaiting = true;
          prompt = `${optionCount} options detected`;
        }
      }

      if (isWaiting) {
        this.detectedWaiting.add(s.num);
        this.emit('approval:requested', {
          session: s,
          name: s.name,
          num: s.num,
          prompt,
        });
      }
    }
  }
}

module.exports = Watcher;
