const EventEmitter = require('events');
const fleet = require('./fleet');
const tmux = require('./tmux');

// Lines that look like Claude presenting choices to the user
const OPTION_PATTERN = /^[-–•]\s+.{5,}/;
const NUMBERED_OPTION_PATTERN = /^\d+[.)]\s+.{5,}/;

/**
 * Watches fleet sessions for state changes and emits events.
 *
 * Events:
 *   'session:idle'          - { session, name, num }  — Claude finished working
 *   'session:working'       - { session, name, num }  — Claude started working
 *   'ci:changed'            - { session, name, num, from, to, pr }  — CI result changed
 *   'review:changed'        - { session, name, num, from, to, pr }  — PR review changed
 *   'approval:requested'    - { session, name, num, prompt }  — Claude needs permission
 */

// Patterns that indicate Claude is asking for permission
const APPROVAL_PATTERNS = [
  /bypass permissions/i,
  /Do you want to proceed/i,
  /Allow this action/i,
  /\(y\/n\)/i,
  /Press y to confirm/i,
  /\[Y\/n\]/i,
  /approve,?\s*deny/i,
];

class Watcher extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.interval = null;
    this.approvalInterval = null;
    this.prevStates = new Map();   // num → 'idle'|'working'|'off'
    this.notifiedIdle = new Set(); // nums we've already emitted idle for
    this.prevCI = new Map();       // num → CI result string
    this.prevReview = new Map();   // num → review status string
    this.detectedApprovals = new Set(); // session nums with active approval prompts
  }

  start() {
    if (this.interval) return;

    // Seed initial states (no notifications on startup)
    this._seed();

    this.interval = setInterval(() => this._poll(), this.config.watcher.interval);
    // Approval detection: poll working sessions every 10s
    this.approvalInterval = setInterval(() => this._checkApprovals(), 10000);
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

  _seed() {
    const sessions = fleet.getFleetStatus(this.config);
    for (const s of sessions) {
      this.prevStates.set(s.num, s.state);
      // Mark already-idle sessions so we don't spam notifications on startup
      if (s.state === 'idle') this.notifiedIdle.add(s.num);
      if (s.pr) this.prevCI.set(s.num, s.pr.ciResult);
    }
  }

  _poll() {
    const sessions = fleet.getFleetStatus(this.config);

    for (const s of sessions) {
      const prevState = this.prevStates.get(s.num);
      const currState = s.state;

      // Detect idle: emit if session is idle and we haven't notified yet.
      // This catches working→idle transitions AND cases where the exact
      // transition was missed between polls (e.g., cache race, fast cycles).
      if (currState === 'idle' && !this.notifiedIdle.has(s.num)) {
        this.notifiedIdle.add(s.num);
        // Capture terminal preview so the feed entry can show context
        let preview = '';
        try { preview = fleet.peekSession(this.config, s.name); } catch {}
        this.emit('session:idle', { session: s, name: s.name, num: s.num, preview });
      }

      // Clear notified flag when session leaves idle — so next time it
      // returns to idle, we'll notify again.
      if (currState !== 'idle') {
        this.notifiedIdle.delete(s.num);
      }

      // State transition: idle/off → working
      if (prevState !== 'working' && currState === 'working') {
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

      // Clear approval flag when session goes idle
      if (currState === 'idle') {
        this.detectedApprovals.delete(s.num);
      }
    }

    // Emit poll event with all session states for task completion checks
    this.emit('poll', sessions);
  }

  _checkApprovals() {
    const sessions = fleet.getFleetStatus(this.config);
    for (const s of sessions) {
      if (s.state !== 'working') continue;
      if (this.detectedApprovals.has(s.num)) continue;

      // Capture last 5 lines and check for permission patterns
      const paneTarget = `${s.name}:.${this.config.sessions.claudePane}`;
      const content = tmux.capturePane(paneTarget, { lines: 5 });
      if (!content) continue;

      const lines = content.split('\n').map(l => l.replace(/[^\x20-\x7E]/g, '').trim()).filter(Boolean);
      for (const line of lines) {
        for (const pat of APPROVAL_PATTERNS) {
          if (pat.test(line)) {
            this.detectedApprovals.add(s.num);
            this.emit('approval:requested', {
              session: s,
              name: s.name,
              num: s.num,
              prompt: line,
            });
            break;
          }
        }
        if (this.detectedApprovals.has(s.num)) break;
      }
    }
  }
}

module.exports = Watcher;
