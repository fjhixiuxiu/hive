import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// A session on a Claude Code startup dialog (folder trust, permissions mode) is
// `blocked`: hive will not answer the dialog or send the session tasks, so it
// waits for a person indefinitely. Before this state existed the detector read
// the dialog as idle and the dashboard drew a green hex — the one colour that
// says "nothing to do here".
//
// The helpers are lifted out of app.js rather than restated, so a change there
// that stops saying so cannot pass this.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(APP_JS, 'utf8');

function lift(name) {
  const m = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}`));
  if (!m) throw new Error(`could not find ${name} in app.js`);
  return new Function(`return (${m[0]});`)();
}

const fleetHexSvg = lift('fleetHexSvg');
const cardBlockedHtml = lift('cardBlockedHtml');

describe('blocked session on the dashboard', () => {
  it('draws the hex red, not the idle green', () => {
    expect(fleetHexSvg('blocked')).toContain('class="hive-logo logo-red"');
    expect(fleetHexSvg('blocked')).not.toContain('logo-green');
  });

  it('leaves the other states their colours', () => {
    expect(fleetHexSvg('idle')).toContain('logo-green');
    expect(fleetHexSvg('working')).toContain('logo-animated');
    expect(fleetHexSvg('off')).toContain('logo-purple');
  });

  it('says in words that the session needs a person', () => {
    const html = cardBlockedHtml('blocked');
    expect(html).toContain('class="card-blocked"');
    expect(html).toContain('Needs you: startup dialog');
    expect(html).toMatch(/will not answer it/);
  });

  it('adds nothing to a card in any other state', () => {
    for (const state of ['idle', 'working', 'off', undefined]) {
      expect(cardBlockedHtml(state)).toBe('');
    }
  });

  it('renders the chip on every card builder', () => {
    // Compact card, expanded card, and the expanded card's meta refresh.
    expect(source.match(/let metaParts = cardBlockedHtml\(s\.state\);/g)).toHaveLength(3);
  });
});
