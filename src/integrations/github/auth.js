const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const log = require('../../core/log');

/**
 * GitHub App authentication — JWT signing + installation token management.
 * No external dependencies; uses Node's built-in crypto module.
 */
class GitHubAppAuth {
  constructor(opts = {}) {
    this.appId = opts.appId || process.env.GITHUB_APP_ID;
    const keyPath = opts.privateKeyPath || process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    if (!this.appId || !keyPath) {
      throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH required');
    }

    // Resolve key path relative to project root
    const resolved = path.isAbsolute(keyPath) ? keyPath : path.join(__dirname, '..', '..', '..', keyPath);
    this.privateKey = fs.readFileSync(resolved, 'utf8');

    this._installationTokens = new Map(); // installationId → { token, expiresAt }
    this._installations = null; // cached list
    this._botUsername = null;
  }

  // ── JWT generation (RS256, 10 min expiry) ──

  generateJWT() {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat: now - 60, exp: now + 600, iss: this.appId };

    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${encode(header)}.${encode(payload)}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), this.privateKey);

    return `${unsigned}.${signature.toString('base64url')}`;
  }

  // ── HTTP helper ──

  _request(method, urlStr, headers, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = https.request(urlStr, {
        method,
        headers: {
          'User-Agent': 'hive-github-bot',
          'Accept': 'application/vnd.github+json',
          ...headers,
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve(data); }
          } else {
            let detail = `HTTP ${res.statusCode}`;
            try { const j = JSON.parse(data); if (j.message) detail += `: ${j.message}`; } catch {}
            reject(new Error(detail));
          }
        });
      });
      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  // ── Installation management ──

  async getInstallations() {
    if (this._installations) return this._installations;
    const jwt = this.generateJWT();
    const data = await this._request('GET', 'https://api.github.com/app/installations', {
      Authorization: `Bearer ${jwt}`,
    });
    this._installations = Array.isArray(data) ? data : [];
    // Refresh cache every 30 min
    setTimeout(() => { this._installations = null; }, 30 * 60 * 1000);
    return this._installations;
  }

  async getInstallationForRepo(owner) {
    const installations = await this.getInstallations();
    return installations.find(i =>
      i.account && i.account.login.toLowerCase() === owner.toLowerCase()
    );
  }

  async getInstallationToken(installationId) {
    const cached = this._installationTokens.get(installationId);
    if (cached && Date.now() < cached.expiresAt - 60000) {
      return cached.token;
    }

    const jwt = this.generateJWT();
    const data = await this._request('POST',
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { Authorization: `Bearer ${jwt}` }
    );

    const token = data.token;
    const expiresAt = new Date(data.expires_at).getTime();
    this._installationTokens.set(installationId, { token, expiresAt });
    return token;
  }

  async getTokenForRepo(repo) {
    const owner = repo.split('/')[0];
    const installation = await this.getInstallationForRepo(owner);
    if (!installation) throw new Error(`No GitHub App installation for ${owner}`);
    return this.getInstallationToken(installation.id);
  }

  // ── Bot identity ──

  async getBotUsername() {
    if (this._botUsername) return this._botUsername;
    const jwt = this.generateJWT();
    const app = await this._request('GET', 'https://api.github.com/app', {
      Authorization: `Bearer ${jwt}`,
    });
    this._botUsername = `${app.slug}[bot]`;
    log.info(`[github] Bot username: ${this._botUsername}`);
    return this._botUsername;
  }

  // ── Authenticated API calls (as bot) ──

  async apiRequest(method, urlPath, repo, body) {
    const token = await this.getTokenForRepo(repo);
    const url = urlPath.startsWith('https://') ? urlPath : `https://api.github.com${urlPath}`;
    return this._request(method, url, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, body ? JSON.stringify(body) : null);
  }

  async postComment(repo, issueNumber, body) {
    return this.apiRequest('POST', `/repos/${repo}/issues/${issueNumber}/comments`, repo, { body });
  }

  async replyToReviewComment(repo, prNumber, commentId, body) {
    return this.apiRequest('POST', `/repos/${repo}/pulls/${prNumber}/comments`, repo, {
      body,
      in_reply_to: commentId,
    });
  }

  async addReaction(repo, commentId, reaction, isReviewComment) {
    const path = isReviewComment
      ? `/repos/${repo}/pulls/comments/${commentId}/reactions`
      : `/repos/${repo}/issues/comments/${commentId}/reactions`;
    return this.apiRequest('POST', path, repo, { content: reaction });
  }
}

module.exports = GitHubAppAuth;
