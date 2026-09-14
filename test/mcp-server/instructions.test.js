import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ALL_TOOLS,
  INSTRUCTION_BLOCKS,
  buildInstructions,
  resolveTools,
  toolsMentionedIn,
} from '../../src/mcp-server/instructions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(
  path.join(here, '..', '..', 'src', 'mcp-server', 'index.mjs'),
  'utf8',
);
const defaultFixture = fs.readFileSync(
  path.join(here, 'fixtures', 'instructions-default.txt'),
  'utf8',
);

// The --tools lists hive is plausibly run with, including the subsets that
// exposed the bug and the degenerate ends of the range.
const TOOL_CONFIGS = [
  null,
  ALL_TOOLS,
  [],
  ['hive_get_task', 'hive_complete_task'],
  ['hive_get_task', 'hive_complete_task', 'hive_post_update'],
  ['hive_publish_plan'],
  ['hive_publish_plan', 'hive_reply_to_comment'],
  ['hive_publish_plan', 'hive_resolve_comment'],
  ['hive_reply_to_comment', 'hive_resolve_comment'],
  ALL_TOOLS.filter((t) => t !== 'hive_publish_plan'),
  ALL_TOOLS.filter((t) => t !== 'hive_resolve_comment'),
];

const label = (tools) =>
  tools === null ? 'tools=all' : tools.length === 0 ? 'tools=none' : `tools=[${tools.join(',')}]`;

describe('MCP instruction/tool parity', () => {
  // The invariant this module exists to hold. Before the instructions were
  // split into tool-gated blocks, a --tools subset still shipped the whole
  // plans protocol: the session was told to call hive_publish_plan and
  // hive_reply_to_comment in an install where neither was registered.
  describe('instructions never name a tool this hive did not register', () => {
    for (const enabledTools of TOOL_CONFIGS) {
      it(label(enabledTools), () => {
        const registered = new Set(resolveTools({ enabledTools }));
        const mentioned = toolsMentionedIn(buildInstructions({ enabledTools }));
        expect(mentioned.filter((t) => !registered.has(t))).toEqual([]);
      });
    }
  });

  describe('the regression that motivated this', () => {
    it('a get_task/complete_task install is not told to publish plans', () => {
      const text = buildInstructions({
        enabledTools: ['hive_get_task', 'hive_complete_task'],
      });
      expect(text).not.toContain('hive_publish_plan');
      expect(text).not.toContain('hive_reply_to_comment');
      expect(text).not.toContain('hive_resolve_comment');
      expect(text).toBe('');
    });

    it('keeps the plans block but drops comments when only the reply tool is gone', () => {
      const text = buildInstructions({
        enabledTools: ALL_TOOLS.filter((t) => t !== 'hive_reply_to_comment'),
      });
      expect(text).toContain('hive_publish_plan');
      expect(text).not.toContain('hive_reply_to_comment');
      expect(text).not.toContain('hive_resolve_comment');
    });

    it('drops both blocks when the plan tool itself is gone', () => {
      const text = buildInstructions({
        enabledTools: ALL_TOOLS.filter((t) => t !== 'hive_publish_plan'),
      });
      // The comments block calls hive_publish_plan too, so it cannot survive
      // its absence either.
      expect(text).toBe('');
    });

    it('an empty --tools list registers nothing and instructs nothing', () => {
      expect(resolveTools({ enabledTools: [] })).toEqual([]);
      expect(buildInstructions({ enabledTools: [] })).toBe('');
    });
  });

  // H1 — no default behavior change. This fixture was captured from the
  // pre-split implementation; a default install must still receive exactly the
  // text it received before.
  describe('default installs get byte-identical instructions', () => {
    it('matches the pre-split output', () => {
      expect(buildInstructions({})).toBe(defaultFixture);
    });

    it('an explicit full tool list is identical to the default', () => {
      expect(buildInstructions({ enabledTools: ALL_TOOLS })).toBe(buildInstructions({}));
    });

    it('is what index.mjs actually passes to the MCP server', () => {
      expect(indexSource).toContain(
        'instructions: buildInstructions({ enabledTools }) || undefined',
      );
    });
  });

  describe('block declarations stay honest', () => {
    for (const block of INSTRUCTION_BLOCKS) {
      it(`${block.id} declares every tool its text names`, () => {
        const undeclared = toolsMentionedIn(block.text).filter((t) => !block.requires.includes(t));
        expect(undeclared).toEqual([]);
      });

      it(`${block.id} requires only tools that exist`, () => {
        expect(block.requires.filter((t) => !ALL_TOOLS.includes(t))).toEqual([]);
      });

      it(`${block.id} has non-empty text`, () => {
        expect(block.text.trim().length).toBeGreaterThan(0);
      });
    }

    it('block ids are unique', () => {
      const ids = INSTRUCTION_BLOCKS.map((b) => b.id);
      expect(ids).toEqual([...new Set(ids)]);
    });
  });

  describe('the tool registry matches what index.mjs registers', () => {
    const registeredInSource = [...indexSource.matchAll(/server\.tool\(\s*'(hive_[a-z_]+)'/g)].map(
      (m) => m[1],
    );

    it('every registered tool is in ALL_TOOLS', () => {
      expect(registeredInSource.filter((n) => !ALL_TOOLS.includes(n))).toEqual([]);
    });

    it('every tool in ALL_TOOLS is registered', () => {
      expect(ALL_TOOLS.filter((n) => !registeredInSource.includes(n))).toEqual([]);
    });

    it('registers each tool exactly once', () => {
      expect(registeredInSource).toEqual([...new Set(registeredInSource)]);
    });

    it('gates every registration on the shared predicate', () => {
      // A tool registered outside has(...) would bypass resolveTools, and the
      // parity invariant above would stop describing reality.
      const gated = [...indexSource.matchAll(/if \(has\('(hive_[a-z_]+)'\)\) \{/g)].map(
        (m) => m[1],
      );
      expect(ALL_TOOLS.filter((n) => !gated.includes(n))).toEqual([]);
      expect(indexSource).not.toContain('enabledTools.includes');
    });
  });

  describe('resolveTools mirrors the registration guard', () => {
    it('returns everything when --tools is absent', () => {
      expect(resolveTools({})).toEqual(ALL_TOOLS);
      expect(resolveTools()).toEqual(ALL_TOOLS);
    });

    it('preserves registry order, not the order of --tools', () => {
      expect(resolveTools({ enabledTools: ['hive_complete_task', 'hive_get_task'] })).toEqual([
        'hive_get_task',
        'hive_complete_task',
      ]);
    });

    it('ignores names that are not tools', () => {
      expect(resolveTools({ enabledTools: ['hive_get_task', 'hive_not_a_tool'] })).toEqual([
        'hive_get_task',
      ]);
    });
  });

  describe('toolsMentionedIn', () => {
    it('finds each distinct tool once', () => {
      expect(
        toolsMentionedIn('call hive_get_task, then hive_get_task, then hive_post_update'),
      ).toEqual(['hive_get_task', 'hive_post_update']);
    });

    it('returns empty for text with no tool references', () => {
      expect(toolsMentionedIn('no tools here')).toEqual([]);
    });
  });
});
