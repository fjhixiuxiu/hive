'use strict';

const log = require('../../core/log');

/**
 * Standup Report Generator — builds a spoken fleet status report
 * from task queue and watcher data. No LLM needed — templates the data directly.
 */
class StandupReport {
  /**
   * Generate a standup report from fleet data.
   * @param {TaskQueue} taskQueue
   * @param {Watcher} watcher
   * @returns {string} - Natural spoken report text
   */
  async generate(taskQueue, watcher) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const tasks = [...taskQueue.tasks.values()];

    const completed = tasks
      .filter(t => t.status === 'completed' && t.completedAt >= since)
      .map(t => this._summarize(t.text));

    const active = tasks
      .filter(t => t.status === 'dispatched')
      .map(t => this._summarize(t.text));

    const queued = tasks.filter(t => t.status === 'queued');

    // Get blocked sessions
    let blocked = [];
    if (watcher && watcher.sessionActivity) {
      for (const [num, activity] of watcher.sessionActivity) {
        const state = watcher.lastState?.get(num);
        if (state === 'waiting') {
          blocked.push(num);
        }
      }
    }

    log.info(`[standup] Fleet: ${completed.length} completed, ${active.length} active, ${queued.length} queued, ${blocked.length} blocked`);

    const parts = [];

    // Completed
    if (completed.length > 0) {
      parts.push(`In the last 24 hours, we completed ${completed.length} tasks.`);
      const highlights = completed.slice(0, 5);
      if (highlights.length > 0) {
        parts.push(`Highlights include: ${highlights.join('. ')}.`);
      }
    } else {
      parts.push('No tasks were completed in the last 24 hours.');
    }

    // Active
    if (active.length > 0) {
      parts.push(`We're currently working on ${active.length} tasks across the fleet.`);
      const highlights = active.slice(0, 4);
      if (highlights.length > 0) {
        parts.push(`Active work includes: ${highlights.join('. ')}.`);
      }
    }

    // Blocked
    if (blocked.length > 0) {
      parts.push(`${blocked.length} sessions are blocked and waiting for input: sessions ${blocked.join(', ')}.`);
    }

    // Queued
    if (queued.length > 0) {
      parts.push(`We have ${queued.length} tasks queued up next.`);
    }

    return parts.join(' ');
  }

  /**
   * Extract a short summary from task text.
   */
  _summarize(text) {
    if (!text) return 'an unnamed task';
    // Strip common prefixes like [zoho-XXX], [re-review-...], etc.
    let clean = text
      .replace(/^\[.*?\]\s*/g, '')
      .replace(/^Context \(.*?\):\s*/i, '')
      .replace(/\n.*/s, '') // first line only
      .trim();
    if (clean.length > 100) clean = clean.substring(0, 97) + '...';
    return clean || 'a task';
  }
}

module.exports = StandupReport;
