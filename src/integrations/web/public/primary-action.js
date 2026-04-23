// Auto-derive context actions (Open Thread, Open PR, Open Issue) from task data.
// No PM config needed — actions appear automatically when the task has the context.
// Returns an array of { url, label } objects (may be empty).
(function (root) {
  'use strict';

  var SLACK_WORKSPACE = 'vivtechnologies.slack.com';

  function getTaskActions(task) {
    if (!task) return [];
    var actions = [];

    // Slack thread action — any task with slackChannel + slackThreadTs
    if (task.slackChannel && task.slackThreadTs) {
      if (task.slackPermalink) {
        actions.push({ url: task.slackPermalink, label: 'Open Thread' });
      } else {
        var tsNoDot = String(task.slackThreadTs).replace('.', '');
        actions.push({
          url: 'https://' + SLACK_WORKSPACE + '/archives/' + task.slackChannel + '/p' + tsNoDot,
          label: 'Open Thread',
        });
      }
    }

    // GitHub PR action — from actionContext or sourceKey
    var ctx = task.actionContext;
    if (ctx && ctx.type === 'github-pr' && ctx.repo && ctx.prNumber) {
      actions.push({ url: 'https://github.com/' + ctx.repo + '/pull/' + ctx.prNumber, label: 'Open PR' });
    } else if (ctx && ctx.type === 'github-issue' && ctx.repo && ctx.issueNumber) {
      actions.push({ url: 'https://github.com/' + ctx.repo + '/issues/' + ctx.issueNumber, label: 'Open Issue' });
    } else if (!ctx && task.sourceKey) {
      // Fallback: parse "owner/repo#123" from sourceKey
      var m = /^(.+)#(\d+)$/.exec(task.sourceKey);
      if (m) {
        var src = String(task.source || '');
        if (src.indexOf('github-issues') >= 0 || src.indexOf('Issue') >= 0) {
          actions.push({ url: 'https://github.com/' + m[1] + '/issues/' + m[2], label: 'Open Issue' });
        } else {
          actions.push({ url: 'https://github.com/' + m[1] + '/pull/' + m[2], label: 'Open PR' });
        }
      }
    }

    return actions;
  }

  // Backward compat: getTaskPrimaryAction returns the first action or null
  function getTaskPrimaryAction(task) {
    var actions = getTaskActions(task);
    return actions.length > 0 ? actions[0] : null;
  }

  var api = { getTaskActions: getTaskActions, getTaskPrimaryAction: getTaskPrimaryAction };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.getTaskActions = getTaskActions;
    root.getTaskPrimaryAction = getTaskPrimaryAction;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
