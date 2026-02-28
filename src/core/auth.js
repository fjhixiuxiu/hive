/**
 * GitHub OAuth + JWT authentication for Hive.
 *
 * Flow:
 *   1. Browser → GET /auth/github → redirect to GitHub OAuth
 *   2. GitHub → GET /auth/github/callback?code=xxx → exchange code for token
 *   3. Fetch GitHub user profile → check allowlist
 *   4. Issue JWT → set httpOnly cookie → redirect to dashboard
 *   5. WebSocket connects → send JWT from cookie → server validates
 *
 * Fallback: if no OAuth is configured, falls back to WEB_TOKEN (single token).
 */

const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const log = require('./log');

// Generate a random secret on startup if not provided
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '7d';
const COOKIE_NAME = 'hive_session';

/**
 * Check if GitHub OAuth is configured.
 */
function isOAuthEnabled() {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

/**
 * Make an HTTPS request and return parsed JSON.
 */
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'User-Agent': 'hive-ai', 'Accept': 'application/json', ...options.headers },
      method: options.method || 'GET',
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Exchange GitHub OAuth code for access token.
 */
async function exchangeCodeForToken(code) {
  const result = await httpRequest('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  if (result.error) throw new Error(result.error_description || result.error);
  return result.access_token;
}

/**
 * Fetch GitHub user profile.
 */
async function fetchGitHubUser(accessToken) {
  return httpRequest('https://api.github.com/user', {
    headers: { Authorization: `token ${accessToken}` },
  });
}

/**
 * Issue a JWT for an authenticated user.
 */
function issueToken(user) {
  return jwt.sign({
    sub: user.login,
    name: user.name || user.login,
    avatar: user.avatar_url,
    githubId: user.id,
  }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Verify and decode a JWT.
 * Returns the payload or null if invalid/expired.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Parse the session cookie from a raw Cookie header string.
 */
function parseCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(`${COOKIE_NAME}=`));
  return match ? match.split('=')[1].trim() : null;
}

/**
 * Wire OAuth routes onto an Express app.
 *
 * Routes:
 *   GET /auth/github          — redirect to GitHub OAuth
 *   GET /auth/github/callback — handle OAuth callback
 *   GET /auth/me              — return current user info (from JWT)
 *   GET /auth/logout          — clear cookie
 */
function wireAuthRoutes(app, taskQueue) {
  if (!isOAuthEnabled()) return;

  const clientId = process.env.GITHUB_CLIENT_ID;
  const callbackPath = '/auth/github/callback';

  // Step 1: Redirect to GitHub
  app.get('/auth/github', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    // Derive callback URL from the request
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host;
    const redirectUri = `${protocol}://${host}${callbackPath}`;
    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user&state=${state}`;
    res.redirect(url);
  });

  // Step 2: Handle callback
  app.get(callbackPath, async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code parameter');

    try {
      const accessToken = await exchangeCodeForToken(code);
      const user = await fetchGitHubUser(accessToken);
      if (!user || !user.login) {
        const reason = user?.message || 'unknown error';
        log.error(`[auth] GitHub /user failed: ${reason}`);
        return res.status(502).send(`GitHub API error: ${reason}. Please try again later.`);
      }

      // Gate access: admin user always allowed, otherwise must be pre-added
      const adminUser = process.env.HIVE_ADMIN_USER;
      const isAdmin = adminUser && adminUser.toLowerCase() === user.login.toLowerCase();
      const isPreAdded = taskQueue && taskQueue.getUser(user.login.toLowerCase());
      if (!isAdmin && !isPreAdded) {
        return res.status(403).send('Access denied — ask your Hive admin to add you.');
      }

      // Register/update user profile in the permission system
      if (taskQueue) {
        taskQueue.ensureUser(user.login, user.name || user.login, user.avatar_url);
      }

      // Issue JWT and set cookie
      const token = issueToken(user);
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: false, // Set to true if behind HTTPS
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/',
      });

      log.info(`[auth] ${user.login} logged in via GitHub OAuth`);
      res.redirect('/');
    } catch (err) {
      log.error('[auth] OAuth error:', err.message);
      res.status(500).send('Authentication failed. Please try again.');
    }
  });

  // User info endpoint (for dashboard to fetch current user)
  app.get('/auth/me', (req, res) => {
    const cookieHeader = req.headers.cookie;
    const token = parseCookie(cookieHeader);
    const user = token ? verifyToken(token) : null;
    if (user) {
      res.json({ authenticated: true, login: user.sub, name: user.name, avatar: user.avatar });
    } else {
      res.json({ authenticated: false });
    }
  });

  // Logout
  app.get('/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>hive</title>
      <style>body{background:#0f0f23;color:#e2e2f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      a{color:#bd93f9;text-decoration:none;font-size:18px}a:hover{text-decoration:underline}</style>
      </head><body><div style="text-align:center"><h2>Logged out</h2><a href="/auth/github">Log back in</a></div></body></html>`);
  });
}

/**
 * Authenticate a WebSocket connection.
 *
 * Supports two modes:
 *   1. OAuth mode: JWT from cookie (sent automatically by browser)
 *   2. Legacy mode: WEB_TOKEN sent in auth message
 *
 * Returns { authenticated: true, user: { login, name, avatar } } or
 *         { authenticated: true, user: null } for legacy token auth.
 */
function authenticateWebSocket(msg, request) {
  // OAuth mode: check JWT cookie from the upgrade request
  if (isOAuthEnabled()) {
    const cookieHeader = request?.headers?.cookie;
    const token = parseCookie(cookieHeader);
    const user = token ? verifyToken(token) : null;
    if (user) {
      return { authenticated: true, user: { login: user.sub, name: user.name, avatar: user.avatar } };
    }
    // Also accept auth message with JWT token directly
    if (msg.type === 'auth' && msg.token) {
      const userFromToken = verifyToken(msg.token);
      if (userFromToken) {
        return { authenticated: true, user: { login: userFromToken.sub, name: userFromToken.name, avatar: userFromToken.avatar } };
      }
    }
    return { authenticated: false };
  }

  // Legacy mode: WEB_TOKEN
  const webToken = process.env.WEB_TOKEN;
  if (msg.type === 'auth' && msg.token === webToken) {
    return { authenticated: true, user: null };
  }
  return { authenticated: false };
}

module.exports = {
  isOAuthEnabled,
  wireAuthRoutes,
  authenticateWebSocket,
  verifyToken,
  parseCookie,
  COOKIE_NAME,
};
