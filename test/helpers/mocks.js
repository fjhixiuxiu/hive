import { vi } from 'vitest';
import EventEmitter from 'events';

/**
 * Create a fake WebSocket (EventEmitter with send/close stubs).
 */
export function createFakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  return ws;
}

/**
 * Extract all JSON messages sent via ws.send().
 */
export function sentMessages(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

/**
 * Find the first sent message of a given type.
 */
export function findSent(ws, type) {
  return sentMessages(ws).find((m) => m.type === type);
}

/**
 * Create a mock Node with standard methods.
 */
export function createMockNode(id = 'local') {
  return {
    id,
    exec: vi.fn().mockResolvedValue(''),
    capturePane: vi.fn().mockResolvedValue(''),
    sendKeys: vi.fn().mockResolvedValue(),
    listSessions: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(null),
    fileExists: vi.fn().mockResolvedValue(false),
    gitInfo: vi.fn().mockResolvedValue({ branch: '', staged: 0, modified: 0, untracked: 0 }),
  };
}

/**
 * Create a minimal valid hive config object.
 */
export function createMockConfig(overrides = {}) {
  return {
    sessions: {
      repoBase: '/home/user/dev/session-',
      pattern: /^\d+-/,
      claudePane: 1,
      repoDir: (num) => `/home/user/dev/session-${num}`,
      hiveName: '',
      namePrefix: '',
      ...(overrides.sessions || {}),
    },
    relay: {
      pollInterval: 100,
      cooldown: 200,
      timeout: 5000,
      streamInterval: 1000,
      ...(overrides.relay || {}),
    },
    watcher: {
      interval: 1000,
      ...(overrides.watcher || {}),
    },
    cache: {
      stateDir: '/tmp/hive-states',
      ...(overrides.cache || {}),
    },
    idlePatterns: [/>\s*$/, /\$\s*$/],
    offPatterns: [/\[exited\]/, /no server running/],
    github: { repo: 'owner/repo', ...(overrides.github || {}) },
    jenkins: { baseUrl: '', jobPath: '', ...(overrides.jenkins || {}) },
    nodes: overrides.nodes || {},
    ...overrides,
  };
}

/**
 * Create a mock Watcher (EventEmitter with start/stop stubs).
 */
export function createMockWatcher() {
  const watcher = new EventEmitter();
  watcher.start = vi.fn().mockResolvedValue();
  watcher.stop = vi.fn();
  watcher.prevStates = new Map();
  watcher.notifiedIdle = new Set();
  watcher.seenWorking = new Set();
  watcher.prevCI = new Map();
  watcher.prevReview = new Map();
  watcher.detectedWaiting = new Set();
  watcher.sessionActivity = new Map();
  watcher.pendingIdle = new Map();
  return watcher;
}
