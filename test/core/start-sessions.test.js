import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseExistingSessions, pathMatchesRoot, resolveSessionAction } = require('../../start-sessions');

// ── parseExistingSessions ──────────────────────────────────

describe('parseExistingSessions', () => {
  it('parses standard tmux list-sessions output', () => {
    const output = '1:/Users/me/agents/1\n2:/Users/me/agents/2\nhive-server:/Users/me/hive';
    expect(parseExistingSessions(output)).toEqual({
      '1': '/Users/me/agents/1',
      '2': '/Users/me/agents/2',
      'hive-server': '/Users/me/hive',
    });
  });

  it('returns empty map for empty string', () => {
    expect(parseExistingSessions('')).toEqual({});
  });

  it('returns empty map for null/undefined', () => {
    expect(parseExistingSessions(null)).toEqual({});
    expect(parseExistingSessions(undefined)).toEqual({});
  });

  it('returns empty map for whitespace-only output', () => {
    expect(parseExistingSessions('  \n  ')).toEqual({});
  });

  it('handles paths containing colons', () => {
    // tmux format uses first colon as separator — paths with colons should work
    const output = '1:/Users/me/project:v2/agents/1';
    expect(parseExistingSessions(output)).toEqual({
      '1': '/Users/me/project:v2/agents/1',
    });
  });

  it('handles single session', () => {
    const output = '3:/home/user/workspace/3\n';
    expect(parseExistingSessions(output)).toEqual({
      '3': '/home/user/workspace/3',
    });
  });
});

// ── pathMatchesRoot ────────────────────────────────────────

describe('pathMatchesRoot', () => {
  it('matches exact path', () => {
    expect(pathMatchesRoot('/Users/me/agents/1', '/Users/me/agents/1')).toBe(true);
  });

  it('matches subdirectory of root', () => {
    expect(pathMatchesRoot('/Users/me/agents/1/sub', '/Users/me/agents/1')).toBe(true);
  });

  it('rejects path that shares a prefix but is a different directory', () => {
    // This is the edge case from the review: webplatform10 vs webplatform1
    expect(pathMatchesRoot('/Users/me/webplatform10', '/Users/me/webplatform1')).toBe(false);
  });

  it('rejects completely different path', () => {
    expect(pathMatchesRoot('/home/user', '/Users/me/agents/1')).toBe(false);
  });

  it('rejects home directory against agent root', () => {
    expect(pathMatchesRoot('/Users/me', '/Users/me/agents/1')).toBe(false);
  });
});

// ── resolveSessionAction ───────────────────────────────────

describe('resolveSessionAction', () => {
  const existing = {
    '1': '/Users/me/agents/1',
    '2': '/Users/me',                 // wrong path (stale)
    '3': '/Users/me/agents/30',       // wrong path (prefix collision)
  };

  it('returns "skip" when session exists with correct path', () => {
    expect(resolveSessionAction('1', '/Users/me/agents/1', existing, false)).toBe('skip');
  });

  it('returns "recreate" when session exists with wrong path', () => {
    expect(resolveSessionAction('2', '/Users/me/agents/2', existing, false)).toBe('recreate');
  });

  it('returns "create" when session does not exist', () => {
    expect(resolveSessionAction('99', '/Users/me/agents/99', existing, false)).toBe('create');
  });

  it('returns "recreate" with --force even when path is correct', () => {
    expect(resolveSessionAction('1', '/Users/me/agents/1', existing, true)).toBe('recreate');
  });

  it('returns "recreate" for prefix-collision path (e.g. agents/30 vs agents/3)', () => {
    expect(resolveSessionAction('3', '/Users/me/agents/3', existing, false)).toBe('recreate');
  });

  it('returns "skip" when current path is a subdirectory of root', () => {
    const withSub = { '5': '/Users/me/agents/5/subdir' };
    expect(resolveSessionAction('5', '/Users/me/agents/5', withSub, false)).toBe('skip');
  });
});
