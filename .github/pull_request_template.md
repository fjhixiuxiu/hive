<!--
Delete any section that does not apply. These prompts exist because each one
maps to a defect that actually shipped — not to make PRs longer.
-->

## What this changes

<!-- One or two sentences. What a reviewer needs before reading the diff. -->

## Blast radius

<!--
The reach of the change, not the size of the diff. The defects that get through
review are rarely wrong lines in the diff — they are the second implementation
of the same decision, sitting one grep away in a file the diff never opened.

Three sweeps are cheap and catch most of it:

  git grep -n "<the symbol you changed>"
  git grep -n "<the old literal value>"     ← the one everyone skips
  git grep -n "<the state key you touched>"

Name every hit as changed / deliberately unchanged / not applicable. "I checked"
is not the answer; the list is.
-->

- [ ] **Every other implementation of the changed decision is listed.** Grep the
      changed symbol _and its old literal value_ — a constant updated in one
      place and hardcoded in three others reads as a clean diff. `'completed'`
      is currently written out in 9 files across `src/core/`, Slack, voice and
      the browser bundle.
- [ ] **Both halves of every pair moved.** local/remote node, create/update,
      send/receive, start/end of a window, serialize/parse. Adding a method to
      `LocalNode` is a three-site change — `local-node.js`, `remote-node.js`,
      and the `switch` in `worker.js` — and only the third one fails at runtime,
      on a remote node, which is the setup nobody is running locally.
- [ ] **Every surface that renders this is updated.** Dashboard, Slack,
      Telegram, voice, GitHub bot, MCP tools — and `src/integrations/web/public/`,
      which cannot `require()` anything and therefore restates the vocabulary by
      hand. A change that only lands on the dashboard looks complete in the diff.
- [ ] **Existing `.hive-state.json` files still load.** A field this PR adds or
      renames is absent from every state file already on disk. Say what a fleet
      that has been running since before this merge reads for it, and where the
      default comes from. Six modules read that file.

## Evidence it works

<!--
Not "tests pass" — something that failed before and passes now, or the reverse.
The cheapest version: revert your fix, run the new test, paste the output.

  Tests  2 failed | 2 passed (4)   ← original
  Tests  4 passed (4)              ← with the fix

It takes a minute and it is the difference between a test that covers a line and
a test that can fail for the right reason.
-->

## Screenshots

<!--
Required for anything that changes the dashboard, the Slack/Telegram output, or
a rendered artifact. Before and after, at desktop width and at ~400px — hive is
used from a phone more than from a laptop, and a layout that only works wide is
a layout that does not work.

For a server-side change with no visible surface, say so and let the terminal
output above stand as the evidence.
-->

## Coverage

<!--
Name the scenarios this change introduces, and where each one is proven.
"Added tests" is not the answer; which cases, at which tier, is.
-->

- [ ] **Every new behaviour has a test that can fail for the right reason.**
      Not a test that merely executes the new line — one that goes red if the
      behaviour is wrong. The check is: break the change on purpose and watch it
      fail.
- [ ] **The variants are covered, not just the happy path.** If the change reads
      an enum, a config flag, a designation or a node type, say what each value
      does and which ones are tested. Defects concentrate in the value nobody
      enumerated — `--tools` subsets, parking off, remote nodes, a fleet with no
      state directory.
- [ ] **A bug fix ships a guard that fails without the fix.** A fix with no
      failing-first test is a fix that can be silently reverted by the next
      merge conflict.
- [ ] **What is not covered is named.** An honest "the remote-node path is
      untested, here is why" is worth more than silence, and it is what the next
      person needs.

## Iterating

<!--
Fill this in as the PR moves, not when you open it. A review finding describes a
defect *shape* — which input, reaching which consumer, under which condition —
not a line. Fixing the line the reviewer pointed at closes one instance of it.
-->

- [ ] **Each fix was swept for the same defect elsewhere.** Grep for the source,
      not the symptom, and report every hit as fixed / same defect / n-a. A
      second occurrence one grep away is the same bug — now one somebody has
      already written down on this PR.
- [ ] **The commits that came after the review were reviewed.** A fix for CI or
      for a finding is written under time pressure against an already-green
      suite, and it invalidates the earlier read of the files it touches. That
      is where the late-breaking defects live.
- [ ] **CI is green, or every remaining failure is named and attributed.** Not
      "flaky" without a link to the run and the reason.
- [ ] **Nothing is deferred silently.** If a branch of this change is going to a
      follow-up, say which branch and why here — a TODO added by this PR that
      this PR should have closed is the thing nobody finds again.

## Checks

- [ ] **Default behaviour is unchanged** — or the change is deliberate, stated
      above, and worth its own PR. An existing fleet, doing nothing, should not
      behave differently after this merges unless that is the point.
- [ ] **New vocabulary went into `src/core/vocab.js`** — a new status, state or
      mode is a constant, not a bare literal. `npm run lint` enforces this; see
      [docs/vocabulary.md](../docs/vocabulary.md).
- [ ] **Config I added has a reader in this PR** — the `integrator` block in
      `.hive-setup.json` is inert config nothing reads, and is indistinguishable
      from a working feature until someone traces it by hand. The same goes for
      an MCP tool name: `hive_get_plan` was documented to sessions for months
      and never registered.
- [ ] **Test doubles write what production writes** — a mock that _produces_ a
      status or event is a second implementation. One that invented its own word
      is why a dead branch looked tested for months.
- [ ] **Nothing off-pattern** — no swallowed errors, no `setTimeout` to fix a
      race, no hardcoded session numbers in shared logic. If something here is
      deliberately weird, say why.
