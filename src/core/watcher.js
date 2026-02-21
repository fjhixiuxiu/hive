const EventEmitter = require('events');
const fleet = require('./fleet');
const tmux = require('./tmux');

/**
 * Watches fleet sessions for state changes and emits events.
 *
 * Events:
 *   'session:idle'    - { session, name, num }  — Claude finished working
 *   'session:working' - { session, name, num }  — Claude started working
 *   'ci:changed'      - { session, name, num, from, to, pr }  — CI result changed
 */
class Watcher extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.interval = null;
    this.prevStates = new Map();   // num → 'idle'|'working'|'off'
    this.prevCI = new Map();       // num → CI result string
  }

  start() {
    if (this.interval) return;

    // Seed initial states (no notifications on startup)
    this._seed();

    this.interval = setInterval(() => this._poll(), this.config.watcher.interval);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  _seed() {
    const sessions = fleet.getFleetStatus(this.config);
    for (const s of sessions) {
      this.prevStates.set(s.num, s.state);
      if (s.pr) this.prevCI.set(s.num, s.pr.ciResult);
    }
  }

  _poll() {
    const sessions = fleet.getFleetStatus(this.config);

    for (const s of sessions) {
      const prevState = this.prevStates.get(s.num);
      const currState = s.state;

      // State transition: working → idle
      if (prevState === 'working' && currState === 'idle') {
        this.emit('session:idle', { session: s, name: s.name, num: s.num });
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
      }
    }
  }
}

module.exports = Watcher;
