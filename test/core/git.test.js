import { describe, it, expect, beforeEach } from 'vitest';
import { createMockNode } from '../helpers/mocks.js';
import git from '../../src/core/git.js';

describe('git', () => {
  let node;

  beforeEach(() => {
    node = createMockNode();
  });

  describe('getLog', () => {
    it('parses git log output into structured objects', async () => {
      node.exec.mockResolvedValue(
        'abc123|abc|Fix bug|John|2 hours ago\ndef456|def|Add feature|Jane|1 day ago'
      );
      const log = await git.getLog(node, '/repo');
      expect(log).toEqual([
        { hash: 'abc123', short: 'abc', message: 'Fix bug', author: 'John', relative: '2 hours ago' },
        { hash: 'def456', short: 'def', message: 'Add feature', author: 'Jane', relative: '1 day ago' },
      ]);
    });

    it('returns [] on empty output', async () => {
      node.exec.mockResolvedValue(null);
      expect(await git.getLog(node, '/repo')).toEqual([]);
    });

    it('returns [] on error', async () => {
      node.exec.mockResolvedValue(null);
      expect(await git.getLog(node, '/bad')).toEqual([]);
    });
  });

  describe('getDiffStat', () => {
    it('parses numstat output', async () => {
      node.exec.mockResolvedValue('10\t5\tsrc/index.js\n3\t0\tREADME.md');
      const stats = await git.getDiffStat(node, '/repo');
      expect(stats).toEqual([
        { file: 'src/index.js', added: 10, deleted: 5 },
        { file: 'README.md', added: 3, deleted: 0 },
      ]);
    });

    it('returns [] on empty output', async () => {
      node.exec.mockResolvedValue(null);
      expect(await git.getDiffStat(node, '/repo')).toEqual([]);
    });
  });

  describe('getStagedStat', () => {
    it('parses cached numstat output', async () => {
      node.exec.mockResolvedValue('7\t2\tsrc/app.js');
      const stats = await git.getStagedStat(node, '/repo');
      expect(stats).toEqual([{ file: 'src/app.js', added: 7, deleted: 2 }]);
    });
  });

  describe('getChangedFiles', () => {
    it('parses porcelain status output', async () => {
      node.exec.mockResolvedValue('M  src/index.js\nA  new-file.js\n?? untracked.js');
      const files = await git.getChangedFiles(node, '/repo');
      expect(files).toEqual([
        { status: 'M', file: 'src/index.js' },
        { status: 'A', file: 'new-file.js' },
        { status: '??', file: 'untracked.js' },
      ]);
    });

    it('handles rename entries', async () => {
      node.exec.mockResolvedValue('R  old-name.js -> new-name.js');
      const files = await git.getChangedFiles(node, '/repo');
      expect(files[0].file).toBe('new-name.js');
    });

    it('returns [] on empty output', async () => {
      node.exec.mockResolvedValue(null);
      expect(await git.getChangedFiles(node, '/repo')).toEqual([]);
    });
  });

  describe('getFileDiff', () => {
    it('returns raw diff text', async () => {
      node.exec.mockResolvedValue('diff --git a/file b/file\n+added line');
      const diff = await git.getFileDiff(node, '/repo', 'file.js');
      expect(diff).toContain('+added line');
    });

    it('handles base branch comparison', async () => {
      node.exec
        .mockResolvedValueOnce('abc123')
        .mockResolvedValueOnce('diff content');
      const diff = await git.getFileDiff(node, '/repo', 'file.js', 'main');
      expect(diff).toBe('diff content');
    });

    it('returns empty string when no diff found', async () => {
      node.exec.mockResolvedValue(null);
      const diff = await git.getFileDiff(node, '/repo', 'file.js');
      expect(diff).toBe('');
    });
  });

  describe('getBranchDiff', () => {
    it('returns branch comparison data', async () => {
      node.exec
        .mockResolvedValueOnce('abc')       // rev-parse --verify main
        .mockResolvedValueOnce('def')       // merge-base
        .mockResolvedValueOnce('3')         // rev-list --count
        .mockResolvedValueOnce('5\t2\tsrc/app.js\n1\t0\tREADME.md');
      const result = await git.getBranchDiff(node, '/repo');
      expect(result.base).toBe('main');
      expect(result.commitCount).toBe(3);
      expect(result.files).toHaveLength(2);
    });
  });

  describe('getCommitFiles', () => {
    it('parses diff-tree output', async () => {
      node.exec.mockResolvedValue('10\t5\tsrc/index.js');
      const files = await git.getCommitFiles(node, '/repo', 'abc123');
      expect(files).toEqual([{ file: 'src/index.js', added: 10, deleted: 5 }]);
    });

    it('returns [] on empty output', async () => {
      node.exec.mockResolvedValue(null);
      expect(await git.getCommitFiles(node, '/repo', 'abc')).toEqual([]);
    });
  });
});
