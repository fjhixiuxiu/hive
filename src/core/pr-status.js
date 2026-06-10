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
const httpKeepAlive  = new http.Agent({  keepAlive: true, maxSockets: 4 });

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
      'Accept': 'application/json',
      ...options.headers,
    };

    // Add If-None-Match if we have a cached ETag for this URL
    const cached = etagCache.get(url);
    if (cached && cached.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers,
      agent: mod === https ? httpsKeepAlive : httpKeepAlive,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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
        }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
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
    if (review.state === 'DISMISSED') { latest.delete(login); continue; }
    latest.set(login, { login, state: review.state, submittedAt: review.submitted_at });
  }
  const reviewers = [...latest.values()];

  // Rollup: worst state wins (changes > approved > commented)
  let rollup = '';
  if (reviewers.some(r => r.state === 'CHANGES_REQUESTED')) rollup = 'CHANGES_REQUESTED';
  else if (reviewers.some(r => r.state === 'APPROVED')) rollup = 'APPROVED';
  else if (reviewers.some(r => r.state === 'COMMENTED')) rollup = 'COMMENTED';

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
  if (cached && (now - cached.ts) < CACHE_TTL) {
    return cached.data;
  }

  // Stale-while-revalidate: return stale data, refresh in background
  if (cached && cached.data && !cached.pending) {
    cached.pending = _fetch(branch, config, githubToken).then(data => {
      cache.set(branch, { data, ts: Date.now(), pending: null });
    }).catch(() => {
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
    getJenkinsStatus(
      jenkinsConfig.baseUrl,
      jenkinsConfig.jobPath,
      pr.number,
      process.env.JENKINS_USER,
      process.env.JENKINS_TOKEN,
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
  if (status !== 200 || !data) return { state: '', merged: false, draft: false, mergedAt: null };
  return {
    state: data.state || '',
    merged: !!data.merged,
    draft: !!data.draft,
    mergedAt: data.merged_at || null,
  };
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
  if (cached && (now - cached.ts) < REVIEW_CACHE_TTL) return cached.data;

  try {
    // Parallel fetch: reviews + PR meta. Both ETag-cached so 304s are free.
    const [reviews, meta] = await Promise.all([
      getReviewStatus(owner, repo, prNumber, githubToken),
      getPRMeta(owner, repo, prNumber, githubToken),
    ]);
    const data = { ...reviews, ...meta };
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
};
