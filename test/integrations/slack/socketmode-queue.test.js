import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { SocketModeReceiver } = require('@slack/bolt');
const { retryPolicies } = require('@slack/web-api');

// Regression guard for the Socket Mode handshake queue leak.
//
// `apps.connections.open` is a Slack Tier-1 endpoint (~1 req/min). The
// @slack/web-api defaults let a reconnect storm park 100 rate-limited
// handshakes in the client's p-queue, each holding a concurrency slot while it
// burns through a long retry policy. The reconnect loop keeps enqueueing, the
// queue never drains, and each queued entry retains an axios request config
// (~20KB). Observed in production: 58,974 queued calls holding 1.18GB of
// V8 old-space after 7 days of uptime.
//
// The subtlety these tests lock in: Bolt's App forwards only
// `installerOptions.clientOptions` to SocketModeReceiver, which passes just
// { appToken, logLevel, logger, clientOptions } to SocketModeClient. Options
// handed to `new App({ clientOptions })` reach `app.client` and NEVER reach the
// client that performs the handshake — so tuning the wrong one looks correct
// and fixes nothing.

// The WebClient keeps its p-queue in a private field; find it structurally.
function findQueue(client) {
  for (const k of Reflect.ownKeys(client)) {
    const v = client[k];
    if (v && typeof v === 'object' && typeof v.concurrency === 'number' && 'pending' in v) return v;
  }
  return null;
}

// Import the real options bot.js uses, so reverting the fix fails these tests
// rather than quietly passing against a copy of the intended values.
const { HANDSHAKE_CLIENT_OPTIONS } = require('../../../src/integrations/slack/bot');

describe('Socket Mode handshake client', () => {
  it('bounds concurrency and retries in the options bot.js actually ships', () => {
    // Guards the values themselves. 100-wide concurrency against a Tier-1
    // endpoint is what produced the 1.18GB leak.
    expect(HANDSHAKE_CLIENT_OPTIONS.maxRequestConcurrency).toBeLessThanOrEqual(10);
    expect(HANDSHAKE_CLIENT_OPTIONS.retryConfig.retries).toBeLessThanOrEqual(
      retryPolicies.fiveRetriesInFiveMinutes.retries,
    );
  });

  it('applies bounded concurrency to the client that calls apps.connections.open', () => {
    const receiver = new SocketModeReceiver({
      appToken: 'xapp-test-token',
      installerOptions: { clientOptions: HANDSHAKE_CLIENT_OPTIONS },
    });

    const queue = findQueue(receiver.client.webClient);
    expect(queue, 'WebClient p-queue should be discoverable').not.toBeNull();
    expect(queue.concurrency).toBe(5);
  });

  it('applies a fast-failing retry policy so slots free up in minutes', () => {
    const receiver = new SocketModeReceiver({
      appToken: 'xapp-test-token',
      installerOptions: { clientOptions: HANDSHAKE_CLIENT_OPTIONS },
    });

    expect(receiver.client.webClient.retryConfig.retries).toBe(
      retryPolicies.fiveRetriesInFiveMinutes.retries,
    );
  });

  it('leaves the SDK defaults dangerously wide when unconfigured', () => {
    // Documents the failure mode: without installerOptions.clientOptions the
    // handshake client is wide open. If a future SDK bump makes the defaults
    // safe, this test fails and the workaround can be reconsidered.
    const receiver = new SocketModeReceiver({ appToken: 'xapp-test-token' });
    const queue = findQueue(receiver.client.webClient);

    expect(queue.concurrency).toBeGreaterThan(50);
    expect(receiver.client.webClient.retryConfig.retries).toBeGreaterThan(50);
  });

  it('does not reach the handshake client via App-level clientOptions', () => {
    // The trap this PR exists to close: top-level clientOptions is NOT
    // forwarded to SocketModeClient, so configuring it there is a silent no-op.
    const receiver = new SocketModeReceiver({
      appToken: 'xapp-test-token',
      clientOptions: HANDSHAKE_CLIENT_OPTIONS, // wrong level on purpose
    });

    const queue = findQueue(receiver.client.webClient);
    expect(queue.concurrency).not.toBe(5);
  });

  it('keeps the server ping timeout at the SDK default', () => {
    // The dead `socketModeOptions` block set serverPingTimeoutMS: 15000 with
    // the annotation "default 5s". The real default is 30000, so applying that
    // value would tighten the timeout and cause more disconnects — each of
    // which costs a rate-limited handshake. Only clientPingTimeoutMS is raised.
    const receiver = new SocketModeReceiver({ appToken: 'xapp-test-token' });

    expect(receiver.client.serverPingTimeoutMS).toBe(30000);
    expect(receiver.client.clientPingTimeoutMS).toBe(5000);
  });
});

describe('nonOverlapping', () => {
  const { nonOverlapping } = require('../../../src/integrations/slack/bot');

  const defer = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('skips a tick while the previous one is still running', async () => {
    const gate = defer();
    let starts = 0;
    const wrapped = nonOverlapping(async () => {
      starts += 1;
      await gate.promise;
    });

    const first = wrapped();
    await wrapped(); // must be skipped, not queued
    await wrapped();
    expect(starts).toBe(1);

    gate.resolve();
    await first;

    await wrapped(); // runs again once the first finished
    expect(starts).toBe(2);
  });

  it('releases the guard when the wrapped fn throws', async () => {
    let calls = 0;
    const wrapped = nonOverlapping(async () => {
      calls += 1;
      throw new Error('boom');
    });

    await expect(wrapped()).rejects.toThrow('boom');
    await expect(wrapped()).rejects.toThrow('boom');
    expect(calls).toBe(2); // guard did not latch shut on the error path
  });

  it('passes arguments and returns the result', async () => {
    const wrapped = nonOverlapping(async (a, b) => a + b);
    await expect(wrapped(2, 3)).resolves.toBe(5);
  });
});
