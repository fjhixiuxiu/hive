/**
 * MCP instruction text and tool gating — the one place that knows which tools
 * this hive registers and which instruction blocks are therefore safe to send.
 *
 * Why this is separate from index.mjs: index.mjs opens a WebSocket to hive at
 * import time, so nothing could test the instruction/tool contract without a
 * live server. Everything here is pure and importable.
 *
 * The invariant: **the instructions must never tell a session to call a tool
 * this hive did not register.** Before this split they did. Starting hive with
 * `--tools hive_get_task,hive_complete_task` still shipped the whole plans
 * protocol, so the session was told to publish plans and reply to plan comments
 * using three tools that install had never registered. Nothing failed loudly;
 * the agent just reached for tools that weren't there. It stayed invisible
 * because the default install registers everything.
 *
 * Adding a tool mention to a block means adding it to that block's `requires`.
 * test/mcp-server/instructions.test.js fails if you forget.
 */

// ── Instruction blocks ────────────────────────────────
// Text is verbatim from the pre-split implementation, split on the blank line
// that already separated these two sections, so a default install receives a
// byte-identical string. test/mcp-server/fixtures/ was captured from that
// implementation and is the proof.

const PLANS_BLOCK = `Plans (always use this flow, never just dump a plan in chat):

When the user asks for a plan, proposal, design, or "think through" anything
non-trivial, do NOT output the plan as a chat message. Instead:

1. Write a self-contained HTML document to a file using your Write tool
   (e.g. /tmp/plan-<slug>.html). Each top-level section MUST be wrapped in
   <section data-id="kebab-case-id"> so comments can anchor. Include an empty
   embedded comments block near the bottom:
   <script type="application/json" id="hive-comments">[]</script>
2. Call hive_publish_plan({ path: "/tmp/plan-<slug>.html" }) — hive reads the
   file, stores the versioned artifact, updates session context, and notifies
   the user's dashboard.
3. Reply in chat with one line only: "Plan published — <title>." The dashboard
   will surface the URL.

To publish a revised version of an existing plan, overwrite the same file (or
write a new one) and call hive_publish_plan again with its path; hive
auto-bumps the version for the current session's plan.

Never paste raw HTML into chat. Never invent a planId — it is returned to you
by hive_publish_plan.`;

const PLAN_COMMENTS_BLOCK = `When you receive a relay message that begins with "N new comments on your plan":
- For each comment, call hive_reply_to_comment({ commentId, text, patch? }).
  Pass a patch ONLY when your reply rewrites a specific section's content
  (the patch auto-resolves the comment). For acknowledgements or follow-up
  questions that don't change the plan, just pass text.
- For comments where you agree but no change is needed, call
  hive_resolve_comment({ commentId, reason? }).
- For sweeping changes that touch many sections, call hive_publish_plan again
  with a new HTML file — that bumps the plan version.
Do NOT reply to comments by typing in chat — the user reads them in the
dashboard. Use the tools.`;

/**
 * Every tool hive's MCP server can register. This is the canonical tool
 * surface: index.mjs gates each registration on it, so a tool added there
 * without a line here fails the registry parity test.
 */
export const ALL_TOOLS = [
  'hive_get_task',
  'hive_complete_task',
  'hive_post_update',
  'hive_get_sessions',
  'hive_report_learnings',
  'hive_share_knowledge',
  'hive_get_knowledge',
  'hive_get_context',
  'hive_set_context',
  'hive_set_working_dir',
  'hive_reply_thread',
  'hive_create_task',
  'hive_publish_plan',
  'hive_reply_to_comment',
  'hive_resolve_comment',
];

/**
 * Instruction blocks, each declaring the tools its text tells the session to
 * call. A block ships only when every tool it names is registered.
 */
export const INSTRUCTION_BLOCKS = [
  {
    id: 'plans',
    requires: ['hive_publish_plan'],
    text: PLANS_BLOCK,
  },
  {
    id: 'plan-comments',
    requires: ['hive_publish_plan', 'hive_reply_to_comment', 'hive_resolve_comment'],
    text: PLAN_COMMENTS_BLOCK,
  },
];

/** Every distinct hive_* tool name the given text tells a session to call. */
export function toolsMentionedIn(text) {
  return [...new Set(text.match(/hive_[a-z_]+/g) || [])];
}

/**
 * The tool names this hive will actually register.
 * Mirrors the registration guards in index.mjs: `enabledTools` null means all.
 */
export function resolveTools({ enabledTools = null } = {}) {
  return ALL_TOOLS.filter((name) => !enabledTools || enabledTools.includes(name));
}

/**
 * Assemble the instruction text for a given hive config. Blocks whose required
 * tools are missing are dropped rather than shipped with dangling references.
 *
 * Returns '' when no block survives; callers should pass undefined rather than
 * an empty instructions string to the MCP server.
 */
export function buildInstructions({ enabledTools = null } = {}) {
  const available = new Set(resolveTools({ enabledTools }));
  return INSTRUCTION_BLOCKS.filter((block) => block.requires.every((tool) => available.has(tool)))
    .map((block) => block.text)
    .join('\n\n');
}
