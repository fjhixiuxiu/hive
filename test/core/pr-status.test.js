import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockConfig } from '../helpers/mocks.js';

describe('pr-status', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getCached', () => {
    it('returns null for uncached branch', async () => {
      const prStatus = await import('../../src/core/pr-status.js');
      expect(prStatus.getCached('feature/test')).toBeNull();
    });

    it('skips main/master/develop branches', async () => {
      const prStatus = await import('../../src/core/pr-status.js');
      expect(prStatus.getCached('main')).toBeNull();
      expect(prStatus.getCached('master')).toBeNull();
      expect(prStatus.getCached('develop')).toBeNull();
    });
  });

  describe('fetch', () => {
    it('returns null for main/master/develop', async () => {
      const prStatus = await import('../../src/core/pr-status.js');
      const config = createMockConfig();
      expect(await prStatus.fetch('main', config)).toBeNull();
      expect(await prStatus.fetch('master', config)).toBeNull();
    });

    it('returns null when GITHUB_TOKEN is missing', async () => {
      delete process.env.GITHUB_TOKEN;
      const prStatus = await import('../../src/core/pr-status.js');
      const config = createMockConfig();
      expect(await prStatus.fetch('feature/test', config)).toBeNull();
    });

    it('returns null for null/empty branch', async () => {
      const prStatus = await import('../../src/core/pr-status.js');
      const config = createMockConfig();
      expect(await prStatus.fetch('', config)).toBeNull();
      expect(await prStatus.fetch(null, config)).toBeNull();
    });
  });

  describe('clearCache / stats', () => {
    it('clears cache and reports stats', async () => {
      const prStatus = await import('../../src/core/pr-status.js');
      prStatus.clearCache();
      const stats = prStatus.stats();
      expect(stats.entries).toBe(0);
      expect(stats.branches).toEqual([]);
    });
  });
});
