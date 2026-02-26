const tmux = require('./tmux');

/**
 * Capture the visible pane and extract Claude's response content,
 * stripping TUI chrome (status bars, prompts, etc).
 */
async function captureResponse(node, paneTarget, config) {
    const content = await node.capturePane(paneTarget);
    return tmux.stripTUIChrome(content, config);
}

/**
 * Send a message to Claude in a session and wait for the response.
 *
 * @param {object} config - hive config
 * @param {Node} node - execution node
 * @param {string} sessionName - tmux session name
 * @param {string} message - message to send to Claude
 * @param {object} callbacks
 * @param {function} callbacks.onProgress - called with status strings
 * @param {function} callbacks.onStream - called with current response content periodically
 * @returns {Promise<{ success: boolean, response?: string, error?: string, duration?: number }>}
 */
async function ask(config, node, sessionName, message, callbacks = {}) {
    const {onProgress, onStream, vimMode, force} =
        typeof callbacks === 'function'
            ? {onProgress: callbacks} // backward compat: single function = onProgress
            : callbacks;

    const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
    const {pollInterval, cooldown, timeout} = config.relay;
    const streamInterval = config.relay.streamInterval || 3000;

    // Check if session is idle first (skip if force=true for manual user input)
    const beforeContent = await node.capturePane(paneTarget, {lines: 3});
    const currentState = tmux.detectState(beforeContent, config);
    if (currentState === 'working' && !force) {
        return {
            success: false,
            error: "Session is busy. Use /peek to see what it's doing.",
        };
    }
    if (currentState === 'off') {
        return {
            success: false,
            error: 'Claude is not running in this session.',
        };
    }

    // Ensure Claude's TUI is in INSERT mode (only needed for vim-mode terminals)
    if (vimMode) {
        await node.exec(`tmux send-keys -t "${paneTarget}" Escape`);
        await new Promise((r) => setTimeout(r, 150));
        await node.exec(`tmux send-keys -t "${paneTarget}" i`);
        await new Promise((r) => setTimeout(r, 100));
    }

    // Send the message
    try {
        await node.sendKeys(paneTarget, message, true);
    } catch (err) {
        return {
            success: false,
            error: `Failed to send message: ${err.message}`,
        };
    }
    const startTime = Date.now();

    if (onProgress) onProgress('Message sent, waiting for response...');

    // Poll for idle + stream updates
    return new Promise((resolve) => {
        let idleDetectedAt = null;
        let lastStreamAt = 0;
        let lastStreamContent = '';
        let polling = false;

        const timer = setInterval(async () => {
            if (polling) return;
            polling = true;

            try {
                const elapsed = Date.now() - startTime;

                // Timeout
                if (elapsed > timeout) {
                    clearInterval(timer);
                    if (onStream) {
                        const content = await captureResponse(
                            node,
                            paneTarget,
                            config,
                        );
                        if (content) onStream(content, true);
                    }
                    resolve({
                        success: false,
                        error: `Timed out after ${Math.round(timeout / 1000)}s. Claude may still be working. Use /peek to check.`,
                        duration: elapsed,
                    });
                    return;
                }

                // Check state
                const tail = await node.capturePane(paneTarget, {lines: 3});
                const state = tmux.detectState(tail, config);

                // Stream update if enough time has passed
                if (
                    onStream &&
                    state === 'working' &&
                    Date.now() - lastStreamAt >= streamInterval
                ) {
                    const content = await captureResponse(
                        node,
                        paneTarget,
                        config,
                    );
                    if (content && content !== lastStreamContent) {
                        lastStreamContent = content;
                        lastStreamAt = Date.now();
                        onStream(content, false);
                    }
                }

                if (state === 'idle') {
                    if (!idleDetectedAt) {
                        idleDetectedAt = Date.now();
                        return;
                    }

                    if (Date.now() - idleDetectedAt >= cooldown) {
                        clearInterval(timer);

                        const response = await captureResponse(
                            node,
                            paneTarget,
                            config,
                        );

                        resolve({
                            success: true,
                            response: response || '(empty response)',
                            duration: Date.now() - startTime,
                        });
                    }
                } else {
                    idleDetectedAt = null;
                }
            } finally {
                polling = false;
            }
        }, pollInterval);
    });
}

/**
 * Send a message to Claude without waiting for response (fire-and-forget).
 * @param {object} config
 * @param {Node} node - execution node
 * @param {string} sessionName
 * @param {string} message
 */
async function tell(config, node, sessionName, message, {vimMode} = {}) {
    const paneTarget = `${sessionName}:.${config.sessions.claudePane}`;
    const beforeContent = await node.capturePane(paneTarget, {lines: 3});
    const state = tmux.detectState(beforeContent, config);

    if (state === 'off') {
        return {
            success: false,
            error: 'Claude is not running in this session.',
        };
    }

    // Ensure Claude's TUI is in INSERT mode (only needed for vim-mode terminals)
    if (vimMode) {
        await node.exec(`tmux send-keys -t "${paneTarget}" Escape`);
        await new Promise((r) => setTimeout(r, 200));
        await node.exec(`tmux send-keys -t "${paneTarget}" i`);
        await new Promise((r) => setTimeout(r, 300));
    }

    try {
        await node.sendKeys(paneTarget, message, false);
    } catch (err) {
        return {
            success: false,
            error: `Failed to send message: ${err.message}`,
        };
    }
    await new Promise((r) => setTimeout(r, 100));
    await node.exec(`tmux send-keys -t "${paneTarget}" Enter`);
    return {success: true};
}

module.exports = {ask, tell};
