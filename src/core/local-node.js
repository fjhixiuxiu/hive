const fs = require('fs');
const tmux = require('./tmux');

/**
 * LocalNode wraps tmux.js in an async Node interface.
 * Executes all operations locally on this machine.
 */
class LocalNode {
    constructor(id = 'local') {
        this.id = id;
        this.type = 'local';
    }

    async exec(cmd, opts) {
        return tmux.exec(cmd, opts);
    }

    async listSessions() {
        return tmux.listSessions();
    }

    async capturePane(target, opts) {
        return tmux.capturePane(target, opts);
    }

    async sendKeys(target, keys, enter) {
        return tmux.sendKeys(target, keys, enter);
    }

    async hasSession(name) {
        return tmux.hasSession(name);
    }

    async killSession(name) {
        return tmux.killSession(name);
    }

    async readFile(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return null;
        }
    }

    async fileExists(filePath) {
        return fs.existsSync(filePath);
    }

    async gitInfo(repoDir) {
        return tmux.gitInfo(repoDir);
    }
}

module.exports = LocalNode;
