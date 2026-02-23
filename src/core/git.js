const tmux = require('./tmux');

/**
 * Get recent commit log.
 * @param {string} repoDir
 * @param {number} n - number of commits (default 15)
 * @returns {Array<{hash, short, message, author, relative}>}
 */
function getLog(repoDir, n = 15) {
  const out = tmux.exec(`git -C "${repoDir}" log --format="%H|%h|%s|%an|%ar" -${n} 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, short, message, author, relative] = line.split('|');
    return { hash, short, message: message || '', author: author || '', relative: relative || '' };
  });
}

/**
 * Get diff stat for unstaged changes.
 * @returns {Array<{file, added, deleted}>}
 */
function getDiffStat(repoDir) {
  const out = tmux.exec(`git -C "${repoDir}" diff --numstat 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...fileParts] = line.split('\t');
    return { file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
  });
}

/**
 * Get diff stat for staged changes.
 * @returns {Array<{file, added, deleted}>}
 */
function getStagedStat(repoDir) {
  const out = tmux.exec(`git -C "${repoDir}" diff --cached --numstat 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...fileParts] = line.split('\t');
    return { file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
  });
}

/**
 * Get changed files via git status --porcelain.
 * @returns {Array<{status, file}>}
 */
function getChangedFiles(repoDir) {
  const out = tmux.exec(`git -C "${repoDir}" status --porcelain 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const status = line.substring(0, 2).trim();
    const file = line.substring(3);
    return { status, file };
  });
}

/**
 * Get unified diff for a specific file.
 * Falls back to showing full file content for untracked files.
 * @param {string} repoDir
 * @param {string} file
 * @param {string} [base] - if provided, diff base...HEAD (branch comparison)
 * @returns {string}
 */
function getFileDiff(repoDir, file, base) {
  if (base) {
    // Branch comparison: show what changed on this branch vs base
    return tmux.exec(`git -C "${repoDir}" diff ${base}...HEAD -- "${file}" 2>/dev/null`) || '';
  }

  // Try normal diff first (staged + unstaged vs HEAD)
  const diff = tmux.exec(`git -C "${repoDir}" diff HEAD -- "${file}" 2>/dev/null`);
  if (diff) return diff;

  // For untracked files, diff --no-index exits 1 (differences found),
  // so we can't use tmux.exec which throws on non-zero. Use || true.
  const untrackedDiff = tmux.exec(`git -C "${repoDir}" diff --no-index /dev/null "${file}" 2>/dev/null || true`);
  if (untrackedDiff) return untrackedDiff;

  return '';
}

/**
 * Get branch comparison against base (main or master).
 * @returns {{ base, commitCount, files: Array<{file, added, deleted}> }}
 */
function getBranchDiff(repoDir) {
  // Auto-detect base branch
  let base = 'main';
  const hasMain = tmux.exec(`git -C "${repoDir}" rev-parse --verify main 2>/dev/null`);
  if (!hasMain) {
    const hasMaster = tmux.exec(`git -C "${repoDir}" rev-parse --verify master 2>/dev/null`);
    base = hasMaster ? 'master' : 'main';
  }

  const countOut = tmux.exec(`git -C "${repoDir}" rev-list --count ${base}...HEAD 2>/dev/null`);
  const commitCount = parseInt(countOut) || 0;

  const numstat = tmux.exec(`git -C "${repoDir}" diff --numstat ${base}...HEAD 2>/dev/null`);
  const files = [];
  if (numstat) {
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added, deleted, ...fileParts] = line.split('\t');
      files.push({ file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 });
    }
  }

  return { base, commitCount, files };
}

/**
 * Get files changed in a specific commit.
 * @param {string} repoDir
 * @param {string} hash - commit hash
 * @returns {Array<{file, added, deleted}>}
 */
function getCommitFiles(repoDir, hash) {
  const out = tmux.exec(`git -C "${repoDir}" diff-tree --no-commit-id -r --numstat "${hash}" 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...fileParts] = line.split('\t');
    return { file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
  });
}

/**
 * Get unified diff for a file in a specific commit.
 * @param {string} repoDir
 * @param {string} hash - commit hash
 * @param {string} file
 * @returns {string}
 */
function getCommitFileDiff(repoDir, hash, file) {
  return tmux.exec(`git -C "${repoDir}" diff "${hash}^".."${hash}" -- "${file}" 2>/dev/null`) || '';
}

module.exports = {
  getLog,
  getDiffStat,
  getStagedStat,
  getChangedFiles,
  getFileDiff,
  getBranchDiff,
  getCommitFiles,
  getCommitFileDiff,
};
