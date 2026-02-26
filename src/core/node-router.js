/**
 * NodeRouter is a registry that maps sessions to nodes.
 * Queries all nodes for their sessions and caches the mapping.
 */
class NodeRouter {
    constructor() {
        this.nodes = new Map(); // nodeId -> Node
        this._sessionCache = new Map(); // sessionName -> nodeId
    }

    addNode(node) {
        this.nodes.set(node.id, node);
    }

    removeNode(id) {
        this.nodes.delete(id);
        for (const [name, nodeId] of this._sessionCache) {
            if (nodeId === id) this._sessionCache.delete(name);
        }
    }

    getNode(id) {
        return this.nodes.get(id) || null;
    }

    /**
     * Get the node that owns a given session.
     */
    nodeFor(sessionName) {
        const nodeId = this._sessionCache.get(sessionName);
        return nodeId ? this.nodes.get(nodeId) : null;
    }

    /**
     * Query all nodes for sessions and rebuild the session->node cache.
     * Returns array of { name, nodeId }.
     */
    async listAllSessions() {
        const all = [];
        this._sessionCache.clear();
        await Promise.all(
            Array.from(this.nodes.entries()).map(async ([nodeId, node]) => {
                try {
                    const sessions = await node.listSessions();
                    for (const {name, lastActivity} of sessions) {
                        this._sessionCache.set(name, nodeId);
                        all.push({name, nodeId, lastActivity});
                    }
                } catch {
                    // Node unreachable — skip
                }
            }),
        );
        return all;
    }

    allNodes() {
        return Array.from(this.nodes.values());
    }
}

module.exports = NodeRouter;
