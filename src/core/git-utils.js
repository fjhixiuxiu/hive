const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const log = require('./log');

/**
 * Clone a git repo into repoDir, or reuse an existing clone by fetching + resetting.
 * If no gitUrl is provided, just ensures the directory exists.
 *
 * @param {string|null} gitUrl  - Git URL to clone (null = just mkdir)
 * @param {string}      repoDir - Target directory
 * @param {object}      [opts]
 * @param {function}    [opts.onProgress] - callback(status, message) where status = 'cloning'|'reusing'|'ok'|'error'
 * @returns {Promise<{action: string}>} - action = 'cloned'|'reused'|'mkdir'
 */
async function cloneOrReuse(gitUrl, repoDir, opts = {}) {
  const { onProgress } = opts;
  const notify = (status, message) => { if (onProgress) onProgress(status, message); };

  if (gitUrl) {
    if (fs.existsSync(require('path').join(repoDir, '.git'))) {
      // Directory already cloned — fetch and reset to latest default branch
      log.info(`[git-utils] Reusing existing clone at ${repoDir}`);
      notify('reusing', `Reusing existing clone at ${repoDir}`);
      try {
        await execAsync(`git -C "${repoDir}" fetch origin`, { timeout: 60000 });
        // Determine default branch — try main, fall back to master
        let branch = 'main';
        try {
          await execAsync(`git -C "${repoDir}" rev-parse --verify origin/main`, { timeout: 5000 });
        } catch {
          branch = 'master';
        }
        await execAsync(`git -C "${repoDir}" checkout ${branch}`, { timeout: 10000 });
        await execAsync(`git -C "${repoDir}" reset --hard origin/${branch}`, { timeout: 10000 });
        notify('ok', `Reused clone at ${repoDir} (${branch})`);
        return { action: 'reused' };
      } catch (err) {
        notify('error', `Git reset of existing clone failed: ${err.message}`);
        throw new Error(`Git reset of existing clone failed: ${err.message}`);
      }
    } else {
      log.info(`[git-utils] Cloning ${gitUrl} → ${repoDir}`);
      notify('cloning', `Cloning ${gitUrl} → ${repoDir}`);
      try {
        await execAsync(`git clone ${gitUrl} "${repoDir}"`, { timeout: 300000 });
        notify('ok', `Cloned into ${repoDir}`);
        return { action: 'cloned' };
      } catch (err) {
        notify('error', `Git clone failed: ${err.message}`);
        throw new Error(`Git clone failed: ${err.message}`);
      }
    }
  } else {
    try {
      fs.mkdirSync(repoDir, { recursive: true });
      return { action: 'mkdir' };
    } catch (err) {
      throw new Error(`Failed to create directory: ${err.message}`);
    }
  }
}

module.exports = { cloneOrReuse };
