import { describe, it, expect, vi, beforeEach } from 'vitest';
import NodeRouter from '../../src/core/node-router.js';
import { createMockNode } from '../helpers/mocks.js';

describe('E2E: Multi-Node Routing', () => {
  let router;

  beforeEach(() => {
    router = new NodeRouter();
  });

  it('local + remote nodes registered → sessions route correctly', async () => {
    const local = createMockNode('local');
    const remote = createMockNode('remote-1');

    local.listSessions.mockResolvedValue([
      { name: '1-main', lastActivity: 1000 },
      { name: '2-feat', lastActivity: 2000 },
    ]);
    remote.listSessions.mockResolvedValue([
      { name: '3-review', lastActivity: 3000 },
      { name: '4-fix', lastActivity: 4000 },
    ]);

    router.addNode(local);
    router.addNode(remote);

    const sessions = await router.listAllSessions();
    expect(sessions).toHaveLength(4);

    // Each session routes to the correct node
    expect(router.nodeFor('1-main')).toBe(local);
    expect(router.nodeFor('2-feat')).toBe(local);
    expect(router.nodeFor('3-review')).toBe(remote);
    expect(router.nodeFor('4-fix')).toBe(remote);
  });

  it('remote node disconnect → session cache cleared', async () => {
    const local = createMockNode('local');
    const remote = createMockNode('remote-1');

    local.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000 }]);
    remote.listSessions.mockResolvedValue([{ name: '3-review', lastActivity: 3000 }]);

    router.addNode(local);
    router.addNode(remote);
    await router.listAllSessions();

    expect(router.nodeFor('3-review')).toBe(remote);

    // Remote disconnects
    router.removeNode('remote-1');

    expect(router.nodeFor('3-review')).toBeNull();
    // Local sessions still work
    expect(router.nodeFor('1-main')).toBe(local);
  });

  it('commands route to correct node via nodeFor', async () => {
    const node1 = createMockNode('worker-1');
    const node2 = createMockNode('worker-2');

    node1.listSessions.mockResolvedValue([{ name: '5-build', lastActivity: 1000 }]);
    node2.listSessions.mockResolvedValue([{ name: '6-test', lastActivity: 2000 }]);
    node1.exec.mockResolvedValue('build output');
    node2.exec.mockResolvedValue('test output');

    router.addNode(node1);
    router.addNode(node2);
    await router.listAllSessions();

    // Route command to correct node
    const buildNode = router.nodeFor('5-build');
    const testNode = router.nodeFor('6-test');

    expect(await buildNode.exec('make')).toBe('build output');
    expect(await testNode.exec('npm test')).toBe('test output');
  });

  it('handles node with no sessions gracefully', async () => {
    const active = createMockNode('active');
    const empty = createMockNode('empty');

    active.listSessions.mockResolvedValue([{ name: '1-main', lastActivity: 1000 }]);
    empty.listSessions.mockResolvedValue([]);

    router.addNode(active);
    router.addNode(empty);

    const sessions = await router.listAllSessions();
    expect(sessions).toHaveLength(1);
    expect(router.allNodes()).toHaveLength(2);
  });

  it('re-scanning updates session-to-node mapping', async () => {
    const node1 = createMockNode('node1');
    const node2 = createMockNode('node2');

    // Initially session on node1
    node1.listSessions.mockResolvedValue([{ name: '5-session', lastActivity: 1000 }]);
    node2.listSessions.mockResolvedValue([]);

    router.addNode(node1);
    router.addNode(node2);
    await router.listAllSessions();
    expect(router.nodeFor('5-session')).toBe(node1);

    // Session moves to node2 (e.g., after migration)
    node1.listSessions.mockResolvedValue([]);
    node2.listSessions.mockResolvedValue([{ name: '5-session', lastActivity: 2000 }]);

    await router.listAllSessions();
    expect(router.nodeFor('5-session')).toBe(node2);
  });
});
