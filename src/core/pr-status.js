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
const CACHE_TTL = 60_000; // 60s
const HTTP_TIMEOUT = 5_000; // 5s per API call

// Branches to skip (no PR to look up)
const SKIP_BRANCHES = new Set(['main', 'master', 'develop']);

/**
 * Make an HTTP(S) request and return parsed JSON.
 */
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    }, HTTP_TIMEOUT);

    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'hive-ai',
        'Accept': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
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
 * Returns 'APPROVED', 'CHANGES_REQUESTED', or '' (no reviews / pending).
 */
async function getReviewStatus(owner, repo, prNum, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNum}/reviews`;
  const { status, data } = await fetchJSON(url, {
    headers: { Authorization: `token ${token}` },
  });
  if (status !== 200 || !Array.isArray(data)) return '';

  // Latest non-COMMENTED review per reviewer
  const latest = new Map();
  for (const review of data) {
    if (review.state === 'COMMENTED') continue;
    latest.set(review.user.login, review.state);
  }

  if ([...latest.values()].some(s => s === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if ([...latest.values()].some(s => s === 'APPROVED')) return 'APPROVED';
  return '';
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
  const [ci, review] = await Promise.all([
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
    review,
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

module.exports = { fetch, clearCache, stats };
