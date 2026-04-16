// Pure, testable URL builder for the PM Primary Action button.
// Used by the dashboard (loaded before app.js) and by vitest.
// Returns { url, label } or null if no URL can be derived.
(function (root) {
  'use strict';

  var SLACK_WORKSPACE = 'vivtechnologies.slack.com'; // fallback when task.slackPermalink is absent

  function getTaskPrimaryAction(task, pms) {
    if (!task || !pms || !task.source) return null;
    var src = String(task.source);

    // Slack @mention tasks are created with source="slack:<authorName>", not
    // "pm:<slackPmName>". Look up the enabled Slack PM via matching channel
    // (or catch-all) rather than by task.source name. See PR #243 review.
    var pm = null;
    if (src.indexOf('slack:') === 0) {
      var exact = null, fallback = null;
      for (var j = 0; j < pms.length; j++) {
        var p = pms[j];
        if (!p || !p.source || p.source.type !== 'slack') continue;
        if (!p.primaryAction || p.primaryAction.enabled !== true) continue;
        if (p.source.channel && task.slackChannel && p.source.channel === task.slackChannel) {
          exact = p; break;
        }
        if (!p.source.channel && !fallback) fallback = p;
      }
      pm = exact || fallback;
    } else if (src.indexOf('pm:') === 0) {
      var pmName = src.slice(3);
      for (var i = 0; i < pms.length; i++) {
        if (pms[i] && pms[i].name === pmName) { pm = pms[i]; break; }
      }
    }
    if (!pm || !pm.primaryAction || pm.primaryAction.enabled !== true) return null;
    if (!pm.source || !pm.source.type) return null;

    var type = pm.source.type;

    if (type === 'github-prs' || type === 'github-re-reviews') {
      var ctx = task.actionContext;
      if (ctx && ctx.type === 'github-pr' && ctx.repo && ctx.prNumber) {
        return { url: 'https://github.com/' + ctx.repo + '/pull/' + ctx.prNumber, label: 'Open PR' };
      }
      var m = /^(.+)#(\d+)$/.exec(task.sourceKey || '');
      if (m) return { url: 'https://github.com/' + m[1] + '/pull/' + m[2], label: 'Open PR' };
      return null;
    }

    if (type === 'github-issues') {
      var ictx = task.actionContext;
      if (ictx && ictx.type === 'github-issue' && ictx.repo && ictx.issueNumber) {
        return { url: 'https://github.com/' + ictx.repo + '/issues/' + ictx.issueNumber, label: 'Open Issue' };
      }
      var im = /^(.+)#(\d+)$/.exec(task.sourceKey || '');
      if (im) return { url: 'https://github.com/' + im[1] + '/issues/' + im[2], label: 'Open Issue' };
      return null;
    }

    if (type === 'slack') {
      if (task.slackPermalink) return { url: task.slackPermalink, label: 'Open Thread' };
      if (task.slackChannel && task.slackThreadTs) {
        var tsNoDot = String(task.slackThreadTs).replace('.', '');
        return {
          url: 'https://' + SLACK_WORKSPACE + '/archives/' + task.slackChannel + '/p' + tsNoDot,
          label: 'Open Thread',
        };
      }
      return null;
    }

    return null;
  }

  var api = { getTaskPrimaryAction: getTaskPrimaryAction };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.getTaskPrimaryAction = getTaskPrimaryAction;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
