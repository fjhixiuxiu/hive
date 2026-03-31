const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const GitHubAppAuth = require('./auth');
const log = require('../../core/log');

/**
 * GitHub bot — polls for @mentions on issues/PRs, creates tasks,
 * routes follow-ups, and replies as the bot.
 *
 * Mirrors the Slack bot flow exactly:
 * - New @mention on issue/PR → create task with context
 * - Follow-up @mention on same issue → relay to active session
 * - Task completes → reply on the issue/PR
 */
function createGithubBot(taskQueue, config, router, pmManager) {
  const appId = process.env.GITHUB_APP_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  if (!appId || !keyPath) {
    log.info('[github] Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY_PATH — GitHub bot disabled');
    return null;
  }

  let auth;
  try {
    auth = new GitHubAppAuth({ appId, privateKeyPath: keyPath });
  } catch (err) {
    log.error(`[github] Auth init failed: ${err.message}`);
    return null;
  }

  let botUsername = null;
  let pollTimer = null;
  const lastPollTimes = {}; // repo → ISO timestamp
  const POLL_INTERVAL = 30000; // 30s

  // ── Helpers ──

  function stripMention(text) {
    if (!text) return '';
    // Remove @bot-name[bot] or @bot-name mentions (dynamic from GitHub App identity)
    const name = (botUsername || '').replace('[bot]', '');
    if (name) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text
        .replace(new RegExp(`@${escaped}\\[bot\\]`, 'gi'), '')
        .replace(new RegExp(`@${escaped}`, 'gi'), '')
        .trim();
    }
    return text.trim();
  }

  function findActiveTaskForIssue(repo, issueNumber) {
    if (!taskQueue) return null;
    const tasks = taskQueue.getTasksList();
    const pattern = `${repo}#${issueNumber}`;
    return tasks.find(t =>
      (t.status === 'queued' || t.status === 'dispatched') &&
      (
        // GitHub mentions tasks (stored metadata)
        (t.githubRepo === repo && t.githubIssueNumber === issueNumber) ||
        // PR review / re-review tasks (sourceKey pattern)
        (t.sourceKey && t.sourceKey.includes(pattern)) ||
        // Text match fallback (e.g. "[mavencare/webplatform#28510]")
        (t.text && t.text.includes(pattern))
      )
    );
  }

  function findGithubPM(repo) {
    if (!pmManager) return null;
    const pms = pmManager.getAll().filter(pm => pm.enabled && pm.source.type === 'github-mentions');
    // Check if repo is in PM's repo list
    const match = pms.find(pm => {
      const repos = pm.source.repos || [];
      return repos.length === 0 || repos.some(r => r.toLowerCase() === repo.toLowerCase());
    });
    return match || null;
  }

  // ── Context gathering ──

  async function gatherContext(repo, issueNumber) {
    const token = await auth.getTokenForRepo(repo);
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'hive-github-bot',
      'Accept': 'application/vnd.github+json',
    };

    const _get = (url) => auth._request('GET', url, headers);

    // Issue/PR details
    let issue;
    try {
      issue = await _get(`https://api.github.com/repos/${repo}/issues/${issueNumber}`);
    } catch (err) {
      log.error(`[github] Failed to fetch issue ${repo}#${issueNumber}: ${err.message}`);
      return { issue: null, comments: [], diff: null, isPR: false };
    }

    const isPR = !!issue.pull_request;

    // Recent comments (last 20)
    let comments = [];
    try {
      comments = await _get(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=20&direction=desc`);
      if (!Array.isArray(comments)) comments = [];
    } catch { comments = []; }

    // PR diff (changed files summary)
    let diff = null;
    if (isPR) {
      try {
        const files = await _get(`https://api.github.com/repos/${repo}/pulls/${issueNumber}/files?per_page=50`);
        if (Array.isArray(files)) {
          diff = files.map(f => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})`).join('\n');
        }
      } catch { /* no diff */ }
    }

    return { issue, comments: comments.reverse(), diff, isPR };
  }

  // ── Handle a single mention ──

  async function handleMention(repo, issueNumber, comment) {
    const text = stripMention(comment.body);
    if (!text) return;

    const author = comment.user ? comment.user.login : 'unknown';
    const lower = text.toLowerCase().trim();

    // ── Status command ──
    if (lower === 'status' || lower === 'queue') {
      const tasks = taskQueue.getTasksList();
      const queued = tasks.filter(t => t.status === 'queued').length;
      const inProgress = tasks.filter(t => t.status === 'dispatched').length;
      await auth.postComment(repo, issueNumber,
        `🐝 **Hive Status**\n- Queued: ${queued}\n- In Progress: ${inProgress}`
      );
      return;
    }

    // ── Close command ──
    if (lower === 'close' || lower === 'done' || lower === 'close task') {
      const activeTask = findActiveTaskForIssue(repo, issueNumber);
      if (!activeTask) {
        await auth.postComment(repo, issueNumber, '🐝 No active task for this issue.');
        return;
      }
      if (activeTask.status === 'dispatched') {
        taskQueue.completeTask(activeTask.id, 'Closed via GitHub');
      } else {
        taskQueue.cancelTask(activeTask.id);
      }
      await auth.postComment(repo, issueNumber, '🐝 Task closed.');
      return;
    }

    // ── Follow-up: active task on this issue? ──
    const isReview = !!comment._isReviewComment;
    const existingTask = findActiveTaskForIssue(repo, issueNumber);
    if (existingTask) {
      if (existingTask.status === 'dispatched' && existingTask.assignedTo) {
        // Relay directly to session
        try {
          const found = await fleet.findSession(config, router, existingTask.assignedTo);
          if (found) {
            const node = router.getNode(found.nodeId);
            const result = await relay.tell(config, node, found.name, text + '\n\nReply back on the thread when done.', { vimMode: taskQueue.vimMode });
            if (result.success) {
              await auth.addReaction(repo, comment.id, 'eyes', isReview).catch(() => {});
              log.info(`[github] Follow-up relayed to session ${existingTask.assignedTo} for ${repo}#${issueNumber}`);
              return;
            }
          }
        } catch (err) {
          log.error(`[github] Follow-up relay error: ${err.message}`);
        }
      } else if (existingTask.status === 'queued') {
        existingTask.text += `\n\n---\nFollow-up from @${author}:\n${text}`;
        taskQueue._saveState();
        await auth.addReaction(repo, comment.id, 'eyes', isReview).catch(() => {});
        log.info(`[github] Follow-up appended to queued task for ${repo}#${issueNumber}`);
        return;
      }
    }

    // ── New task ──
    const pm = findGithubPM(repo);
    const { issue, comments, diff, isPR } = await gatherContext(repo, issueNumber);

    // Build task text
    const contextParts = [];
    if (issue) {
      contextParts.push(`GitHub ${isPR ? 'PR' : 'Issue'} #${issueNumber}: ${issue.title}`);
      contextParts.push(`Repo: ${repo}`);
      contextParts.push(`Author: @${issue.user ? issue.user.login : 'unknown'}`);
      if (issue.labels && issue.labels.length) {
        contextParts.push(`Labels: ${issue.labels.map(l => l.name).join(', ')}`);
      }
      contextParts.push(`URL: ${issue.html_url}`);
      if (issue.body) {
        contextParts.push(`\n## ${isPR ? 'PR' : 'Issue'} Description\n${issue.body.slice(0, 2000)}`);
      }
    }

    if (diff) {
      contextParts.push(`\n## Changed Files\n${diff}`);
    }

    if (comments.length > 0) {
      const recentComments = comments.slice(-10).map(c => {
        const cAuthor = c.user ? c.user.login : 'unknown';
        const cBody = (c.body || '').slice(0, 300);
        return `@${cAuthor}: ${cBody}`;
      }).join('\n\n');
      contextParts.push(`\n## Recent Comments\n${recentComments}`);
    }

    // Include inline review comment context (file, line, diff hunk)
    if (isReview) {
      const reviewContext = [];
      if (comment.path) reviewContext.push(`File: \`${comment.path}\``);
      if (comment.line) reviewContext.push(`Line: ${comment.line}`);
      if (comment.diff_hunk) reviewContext.push(`\`\`\`diff\n${comment.diff_hunk}\n\`\`\``);
      if (reviewContext.length) {
        contextParts.push(`\n## Review Comment Context\n${reviewContext.join('\n')}`);
      }
    }

    let fullText = '';
    if (contextParts.length) {
      fullText += contextParts.join('\n') + '\n\n---\n\n';
    }

    if (pm && pm.taskFormat) {
      fullText += pm.taskFormat
        .replace('{key}', `${repo}#${issueNumber}`)
        .replace('{summary}', text);
    } else {
      fullText += `Instructions from @${author}:\n${text}`;
    }

    if (pm && pm.instructions) {
      fullText += `\n\nInstructions: ${pm.instructions}`;
    }

    // Routing
    const mode = pm && pm.targetSession ? 'manual' : 'auto';
    const targetSession = (pm && pm.targetSession) || null;
    const designation = (pm && pm.designation) || null;

    let task;
    try {
      task = taskQueue.createTask(fullText, mode, targetSession, designation, {
        source: `github:${author}`,
        createdBy: author,
      });

      // Store GitHub metadata
      task.githubRepo = repo;
      task.githubIssueNumber = issueNumber;
      task.githubCommentId = comment.id;
      task.githubIsPR = isPR;
      task.githubIsReviewComment = isReview;
      taskQueue._saveState();

      log.info(`[github] Task ${task.id} created for ${repo}#${issueNumber} by @${author}`);
    } catch (err) {
      log.error(`[github] Task creation failed: ${err.message}`);
      await auth.postComment(repo, issueNumber, `🐝 Failed to create task: ${err.message}`);
      return;
    }

    // Seed checklist
    if (pm && pm.checklistTemplate && pmManager) {
      try { pmManager._seedChecklist(pm, task); } catch {}
    }

    // PM stats
    if (pm) {
      pm.tasksCreated++;
      pm.lastPoll = Date.now();
      pmManager._save();
      pmManager.emit('pm:changed');
    }

    // Acknowledge
    await auth.addReaction(repo, comment.id, 'eyes', isReview).catch(() => {});
    const pos = taskQueue.getQueuePosition(task.id);
    const posText = pos > 0 ? ` (position #${pos} in queue)` : '';
    const ackText = `🐝 Task created${posText} — dispatching to session.\n\n> ${text.slice(0, 200)}`;
    if (isReview) {
      await auth.replyToReviewComment(repo, issueNumber, comment.id, ackText)
        .catch(err => log.error(`[github] Failed to acknowledge review comment: ${err.message}`));
    } else {
      await auth.postComment(repo, issueNumber, ackText)
        .catch(err => log.error(`[github] Failed to acknowledge: ${err.message}`));
    }
  }

  // ── Poll loop ──

  async function poll() {
    if (!botUsername) {
      try {
        botUsername = await auth.getBotUsername();
      } catch (err) {
        log.error(`[github] Failed to get bot username: ${err.message}`);
        return;
      }
    }

    // Get repos to watch from all github-mentions PMs
    const repos = getWatchedRepos();
    if (repos.length === 0) return;

    for (const repo of repos) {
      try {
        await pollRepo(repo);
      } catch (err) {
        log.error(`[github] Poll error for ${repo}: ${err.message}`);
      }
    }
  }

  function getWatchedRepos() {
    if (!pmManager) return [];
    const pms = pmManager.getAll().filter(pm => pm.enabled && pm.source.type === 'github-mentions');
    const repos = new Set();
    for (const pm of pms) {
      const pmRepos = pm.source.repos || [];
      for (const r of pmRepos) repos.add(r);
    }
    return [...repos];
  }

  async function pollRepo(repo) {
    const since = lastPollTimes[repo] || new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour lookback on first poll
    const token = await auth.getTokenForRepo(repo);
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'hive-github-bot',
      'Accept': 'application/vnd.github+json',
    };

    // Fetch both issue comments and PR review comments in parallel
    const [issueComments, reviewComments] = await Promise.all([
      auth._request('GET',
        `https://api.github.com/repos/${repo}/issues/comments?since=${since}&per_page=100&sort=created&direction=asc`,
        headers
      ).catch(err => { log.error(`[github] Failed to fetch issue comments for ${repo}: ${err.message}`); return []; }),
      auth._request('GET',
        `https://api.github.com/repos/${repo}/pulls/comments?since=${since}&per_page=100&sort=created&direction=asc`,
        headers
      ).catch(err => { log.error(`[github] Failed to fetch review comments for ${repo}: ${err.message}`); return []; }),
    ]);

    lastPollTimes[repo] = new Date().toISOString();

    log.info(`[github] Poll ${repo}: since=${since}, issue_comments=${Array.isArray(issueComments) ? issueComments.length : 0}, review_comments=${Array.isArray(reviewComments) ? reviewComments.length : 0}`);

    // Normalize both comment types into a unified list
    const allComments = [];
    if (Array.isArray(issueComments)) {
      for (const c of issueComments) {
        const issueMatch = c.issue_url && c.issue_url.match(/\/issues\/(\d+)$/);
        if (issueMatch) {
          allComments.push({ ...c, _issueNumber: parseInt(issueMatch[1]), _isReviewComment: false });
        }
      }
    }
    if (Array.isArray(reviewComments)) {
      for (const c of reviewComments) {
        const prMatch = c.pull_request_url && c.pull_request_url.match(/\/pulls\/(\d+)$/);
        if (prMatch) {
          allComments.push({ ...c, _issueNumber: parseInt(prMatch[1]), _isReviewComment: true });
        }
      }
    }

    const botName = (botUsername || '').replace('[bot]', '');
    log.info(`[github] Looking for @${botName} in ${allComments.length} comments`);

    for (const comment of allComments) {
      // Skip bot's own comments
      if (comment.user && comment.user.login === botUsername) continue;
      if (comment.user && comment.user.type === 'Bot') continue;

      // Check for @mention of the bot
      const body = comment.body || '';
      const hasMention = body.toLowerCase().includes(`@${botName.toLowerCase()}`);
      if (!hasMention) continue;
      log.info(`[github] Found mention in comment ${comment.id} by ${comment.user?.login}: "${body.slice(0, 80)}..."`);

      // Dedupe: check if we've seen this comment
      const seenKey = `gh-mention-${comment.id}`;
      const pm = findGithubPM(repo);
      if (pm) {
        const seenSet = new Set(pm.seenKeys || []);
        if (seenSet.has(seenKey)) continue;
        pm.seenKeys = pm.seenKeys || [];
        pm.seenKeys.push(seenKey);
        if (pm.seenKeys.length > 5000) pm.seenKeys = pm.seenKeys.slice(-4000);
        pmManager._save();
      }

      const issueNumber = comment._issueNumber;
      log.info(`[github] New ${comment._isReviewComment ? 'review ' : ''}mention by @${comment.user.login} on ${repo}#${issueNumber}`);

      try {
        await handleMention(repo, issueNumber, comment);
      } catch (err) {
        log.error(`[github] Error handling mention on ${repo}#${issueNumber}: ${err.message}`);
      }
    }
  }

  // ── Task lifecycle callbacks ──

  if (taskQueue) {
    taskQueue.on('task:completed', async (task) => {
      if (!task.githubRepo || !task.githubIssueNumber) return;
      try {
        const duration = task.dispatchedAt
          ? Math.round((task.completedAt - task.dispatchedAt) / 60000)
          : 0;
        const snippet = task.result
          ? task.result.substring(0, 500)
          : 'No result summary.';
        await auth.postComment(task.githubRepo, task.githubIssueNumber,
          `🐝 **Task completed** (${duration}m)\n\n${snippet}`
        );
      } catch (err) {
        log.error(`[github] Completion reply error: ${err.message}`);
      }
    });

    taskQueue.on('task:failed', async (task) => {
      if (!task.githubRepo || !task.githubIssueNumber) return;
      try {
        await auth.postComment(task.githubRepo, task.githubIssueNumber,
          `🐝 **Task failed**: ${task.result || 'Unknown error'}`
        );
      } catch (err) {
        log.error(`[github] Failure reply error: ${err.message}`);
      }
    });
  }

  // ── Start polling ──

  async function start() {
    try {
      botUsername = await auth.getBotUsername();
      log.info(`[github] Bot initialized as ${botUsername}`);
    } catch (err) {
      log.error(`[github] Failed to initialize: ${err.message}`);
      return;
    }

    // Initial poll
    poll().catch(err => log.error(`[github] Initial poll error: ${err.message}`));

    // Schedule recurring polls
    pollTimer = setInterval(() => {
      poll().catch(err => log.error(`[github] Poll error: ${err.message}`));
    }, POLL_INTERVAL);

    // Listen for Scan Now from PM dashboard
    if (pmManager) {
      pmManager.on('pm:rescan', (pm) => {
        if (pm.source.type === 'github-mentions') {
          // Reset poll times so we look back further
          for (const repo of (pm.source.repos || [])) {
            delete lastPollTimes[repo];
          }
          log.info(`[github] Scan Now triggered — polling now (reset timestamps)`);
          poll().catch(err => log.error(`[github] Scan Now poll error: ${err.message}`));
        }
      });
    }
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Start immediately
  start();

  return { stop, poll, auth };
}

module.exports = { createGithubBot };
