const crypto = require('crypto');

/**
 * RemoteNode forwards Node interface calls over WebSocket RPC
 * to a hive-worker running on a remote machine.
 */
class RemoteNode {
  constructor(id, ws) {
    this.id = id;
    this.type = 'remote';
    this.ws = ws;
    this.pending = new Map();
    this.connected = true;
  }

  async exec(cmd, opts) {
    return this._rpc('exec', { cmd, opts });
  }

  async listSessions() {
    return this._rpc('listSessions', {});
  }

  async capturePane(target, opts) {
    return this._rpc('capturePane', { target, opts });
  }

  async sendKeys(target, keys, enter) {
    return this._rpc('sendKeys', { target, keys, enter });
  }

  async hasSession(name) {
    return this._rpc('hasSession', { name });
  }

  async killSession(name) {
    return this._rpc('killSession', { name });
  }

  async readFile(filePath) {
    return this._rpc('readFile', { filePath });
  }

  async fileExists(filePath) {
    return this._rpc('fileExists', { filePath });
  }

  async gitInfo(repoDir) {
    return this._rpc('gitInfo', { repoDir });
  }

  /**
   * Send an RPC call and wait for the response.
   */
  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.connected || this.ws.readyState !== 1) {
        return reject(new Error(`Node ${this.id} is disconnected`));
      }
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
    });
  }

  /**
   * Handle an RPC response from the worker.
   */
  handleResponse(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Clean up when connection is lost.
   */
  disconnect() {
    this.connected = false;
    for (const [, { reject, timeout }] of this.pending) {
      clearTimeout(timeout);
      reject(new Error(`Node ${this.id} disconnected`));
    }
    this.pending.clear();
  }
}

module.exports = RemoteNode;
