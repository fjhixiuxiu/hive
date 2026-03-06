import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/core/log.js', () => ({
  default: { info: vi.fn(), error: vi.fn() },
  info: vi.fn(),
  error: vi.fn(),
}));

async function loadAuth() {
  const mod = await import('../../src/core/auth.js');
  return mod.default || mod;
}

describe('auth', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isOAuthEnabled', () => {
    it('returns true when env vars are set', async () => {
      process.env.GITHUB_CLIENT_ID = 'test-id';
      process.env.GITHUB_CLIENT_SECRET = 'test-secret';
      const auth = await loadAuth();
      expect(auth.isOAuthEnabled()).toBe(true);
    });

    it('returns false when env vars are missing', async () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      const auth = await loadAuth();
      expect(auth.isOAuthEnabled()).toBe(false);
    });

    it('returns false when only one var is set', async () => {
      process.env.GITHUB_CLIENT_ID = 'test-id';
      delete process.env.GITHUB_CLIENT_SECRET;
      const auth = await loadAuth();
      expect(auth.isOAuthEnabled()).toBe(false);
    });
  });

  describe('verifyToken', () => {
    it('rejects invalid JWT', async () => {
      const auth = await loadAuth();
      expect(auth.verifyToken('invalid-token')).toBeNull();
    });

    it('rejects empty string', async () => {
      const auth = await loadAuth();
      expect(auth.verifyToken('')).toBeNull();
    });

    it('rejects malformed JWT', async () => {
      const auth = await loadAuth();
      expect(auth.verifyToken('a.b.c')).toBeNull();
    });
  });

  describe('parseCookie', () => {
    it('extracts session cookie', async () => {
      const auth = await loadAuth();
      expect(auth.parseCookie('other=abc; hive_session=mytoken; x=y')).toBe('mytoken');
    });

    it('extracts session cookie when first', async () => {
      const auth = await loadAuth();
      expect(auth.parseCookie('hive_session=mytoken')).toBe('mytoken');
    });

    it('returns null when not found', async () => {
      const auth = await loadAuth();
      expect(auth.parseCookie('other=abc')).toBeNull();
    });

    it('returns null for null/empty header', async () => {
      const auth = await loadAuth();
      expect(auth.parseCookie(null)).toBeNull();
      expect(auth.parseCookie('')).toBeNull();
    });
  });

  describe('COOKIE_NAME', () => {
    it('is exported as hive_session', async () => {
      const auth = await loadAuth();
      expect(auth.COOKIE_NAME).toBe('hive_session');
    });

    it('STATE_COOKIE is exported as hive_oauth_state', async () => {
      const auth = await loadAuth();
      expect(auth.STATE_COOKIE).toBe('hive_oauth_state');
    });
  });

  describe('parseCookie with custom name', () => {
    it('extracts a named cookie', async () => {
      const auth = await loadAuth();
      expect(auth.parseCookie('hive_oauth_state=abc123; hive_session=xyz', 'hive_oauth_state')).toBe('abc123');
    });

    it('defaults to session cookie when no name given', async () => {
      const auth = await loadAuth();
      expect(auth.parseCookie('hive_session=mytoken')).toBe('mytoken');
    });
  });

  describe('checkOrgMembership', () => {
    it('returns true when GITHUB_ORG is not set', async () => {
      delete process.env.GITHUB_ORG;
      const auth = await loadAuth();
      const result = await auth.checkOrgMembership('fake-token');
      expect(result).toBe(true);
    });
  });

  describe('authenticateWebSocket', () => {
    it('OAuth mode: rejects without valid cookie', async () => {
      process.env.GITHUB_CLIENT_ID = 'id';
      process.env.GITHUB_CLIENT_SECRET = 'secret';
      const auth = await loadAuth();
      const result = auth.authenticateWebSocket({}, { headers: { cookie: 'hive_session=bad' } });
      expect(result.authenticated).toBe(false);
    });

    it('OAuth mode: rejects missing cookie', async () => {
      process.env.GITHUB_CLIENT_ID = 'id';
      process.env.GITHUB_CLIENT_SECRET = 'secret';
      const auth = await loadAuth();
      const result = auth.authenticateWebSocket({}, { headers: {} });
      expect(result.authenticated).toBe(false);
    });

    it('Legacy mode: accepts matching WEB_TOKEN', async () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      process.env.WEB_TOKEN = 'my-token';
      const auth = await loadAuth();
      const result = auth.authenticateWebSocket({ type: 'auth', token: 'my-token' }, {});
      expect(result.authenticated).toBe(true);
      expect(result.user).toBeNull();
    });

    it('Legacy mode: rejects wrong token', async () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      process.env.WEB_TOKEN = 'correct';
      const auth = await loadAuth();
      const result = auth.authenticateWebSocket({ type: 'auth', token: 'wrong' }, {});
      expect(result.authenticated).toBe(false);
    });

    it('Legacy mode: rejects non-auth message type', async () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_CLIENT_SECRET;
      process.env.WEB_TOKEN = 'token';
      const auth = await loadAuth();
      const result = auth.authenticateWebSocket({ type: 'fleet:get', token: 'token' }, {});
      expect(result.authenticated).toBe(false);
    });
  });
});
