import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getTaskActions, getTaskPrimaryAction } = require('../../../src/integrations/web/public/primary-action.js');

/**
 * Auto-derived context actions (Open Thread, Open PR, Open Issue).
 * Actions are derived from task data — no PM config needed.
 */
describe('getTaskActions', () => {
  describe('no-op cases', () => {
    it('returns empty array for null task', () => {
      expect(getTaskActions(null)).toEqual([]);
    });

    it('returns empty array for task with no context', () => {
      expect(getTaskActions({ id: 1, source: 'manual' })).toEqual([]);
    });
  });

  describe('Slack thread actions', () => {
    it('builds Open Thread from slackChannel + slackThreadTs', () => {
      const task = { slackChannel: 'C08LPA0N9J8', slackThreadTs: '1776268446.027589' };
      expect(getTaskActions(task)).toEqual([{
        url: 'https://vivtechnologies.slack.com/archives/C08LPA0N9J8/p1776268446027589',
        label: 'Open Thread',
      }]);
    });

    it('prefers slackPermalink when present', () => {
      const task = {
        slackPermalink: 'https://vivtechnologies.slack.com/archives/C08/p1776268507043009',
        slackChannel: 'C08',
        slackThreadTs: '1776268446.027589',
      };
      expect(getTaskActions(task)).toEqual([{
        url: 'https://vivtechnologies.slack.com/archives/C08/p1776268507043009',
        label: 'Open Thread',
      }]);
    });

    it('does not show Open Thread when slackChannel is missing', () => {
      const task = { slackThreadTs: '1776268446.027589' };
      expect(getTaskActions(task)).toEqual([]);
    });

    it('does not show Open Thread when slackThreadTs is missing', () => {
      const task = { slackChannel: 'C08' };
      expect(getTaskActions(task)).toEqual([]);
    });
  });

  describe('GitHub PR actions', () => {
    it('builds Open PR from actionContext', () => {
      const task = { actionContext: { type: 'github-pr', repo: 'mavencare/nectar', prNumber: 42 } };
      expect(getTaskActions(task)).toEqual([{
        url: 'https://github.com/mavencare/nectar/pull/42',
        label: 'Open PR',
      }]);
    });

    it('falls back to parsing sourceKey', () => {
      const task = { sourceKey: 'mavencare/nectar#7' };
      expect(getTaskActions(task)).toEqual([{
        url: 'https://github.com/mavencare/nectar/pull/7',
        label: 'Open PR',
      }]);
    });

    it('returns empty when neither actionContext nor sourceKey is usable', () => {
      expect(getTaskActions({ source: 'pm:Reviews' })).toEqual([]);
    });
  });

  describe('GitHub issue actions', () => {
    it('builds Open Issue from actionContext', () => {
      const task = { actionContext: { type: 'github-issue', repo: 'mavencare/nectar', issueNumber: 15 } };
      expect(getTaskActions(task)).toEqual([{
        url: 'https://github.com/mavencare/nectar/issues/15',
        label: 'Open Issue',
      }]);
    });
  });

  describe('combined actions', () => {
    it('shows both Open Thread and Open PR when task has both contexts', () => {
      const task = {
        slackChannel: 'C08LPA0N9J8',
        slackThreadTs: '1776268446.027589',
        actionContext: { type: 'github-pr', repo: 'mavencare/webplatform', prNumber: 100 },
      };
      const actions = getTaskActions(task);
      expect(actions).toHaveLength(2);
      expect(actions[0]).toEqual({
        url: 'https://vivtechnologies.slack.com/archives/C08LPA0N9J8/p1776268446027589',
        label: 'Open Thread',
      });
      expect(actions[1]).toEqual({
        url: 'https://github.com/mavencare/webplatform/pull/100',
        label: 'Open PR',
      });
    });

    it('shows Open Thread and Open Issue together', () => {
      const task = {
        slackChannel: 'C0A6XUGT0N6',
        slackThreadTs: '1.2',
        actionContext: { type: 'github-issue', repo: 'nukulb/hive', issueNumber: 5 },
      };
      const actions = getTaskActions(task);
      expect(actions).toHaveLength(2);
      expect(actions[0].label).toBe('Open Thread');
      expect(actions[1].label).toBe('Open Issue');
    });
  });
});

describe('getTaskPrimaryAction (backward compat)', () => {
  it('returns first action for task with context', () => {
    const task = { slackChannel: 'C08', slackThreadTs: '1.2' };
    const result = getTaskPrimaryAction(task);
    expect(result).toEqual({
      url: 'https://vivtechnologies.slack.com/archives/C08/p12',
      label: 'Open Thread',
    });
  });

  it('returns null for task with no context', () => {
    expect(getTaskPrimaryAction({ id: 1 })).toBeNull();
  });

  it('returns null for null task', () => {
    expect(getTaskPrimaryAction(null)).toBeNull();
  });
});
