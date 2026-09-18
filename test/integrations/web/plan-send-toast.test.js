import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// The plan sidebar's "Send" toast names the session the comments went to.
//
// A mis-routed send used to look exactly like a correct one ("Sent to Claude"),
// so comments delivered to the wrong session went unnoticed until the real
// owner was found still waiting. The server now answers with the session it
// relayed to, and the toast has to show it.
//
// sendPlanRefDrafts is lifted out of app.js rather than restated, so a change
// there that stops reading the response cannot pass this.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(APP_JS, 'utf8');

function liftSend({ fetch, showToast, alert = vi.fn() }) {
  const m = source.match(/async function sendPlanRefDrafts\(\) \{[\s\S]*?\n {2}\}/);
  if (!m) throw new Error('could not find sendPlanRefDrafts in app.js');
  const document = { getElementById: () => null };
  return new Function(
    'document',
    'fetch',
    'showToast',
    'alert',
    'refreshPlanRefComments',
    'renderPlanRefComments',
    'currentPlanRefId',
    'currentPlanRefComments',
    `${m[0]}\nreturn sendPlanRefDrafts;`,
  )(
    document,
    fetch,
    showToast,
    alert,
    async () => {},
    () => {},
    'abc12345',
    [{ id: 'c1', status: 'draft' }],
  );
}

const okResponse = (body) => ({ ok: true, json: async () => body });

describe('plan send toast', () => {
  it('names the session the server relayed to', async () => {
    const showToast = vi.fn();
    const send = liftSend({
      fetch: vi.fn(async () => okResponse({ sent: 1, session: 12 })),
      showToast,
    });

    await send();

    expect(showToast).toHaveBeenCalledWith('Sent to S12', '1 comment(s) delivered', 'success');
  });

  it('falls back to "Claude" when the response names no session', async () => {
    const showToast = vi.fn();
    const send = liftSend({ fetch: vi.fn(async () => okResponse({ sent: 1 })), showToast });

    await send();

    expect(showToast).toHaveBeenCalledWith('Sent to Claude', '1 comment(s) delivered', 'success');
  });
});
