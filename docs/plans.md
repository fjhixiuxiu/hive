# Plans

Interactive HTML plan authoring and review for Hive. Claude publishes plans as versioned HTML artifacts; users read them in the dashboard, anchor comments to sections, and round-trip feedback through tmux without leaving the plan view.

## Why

The pre-Plans loop was: ask Claude in tmux to write a plan to a file, open the file in a browser, type comments back into tmux, ask Claude to revise. The "open the file" step was local-only and comments lost their anchoring to specific sections.

Plans promotes the plan to a first-class artifact. The dashboard renders it, comments anchor to `<section data-id="...">`, and a `Send to Claude` button relays draft comments back to the session via the existing relay path.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude (tmux session)                                            │
│   │                                                              │
│   │ 1. Write HTML to /tmp/plan-foo.html                          │
│   │ 2. hive_publish_plan({ path })                               │
│   ▼                                                              │
│ MCP server (src/mcp-server/index.mjs)                            │
│   reads file, sends html over WS as mcp:publish_plan             │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Hive WS handler (src/integrations/web/ws-handlers.js)            │
│   • plansStore.publishPlan({ planId?, sessionNum, html, title })│
│   • taskQueue.setSessionContext(sessionNum, { planRef })         │
│   • broadcast plan:published + context:updated                   │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Storage (src/core/plans-store.js)                                │
│   .hive-plans/<planId>/                                          │
│     meta.json     { sessionId, title, status, currentVersion }   │
│     v1.html       <section data-id="..."> + comments script      │
│     v2.html                                                      │
│     current       (text pointer "v2")                            │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Dashboard (src/integrations/web/public/)                         │
│   • Plans nav item → plans-panel                                 │
│   • Master list (left) · editor iframe (right)                   │
│   • Editor: comments sidebar, archive, send, session pill         │
└─────────────────────────────────────────────────────────────────┘
```

## Data model

### Plan HTML document

A self-contained HTML file with two conventions:

1. Each top-level section wrapped in `<section data-id="kebab-case-id">` so comments can anchor.
2. An embedded JSON block holds the comments:
   ```html
   <script type="application/json" id="hive-comments">
     [
       {
         "id": "c1",
         "sectionId": "approach",
         "status": "open",
         "createdAt": "2026-05-24T14:02:00Z",
         "thread": [
           { "author": "user", "text": "why X?", "at": "..." },
           { "author": "claude", "text": "good catch — switching", "at": "..." }
         ]
       }
     ]
   </script>
   ```

Comments live inside the HTML on purpose: one file = one artifact. No split-brain on versioning, no two streams to merge during regeneration.

### Comment status

| Status     | Meaning                                                 |
| ---------- | ------------------------------------------------------- |
| `draft`    | Authored in the dashboard, not yet sent to Claude       |
| `open`     | Sent to Claude, awaiting / received reply, not resolved |
| `resolved` | Addressed (auto on patch, or manual)                    |
| `moved`    | Regeneration migrated this comment to a new section     |

### Plan meta (sidecar)

`.hive-plans/<planId>/meta.json`:

```json
{
  "id": "abc123",
  "sessionId": 1,
  "title": "Plans — interactive plan review",
  "status": "open",
  "currentVersion": 2,
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Session context

`sessionContext.<num>.planRef` is the dashboard-side pointer:

```js
{
  planId: "abc123",
  version: 2,
  openCommentCount: 3,
  title: "Plans feature"
}
```

`planRef` is distinct from the legacy `plan` field (string filepath) so existing search/sidebar code that calls `ctx.plan.toLowerCase()` keeps working.

## Storage

Sidecar directory, one folder per plan, versioned HTML files:

```
.hive-plans/
  abc123/
    meta.json
    v1.html
    v2.html
    current        # text pointer, contents: "v2"
```

Sidecar (not `.hive-state.json`) so 30–50KB HTML blobs don't bloat the in-memory state and don't slow every save. Versioned so a regenerate produces a real diff.

`HIVE_PLANS_DIR` env var overrides the storage root for tests.

## MCP tool

`src/mcp-server/index.mjs` exposes `hive_publish_plan` to Claude sessions. The tool accepts a **file path** rather than an HTML string — Claude writes the doc with its `Write` tool, then passes the path:

```
hive_publish_plan({
  path: "/tmp/plan-redis-cache.html",
  title: "Redis cache plan"   // optional
})
```

Returns `{ planId, version, url }`. Side effects:

- Reads file via `fs.readFileSync`, sends content to hive over the existing WS connection
- Writes `sessionContext.<num>.planRef` for the calling session
- Broadcasts `plan:published` and `context:updated` to the dashboard

Republishing for the same session bumps the version (no new planId).

### Server-level instructions

The MCP server returns server-level `instructions` at initialization telling Claude to:

1. Always write a plan to a file first
2. Use `<section data-id="...">` blocks
3. Include `<script type="application/json" id="hive-comments">[]</script>`
4. Reply in chat with one line: `"Plan published — <title>."`

This makes plans the default for any "design this", "plan this", or "think through this" request.

## Web routes

| Method · URL                                            | Purpose                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /plans`                                            | Index page (static `plans-index.html`) — used standalone; in-app uses the Plans nav panel |
| `GET /plans/:planId`                                    | Editor wrapper (iframe + comments sidebar) — `plan-editor.html`                           |
| `GET /plans/:planId/raw`                                | Raw plan HTML — loaded inside the editor iframe                                           |
| `GET /plans/:planId/v:n`                                | Pinned version (read-only diff target)                                                    |
| `GET /api/plans?status=open\|archived\|all&session=<n>` | List plans                                                                                |
| `GET /api/plans/:planId`                                | Meta + currentVersion + openCommentCount                                                  |
| `GET /api/plans/:planId/comments`                       | Comments for current version                                                              |
| `POST /api/plans/:planId/comments`                      | Add a draft comment `{ sectionId, text }`                                                 |
| `PATCH /api/plans/:planId/comments/:commentId`          | Update comment status                                                                     |
| `POST /api/plans/:planId/send`                          | Send all draft comments to the originating session (`relay.tell`); flips drafts → open    |
| `POST /api/plans/:planId/archive`                       | Archive (clears `planRef` from any session pointing to this plan)                         |
| `POST /api/plans/:planId/unarchive`                     | Restore to open status                                                                    |

## Dashboard UI

### Plans nav panel (`#plans-panel`)

Top-level nav item between Ideas and Admin. Two-column layout inside the panel:

- **Left (340px)** — filter tabs (Open · Archived · All with counts) + scrollable plan list, each row showing title / `S<sessionId> · v<n>` / updated time / status pill (open count, resolved, archived)
- **Right (flex)** — iframe loading `/plans/:planId` when a plan is selected, otherwise an empty state

WS events that refresh the list: `plan:published`, `plan:archived`, `plan:unarchived`, `plan:comments-changed`.

### Plan editor (`plan-editor.html`)

Iframe of the raw plan HTML on the left, fixed-width sidebar on the right:

- **Sidebar header** — title, version, archive banner (when archived), `Session N ↗` pill
- **Comment list** — one card per comment with anchor, thread, status pill; click anchor to scroll the iframe to that section
- **Per-section comment button** — injected into each `<section data-id>` of the iframe via DOM manipulation; click to open an inline drawer with a textarea + Save Draft
- **Toolbar** — status counts (drafts · open · resolved) + Archive · Restore (when archived) · Send to Claude

### Plan → Session navigation (`Session N ↗` pill)

Plan knows `sessionId`, session knows its active task. Click the pill in the editor's sidebar header:

1. Editor sends `postMessage({ type: 'hive:open-session-drawer', sessionNum })` to parent window
2. Parent listener finds the session's active task (dispatched → queued → any) and calls `openTaskDetail(task.id)`
3. The existing task-detail slide-out drawer opens (the same one used on the Tasks board) — terminal preview, send box, keys bar, all included
4. If no active task exists, falls back to opening the session in the board view

The plan stays open in the background while the drawer is overlaid.

### Session → Plan navigation

The session's context sidebar shows a `Plan: <title> · N open` link. Click → switches to the global Plans panel and selects the linked plan. Shift/Ctrl-click still opens the standalone `/plans/:id` URL in a new window (share-link behavior).

## Archive lifecycle

Plans live as `open` until manually archived. Manual-only (no auto-archive on task complete) because a plan is a per-feature/per-investigation artifact, not per-task — auto would guess wrong half the time.

On archive (`POST /api/plans/:id/archive`):

- `meta.status = 'archived'`
- Every session whose `planRef.planId` matches is cleared (`taskQueue.setSessionContext(num, { planRef: null })`)
- Broadcasts `context:updated` for each affected session + `plan:archived`
- Editor flips to read-only — Send hidden, Restore shown, banner: _"This plan is archived — read-only."_
- Plan files (HTML + comments + meta) stay on disk forever as a record

Unarchive flips status back to `open`. Does **not** auto-restore `planRef` to any session — user must re-pin manually.

## Send-to-Claude relay

`POST /api/plans/:planId/send` compiles all `draft` comments into a single message:

```
3 new comments on your plan "<title>" (planId: abc123 v1).
Reply to each using hive_reply_to_comment(commentId, text, patch?). For changes
that resolve a comment, include the patch. For brief acknowledgements, just
reply with text.

[c1 §approach] why JSON block vs separate file?
[c2 §approach] how big do these HTML files get?
[c3 §mcp-tools] do we need hive_resolve_comment if patches auto-resolve?
```

Resolves the originating session via the existing `fleet`/`router`, calls `relay.tell` (the same path used by manual user input from the dashboard). On success, flips every sent comment from `draft` → `open` and re-broadcasts.

### Comment replies (`hive_reply_to_comment` / `hive_resolve_comment`)

Once drafts land in tmux, Claude replies via two new MCP tools that target the session's currently pinned plan (`sessionContext.planRef.planId`):

| Tool                                                 | Behavior                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hive_reply_to_comment({ commentId, text, patch? })` | Appends `{ author: 'claude', text, at, patch? }` to the comment's `thread`. If `patch: { sectionId, html }` is provided, the section's inner HTML is replaced inline (no version bump) **and** the comment is auto-resolved. Without a patch, the comment status stays as-is. |
| `hive_resolve_comment({ commentId, reason? })`       | Sets status to `resolved`. Optional `reason` is recorded as a `claude` message in the thread.                                                                                                                                                                                 |

Server broadcasts `plan:comments-changed` with `{ planId, openCount, hasPatch }`. The dashboard:

1. Refreshes the Plans list (counts update)
2. If the open iframe is viewing this plan, posts `hive:plan-comments-changed` into the iframe; editor reloads its comment sidebar
3. If the change included a patch, reloads the inner iframe too so the section update is visible

Patches are point-fixes; sweeping changes still bump the plan version via `hive_publish_plan` (which carries comments forward in the new file).

## File layout

```
src/
├── core/
│   └── plans-store.js          # All file I/O for plans (read/write/version/comments/archive)
├── integrations/web/
│   ├── server.js               # Routes: /plans, /api/plans/*, archive, send
│   ├── ws-handlers.js          # mcp:publish_plan handler
│   └── public/
│       ├── index.html          # Plans nav + plans-panel markup
│       ├── app.js              # loadPlansList, renderPlansPanel, selectPlan, postMessage listener
│       ├── styles.css          # .plans-panel-* styles
│       ├── plan-editor.html    # Editor (iframe + sidebar)
│       └── plans-index.html    # Standalone /plans page (used outside dashboard)
└── mcp-server/
    └── index.mjs               # hive_publish_plan tool + server instructions

test/
├── core/plans-store.test.js              # 23 storage tests
└── integrations/web/plans.test.js        # 4 publish-handler integration tests
```

## Open questions / future work

- **Auto-archive after N days idle** — currently manual only; defer until clutter is real
- **Multi-session plans** — a plan is currently 1:1 with its originating session; no shared plans for now
- **Markdown in comments** — currently raw text; render markdown in comment threads
