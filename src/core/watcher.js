const EventEmitter = require('events');
const fleet = require('./fleet');
const tmux = require('./tmux');
const log = require('./log');

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

// Patterns that indicate Claude hit a retryable API error
const API_ERROR_PATTERNS = [
  /API Error:\s*500/,
  /API Error:\s*429/,
  /API Error:\s*529/,
  /overloaded/i,
  /rate.?limit/i,
  /capacity/i,
  /Internal server error/i,
];

const MAX_ERROR_RETRIES = 3;
const ERROR_RETRY_DELAY = 15000; // 15s before retry (helps with rate limits)

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
  /^\s*❯\s+/,           // selection cursor (AskUserQuestion UI)
  /^\s*>\s+\S/,          // alternate selection cursor
  /^\s*\?\s+.{5,}/,     // ? prefix on question line
  /Other$/,              // "Other" option always present in AskUserQuestion
];

// Lines that look like questions but are actually Claude UI tips/chrome
const QUESTION_IGNORE = [
  /\?\s+for shortcuts/,
  /\?\s+for help/,
  /Try "/,
];

class Watcher extends EventEmitter {
  constructor(config, router) {
    super();
    this.config = config;
    this.router = router;
    this.interval = null;
    this.approvalInterval = null;
    this.prevStates = new Map();   // num -> 'idle'|'working'|'off'
    this.notifiedIdle = new Set(); // nums we've already emitted idle for
    this.pendingIdle = new Map();  // num -> count of consecutive idle polls (confirm at 5)
    this.seenWorking = new Set();  // nums that have been observed working at least once
    this._pendingWorking = new Map(); // num -> count of consecutive working polls
    this.prevCI = new Map();       // num -> CI result string
    this.prevReview = new Map();   // num -> review status string
    this.prevBranch = new Map();   // num -> branch name
    this.detectedWaiting = new Set(); // session nums waiting for user (approvals or questions)
    this.sessionActivity = new Map(); // num -> timestamp of last meaningful activity
    this.errorRetries = new Map();    // num -> { count, lastRetryAt }
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
      this._poll().catch(err => log.error('Watcher poll error:', err.message));
    }, this.config.watcher.interval);
    // Approval detection: poll working sessions every 10s
    this.approvalInterval = setInterval(() => {
      this._checkApprovals().catch(err => log.error('Approval check error:', err.message));
    }, 10000);
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
  }

  async _seed() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    for (const s of sessions) {
      this.prevStates.set(s.num, s.state);
      // Mark all idle sessions as notified — no idle notifications on startup.
      // After restart, Claude doesn't auto-resume work, so sessions with
      // dispatched tasks are just sitting idle. They need a real working→idle
      // cycle before completion fires.
      if (s.state === 'idle') this.notifiedIdle.add(s.num);
      if (s.pr) this.prevCI.set(s.num, s.pr.ciResult);
      if (s.branch) this.prevBranch.set(s.num, s.branch);
    }
    // Seed git info for all sessions (runs once, in background)
    for (const s of sessions) {
      const node = this.router.nodeFor(s.name);
      if (node && fleet.refreshGitInfo) fleet.refreshGitInfo(this.config, node, s.name, s.nodeId).catch(() => {});
    }
  }

  async _poll() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);

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
      if (currState === 'working') {
        const wc = (this._pendingWorking.get(s.num) || 0) + 1;
        if (wc >= 2) {
          this.seenWorking.add(s.num);
          this._pendingWorking.delete(s.num);
        } else {
          this._pendingWorking.set(s.num, wc);
        }
      } else {
        this._pendingWorking.delete(s.num);
      }

      // Detect idle with confirmation: require FIVE consecutive idle polls
      // to avoid false positives from brief idle flickers between tool calls.
      // Also skip if session is waiting for user answer (approval or question).
      // Only notify for sessions that have been seen working at least once.
      if (currState === 'idle' && !this.notifiedIdle.has(s.num) && this.seenWorking.has(s.num)) {
        if (this.detectedWaiting.has(s.num)) {
          // Session is waiting for user answer — do NOT count toward idle
          this.pendingIdle.delete(s.num);
        } else {
          const count = (this.pendingIdle.get(s.num) || 0) + 1;
          if (count >= 5) {
            // Before confirming idle, check for API errors that stalled the session
            const retried = await this._checkAndRetryErrors(s);
            if (retried) {
              this.pendingIdle.delete(s.num);
              continue; // Skip idle confirmation — retry sent
            }
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
                if (fleet.refreshGitInfo) fleet.refreshGitInfo(this.config, node, s.name, s.nodeId).catch(() => {});
                preview = await fleet.peekSession(this.config, node, s.name);
                // Also capture ANSI version + pane width for task snapshot display
                const paneTarget = `${s.name}:.${this.config.sessions.claudePane}`;
                ansiSnapshot = await node.exec(`tmux capture-pane -e -p -S -500 -t "${paneTarget}" 2>/dev/null`) || '';
                const colsStr = await node.exec(`tmux display-message -p -t "${paneTarget}" "#{pane_width}" 2>/dev/null`);
                paneCols = parseInt(colsStr) || 0;
              }
            } catch {}
            this.sessionActivity.set(s.num, Date.now());
            this.emit('session:idle', { session: s, name: s.name, num: s.num, preview, ansiSnapshot, paneCols });
          } else {
            this.pendingIdle.set(s.num, count);
          }
        }
      }

      // Clear pending/notified flags when session leaves idle
      if (currState !== 'idle') {
        this.notifiedIdle.delete(s.num);
        this.pendingIdle.delete(s.num);
      }

      // State transition: idle/off -> working
      if (prevState !== 'working' && currState === 'working') {
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
          session: s, name: s.name, num: s.num,
          from: prevBranch, to: currBranch, pr: s.pr || null,
        });
      }
      if (currBranch) this.prevBranch.set(s.num, currBranch);

      // Clear waiting flag and error retries when session starts working
      if (currState === 'working' && prevState !== 'working') {
        this.detectedWaiting.delete(s.num);
        this.errorRetries.delete(s.num);
      }
    }

    // Clean up stale entries for sessions that no longer exist
    const currentNums = new Set(sessions.map(s => s.num));
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
    const node = this.router.nodeFor(s.name);
    if (!node) return false;

    // Check retry budget
    const retry = this.errorRetries.get(s.num) || { count: 0, lastRetryAt: 0 };
    if (retry.count >= MAX_ERROR_RETRIES) return false;

    // Don't retry more than once per delay window
    if (Date.now() - retry.lastRetryAt < ERROR_RETRY_DELAY) return true; // still waiting

    // Capture recent pane content
    const paneTarget = `${s.name}:.${this.config.sessions.claudePane}`;
    const content = await node.capturePane(paneTarget, { lines: 15 });
    if (!content) return false;

    // Check for API error patterns in the last 15 lines
    const lines = content.split('\n');
    let hasError = false;
    for (const line of lines) {
      for (const pat of API_ERROR_PATTERNS) {
        if (pat.test(line)) {
          hasError = true;
          break;
        }
      }
      if (hasError) break;
    }

    if (!hasError) return false;

    // Send retry
    retry.count++;
    retry.lastRetryAt = Date.now();
    this.errorRetries.set(s.num, retry);

    log.info(`[watcher] session ${s.num}: API error detected, sending retry (${retry.count}/${MAX_ERROR_RETRIES})`);

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
      maxRetries: MAX_ERROR_RETRIES,
    });

    return true;
  }

  async _checkApprovals() {
    const sessions = await fleet.getFleetStatus(this.config, this.router);
    for (const s of sessions) {
      if (this.detectedWaiting.has(s.num)) continue;
      // Only check working sessions — idle sessions are at the prompt, not asking questions
      if (s.state !== 'working') continue;

      const node = this.router.nodeFor(s.name);
      if (!node) continue;

      // Capture last 8 lines and check for permission/question patterns
      const paneTarget = `${s.name}:.${this.config.sessions.claudePane}`;
      const content = await node.capturePane(paneTarget, { lines: 8 });
      if (!content) continue;

      const lines = content.split('\n').map(l => l.replace(/[^\x20-\x7E]/g, '').trim()).filter(Boolean);
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
                if (ign.test(line)) { ignored = true; break; }
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
