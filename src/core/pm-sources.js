const https = require('https');
const http = require('http');
const log = require('./log');

const MCP_INSTRUCTIONS = `
## Hive Integration

You have hive MCP tools available. Use them:

1. **Start**: Call \`hive_get_task\` to see your full assignment before doing anything. Call \`hive_get_context\` to check for any shared context (plan files, PR URLs, JIRA keys) from previous work on this task.
2. **Knowledge**: Before diving in, call \`hive_get_knowledge\` with the domain or file names relevant to your task. This returns insights from other sessions that have worked on the same code — gotchas, patterns, and things that failed. Use this knowledge to avoid repeating mistakes.
3. **Progress updates**: Call \`hive_post_update\` at key milestones — when you have a plan, when implementation is done, or if you hit a blocker.
4. **Context sharing**: Call \`hive_set_context\` to share key information with the dashboard. Set \`"plan"\` (absolute file path), \`"pr"\` (GitHub PR URL), \`"jira"\` (issue key), \`"branch"\` (git branch), or \`"planText"\` (markdown summary). Update context as things change. Set a key to \`null\` to remove it.
5. **Coordination**: If your task mentions other sessions or dependencies, call \`hive_get_sessions\` to check their status.
6. **Finish**: Do NOT call \`hive_complete_task\` unless the task instructions explicitly tell you to. The task owner will close it manually or it will close when you go idle.
7. **Share knowledge**: Before finishing, call \`hive_share_knowledge\` with insights you discovered — include the specific file paths and domain (e.g. "evv", "billing", "booking"). This builds the fleet's shared knowledge base so other sessions benefit from your work.
8. **Learnings**: If learning mode is active, also call \`hive_report_learnings\` with insights for your PM's local memory.
`.trim();

// ── HTTP layer ──────────────────────────────────────────

