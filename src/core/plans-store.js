const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// HIVE_PLANS_DIR override lets tests redirect storage to a tmp dir without
// touching the real .hive-plans/ at repo root.
function plansRoot() {
  return process.env.HIVE_PLANS_DIR || path.join(__dirname, '..', '..', '.hive-plans');
}

function ensureDir() {
  fs.mkdirSync(plansRoot(), { recursive: true });
}

function planDir(planId) {
  return path.join(plansRoot(), planId);
}

function metaPath(planId) {
  return path.join(planDir(planId), 'meta.json');
}

function versionPath(planId, version) {
  return path.join(planDir(planId), `v${version}.html`);
}

function currentPointerPath(planId) {
  return path.join(planDir(planId), 'current');
}

function newPlanId() {
  return crypto.randomBytes(4).toString('hex');
}

function readMeta(planId) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(planId), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(planId, meta) {
  fs.writeFileSync(metaPath(planId), JSON.stringify(meta, null, 2));
}

function readCurrent(planId) {
  try {
    return parseInt(fs.readFileSync(currentPointerPath(planId), 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function writeCurrent(planId, version) {
  fs.writeFileSync(currentPointerPath(planId), String(version));
}

// Parse the <script id="hive-comments"> block out of the HTML.
const COMMENTS_RE = /(<script[^>]*id="hive-comments"[^>]*>)([\s\S]*?)(<\/script>)/i;

function parseComments(html) {
  if (!html) return [];
  const m = html.match(COMMENTS_RE);
  if (!m) return [];
  try {
    const arr = JSON.parse((m[2] || '').trim() || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function countOpenComments(html) {
  return parseComments(html).filter(c => c && c.status === 'open').length;
}

// Replace the comments block in HTML with a new array. If no block exists,
// inject one right before </body>. Returns the new HTML.
function setComments(html, comments) {
  const payload = JSON.stringify(comments, null, 2);
  if (COMMENTS_RE.test(html)) {
    return html.replace(COMMENTS_RE, (_, open, _body, close) => `${open}\n${payload}\n${close}`);
  }
  const block = `<script type="application/json" id="hive-comments">\n${payload}\n</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}\n</body>`);
  }
  return html + '\n' + block + '\n';
}

function newCommentId() {
  return 'c' + crypto.randomBytes(3).toString('hex');
}

// Mutate the current version of a plan: append/update/remove comments.
// `mutator(comments)` receives the array and must return the new array.
// Does NOT bump the plan version. Returns the new comment array.
function mutateComments(planId, mutator) {
  const v = readCurrent(planId);
  if (!v) throw new Error(`Plan ${planId} not found`);
  const filePath = versionPath(planId, v);
  const html = fs.readFileSync(filePath, 'utf8');
  const current = parseComments(html);
  const updated = mutator(current);
  const newHtml = setComments(html, updated);
  fs.writeFileSync(filePath, newHtml);

  // Bump meta.updatedAt so the index sorts surface recent activity
  const meta = readMeta(planId);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    writeMeta(planId, meta);
  }
  return updated;
}

function addComment(planId, { sectionId, text, status = 'draft', author = 'user' }) {
  if (!text || typeof text !== 'string') throw new Error('text is required');
  if (!sectionId || typeof sectionId !== 'string') throw new Error('sectionId is required');
  const comment = {
    id: newCommentId(),
    sectionId,
    status,
    createdAt: new Date().toISOString(),
    thread: [{ author, text, at: new Date().toISOString() }],
  };
  mutateComments(planId, (arr) => [...arr, comment]);
  return comment;
}

function updateCommentStatus(planId, commentId, status) {
  let found = null;
  mutateComments(planId, (arr) => arr.map(c => {
    if (c.id === commentId) {
      found = { ...c, status };
      return found;
    }
    return c;
  }));
  return found;
}

function getComments(planId) {
  const v = readCurrent(planId);
  if (!v) return [];
  try {
    const html = fs.readFileSync(versionPath(planId, v), 'utf8');
    return parseComments(html);
  } catch {
    return [];
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the inner HTML of <section data-id="X">…</section>. Idempotent;
// returns the unchanged html if the section isn't found.
function applySectionPatch(html, sectionId, newInnerHtml) {
  const re = new RegExp(
    `(<section\\b[^>]*\\bdata-id\\s*=\\s*["']${escapeRegex(sectionId)}["'][^>]*>)([\\s\\S]*?)(<\\/section>)`,
    'i'
  );
  if (!re.test(html)) return html;
  return html.replace(re, (_m, open, _inner, close) => `${open}\n${newInnerHtml}\n${close}`);
}

// Claude calls this to reply to a single comment. Appends a 'claude' message
// to the thread, optionally applies a section patch (which also auto-resolves
// the comment). Throws if the comment isn't found.
function replyToComment(planId, commentId, { text, patch, author = 'claude' } = {}) {
  if (!text || typeof text !== 'string') throw new Error('text is required');
  const v = readCurrent(planId);
  if (!v) throw new Error(`Plan ${planId} not found`);
  const filePath = versionPath(planId, v);
  let html = fs.readFileSync(filePath, 'utf8');

  let updatedComment = null;
  const updated = parseComments(html).map(c => {
    if (c.id !== commentId) return c;
    const reply = { author, text, at: new Date().toISOString() };
    if (patch) reply.patch = patch;
    updatedComment = {
      ...c,
      thread: [...(c.thread || []), reply],
      status: patch ? 'resolved' : c.status,
    };
    return updatedComment;
  });
  if (!updatedComment) throw new Error(`Comment ${commentId} not found in plan ${planId}`);

  if (patch && patch.sectionId && typeof patch.html === 'string') {
    html = applySectionPatch(html, patch.sectionId, patch.html);
  }
  html = setComments(html, updated);
  fs.writeFileSync(filePath, html);

  const meta = readMeta(planId);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    writeMeta(planId, meta);
  }
  return updatedComment;
}

// Mark a comment resolved without a reply (e.g. Claude agrees, no change needed).
// Optional reason becomes a 'claude' system message in the thread.
function resolveComment(planId, commentId, reason) {
  const v = readCurrent(planId);
  if (!v) throw new Error(`Plan ${planId} not found`);
  const filePath = versionPath(planId, v);
  const html = fs.readFileSync(filePath, 'utf8');

  let updatedComment = null;
  const updated = parseComments(html).map(c => {
    if (c.id !== commentId) return c;
    const thread = [...(c.thread || [])];
    if (reason) thread.push({ author: 'claude', text: reason, at: new Date().toISOString() });
    updatedComment = { ...c, thread, status: 'resolved' };
    return updatedComment;
  });
  if (!updatedComment) throw new Error(`Comment ${commentId} not found in plan ${planId}`);

  fs.writeFileSync(filePath, setComments(html, updated));
  const meta = readMeta(planId);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
    writeMeta(planId, meta);
  }
  return updatedComment;
}

// Publish a new plan or a new version of an existing plan.
// If planId is null, creates a new plan and returns the new id.
// Returns { planId, version, openCommentCount, title }.
function publishPlan({ planId, sessionNum, html, title }) {
  ensureDir();
  if (!html || typeof html !== 'string') {
    throw new Error('html is required and must be a string');
  }

  let meta;
  let version;
  if (planId) {
    meta = readMeta(planId);
    if (!meta) throw new Error(`Plan ${planId} not found`);
    version = (readCurrent(planId) || meta.currentVersion || 0) + 1;
    meta.currentVersion = version;
    meta.updatedAt = new Date().toISOString();
    if (title) meta.title = title;
  } else {
    planId = newPlanId();
    version = 1;
    meta = {
      id: planId,
      sessionId: sessionNum ?? null,
      title: title || 'Untitled plan',
      status: 'open',
      currentVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(planDir(planId), { recursive: true });
  }

  fs.writeFileSync(versionPath(planId, version), html);
  writeCurrent(planId, version);
  writeMeta(planId, meta);

  return {
    planId,
    version,
    openCommentCount: countOpenComments(html),
    title: meta.title,
  };
}

function getPlan(planId) {
  const meta = readMeta(planId);
  if (!meta) return null;
  const current = readCurrent(planId) || meta.currentVersion;
  return { meta, currentVersion: current };
}

function getPlanHtml(planId, version) {
  const v = version || readCurrent(planId);
  if (!v) return null;
  try {
    return fs.readFileSync(versionPath(planId, v), 'utf8');
  } catch {
    return null;
  }
}

function listPlans({ sessionNum, status } = {}) {
  ensureDir();
  let entries;
  try {
    entries = fs.readdirSync(plansRoot());
  } catch {
    return [];
  }
  const plans = [];
  for (const id of entries) {
    const meta = readMeta(id);
    if (!meta) continue;
    if (sessionNum != null && meta.sessionId !== Number(sessionNum)) continue;
    // `status: 'all'` is a no-op filter; only filter when a real status is given
    if (status && status !== 'all' && meta.status !== status) continue;
    const html = getPlanHtml(id);
    plans.push({
      ...meta,
      openCommentCount: countOpenComments(html),
    });
  }
  plans.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return plans;
}

function archivePlan(planId) {
  const meta = readMeta(planId);
  if (!meta) return false;
  meta.status = 'archived';
  meta.updatedAt = new Date().toISOString();
  writeMeta(planId, meta);
  return true;
}

function unarchivePlan(planId) {
  const meta = readMeta(planId);
  if (!meta) return false;
  meta.status = 'open';
  meta.updatedAt = new Date().toISOString();
  writeMeta(planId, meta);
  return true;
}

module.exports = {
  plansRoot,
  publishPlan,
  getPlan,
  getPlanHtml,
  listPlans,
  archivePlan,
  unarchivePlan,
  countOpenComments,
  parseComments,
  setComments,
  addComment,
  updateCommentStatus,
  getComments,
  applySectionPatch,
  replyToComment,
  resolveComment,
};
