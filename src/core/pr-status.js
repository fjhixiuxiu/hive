/**
 * PR/CI/Review status fetcher.
 *
 * Replaces the external cache-warmer.sh script with native API calls.
 * Given a git branch, looks up the open PR via GitHub API, fetches
 * Jenkins CI status and GitHub review state, and returns the same
 * shape that readCache() used to return from flat files.
 *
 * Cache: in-memory Map with 60s TTL, stale-while-revalidate,
 * deduped in-flight requests per branch.
 */

const https = require('https');
const http = require('http');

// In-memory cache: branch → { data, ts, pending }
const cache = new Map();
const CACHE_TTL = 300_000; // 5 minutes
const HTTP_TIMEOUT = 5_000; // 5s per API call

// Shared keep-alive agents. Without these, every request opens a fresh TCP
// socket; under sustained polling that leaks FDs on macOS until the process
// hits the per-process file-descriptor limit.
const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 4 });
const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 4 });

// ETag cache: url → { etag, data } — GitHub 304s don't count against rate limit
const etagCache = new Map();

// Branches to skip (no PR to look up)
const SKIP_BRANCHES = new Set(['main', 'master', 'develop']);

/**
 * Make an HTTP(S) request and return parsed JSON.
 * Supports ETag conditional requests — 304 responses return cached data for free.
 */
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    }, HTTP_TIMEOUT);

    const headers = {
      'User-Agent': 'hive-ai',
      Accept: 'application/json',
      ...options.headers,
    };

    // Add If-None-Match if we have a cached ETag for this URL
    const cached = etagCache.get(url);
    if (cached && cached.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(
      url,
      {
        method: options.method || 'GET',
        headers,
        agent: mod === https ? httpsKeepAlive : httpKeepAlive,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          clearTimeout(timer);
          // 304 Not Modified — return cached data (free, no rate limit cost)
          if (res.statusCode === 304 && cached) {
            return resolve({ status: 200, data: cached.data });
          }
          try {
            const parsed = JSON.parse(data);
            // Store ETag for future conditional requests
            const etag = res.headers['etag'];
            if (etag && res.statusCode === 200) {
              etagCache.set(url, { etag, data: parsed });
            }
            resolve({ status: res.statusCode, data: parsed });
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      },
    );
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/**
 * Find open PR by head branch.
 * Uses list endpoint to find the PR number, then fetches individual PR for stats.
 * Returns { number, additions, deletions, changed_files } or null.
 */
async function findPR(owner, repo, branch, token) {
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open&per_page=1`;
  const { status, data } = await fetchJSON(listUrl, {
    headers: { Authorization: `token ${token}` },
  });
  if (status !== 200 || !Array.isArray(data) || data.length === 0) return null;

  const prNum = data[0].number;

  // Fetch individual PR for additions/deletions/changed_files
  const detailUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`;
  const detail = await fetchJSON(detailUrl, {
    headers: { Authorization: `token ${token}` },
  });
  if (detail.status !== 200) {
    return { number: prNum, additions: 0, deletions: 0, changed_files: 0 };
  }

  return {
    number: prNum,
    additions: detail.data.additions || 0,
    deletions: detail.data.deletions || 0,
    changed_files: detail.data.changed_files || 0,
  };
}

/**
 * Get review status for a PR.
 * Returns { rollup, reviewers } where:
 *   rollup: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | ''
 *   reviewers: [{ login, state, submittedAt }]
 */
async function getReviewStatus(owner, repo, prNum, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/reviews`;
  const { status, data } = await fetchJSON(url, {
    headers: { Authorization: `token ${token}` },
  });
  if (status !== 200 || !Array.isArray(data)) return { rollup: '', reviewers: [] };

  // Latest review per reviewer. GitHub returns chronological; later overrides earlier.
  // DISMISSED drops the reviewer out entirely.
  const latest = new Map();
  for (const review of data) {
    const login = review.user && review.user.login;
    if (!login) continue;
    if (review.state === 'DISMISSED') {
      latest.delete(login);
      continue;
    }
    latest.set(login, { login, state: review.state, submittedAt: review.submitted_at });
  }
  const reviewers = [...latest.values()];

  // Rollup: worst state wins (changes > approved > commented)
  let rollup = '';
  if (reviewers.some((r) => r.state === 'CHANGES_REQUESTED')) rollup = 'CHANGES_REQUESTED';
  else if (reviewers.some((r) => r.state === 'APPROVED')) rollup = 'APPROVED';
  else if (reviewers.some((r) => r.state === 'COMMENTED')) rollup = 'COMMENTED';

  return { rollup, reviewers };
}

/**
 * Get Jenkins CI status for a PR.
 * Returns { result, build } where result is SUCCESS/FAILURE/UNSTABLE/RUNNING/null.
 */
async function getJenkinsStatus(baseUrl, jobPath, prNum, user, apiToken) {
  if (!baseUrl || !user || !apiToken) return { result: '', build: '' };

  const url = `${baseUrl}/${jobPath}/PR-${prNum}/lastBuild/api/json?tree=number,result`;
  const auth = Buffer.from(`${user}:${apiToken}`).toString('base64');
  try {
    const { status, data } = await fetchJSON(url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (status !== 200) return { result: '', build: '' };
    return {
      result: data.result || 'RUNNING', // null result = still building
      build: String(data.number || ''),
    };
  } catch {
    return { result: '', build: '' };
  }
}

// Worst-state-wins ranking for aggregating multiple CI pipelines.
const CI_RANK = { FAILURE: 5, UNSTABLE: 4, ABORTED: 3, RUNNING: 2, SUCCESS: 1, '': 0 };

/**
 * Aggregate per-pipeline CI statuses into a single badge state.
 * Worst state wins: FAILURE > UNSTABLE > ABORTED > RUNNING > SUCCESS > none.
 * Pure — exposed for unit tests.
 */
function aggregateCi(statuses) {
  let worst = { result: '', build: '', job: '' };
  for (const s of statuses) {
    if ((CI_RANK[s.result] || 0) > (CI_RANK[worst.result] || 0)) worst = s;
  }
  return worst;
}

/**
 * Get aggregated Jenkins CI status across all configured PR pipelines.
 * Returns { result, build, job } for the pipeline in the worst state,
 * so badge links point at the run that needs attention.
 */
async function getJenkinsStatusMulti(baseUrl, jobPaths, prNum, user, apiToken) {
  const paths = (Array.isArray(jobPaths) ? jobPaths : [jobPaths]).filter(Boolean);
  if (!paths.length) return { result: '', build: '', job: '' };
  const statuses = await Promise.all(
    paths.map(async (p) => {
      const s = await getJenkinsStatus(baseUrl, p, prNum, user, apiToken);
      return { ...s, job: p };
    }),
  );
  return aggregateCi(statuses);
}

/**
 * Fetch PR/CI/review status for a branch.
 *
 * @param {string} branch - git branch name
 * @param {object} config - hive config (needs config.github, config.jenkins, env vars)
 * @returns {Promise<{prNum, prAdds, prDels, prFiles, ciResult, ciBuild, review}|null>}
 */
async function fetch(branch, config) {
  if (!branch || SKIP_BRANCHES.has(branch)) return null;

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return null;

  // Check cache
  const cached = cache.get(branch);
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  // Stale-while-revalidate: return stale data, refresh in background
  if (cached && cached.data && !cached.pending) {
    cached.pending = _fetch(branch, config, githubToken)
      .then((data) => {
        cache.set(branch, { data, ts: Date.now(), pending: null });
      })
      .catch(() => {
        cached.pending = null;
      });
    return cached.data;
  }

  // Dedup in-flight requests
  if (cached && cached.pending) {
    await cached.pending;
    const result = cache.get(branch);
    return result ? result.data : null;
  }

  // Fresh fetch
  const pending = _fetch(branch, config, githubToken);
  cache.set(branch, { data: null, ts: 0, pending });
  try {
    const data = await pending;
    cache.set(branch, { data, ts: Date.now(), pending: null });
    return data;
  } catch (err) {
    cache.delete(branch);
    return null;
  }
}

/**
 * Internal: do the actual API calls.
 */
async function _fetch(branch, config, githubToken) {
  const ghConfig = config.github || {};
  const repo = ghConfig.repo || '';
  if (!repo) return null;

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return null;

  // Step 1: Find PR
  const pr = await findPR(owner, repoName, branch, githubToken);
  if (!pr) return null;

  // Step 2: Get CI + review in parallel
  const jenkinsConfig = config.jenkins || {};
  const [ci, reviewInfo] = await Promise.all([
    getJenkinsStatusMulti(
      jenkinsConfig.baseUrl,
      jenkinsConfig.jobPaths || jenkinsConfig.jobPath,
      pr.number,
      process.env.JENKINS_USER,
      // JENKINS_API_TOKEN is the documented var (integrations UI, PM sources);
      // JENKINS_TOKEN kept as legacy fallback.
      process.env.JENKINS_API_TOKEN || process.env.JENKINS_TOKEN,
    ),
    getReviewStatus(owner, repoName, pr.number, githubToken),
  ]);

  return {
    prNum: String(pr.number),
    prAdds: String(pr.additions),
    prDels: String(pr.deletions),
    prFiles: String(pr.changed_files),
    ciResult: ci.result,
    ciBuild: ci.build,
    ciJob: ci.job,
    review: reviewInfo.rollup,
    reviewers: reviewInfo.reviewers,
  };
}

/**
 * Clear the cache (e.g. on config reload).
 */
function clearCache() {
  cache.clear();
}

/**
 * Get cache stats for debugging.
 */
function stats() {
  return {
    entries: cache.size,
    branches: [...cache.keys()],
  };
}

/**
 * Return cached PR data for a branch without triggering any API call.
 * Returns null if not cached.
 */
function getCached(branch) {
  if (!branch || SKIP_BRANCHES.has(branch)) return null;
  const cached = cache.get(branch);
  return (cached && cached.data) || null;
}

// Per-PR review cache for task-driven lookups (key: owner/repo#prNum)
const reviewCache = new Map();
const REVIEW_CACHE_TTL = 60_000; // 1 min — lazy/on-demand, freshness matters

/**
 * Get PR meta — open/closed/merged/draft state.
 * Returns { state, merged, draft, mergedAt }. state is 'open'|'closed'.
 * merged is true when the closed PR was merged (vs. just closed unmerged).
 */
async function getPRMeta(owner, repo, prNum, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}`;
  const { status, data } = await fetchJSON(url, {
    headers: { Authorization: `token ${token}` },
  });
  if (status !== 200 || !data) {
    return {
      state: '',
      merged: false,
      draft: false,
      mergedAt: null,
      headSha: null,
      title: '',
      author: '',
      authorAvatar: '',
      baseBranch: '',
      headBranch: '',
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      mergedBy: '',
      mergedByAvatar: '',
      updatedAt: null,
      createdAt: null,
      mergeable: null,
      mergeableState: '',
    };
  }
  return {
    state: data.state || '',
    merged: !!data.merged,
    draft: !!data.draft,
    mergedAt: data.merged_at || null,
    headSha: data.head && data.head.sha ? data.head.sha : null,
    title: data.title || '',
    author: data.user && data.user.login ? data.user.login : '',
    authorAvatar: data.user && data.user.avatar_url ? data.user.avatar_url : '',
    baseBranch: data.base && data.base.ref ? data.base.ref : '',
    headBranch: data.head && data.head.ref ? data.head.ref : '',
    additions: data.additions || 0,
    deletions: data.deletions || 0,
    changedFiles: data.changed_files || 0,
    mergedBy: data.merged_by && data.merged_by.login ? data.merged_by.login : '',
    mergedByAvatar: data.merged_by && data.merged_by.avatar_url ? data.merged_by.avatar_url : '',
    updatedAt: data.updated_at || null,
    createdAt: data.created_at || null,
    mergeable: data.mergeable, // null | true | false
    mergeableState: data.mergeable_state || '',
  };
}

/**
 * Get combined CI/check rollup for a commit SHA.
 * Uses GitHub's combined status API which merges:
 *   - Statuses (Jenkins-style external status reports)
 *   - Check runs (GitHub Actions / check-suite reports)
 * Returns 'success' | 'failure' | 'pending' | 'error' | null.
 */
async function getCIRollup(owner, repo, sha, token) {
  if (!sha) return null;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`;
  try {
    const { status, data } = await fetchJSON(url, {
      headers: { Authorization: `token ${token}` },
    });
    if (status !== 200 || !data) return null;
    // data.state is 'success' | 'failure' | 'pending' (statuses-only rollup).
    // total_count = 0 means no statuses ever posted — treat as null, not pending.
    if (data.total_count === 0) return null;
    return data.state || null;
  } catch {
    return null;
  }
}

/**
 * Get per-check breakdown for a commit SHA.
 * Merges two GitHub sources into a single unified list:
 *   - "Statuses" (Jenkins-style external reports): /commits/{sha}/status
 *   - "Check runs" (GitHub Actions, etc.): /commits/{sha}/check-runs
 *
 * Returns array of { name, state, url, durationMs }
 *   state ∈ {success, failure, pending, neutral, skipped, cancelled}
 *   durationMs: null when still running
 */
async function getCheckDetails(owner, repo, sha, token) {
  if (!sha) return [];
  try {
    const [statusRes, checksRes] = await Promise.all([
      fetchJSON(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`, {
        headers: { Authorization: `token ${token}` },
      }).catch(() => ({ status: 0, data: null })),
      fetchJSON(
        `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=50`,
        {
          headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
        },
      ).catch(() => ({ status: 0, data: null })),
    ]);

    const out = [];
    // 1. Statuses (commit status API). Latest per context.
    if (statusRes.status === 200 && statusRes.data && Array.isArray(statusRes.data.statuses)) {
      for (const s of statusRes.data.statuses) {
        out.push({
          name: s.context || '(unnamed status)',
          state: normaliseState(s.state),
          url: s.target_url || '',
          durationMs: null, // status API doesn't carry timing
        });
      }
    }
    // 2. Check-runs (GitHub Actions). Each run has status (in_progress/completed)
    //    and conclusion (success/failure/skipped/neutral/cancelled/timed_out).
    if (checksRes.status === 200 && checksRes.data && Array.isArray(checksRes.data.check_runs)) {
      for (const c of checksRes.data.check_runs) {
        let state;
        // 'completed' here is GitHub's check-run status, not hive's task
        // status. Different vocabulary, same word — it must not be folded into
        // TaskStatus, so the rule is suppressed rather than satisfied.
        // eslint-disable-next-line no-restricted-syntax -- GitHub check-run status
        if (c.status === 'completed') state = normaliseState(c.conclusion);
        else state = 'pending'; // queued or in_progress
        let durationMs = null;
        if (c.started_at && c.completed_at) {
          const start = Date.parse(c.started_at);
          const end = Date.parse(c.completed_at);
          if (!isNaN(start) && !isNaN(end) && end >= start) durationMs = end - start;
        }
        out.push({
          name: c.name || '(unnamed check)',
          state,
          url: c.html_url || c.details_url || '',
          durationMs,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function normaliseState(s) {
  if (!s) return 'pending';
  const v = String(s).toLowerCase();
  if (v === 'success' || v === 'passed') return 'success';
  if (v === 'failure' || v === 'failed' || v === 'error' || v === 'timed_out') return 'failure';
  if (v === 'skipped') return 'skipped';
  if (v === 'cancelled' || v === 'canceled') return 'cancelled';
  if (v === 'neutral') return 'neutral';
  if (v === 'pending' || v === 'queued' || v === 'in_progress') return 'pending';
  return 'pending';
}

/**
 * Fetch review status + PR meta for a specific PR (bypasses branch→PR lookup).
 * Used when the task already knows its target PR (e.g. re-review tasks).
 *
 * @param {string} owner - GitHub org/user
 * @param {string} repo  - GitHub repo name
 * @param {string|number} prNumber
 * @returns {Promise<{rollup, reviewers, state, merged, draft, mergedAt}|null>}
 */
async function fetchReviewByPR(owner, repo, prNumber) {
  if (!owner || !repo || !prNumber) return null;
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) return null;

  const key = `${owner}/${repo}#${prNumber}`;
  const cached = reviewCache.get(key);
  const now = Date.now();
  if (cached && now - cached.ts < REVIEW_CACHE_TTL) return cached.data;

  try {
    // Parallel fetch: reviews + PR meta. Both ETag-cached so 304s are free.
    const [reviews, meta] = await Promise.all([
      getReviewStatus(owner, repo, prNumber, githubToken),
      getPRMeta(owner, repo, prNumber, githubToken),
    ]);
    // CI lookups need the head SHA from meta. Skip CI when PR is closed.
    let ciState = null;
    let checks = [];
    if (!meta.merged && meta.state !== 'closed' && meta.headSha) {
      const [rollup, details] = await Promise.all([
        getCIRollup(owner, repo, meta.headSha, githubToken),
        getCheckDetails(owner, repo, meta.headSha, githubToken),
      ]);
      ciState = rollup;
      checks = details;
    }
    const data = { ...reviews, ...meta, ciState, checks };
    reviewCache.set(key, { data, ts: now });
    return data;
  } catch {
    return cached ? cached.data : null;
  }
}

module.exports = {
  fetch,
  getCached,
  clearCache,
  stats,
  fetchReviewByPR,
  // Internal — exposed for unit tests; matches the `_httpRequest` pattern in pm-sources.js.
  _fetchJSON: fetchJSON,
  _aggregateCi: aggregateCi,
};
