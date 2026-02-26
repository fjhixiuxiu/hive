/**
 * Get recent commit log.
 * @param {Node} node - execution node
 * @param {string} repoDir
 * @param {number} n - number of commits (default 15)
 * @returns {Promise<Array<{hash, short, message, author, relative}>>}
 */
async function getLog(node, repoDir, n = 15) {
  const out = await node.exec(`git -C "${repoDir}" log --format="%H|%h|%s|%an|%ar" -${n} 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, short, message, author, relative] = line.split('|');
    return { hash, short, message: message || '', author: author || '', relative: relative || '' };
  });
}

/**
 * Get diff stat for unstaged changes.
 * @returns {Promise<Array<{file, added, deleted}>>}
 */
async function getDiffStat(node, repoDir) {
  const out = await node.exec(`git -C "${repoDir}" diff --numstat 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...fileParts] = line.split('\t');
    return { file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
  });
}

/**
 * Get diff stat for staged changes.
 * @returns {Promise<Array<{file, added, deleted}>>}
 */
async function getStagedStat(node, repoDir) {
  const out = await node.exec(`git -C "${repoDir}" diff --cached --numstat 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...fileParts] = line.split('\t');
    return { file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
  });
}

/**
 * Get changed files via git status --porcelain.
 * @returns {Promise<Array<{status, file}>>}
 */
async function getChangedFiles(node, repoDir) {
  // Use -z for NUL-delimited output to avoid trim() stripping leading spaces
  // from porcelain status columns (e.g. " M file" → "M file" breaks parsing).
  // Fallback: parse with regex that handles both " M" and "M " status formats.
  const out = await node.exec(`git -C "${repoDir}" status --porcelain 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    // Porcelain format: XY<space>filename — but trim() may strip leading space
    // from first line, turning " M file" into "M file". Use regex to handle both.
    const m = line.match(/^([MADRCU? ]{1,2})\s+(.+)$/);
    if (!m) return null;
    const status = m[1].trim();
    let file = m[2];
    // Handle rename: "R  old -> new" — use the new name
    if (status.startsWith('R') && file.includes(' -> ')) {
      file = file.split(' -> ').pop();
    }
    return { status, file };
  }).filter(Boolean);
}

/**
 * Get unified diff for a specific file.
 * Falls back to showing full file content for untracked files.
 * @param {Node} node
 * @param {string} repoDir
 * @param {string} file
 * @param {string} [base] - if provided, diff base...HEAD (branch comparison)
 * @returns {Promise<string>}
 */
async function getFileDiff(node, repoDir, file, base) {
  const gitOpts = { timeout: 30000 }; // 30s — large repos can be slow
  if (base) {
    // Use merge-base to only show branch-specific changes
    const mergeBase = await node.exec(`git -C "${repoDir}" merge-base ${base} HEAD 2>/dev/null`, gitOpts);
    const diffRef = mergeBase ? mergeBase.trim() : base;
    return await node.exec(`git -C "${repoDir}" diff ${diffRef}..HEAD -- "${file}" 2>/dev/null`, gitOpts) || '';
  }

  // Try normal diff first (staged + unstaged vs HEAD)
  const diff = await node.exec(`git -C "${repoDir}" diff HEAD -- "${file}" 2>/dev/null`, gitOpts);
  if (diff) return diff;

  // For untracked files, diff --no-index exits 1 (differences found),
  // so we can't use node.exec which returns null on non-zero. Use || true.
  const untrackedDiff = await node.exec(`git -C "${repoDir}" diff --no-index /dev/null "${file}" 2>/dev/null || true`, gitOpts);
  if (untrackedDiff) return untrackedDiff;

  return '';
}

/**
 * Get branch comparison against base (main or master).
 * @returns {Promise<{ base, commitCount, files: Array<{file, added, deleted}> }>}
 */
async function getBranchDiff(node, repoDir) {
  // Auto-detect base branch
  let base = 'main';
  const hasMain = await node.exec(`git -C "${repoDir}" rev-parse --verify main 2>/dev/null`);
  if (!hasMain) {
    const hasMaster = await node.exec(`git -C "${repoDir}" rev-parse --verify master 2>/dev/null`);
    base = hasMaster ? 'master' : 'main';
  }

  // Find merge-base to only show branch-specific changes (not changes on base branch)
  const mergeBase = await node.exec(`git -C "${repoDir}" merge-base ${base} HEAD 2>/dev/null`);
  const diffRef = mergeBase ? mergeBase.trim() : base;

  const countOut = await node.exec(`git -C "${repoDir}" rev-list --count ${diffRef}..HEAD 2>/dev/null`);
  const commitCount = parseInt(countOut) || 0;

  const numstat = await node.exec(`git -C "${repoDir}" diff --numstat ${diffRef}..HEAD 2>/dev/null`);
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
 * @param {Node} node
 * @param {string} repoDir
 * @param {string} hash - commit hash
 * @returns {Promise<Array<{file, added, deleted}>>}
 */
async function getCommitFiles(node, repoDir, hash) {
  const out = await node.exec(`git -C "${repoDir}" diff-tree --no-commit-id -r --numstat "${hash}" 2>/dev/null`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...fileParts] = line.split('\t');
    return { file: fileParts.join('\t'), added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
  });
}

/**
 * Get unified diff for a file in a specific commit.
 * @param {Node} node
 * @param {string} repoDir
 * @param {string} hash - commit hash
 * @param {string} file
 * @returns {Promise<string>}
 */
async function getCommitFileDiff(node, repoDir, hash, file) {
  return await node.exec(`git -C "${repoDir}" diff "${hash}^".."${hash}" -- "${file}" 2>/dev/null`, { timeout: 30000 }) || '';
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
