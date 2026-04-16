import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getTaskPrimaryAction } = require('../../../src/integrations/web/public/primary-action.js');

/**
 * URL builder for the PM Primary Action button on task cards.
 * See docs/PM-primary-action.md (if added) or src/integrations/web/public/primary-action.js.
 */
describe('getTaskPrimaryAction', () => {
  // PM fixtures
  const prPm        = { name: 'Nectar Reviews',    source: { type: 'github-prs' },        primaryAction: { enabled: true } };
  const reReviewPm  = { name: 'Nectar Re-reviews', source: { type: 'github-re-reviews' }, primaryAction: { enabled: true } };
  const issuePm     = { name: 'Nectar Dev',        source: { type: 'github-issues' },     primaryAction: { enabled: true } };
  const slackPm     = { name: 'Slack',             source: { type: 'slack' },             primaryAction: { enabled: true } };
  const prPmDisabled = { name: 'Disabled PM',      source: { type: 'github-prs' },        primaryAction: { enabled: false } };
  const prPmNoFlag   = { name: 'Legacy PM',        source: { type: 'github-prs' } };
  const unsupportedPm = { name: 'Jira PM',         source: { type: 'jira' },              primaryAction: { enabled: true } };

  const pms = [prPm, reReviewPm, issuePm, slackPm, prPmDisabled, prPmNoFlag, unsupportedPm];

  describe('no-op cases', () => {
    it('returns null for missing task', () => {
      expect(getTaskPrimaryAction(null, pms)).toBeNull();
    });

    it('returns null for missing pms', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Nectar Reviews' }, null)).toBeNull();
    });

    it('returns null when task has no source', () => {
      expect(getTaskPrimaryAction({ id: 1 }, pms)).toBeNull();
    });

    it('returns null when source is non-PM (e.g. slack:user)', () => {
      const task = { source: 'slack:Nukul Bhasin', actionContext: { type: 'github-pr', repo: 'a/b', prNumber: 1 } };
      expect(getTaskPrimaryAction(task, pms)).toBeNull();
    });

    it('returns null when PM not found in list', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Unknown' }, pms)).toBeNull();
    });

    it('returns null when PM has primaryAction disabled', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Disabled PM' }, pms)).toBeNull();
    });

    it('returns null when PM has no primaryAction field (legacy)', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Legacy PM' }, pms)).toBeNull();
    });

    it('returns null for unsupported source types (scope A only)', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Jira PM', sourceKey: 'DEV-123' }, pms)).toBeNull();
    });
  });

  describe('github-prs', () => {
    it('builds PR URL from actionContext', () => {
      const task = { source: 'pm:Nectar Reviews', actionContext: { type: 'github-pr', repo: 'mavencare/nectar', prNumber: 42 } };
      expect(getTaskPrimaryAction(task, pms)).toEqual({ url: 'https://github.com/mavencare/nectar/pull/42', label: 'Open PR' });
    });

    it('falls back to parsing sourceKey when actionContext is missing', () => {
      const task = { source: 'pm:Nectar Reviews', sourceKey: 'mavencare/nectar#7' };
      expect(getTaskPrimaryAction(task, pms)).toEqual({ url: 'https://github.com/mavencare/nectar/pull/7', label: 'Open PR' });
    });

    it('returns null when neither actionContext nor sourceKey is usable', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Nectar Reviews' }, pms)).toBeNull();
    });
  });

  describe('github-re-reviews', () => {
    it('builds PR URL from actionContext (same as github-prs)', () => {
      const task = { source: 'pm:Nectar Re-reviews', actionContext: { type: 'github-pr', repo: 'mavencare/nectar', prNumber: 9 } };
      expect(getTaskPrimaryAction(task, pms)).toEqual({ url: 'https://github.com/mavencare/nectar/pull/9', label: 'Open PR' });
    });
  });

  describe('github-issues', () => {
    it('builds issue URL from actionContext', () => {
      const task = { source: 'pm:Nectar Dev', actionContext: { type: 'github-issue', repo: 'mavencare/nectar', issueNumber: 15 } };
      expect(getTaskPrimaryAction(task, pms)).toEqual({ url: 'https://github.com/mavencare/nectar/issues/15', label: 'Open Issue' });
    });

    it('falls back to parsing sourceKey for backfill on old tasks', () => {
      const task = { source: 'pm:Nectar Dev', sourceKey: 'mavencare/nectar#15' };
      expect(getTaskPrimaryAction(task, pms)).toEqual({ url: 'https://github.com/mavencare/nectar/issues/15', label: 'Open Issue' });
    });
  });

  describe('slack (pm:<name> source — synthetic / tests)', () => {
    it('prefers stored slackPermalink when present', () => {
      const task = {
        source: 'pm:Slack',
        slackPermalink: 'https://vivtechnologies.slack.com/archives/C08/p1776268507043009',
        slackChannel: 'C08',
        slackThreadTs: '1776268446.027589',
      };
      expect(getTaskPrimaryAction(task, pms)).toEqual({
        url: 'https://vivtechnologies.slack.com/archives/C08/p1776268507043009',
        label: 'Open Thread',
      });
    });

    it('falls back to constructing URL from channel + threadTs for old tasks without permalink', () => {
      const task = { source: 'pm:Slack', slackChannel: 'C08LPA0N9J8', slackThreadTs: '1776268446.027589' };
      expect(getTaskPrimaryAction(task, pms)).toEqual({
        url: 'https://vivtechnologies.slack.com/archives/C08LPA0N9J8/p1776268446027589',
        label: 'Open Thread',
      });
    });

    it('returns null when Slack task has neither permalink nor channel+ts', () => {
      expect(getTaskPrimaryAction({ source: 'pm:Slack' }, pms)).toBeNull();
    });
  });

  // REAL Slack @mention flow — bot.js creates tasks with source="slack:<authorName>",
  // not "pm:<slackPmName>". PR #243 review caught that the original PM-name lookup
  // was dead code for every real Slack task. These fixtures cover that path.
  describe('slack (slack:<author> source — real @mention flow)', () => {
    it('resolves via catch-all Slack PM when no channel is configured', () => {
      const task = {
        source: 'slack:Nukul Bhasin',
        slackChannel: 'C0A72B59EDC',
        slackThreadTs: '1776132841.415429',
      };
      expect(getTaskPrimaryAction(task, pms)).toEqual({
        url: 'https://vivtechnologies.slack.com/archives/C0A72B59EDC/p1776132841415429',
        label: 'Open Thread',
      });
    });

    it('prefers stored slackPermalink over constructed URL', () => {
      const task = {
        source: 'slack:Alice',
        slackPermalink: 'https://vivtechnologies.slack.com/archives/C08/p1776268507043009',
        slackChannel: 'C08',
        slackThreadTs: '1776268446.027589',
      };
      expect(getTaskPrimaryAction(task, pms)).toEqual({
        url: 'https://vivtechnologies.slack.com/archives/C08/p1776268507043009',
        label: 'Open Thread',
      });
    });

    it('prefers a channel-specific Slack PM over the catch-all when both are enabled', () => {
      const channelPm = { name: 'Dev Channel', source: { type: 'slack', channel: 'C0DEV' }, primaryAction: { enabled: true } };
      const catchAll  = { name: 'Slack',       source: { type: 'slack' },                    primaryAction: { enabled: true } };
      const task = { source: 'slack:Alice', slackChannel: 'C0DEV', slackThreadTs: '1.2' };
      expect(getTaskPrimaryAction(task, [channelPm, catchAll])).toEqual({
        url: 'https://vivtechnologies.slack.com/archives/C0DEV/p12',
        label: 'Open Thread',
      });
    });

    it('returns null when no Slack PM has primaryAction enabled', () => {
      const disabledSlackPm = { name: 'Slack', source: { type: 'slack' }, primaryAction: { enabled: false } };
      const task = { source: 'slack:Alice', slackChannel: 'C08', slackThreadTs: '1.2' };
      expect(getTaskPrimaryAction(task, [disabledSlackPm])).toBeNull();
    });

    it('returns null when no Slack-type PM exists at all', () => {
      const task = { source: 'slack:Alice', slackChannel: 'C08', slackThreadTs: '1.2' };
      expect(getTaskPrimaryAction(task, [prPm])).toBeNull();
    });
  });
});
