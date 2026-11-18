import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ALL_TOOLS } from '../../../src/mcp-server/instructions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '../../../src/integrations/web/public/app.js');

// ---------------------------------------------------------------------------
// The admin → MCP config page renders one toggle per tool from a hardcoded
// `MCP_TOOLS` array in app.js. A tool missing from that array can never be
// ticked, so `mcp:deploy` never writes it into a session's `.mcp.json` and the
// agent never gets it — which is exactly how `hive_publish_plan`,
// `hive_reply_to_comment` and `hive_resolve_comment` ended up unreachable on
// hives after those tools were added to ALL_TOOLS but not to this list.
//
// ALL_TOOLS (instructions.mjs) is the canonical set the MCP server can
// register. The admin page must offer every one of them and nothing else, so
// the two lists can never drift again.
// ---------------------------------------------------------------------------

const source = fs.readFileSync(APP_JS, 'utf8');

function liftMcpToolNames() {
  const block = source.match(/var MCP_TOOLS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('could not find MCP_TOOLS array in app.js');
  const names = [...block[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('MCP_TOOLS parsed but held no tool names');
  return names;
}

describe('admin MCP config tool catalog (app.js MCP_TOOLS)', () => {
  const names = liftMcpToolNames();

  it('offers exactly the tools the MCP server can register (parity with ALL_TOOLS)', () => {
    expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('lists no tool twice', () => {
    expect(names.length).toBe(new Set(names).size);
  });

  it('exposes the plan tools so they can be deployed from the admin page', () => {
    expect(names).toContain('hive_publish_plan');
    expect(names).toContain('hive_reply_to_comment');
    expect(names).toContain('hive_resolve_comment');
  });
});
