import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockNode, createMockConfig } from '../helpers/mocks.js';

vi.mock('../../src/core/tmux.js', () => ({
  default: {
    detectState: vi.fn().mockReturnValue('idle'),
    stripTUIChrome: vi.fn((content) => content || ''),
  },
  detectState: vi.fn().mockReturnValue('idle'),
  stripTUIChrome: vi.fn((content) => content || ''),
}));

vi.mock('../../src/core/pr-status.js', () => ({
  default: { getCached: vi.fn().mockReturnValue(null) },
  getCached: vi.fn().mockReturnValue(null),
}));

const fleet =
  (await import('../../src/core/fleet.js')).default || (await import('../../src/core/fleet.js'));
const NodeRouter =
  (await import('../../src/core/node-router.js')).default ||
  (await import('../../src/core/node-router.js'));

describe('fleet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleet.invalidateCache();
  });

  describe('getNodeConfig', () => {
    it('returns default config for "local" node', () => {
      const config = createMockConfig();
      const result = fleet.getNodeConfig(config, 'local');
      expect(result).toBe(config);
    });

    it('returns default config when nodeId is falsy', () => {
      const config = createMockConfig();
      expect(fleet.getNodeConfig(config, null)).toBe(config);
      expect(fleet.getNodeConfig(config, undefined)).toBe(config);
    });

    it('merges node-specific overrides', () => {
      const config = createMockConfig({
        nodes: {
          remote1: {
            sessions: { claudePane: 2 },
            cache: { stateDir: '/remote/states' },
          },
        },
      });
      const result = fleet.getNodeConfig(config, 'remote1');
      expect(result.sessions.claudePane).toBe(2);
      expect(result.cache.stateDir).toBe('/remote/states');
    });
  });

  describe('readState', () => {
    it('reads state file and trims', async () => {
      const node = createMockNode();
      node.readFile.mockResolvedValue('  idle  \n');
      const result = await fleet.readState({ stateDir: '/tmp/states' }, node, 6);
      expect(result).toBe('idle');
    });

    it('returns null on missing file', async () => {
      const node = createMockNode();
      node.readFile.mockRejectedValue(new Error('ENOENT'));
      const result = await fleet.readState({ stateDir: '/tmp/states' }, node, 6);
      expect(result).toBeNull();
    });

    it('returns null on empty content', async () => {
      const node = createMockNode();
      node.readFile.mockResolvedValue('   \n');
      const result = await fleet.readState({ stateDir: '/tmp/states' }, node, 6);
      expect(result).toBeNull();
    });
  });

  describe('sessionNum', () => {
    it('extracts number from session name', () => {
      expect(fleet.sessionNum('6-DEV-43966')).toBe(6);
      expect(fleet.sessionNum('12-feature-branch')).toBe(12);
    });

    it('returns null for non-numeric prefix', () => {
      expect(fleet.sessionNum('abc-branch')).toBeNull();
    });

    it('strips namePrefix before extracting number', () => {
      expect(fleet.sessionNum('dev-6-DEV-123', 'dev-')).toBe(6);
      expect(fleet.sessionNum('prod-12-feature', 'prod-')).toBe(12);
    });

    it('works with empty namePrefix (legacy)', () => {
      expect(fleet.sessionNum('6-DEV-123', '')).toBe(6);
      expect(fleet.sessionNum('12-feature', undefined)).toBe(12);
    });

    it('returns null when prefix does not match', () => {
      expect(fleet.sessionNum('dev-6-DEV-123', 'prod-')).toBeNull();
    });
  });

  describe('ticketFromBranch', () => {
    it('extracts JIRA key from branch name', () => {
      expect(fleet.ticketFromBranch('nukulb/DEV-43966-feature')).toBe('DEV-43966');
    });

    it('returns null when no ticket found', () => {
      expect(fleet.ticketFromBranch('main')).toBeNull();
      expect(fleet.ticketFromBranch(null)).toBeNull();
    });
  });

  describe('git info cache', () => {
    const config = createMockConfig();
    const info = (branch) => ({ branch, staged: 0, modified: 0, untracked: 0 });

    function repoNode(id = 'local') {
      const node = createMockNode(id);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(true);
      node.gitInfo.mockResolvedValue(info('jeff/DEV-1-a'));
      return node;
    }

    afterEach(() => vi.useRealTimers());

    it('runs git once per minute per repo, not on every poll', async () => {
      vi.useFakeTimers({ now: 0 });
      const node = repoNode();
      await fleet.getSession(config, node, '6', 'local');
      vi.setSystemTime(59_000);
      await fleet.getSession(config, node, '6', 'local');
      expect(node.gitInfo).toHaveBeenCalledTimes(1);
      vi.setSystemTime(61_000);
      await fleet.getSession(config, node, '6', 'local');
      expect(node.gitInfo).toHaveBeenCalledTimes(2);
    });

    it('refreshGitInfo re-reads inside the minute, and the next poll shows it', async () => {
      const node = repoNode();
      await fleet.getSession(config, node, '6', 'local');
      node.gitInfo.mockResolvedValue(info('jeff/DEV-2-b'));
      await fleet.refreshGitInfo(config, node, '6', 'local');
      expect(node.gitInfo).toHaveBeenCalledTimes(2);
      expect(node.gitInfo).toHaveBeenLastCalledWith('/home/user/dev/session-6');
      const s = await fleet.getSession(config, node, '6', 'local');
      expect(s.branch).toBe('jeff/DEV-2-b');
      expect(node.gitInfo).toHaveBeenCalledTimes(2);
    });

    it('refreshGitInfo drops the fleet snapshot so the dashboard sees the new branch', async () => {
      const node = repoNode();
      node.listSessions.mockResolvedValue([
        { name: '6-DEV-1', lastActivity: 1, path: '/home/user/dev/session-6' },
      ]);
      const router = new NodeRouter();
      router.addNode(node);
      expect((await fleet.getFleetStatus(config, router))[0].branch).toBe('jeff/DEV-1-a');
      node.gitInfo.mockResolvedValue(info('jeff/DEV-2-b'));
      await fleet.refreshGitInfo(config, node, '6-DEV-1', 'local');
      expect((await fleet.getFleetStatus(config, router))[0].branch).toBe('jeff/DEV-2-b');
    });

    it('refreshGitInfo skips a session with no repo', async () => {
      const node = repoNode();
      node.fileExists.mockResolvedValue(false);
      await fleet.refreshGitInfo(config, node, '6', 'local');
      await fleet.refreshGitInfo(config, node, 'hive-console', 'local');
      expect(node.gitInfo).not.toHaveBeenCalled();
    });

    it('shares one git run between concurrent polls', async () => {
      const node = repoNode();
      await Promise.all([
        fleet.getSession(config, node, '6', 'local'),
        fleet.getSession(config, node, '6', 'local'),
      ]);
      expect(node.gitInfo).toHaveBeenCalledTimes(1);
    });

    it('keeps one entry per node, so the same path on two machines is two repos', async () => {
      const local = repoNode('local');
      const remote = repoNode('mini');
      await fleet.getSession(config, local, '6', 'local');
      await fleet.getSession(config, remote, '6', 'mini');
      expect(local.gitInfo).toHaveBeenCalledTimes(1);
      expect(remote.gitInfo).toHaveBeenCalledTimes(1);
    });

    it('a failed refresh keeps the last good value instead of caching the failure', async () => {
      const node = repoNode();
      await fleet.getSession(config, node, '6', 'local');
      node.gitInfo.mockRejectedValueOnce(new Error('worker gone'));
      await expect(fleet.refreshGitInfo(config, node, '6', 'local')).rejects.toThrow('worker gone');
      const s = await fleet.getSession(config, node, '6', 'local');
      expect(s.branch).toBe('jeff/DEV-1-a');
      expect(node.gitInfo).toHaveBeenCalledTimes(2);
    });

    it('invalidateCache makes the next poll read git again', async () => {
      const node = repoNode();
      await fleet.getSession(config, node, '6', 'local');
      fleet.invalidateCache();
      await fleet.getSession(config, node, '6', 'local');
      expect(node.gitInfo).toHaveBeenCalledTimes(2);
    });
  });

  describe('getFleetStatus', () => {
    it('aggregates sessions with state and branch info', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.listSessions.mockResolvedValue([
        { name: '6-DEV-123', lastActivity: 1000, path: '/home/user/dev/session-6' },
      ]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(true);
      node.gitInfo.mockResolvedValue({
        branch: 'nukulb/DEV-123-fix',
        staged: 0,
        modified: 0,
        untracked: 0,
      });

      const router = new NodeRouter();
      router.addNode(node);

      const sessions = await fleet.getFleetStatus(config, router);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        name: '6-DEV-123',
        num: 6,
        state: 'idle',
        ticket: 'DEV-123',
      });
    });

    it('excludes sessions with non-matching paths', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.listSessions.mockResolvedValue([
        { name: '6-DEV-123', lastActivity: 1000, path: '/home/user/dev/session-6' },
        { name: '7-DEV-456', lastActivity: 2000, path: '/tmp/other-repo-7' },
      ]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(true);
      node.gitInfo.mockResolvedValue({ branch: 'main', staged: 0, modified: 0, untracked: 0 });

      const router = new NodeRouter();
      router.addNode(node);

      const sessions = await fleet.getFleetStatus(config, router);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe('6-DEV-123');
    });

    it('falls back to pattern when repoBase is null', async () => {
      const config = createMockConfig();
      config.sessions.repoBase = null;
      const node = createMockNode();
      node.listSessions.mockResolvedValue([
        { name: '6-DEV-123', lastActivity: 1000, path: '/some/random/path' },
      ]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(false);

      const router = new NodeRouter();
      router.addNode(node);

      const sessions = await fleet.getFleetStatus(config, router);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe('6-DEV-123');
    });

    it('returns cached result within TTL', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.listSessions.mockResolvedValue([
        { name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' },
      ]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(false);

      const router = new NodeRouter();
      router.addNode(node);

      const first = await fleet.getFleetStatus(config, router);
      const second = await fleet.getFleetStatus(config, router);
      expect(second).toBe(first);
      expect(node.listSessions).toHaveBeenCalledTimes(1);
    });

    it('serves the last-known fleet when a poll comes back empty (transient tmux timeout)', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(false);
      const router = new NodeRouter();
      router.addNode(node);

      // A real poll establishes the last-known fleet.
      node.listSessions.mockResolvedValue([
        { name: '6-DEV-123', lastActivity: 1000, path: '/home/user/dev/session-6' },
      ]);
      const good = await fleet.getFleetStatus(config, router);
      expect(good).toHaveLength(1);

      // Next poll times out and returns nothing — must NOT report an empty fleet.
      fleet.invalidateCache();
      node.listSessions.mockResolvedValue([]);
      const afterEmpty = await fleet.getFleetStatus(config, router);
      expect(afterEmpty).toHaveLength(1);
      expect(afterEmpty[0].name).toBe('6-DEV-123');
    });

    it('accepts an empty fleet once the fallback window has expired', async () => {
      vi.useFakeTimers();
      try {
        const config = createMockConfig();
        const node = createMockNode();
        node.readFile.mockResolvedValue('idle');
        node.fileExists.mockResolvedValue(false);
        const router = new NodeRouter();
        router.addNode(node);

        node.listSessions.mockResolvedValue([
          { name: '6-DEV-123', lastActivity: 1000, path: '/home/user/dev/session-6' },
        ]);
        await fleet.getFleetStatus(config, router); // lastGood set at t=0

        vi.advanceTimersByTime(61000); // past the 60s fallback window
        fleet.invalidateCache();
        node.listSessions.mockResolvedValue([]);
        const result = await fleet.getFleetStatus(config, router);
        expect(result).toHaveLength(0); // stale last-known is not served
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('invalidateCache', () => {
    it('forces fresh fetch on next call', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.listSessions.mockResolvedValue([
        { name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' },
      ]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(false);

      const router = new NodeRouter();
      router.addNode(node);

      await fleet.getFleetStatus(config, router);
      fleet.invalidateCache();
      await fleet.getFleetStatus(config, router);
      expect(node.listSessions).toHaveBeenCalledTimes(2);
    });
  });
});
