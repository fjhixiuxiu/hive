import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const fleet = (await import('../../src/core/fleet.js')).default || await import('../../src/core/fleet.js');
const NodeRouter = (await import('../../src/core/node-router.js')).default || (await import('../../src/core/node-router.js'));

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

  describe('getFleetStatus', () => {
    it('aggregates sessions with state and branch info', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.listSessions.mockResolvedValue([{ name: '6-DEV-123', lastActivity: 1000, path: '/home/user/dev/session-6' }]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(true);
      node.gitInfo.mockResolvedValue({ branch: 'nukulb/DEV-123-fix', staged: 0, modified: 0, untracked: 0 });

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
      node.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
      node.readFile.mockResolvedValue('idle');
      node.fileExists.mockResolvedValue(false);

      const router = new NodeRouter();
      router.addNode(node);

      const first = await fleet.getFleetStatus(config, router);
      const second = await fleet.getFleetStatus(config, router);
      expect(second).toBe(first);
      expect(node.listSessions).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidateCache', () => {
    it('forces fresh fetch on next call', async () => {
      const config = createMockConfig();
      const node = createMockNode();
      node.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
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
