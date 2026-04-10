import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { buildConfigMessage } from '../../../src/integrations/web/ws-helpers.js';

/**
 * Tests for the `config` WebSocket payload builder.
 * Verifies env vars (HIVE_TITLE, HIVE_REPO_DIR) and hive.config.js values
 * propagate into the message sent to clients on connect.
 */
describe('buildConfigMessage', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HIVE_TITLE;
    delete process.env.HIVE_REPO_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function makeConfig(overrides = {}) {
    return {
      links: { github: 'https://github.com/x/y' },
      sessions: { repoBase: '/repos', hiveName: 'alpha' },
      ...overrides,
    };
  }

  it('returns a message with type "config"', () => {
    const msg = buildConfigMessage(makeConfig());
    expect(msg.type).toBe('config');
  });

  it('propagates HIVE_TITLE from env to the title field', () => {
    process.env.HIVE_TITLE = 'my-custom-hive';
    const msg = buildConfigMessage(makeConfig());
    expect(msg.title).toBe('my-custom-hive');
  });

  it('defaults title to empty string when HIVE_TITLE is unset', () => {
    const msg = buildConfigMessage(makeConfig());
    expect(msg.title).toBe('');
  });

  it('passes through links from config', () => {
    const msg = buildConfigMessage(makeConfig());
    expect(msg.links).toEqual({ github: 'https://github.com/x/y' });
  });

  it('defaults links to empty object when not set', () => {
    const msg = buildConfigMessage({ sessions: {} });
    expect(msg.links).toEqual({});
  });

  it('uses config.sessions.repoBase for spawnBaseDir', () => {
    const msg = buildConfigMessage(makeConfig({ sessions: { repoBase: '/custom/repos' } }));
    expect(msg.spawnBaseDir).toBe('/custom/repos');
  });

  it('falls back to HIVE_REPO_DIR env when repoBase is missing', () => {
    process.env.HIVE_REPO_DIR = '/env/repos';
    const msg = buildConfigMessage({ sessions: {} });
    expect(msg.spawnBaseDir).toBe('/env/repos');
  });

  it('falls back to ~/ai-dev when both repoBase and HIVE_REPO_DIR are missing', () => {
    const msg = buildConfigMessage({ sessions: {} });
    expect(msg.spawnBaseDir).toBe('~/ai-dev');
  });

  it('propagates hiveName from config', () => {
    const msg = buildConfigMessage(makeConfig());
    expect(msg.hiveName).toBe('alpha');
  });

  it('defaults hiveName to empty string when not set', () => {
    const msg = buildConfigMessage({ sessions: {} });
    expect(msg.hiveName).toBe('');
  });

  it('does not mutate the input config', () => {
    const config = makeConfig();
    const snapshot = JSON.parse(JSON.stringify(config));
    buildConfigMessage(config);
    expect(config).toEqual(snapshot);
  });
});
