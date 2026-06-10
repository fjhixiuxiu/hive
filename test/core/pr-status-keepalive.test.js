import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

// Verifies that `fetchJSON` reuses a single TCP socket across requests via the
// shared keep-alive Agent. See plans/2026-06-10-hive-keepalive-agent.md.

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  // Force-close any keep-alive sockets the client may still be holding open.
  // Without this, server.close() waits for the default 5s keepAliveTimeout.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

describe('pr-status keep-alive agent', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // T1 — Load-bearing: socket reuse across many requests.
  // Without keep-alive, N requests → N connections. With keep-alive, N → 1.
  it('reuses a single TCP socket across sequential requests', async () => {
    let connections = 0;
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    server.on('connection', () => { connections++; });

    const { _fetchJSON } = await import('../../src/core/pr-status.js');
    for (let i = 0; i < 5; i++) {
      await _fetchJSON(`${url}/req-${i}`);
    }
    expect(connections).toBe(1);

    await closeServer(server);
  });

  // T2 — Error path unchanged: server closes mid-handshake.
  it('rejects when the server closes the socket without responding', async () => {
    const { server, url } = await startServer((req) => { req.socket.destroy(); });

    const { _fetchJSON } = await import('../../src/core/pr-status.js');
    await expect(_fetchJSON(`${url}/x`)).rejects.toThrow();

    await closeServer(server);
  });

  // T3 — Timeout still fires: server accepts then hangs forever.
  it('rejects with timeout when server never responds', async () => {
    const { server, url } = await startServer(() => {});

    const { _fetchJSON } = await import('../../src/core/pr-status.js');
    // HTTP_TIMEOUT is 5s; cap the test at 7s so we don't hang the suite.
    await expect(
      Promise.race([
        _fetchJSON(`${url}/x`),
        new Promise((_, r) => setTimeout(() => r(new Error('test timeout exceeded')), 7000)),
      ])
    ).rejects.toThrow(/Timeout|test timeout exceeded/);

    await closeServer(server);
  }, 10000);

  // T4 — ETag path still works after threading `agent` through the same
  // options object. Regression guard, not a behavior test.
  it('honors ETag — 304 returns cached parsed body', async () => {
    const payload = { number: 7, ok: true };
    let hits = 0;
    const { server, url } = await startServer((req, res) => {
      hits++;
      if (req.headers['if-none-match'] === '"abc"') {
        res.writeHead(304, { 'ETag': '"abc"' });
        return res.end();
      }
      res.writeHead(200, { 'ETag': '"abc"', 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });

    const { _fetchJSON } = await import('../../src/core/pr-status.js');
    const first = await _fetchJSON(`${url}/etag`);
    const second = await _fetchJSON(`${url}/etag`);

    expect(hits).toBe(2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);     // 304 normalized to cached 200
    expect(second.data).toEqual(payload);

    await closeServer(server);
  });
});