function _httpRequest(urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;

    const options = {
      method: body ? 'POST' : 'GET',
      headers: { ...headers },
      timeout: 30000,
    };

    const req = mod.request(urlStr, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${e.message}`));
          }
        } else {
          // Extract clean error: JSON message if possible, otherwise just the status code
          let detail = `HTTP ${res.statusCode}`;
          try { const j = JSON.parse(data); if (j.message) detail += `: ${j.message}`; } catch {
            if (res.statusCode >= 500) detail += ' (server error, will retry)';
          }
          reject(new Error(detail));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

function _httpMethod(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : '';
    const reqHeaders = { ...headers, 'Content-Type': 'application/json' };
    if (data) reqHeaders['Content-Length'] = Buffer.byteLength(data);
    const req = mod.request(urlStr, {
      method,
      headers: reqHeaders,
      timeout: 30000,
    }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => resBody += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(resBody)); } catch { resolve(resBody); }
        } else {
          let detail = `HTTP ${res.statusCode}`;
          try { const j = JSON.parse(resBody); if (j.message) detail += `: ${j.message}`; } catch {
            if (res.statusCode >= 500) detail += ' (server error, will retry)';
          }
          reject(new Error(detail));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

function _httpPost(urlStr, headers, body) {
  return this._httpMethod('POST', urlStr, headers, body);
}

// ── GitHub helpers ──────────────────────────────────────

function _githubHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured');
  return { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'hive-pm' };
}

async function _resolveGithubLogin() {
  try {
    const data = await this._httpRequest('https://api.github.com/user', this._githubHeaders());
    if (data && data.login) {
      this._githubLogin = data.login;
      log.info(`[pm] GitHub token belongs to @${data.login}`);
    }
  } catch (err) {
    log.error('[pm] Could not resolve GitHub login:', err.message);
  }
}

async function _commentOnPR(repo, prNumber, body) {
  const headers = this._githubHeaders();
  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  await this._httpPost(url, headers, { body });
}

function _parsePRFromKey(key) {
  // re-review-org/repo#123-commentId
  let m = key.match(/^re-review-(.+?)#(\d+)/);
  if (m) return { repo: m[1], prNumber: parseInt(m[2]) };
  // org/repo#123
  m = key.match(/^(.+?)#(\d+)/);
  if (m) return { repo: m[1], prNumber: parseInt(m[2]) };
  return null;
}

function _hasActiveTaskForPR(repo, number) {
  const pattern = `${repo}#${number}`;
  for (const task of this.taskQueue.tasks.values()) {
    if ((task.status === 'queued' || task.status === 'dispatched') && task.text.includes(pattern)) {
      return true;
    }
  }
  return false;
}

// ── Source fetchers ─────────────────────────────────────

async function _fetchJira(source) {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!baseUrl || !email || !apiToken) {
    throw new Error('JIRA credentials not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
  }

  const jql = source.jql || '';
  const fields = ['summary', 'issuetype', 'customfield_10016', 'priority', 'labels'];
  const urlStr = `${baseUrl}/rest/api/3/search/jql`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  const data = await this._httpRequest(urlStr, {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }, JSON.stringify({ jql, fields, maxResults: 50 }));
  return (data.issues || []).map(i => ({
    key: i.key,
    summary: i.fields.summary,
    issueType: i.fields.issuetype ? i.fields.issuetype.name : '',
    storyPoints: i.fields.customfield_10016,
  }));
}

async function _fetchGithubIssues(source) {
  // Raw query mode — pass directly to Search API
  if (source.query) {
    const q = source.query.includes('is:issue') ? source.query : `is:issue ${source.query}`;
    const params = new URLSearchParams({ q, per_page: '50', sort: 'created', order: 'desc' });
    const urlStr = `https://api.github.com/search/issues?${params}`;
    const data = await this._httpRequest(urlStr, this._githubHeaders());
    return (data && data.items ? data.items : []).map(item => ({
      key: `${item.repository_url ? item.repository_url.replace('https://api.github.com/repos/', '') : 'unknown'}#${item.number}`,
      summary: item.title,
      issueType: 'issue',
      storyPoints: null,
    }));
  }

  if (!source.repo) throw new Error('GitHub repo not configured');
  const params = new URLSearchParams({ per_page: '50' });
  if (source.labels) params.set('labels', source.labels);
  if (source.state) params.set('state', source.state);
  const urlStr = `https://api.github.com/repos/${source.repo}/issues?${params}`;

  const data = await this._httpRequest(urlStr, this._githubHeaders());
  const authorFilter = source.author ? source.author.toLowerCase() : null;
  const excludeSet = source.excludeLabels
    ? new Set(source.excludeLabels.split(',').map(l => l.trim().toLowerCase()).filter(Boolean))
    : null;
  return (Array.isArray(data) ? data : [])
    .filter(i => !i.pull_request) // exclude PRs from issues endpoint
    .filter(i => !authorFilter || (i.user && i.user.login.toLowerCase() === authorFilter))
    .filter(i => !excludeSet || !i.labels.some(l => excludeSet.has(l.name.toLowerCase())))
    .map(i => ({
      key: `${source.repo}#${i.number}`,
      summary: i.title,
      issueType: 'issue',
      storyPoints: null,
    }));
}

async function _fetchGithubPrs(source) {
  // Raw query mode — pass directly to Search API
  if (source.query) {
    return this._fetchGithubPrsViaSearch(source);
  }

  if (!source.repo) throw new Error('GitHub repo not configured');

  const hasLabels = source.labels && source.labels.trim();
  const hasExcludeLabels = source.excludeLabels && source.excludeLabels.trim();

  // When labels are specified, use the Search API (Pulls API ignores labels param).
  // Search API supports labels, base, author, and state natively.
  if (hasLabels || hasExcludeLabels) {
    return this._fetchGithubPrsViaSearch(source);
  }

  // No label filters — use the Pulls API (faster, no rate limit concerns)
  const allowedBases = source.base
    ? source.base.split(',').map(b => b.trim()).filter(Boolean)
    : ['main', 'master'];

  const allPrs = [];
  for (const base of allowedBases) {
    const params = new URLSearchParams({ per_page: '100', base });
    if (source.state) params.set('state', source.state);
    const urlStr = `https://api.github.com/repos/${source.repo}/pulls?${params}`;
    const data = await this._httpRequest(urlStr, this._githubHeaders());
    if (Array.isArray(data)) allPrs.push(...data);
  }

  const baseSet = new Set(allowedBases);
  const authorFilter = source.author ? source.author.toLowerCase() : null;
  const excludeSet = new Set((source.excludeAuthors || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  return allPrs
    .filter(pr => baseSet.has(pr.base && pr.base.ref) && !pr.draft)
    .filter(pr => !authorFilter || (pr.user && pr.user.login.toLowerCase() === authorFilter))
    .filter(pr => !excludeSet.size || !excludeSet.has((pr.user && pr.user.login || '').toLowerCase()))
    .map(pr => ({
      key: `${source.repo}#${pr.number}`,
      summary: pr.title,
      issueType: 'pr',
      storyPoints: null,
    }));
}

async function _fetchGithubPrsViaSearch(source) {
  let q;
  if (source.query) {
    // Raw query — use directly, ensure is:pr is included
    q = source.query.includes('is:pr') ? source.query : `is:pr ${source.query}`;
  } else {
    // Build GitHub Search query: is:pr + repo + state + labels + excludeLabels + base + author
    const parts = ['is:pr', `repo:${source.repo}`];
    if (source.state && source.state !== 'all') parts.push(`is:${source.state}`);
    if (source.labels) {
      for (const l of source.labels.split(',').map(s => s.trim()).filter(Boolean)) {
        parts.push(l.includes(' ') ? `label:"${l}"` : `label:${l}`);
      }
    }
    if (source.excludeLabels) {
      for (const l of source.excludeLabels.split(',').map(s => s.trim()).filter(Boolean)) {
        parts.push(l.includes(' ') ? `-label:"${l}"` : `-label:${l}`);
      }
    }
    if (source.base) parts.push(`base:${source.base}`);
    if (source.author) parts.push(`author:${source.author}`);
    if (source.excludeAuthors) {
      for (const a of source.excludeAuthors.split(',').map(s => s.trim()).filter(Boolean)) {
        parts.push(`-author:${a}`);
      }
    }
    parts.push('-is:draft');
    q = parts.join(' ');
  }
  const params = new URLSearchParams({ q, per_page: '50', sort: 'created', order: 'desc' });
  const urlStr = `https://api.github.com/search/issues?${params}`;
  const data = await this._httpRequest(urlStr, this._githubHeaders());
  const items = data && data.items ? data.items : [];

  return items.map(item => {
    const repo = source.repo || (item.repository_url ? item.repository_url.replace('https://api.github.com/repos/', '') : 'unknown');
    return {
      key: `${repo}#${item.number}`,
      summary: item.title,
      issueType: 'pr',
      storyPoints: null,
    };
  });
}

async function _fetchJenkins(source) {
  const baseUrl = process.env.JENKINS_URL;
  const user = process.env.JENKINS_USER;
  const token = process.env.JENKINS_API_TOKEN;
  if (!baseUrl || !user || !token) throw new Error('Jenkins credentials not configured (JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN)');
  if (!source.jobPath) throw new Error('Jenkins job path not configured');

  const urlStr = `${baseUrl}/job/${source.jobPath}/api/json?tree=builds[number,result,timestamp,url]{0,20}`;
  const auth = Buffer.from(`${user}:${token}`).toString('base64');

  const data = await this._httpRequest(urlStr, {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
  });
  return (data.builds || [])
    .filter(b => b.result === 'FAILURE')
    .map(b => ({
      key: `jenkins-${b.number}`,
      summary: `Build #${b.number} failed — ${source.jobPath}`,
      issueType: 'bug',
      storyPoints: null,
    }));
}

async function _refreshZohoToken() {
  const clientId = process.env.ZOHO_DESK_CLIENT_ID;
  const clientSecret = process.env.ZOHO_DESK_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_DESK_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho OAuth refresh credentials not configured (ZOHO_DESK_CLIENT_ID, ZOHO_DESK_CLIENT_SECRET, ZOHO_DESK_REFRESH_TOKEN)');
  }
  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Zoho token refresh failed: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh returned no access_token');
  this._zohoAccessToken = data.access_token;
  this._zohoTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000; // refresh 1 min early
  return this._zohoAccessToken;
}

async function _getZohoToken() {
  // Return cached token if still valid
  if (this._zohoAccessToken && this._zohoTokenExpiry && Date.now() < this._zohoTokenExpiry) {
    return this._zohoAccessToken;
  }
  // Fall back to static token if set
  if (process.env.ZOHO_DESK_API_TOKEN) return process.env.ZOHO_DESK_API_TOKEN;
  return this._refreshZohoToken();
}

async function _fetchZoho(source) {
  const orgId = process.env.ZOHO_DESK_ORG_ID;
  if (!orgId) throw new Error('ZOHO_DESK_ORG_ID not configured');
  const token = await this._getZohoToken();

  let urlStr;
  if (source.query) {
    const params = new URLSearchParams({ searchStr: source.query, limit: '50' });
    if (source.department) params.set('departmentId', source.department);
    if (source.status) params.set('status', source.status);
    urlStr = `https://desk.zoho.com/api/v1/tickets/search?${params}`;
  } else {
    const params = new URLSearchParams({ limit: '50' });
    if (source.department) params.set('departmentId', source.department);
    if (source.status) params.set('status', source.status);
    urlStr = `https://desk.zoho.com/api/v1/tickets?${params}`;
  }

  const data = await this._httpRequest(urlStr, {
    'Authorization': `Zoho-oauthtoken ${token}`,
    'orgId': orgId,
    'Accept': 'application/json',
  });
  const tickets = data.data || data || [];
  const since = source.since ? new Date(source.since).getTime() : 0;
  return (Array.isArray(tickets) ? tickets : [])
    .filter(t => {
      if (!since) return true;
      const created = new Date(t.createdTime).getTime();
      return created >= since;
    })
    .map(t => ({
      key: `zoho-${t.ticketNumber || t.id}`,
      summary: t.subject || t.description || '',
      issueType: 'ticket',
      storyPoints: null,
    }));
}

async function _fetchReReviews(source, pmId) {
  if (!source.repo) throw new Error('GitHub repo not configured');
  if (!source.reviewer) throw new Error('Reviewer username not configured');

  const triggers = (source.triggerPhrases || 'ready for review,ptal,please review,addressed')
    .split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (triggers.length === 0) throw new Error('No trigger phrases configured');

  const headers = this._githubHeaders();

  // 1. Fetch all open PRs (paginate — repos can have >100 open PRs)
  let prs = [];
  let page = 1;
  while (true) {
    const prsUrl = `https://api.github.com/repos/${source.repo}/pulls?state=open&per_page=100&page=${page}`;
    const batch = await this._httpRequest(prsUrl, headers);
    if (!Array.isArray(batch) || batch.length === 0) break;
    prs.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  const results = [];
  const reviewer = source.reviewer.toLowerCase();
  const excludeSet = new Set((source.excludeAuthors || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

  for (const pr of prs) {
    if (pr.draft) continue;
    if (excludeSet.size && excludeSet.has((pr.user && pr.user.login || '').toLowerCase())) continue;
    // Skip PRs not updated since this PM's last poll (2 min buffer for clock/propagation lag)
    if (!this._reReviewPollTimes) this._reReviewPollTimes = {};
    const lastPoll = this._reReviewPollTimes[pmId];
    if (lastPoll && new Date(pr.updated_at).getTime() < lastPoll - 120000) continue;

    // 2. Fetch recent issue comments (last 48h) and check for trigger phrases
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const commentsUrl = `https://api.github.com/repos/${source.repo}/issues/${pr.number}/comments?since=${since}&per_page=100`;
    let comments;
    try { comments = await this._httpRequest(commentsUrl, headers); } catch (e) { continue; }
    if (!Array.isArray(comments)) continue;

    for (const comment of comments) {
      // Skip bot comments (hive prefix, GitHub [bot] users, and HTML/markdown-heavy bot posts)
      if (comment.body && comment.body.startsWith('\u{1F41D}')) continue;
      const login = (comment.user && comment.user.login) || '';
      if (login.endsWith('[bot]') || comment.user?.type === 'Bot') continue;

      const rawBody = comment.body || '';
      if (rawBody.length > 500) continue; // Skip long bot summaries / auto-generated comments
      const body = rawBody.toLowerCase();
      if (!triggers.some(t => body.includes(t))) continue;

      // If there's already a queued/dispatched task, flag it for "already queued" reply
      if (this._hasActiveTaskForPR(source.repo, pr.number)) {
        results.push({
          key: `re-review-${source.repo}#${pr.number}-${comment.id}`,
          summary: `Re-review PR #${pr.number}: ${pr.title}`,
          issueType: 'pr',
          storyPoints: null,
          _alreadyQueued: true,
          _repo: source.repo,
          _prNumber: pr.number,
        });
        continue;
      }

      results.push({
        key: `re-review-${source.repo}#${pr.number}-${comment.id}`,
        summary: `Re-review PR #${pr.number}: ${pr.title}`,
        issueType: 'pr',
        storyPoints: null,
        _repo: source.repo,
        _prNumber: pr.number,
      });
    }
  }

  if (!this._reReviewPollTimes) this._reReviewPollTimes = {};
  this._reReviewPollTimes[pmId] = Date.now();
  return results;
}

// ── Checklist seeding ───────────────────────────────────

function _seedChecklist(pm, task) {
  if (!pm.checklistTemplate || !task) return;
  const tpl = this.taskQueue.checklistTemplates.get(pm.checklistTemplate);
  if (!tpl || !tpl.items || !tpl.items.length) return;
  const checklist = tpl.items.map(text => ({
    id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    checked: false,
  }));
  task.checklist = checklist;
  this.taskQueue.emit('task:updated', task);
  this.taskQueue._saveState();
}

// ── Task text enrichment ────────────────────────────────

function enrichTaskText(task) {
  if (!task.source || !task.source.startsWith('pm:')) {
    // Non-PM tasks still get MCP instructions so agents know not to auto-complete
    return task.text + `\n\n${MCP_INSTRUCTIONS}`;
  }
  const pmName = task.source.replace('pm:', '');
  const pm = [...this.pms.values()].find(p => p.name === pmName);
  if (!pm) return task.text + `\n\n${MCP_INSTRUCTIONS}`;
  return this._buildFullText(pm, task.text);
}

function _buildFullText(pm, text) {
  let result = text;
  if (pm.instructions) result += `\n\nInstructions: ${pm.instructions}`;
  if (pm.slackUserId) {
    const ids = pm.slackUserId.split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length === 1) {
      result += `\n\n## PM Slack Contact\n\nThe PM assignee for this task has Slack User ID: \`${ids[0]}\`. When asked to report status to the PM, send a Slack DM to this user ID.`;
    } else if (ids.length > 1) {
      const formatted = ids.map(id => `\`${id}\``).join(', ');
      result += `\n\n## PM Slack Contacts\n\nThe PM assignees for this task have Slack User IDs: ${formatted}. When asked to report status to the PMs, send a Slack DM to each of these user IDs.`;
    }
  }
  if (pm.mcpEnabled) result += `\n\n${MCP_INSTRUCTIONS}`;
  if (pm.learningEnabled && pm.learningPrompt) {
    result += '\n\n## Learning\n\n';
    result += 'After completing this task, call `hive_report_learnings` with NEW insights you discovered.\n\n';
    result += 'Focus on: ' + pm.learningPrompt + '\n';
  }
  return result;
}

// ── Export all methods as prototype mixin ────────────────

// ── Nectar source ─────────────────────────────────────

/**
 * Fetch pending tasks from a Nectar instance.
 * Source config: { type: 'nectar', url: '...', apiKey: '...' }
 * Returns tasks in the standard { key, summary } format for PM consumption.
 */
async function _fetchNectar(source) {
  const url = source.url || process.env.NECTAR_URL;
  const apiKey = source.apiKey || process.env.NECTAR_API_KEY;

  if (!url) throw new Error('Nectar URL not configured (source.url or NECTAR_URL)');
  if (!apiKey) throw new Error('Nectar API key not configured (source.apiKey or NECTAR_API_KEY)');

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  const tasks = await _httpRequest(`${url}/api/tasks?status=pending`, headers);
  const items = Array.isArray(tasks) ? tasks : tasks.tasks || [];

  return items.map(t => ({
    key: t.id,
    summary: `[${t.type}] ${t.input?.version || 'unknown'} — ${t.input?.tickets?.length || 0} tickets`,
    _nectarTask: t, // Attach full task data for enrichment
  }));
}

/**
 * Claim a Nectar task (set status to in-progress).
 * Called after a task is dispatched to a session.
 */
async function _claimNectarTask(source, taskId) {
  const url = source.url || process.env.NECTAR_URL;
  const apiKey = source.apiKey || process.env.NECTAR_API_KEY;
  if (!url || !apiKey) return;

  try {
    await _httpMethod('PATCH', `${url}/api/tasks/${taskId}`, {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    }, { status: 'in-progress' });
  } catch (err) {
    log.error(`Failed to claim Nectar task ${taskId}: ${err.message}`);
  }
}

module.exports = {
  // HTTP
  _httpRequest,
  _httpMethod,
  _httpPost,
  // GitHub
  _githubHeaders,
  _resolveGithubLogin,
  _commentOnPR,
  _parsePRFromKey,
  _hasActiveTaskForPR,
  // Source fetchers
  _fetchJira,
  _fetchGithubIssues,
  _fetchGithubPrs,
  _fetchGithubPrsViaSearch,
  _fetchJenkins,
  _refreshZohoToken,
  _getZohoToken,
  _fetchZoho,
  _fetchReReviews,
  _fetchNectar,
  _claimNectarTask,
  // Helpers
  _seedChecklist,
  enrichTaskText,
  _buildFullText,
};
