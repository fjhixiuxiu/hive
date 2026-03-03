import { describe, it, expect, beforeEach } from 'vitest';
import NodeRouter from '../../src/core/node-router.js';
import { createMockNode } from '../helpers/mocks.js';

describe('NodeRouter', () => {
  let router;

  beforeEach(() => {
    router = new NodeRouter();
  });

  describe('addNode / getNode', () => {
    it('registers a node by id', () => {
      const node = createMockNode('local');
      router.addNode(node);
      expect(router.getNode('local')).toBe(node);
    });

    it('returns null for unknown node', () => {
      expect(router.getNode('nonexistent')).toBeNull();
    });
  });

  describe('removeNode', () => {
    it('removes node and clears its session cache entries', async () => {
      const node = createMockNode('remote1');
      node.listSessions.mockResolvedValue([
        { name: '6-DEV-123', lastActivity: 1000, path: '/home/user/dev/session-6' },
      ]);
      router.addNode(node);

      await router.listAllSessions();
      expect(router.nodeFor('6-DEV-123')).toBe(node);

      router.removeNode('remote1');
      expect(router.getNode('remote1')).toBeNull();
      expect(router.nodeFor('6-DEV-123')).toBeNull();
    });
  });

  describe('nodeFor', () => {
    it('returns null before listAllSessions is called', () => {
      const node = createMockNode('local');
      node.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
      router.addNode(node);
      expect(router.nodeFor('1-main')).toBeNull();
    });

    it('returns correct node after cache is populated', async () => {
      const node1 = createMockNode('node1');
      const node2 = createMockNode('node2');
      node1.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
      node2.listSessions.mockResolvedValue([{ name: '2-feat', lastActivity: 2000, path: '/home/user/dev/session-2' }]);

      router.addNode(node1);
      router.addNode(node2);
      await router.listAllSessions();

      expect(router.nodeFor('1-main')).toBe(node1);
      expect(router.nodeFor('2-feat')).toBe(node2);
    });
  });

  describe('listAllSessions', () => {
    it('queries all nodes and returns merged session list', async () => {
      const node1 = createMockNode('node1');
      const node2 = createMockNode('node2');
      node1.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
      node2.listSessions.mockResolvedValue([
        { name: '2-feat', lastActivity: 2000, path: '/home/user/dev/session-2' },
        { name: '3-fix', lastActivity: 3000, path: '/home/user/dev/session-3' },
      ]);

      router.addNode(node1);
      router.addNode(node2);

      const sessions = await router.listAllSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions.find(s => s.name === '1-main').nodeId).toBe('node1');
      expect(sessions.find(s => s.name === '2-feat').nodeId).toBe('node2');
    });

    it('forwards path from node sessions', async () => {
      const node = createMockNode('local');
      node.listSessions.mockResolvedValue([
        { name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' },
      ]);
      router.addNode(node);

      const sessions = await router.listAllSessions();
      expect(sessions[0].path).toBe('/home/user/dev/session-1');
    });

    it('handles unreachable nodes gracefully', async () => {
      const good = createMockNode('good');
      const bad = createMockNode('bad');
      good.listSessions.mockResolvedValue([{ name: '1-ok', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
      bad.listSessions.mockRejectedValue(new Error('Connection refused'));

      router.addNode(good);
      router.addNode(bad);

      const sessions = await router.listAllSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe('1-ok');
    });

    it('clears old cache before rebuilding', async () => {
      const node = createMockNode('local');
      node.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000, path: '/home/user/dev/session-1' }]);
      router.addNode(node);

      await router.listAllSessions();
      expect(router.nodeFor('1-main')).toBe(node);

      node.listSessions.mockResolvedValue([{ name: '2-new', lastActivity: 2000, path: '/home/user/dev/session-2' }]);
      await router.listAllSessions();

      expect(router.nodeFor('1-main')).toBeNull();
      expect(router.nodeFor('2-new')).toBe(node);
    });
  });

  describe('allNodes', () => {
    it('returns all registered nodes', () => {
      const node1 = createMockNode('a');
      const node2 = createMockNode('b');
      router.addNode(node1);
      router.addNode(node2);
      expect(router.allNodes()).toHaveLength(2);
    });
  });
});
