import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import plansStore from '../../src/core/plans-store.js';

const SAMPLE_HTML = `<!DOCTYPE html>
<html><body>
<section data-id="overview"><p>Plan overview.</p></section>
<section data-id="risks"><p>Risks.</p></section>
<script type="application/json" id="hive-comments">[]</script>
</body></html>`;

const HTML_WITH_COMMENTS = `<!DOCTYPE html>
<html><body>
<section data-id="overview"><p>Plan.</p></section>
<script type="application/json" id="hive-comments">
[
  { "id": "c1", "status": "open", "sectionId": "overview", "thread": [] },
  { "id": "c2", "status": "resolved", "sectionId": "overview", "thread": [] },
  { "id": "c3", "status": "open", "sectionId": "overview", "thread": [] }
]
</script>
</body></html>`;

describe('plans-store', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-plans-test-'));
    process.env.HIVE_PLANS_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.HIVE_PLANS_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('publishPlan', () => {
    it('creates a new plan with a generated id and version 1', () => {
      const res = plansStore.publishPlan({
        sessionNum: 3,
        html: SAMPLE_HTML,
        title: 'My plan',
      });

      expect(res.planId).toMatch(/^[a-f0-9]{8}$/);
      expect(res.version).toBe(1);
      expect(res.title).toBe('My plan');
      expect(res.openCommentCount).toBe(0);

      // Files written
      expect(fs.existsSync(path.join(tmpDir, res.planId, 'meta.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, res.planId, 'v1.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, res.planId, 'current'))).toBe(true);

      const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, res.planId, 'meta.json'), 'utf8'));
      expect(meta.sessionId).toBe(3);
      expect(meta.title).toBe('My plan');
      expect(meta.status).toBe('open');
      expect(meta.currentVersion).toBe(1);
    });

    it('bumps the version when republishing an existing planId', () => {
      const v1 = plansStore.publishPlan({ sessionNum: 3, html: SAMPLE_HTML, title: 'Plan' });
      const v2 = plansStore.publishPlan({ planId: v1.planId, html: '<p>v2</p>' });
      const v3 = plansStore.publishPlan({ planId: v1.planId, html: '<p>v3</p>' });

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v3.version).toBe(3);
      expect(v2.planId).toBe(v1.planId);
      expect(v3.planId).toBe(v1.planId);

      expect(fs.readFileSync(path.join(tmpDir, v1.planId, 'current'), 'utf8')).toBe('3');
      expect(fs.existsSync(path.join(tmpDir, v1.planId, 'v1.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, v1.planId, 'v2.html'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, v1.planId, 'v3.html'))).toBe(true);
    });

    it('preserves the original title across version bumps when not overridden', () => {
      const v1 = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'Original' });
      const v2 = plansStore.publishPlan({ planId: v1.planId, html: '<p>v2</p>' });
      expect(v2.title).toBe('Original');
    });

    it('moves sessionId to the republishing session', () => {
      // Plans get handed on (a PR-watch handoff seeds the planRef into the next
      // session). If ownership stayed with whoever published v1, the dashboard
      // would keep labelling the plan with a session that no longer has it.
      const v1 = plansStore.publishPlan({ sessionNum: 10, html: SAMPLE_HTML, title: 'Paystubs' });
      plansStore.publishPlan({ planId: v1.planId, sessionNum: 12, html: '<p>v2</p>' });

      const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, v1.planId, 'meta.json'), 'utf8'));
      expect(meta.sessionId).toBe(12);
    });

    it('keeps sessionId when a republish names no session', () => {
      const v1 = plansStore.publishPlan({ sessionNum: 10, html: SAMPLE_HTML, title: 'Paystubs' });
      plansStore.publishPlan({ planId: v1.planId, html: '<p>v2</p>' });

      const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, v1.planId, 'meta.json'), 'utf8'));
      expect(meta.sessionId).toBe(10);
    });

    it('throws when html is missing', () => {
      expect(() => plansStore.publishPlan({ sessionNum: 1 })).toThrow(/html is required/);
    });

    it('throws when republishing a missing planId', () => {
      expect(() => plansStore.publishPlan({ planId: 'deadbeef', html: SAMPLE_HTML })).toThrow(
        /not found/,
      );
    });
  });

  describe('countOpenComments', () => {
    it('returns 0 for empty comments block', () => {
      expect(plansStore.countOpenComments(SAMPLE_HTML)).toBe(0);
    });

    it('counts comments with status "open"', () => {
      expect(plansStore.countOpenComments(HTML_WITH_COMMENTS)).toBe(2);
    });

    it('returns 0 when comments block is missing', () => {
      expect(plansStore.countOpenComments('<html></html>')).toBe(0);
    });

    it('returns 0 when comments JSON is malformed', () => {
      const html = `<script type="application/json" id="hive-comments">{ not valid json</script>`;
      expect(plansStore.countOpenComments(html)).toBe(0);
    });
  });

  describe('getPlan / getPlanHtml', () => {
    it('returns meta and current version', () => {
      const res = plansStore.publishPlan({ sessionNum: 2, html: SAMPLE_HTML, title: 'A' });
      const plan = plansStore.getPlan(res.planId);
      expect(plan.meta.title).toBe('A');
      expect(plan.currentVersion).toBe(1);
    });

    it('returns null for missing plan', () => {
      expect(plansStore.getPlan('nonexistent')).toBeNull();
      expect(plansStore.getPlanHtml('nonexistent')).toBeNull();
    });

    it('returns current version html by default and pinned version when requested', () => {
      const v1 = plansStore.publishPlan({ sessionNum: 1, html: '<p>one</p>', title: 'X' });
      plansStore.publishPlan({ planId: v1.planId, html: '<p>two</p>' });
      expect(plansStore.getPlanHtml(v1.planId)).toContain('two');
      expect(plansStore.getPlanHtml(v1.planId, 1)).toContain('one');
    });

    it('injects color-scheme:light so dark-mode browsers do not auto-darken light plans', () => {
      const res = plansStore.publishPlan({
        sessionNum: 1,
        html: '<!DOCTYPE html><html><head><title>P</title></head><body><p>hi</p></body></html>',
        title: 'H',
      });
      const out = plansStore.getPlanHtml(res.planId);
      expect(out).toContain('name="color-scheme" content="light"');
      expect(out).toContain('hi'); // original content preserved
      expect(out.indexOf('color-scheme')).toBeLessThan(out.indexOf('<title>')); // injected after <head>
    });

    it('does not override a plan that already declares its own color-scheme', () => {
      const res = plansStore.publishPlan({
        sessionNum: 1,
        html: '<html><head><meta name="color-scheme" content="dark"></head><body>x</body></html>',
        title: 'D',
      });
      const out = plansStore.getPlanHtml(res.planId);
      expect((out.match(/name="color-scheme"/g) || []).length).toBe(1); // not double-injected
      expect(out).toContain('content="dark"'); // author's declaration preserved
    });

    it("forces light with !important so a plan's CSS color-scheme:light-dark cannot win the cascade", () => {
      // Regression: plans generated with `:root{color-scheme:light dark}` in a
      // <style> have no color-scheme <meta>, so injection runs — but a bare
      // injected `color-scheme:light` loses the cascade to the plan's later
      // :root rule, and a dark-mode browser then renders white-on-white. The
      // injected rule must be !important to win regardless of source order.
      const res = plansStore.publishPlan({
        sessionNum: 1,
        html:
          '<!DOCTYPE html><html><head><title>P</title>' +
          '<style>:root{color-scheme:light dark}</style></head><body><p>hi</p></body></html>',
        title: 'CS',
      });
      const out = plansStore.getPlanHtml(res.planId);
      expect(out).toContain('color-scheme:light !important'); // injected rule wins the cascade
      expect(out).toContain('color-scheme:light dark'); // plan's own declaration still present
      expect(out.indexOf('color-scheme:light !important')).toBeLessThan(
        out.indexOf('color-scheme:light dark'),
      );
    });
  });

  describe('comments', () => {
    let planId;
    beforeEach(() => {
      planId = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'X' }).planId;
    });

    it('addComment appends a new draft comment', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'why?' });
      expect(c.id).toMatch(/^c[a-f0-9]+$/);
      expect(c.sectionId).toBe('overview');
      expect(c.status).toBe('draft');
      expect(c.thread[0].text).toBe('why?');
      expect(c.thread[0].author).toBe('user');

      const all = plansStore.getComments(planId);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(c.id);
    });

    it('addComment persists across reads (round-trip via HTML)', () => {
      plansStore.addComment(planId, { sectionId: 'overview', text: 'one' });
      plansStore.addComment(planId, { sectionId: 'risks', text: 'two' });
      const html = plansStore.getPlanHtml(planId);
      expect(html).toContain('"sectionId": "overview"');
      expect(html).toContain('"sectionId": "risks"');
      const all = plansStore.getComments(planId);
      expect(all).toHaveLength(2);
    });

    it('addComment requires text and sectionId', () => {
      expect(() => plansStore.addComment(planId, { sectionId: 'overview', text: '' })).toThrow(
        /text is required/,
      );
      expect(() => plansStore.addComment(planId, { sectionId: '', text: 'x' })).toThrow(
        /sectionId is required/,
      );
    });

    it('updateCommentStatus flips draft → open', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'hello' });
      const updated = plansStore.updateCommentStatus(planId, c.id, 'open');
      expect(updated.status).toBe('open');
      const all = plansStore.getComments(planId);
      expect(all.find((x) => x.id === c.id).status).toBe('open');
    });

    it('updateCommentStatus returns null for missing id', () => {
      expect(plansStore.updateCommentStatus(planId, 'cnope', 'open')).toBeNull();
    });

    it('setting comments updates openCommentCount via listPlans', () => {
      const c1 = plansStore.addComment(planId, { sectionId: 'overview', text: 'a' });
      const c2 = plansStore.addComment(planId, { sectionId: 'risks', text: 'b' });
      plansStore.updateCommentStatus(planId, c1.id, 'open');
      plansStore.updateCommentStatus(planId, c2.id, 'open');
      const list = plansStore.listPlans();
      expect(list[0].openCommentCount).toBe(2);
    });

    it('comments survive a version bump and become carry-forward in v2', () => {
      plansStore.addComment(planId, { sectionId: 'overview', text: 'old' });
      // Bumping creates a NEW version html without comments — caller controls v2 content
      plansStore.publishPlan({
        planId,
        html: '<section data-id="x"></section><script type="application/json" id="hive-comments">[]</script>',
      });
      // Old version still has the comment
      expect(plansStore.parseComments(plansStore.getPlanHtml(planId, 1))).toHaveLength(1);
      // New version starts empty
      expect(plansStore.getComments(planId)).toHaveLength(0);
    });

    it('replyToComment appends a claude reply to the thread', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'question' });
      const reply = plansStore.replyToComment(planId, c.id, { text: 'answer' });
      expect(reply.thread).toHaveLength(2);
      expect(reply.thread[1]).toMatchObject({ author: 'claude', text: 'answer' });
      // Without patch, status stays open
      expect(reply.status).toBe('draft');
    });

    it('replyToComment with patch auto-resolves and rewrites the section', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'use Postgres?' });
      const reply = plansStore.replyToComment(planId, c.id, {
        text: 'switching',
        patch: { sectionId: 'overview', html: '<p>Now uses Postgres.</p>' },
      });
      expect(reply.status).toBe('resolved');
      expect(reply.thread[1].patch).toEqual({
        sectionId: 'overview',
        html: '<p>Now uses Postgres.</p>',
      });
      const html = plansStore.getPlanHtml(planId);
      expect(html).toContain('<p>Now uses Postgres.</p>');
      expect(html).not.toContain('Plan overview.');
    });

    it('replyToComment throws for missing commentId', () => {
      expect(() => plansStore.replyToComment(planId, 'cnope', { text: 'x' })).toThrow(/not found/);
    });

    it('replyToComment requires text', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'q' });
      expect(() => plansStore.replyToComment(planId, c.id, {})).toThrow(/text is required/);
    });

    it('resolveComment marks resolved and optionally adds a reason note', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'q' });
      const r = plansStore.resolveComment(planId, c.id, 'agreed, no change needed');
      expect(r.status).toBe('resolved');
      expect(r.thread).toHaveLength(2);
      expect(r.thread[1]).toMatchObject({ author: 'claude', text: 'agreed, no change needed' });
    });

    it('resolveComment without reason just sets status', () => {
      const c = plansStore.addComment(planId, { sectionId: 'overview', text: 'q' });
      const r = plansStore.resolveComment(planId, c.id);
      expect(r.status).toBe('resolved');
      expect(r.thread).toHaveLength(1); // no new entry
    });

    it('applySectionPatch leaves html unchanged when sectionId missing', () => {
      const html = '<section data-id="a">one</section>';
      expect(plansStore.applySectionPatch(html, 'missing', '<p>x</p>')).toBe(html);
    });

    it('applySectionPatch replaces inner contents only', () => {
      const html = '<section data-id="a" class="foo">old</section>';
      const out = plansStore.applySectionPatch(html, 'a', '<p>new</p>');
      expect(out).toContain('<section data-id="a" class="foo">');
      expect(out).toContain('<p>new</p>');
      expect(out).not.toContain('old');
    });
  });

  describe('listPlans', () => {
    it('lists all plans sorted by updatedAt desc', () => {
      const a = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      // small delay to ensure timestamps differ
      const b = plansStore.publishPlan({ sessionNum: 2, html: SAMPLE_HTML, title: 'B' });
      const all = plansStore.listPlans();
      expect(all.length).toBe(2);
      expect(all.map((p) => p.id)).toContain(a.planId);
      expect(all.map((p) => p.id)).toContain(b.planId);
    });

    it('filters by sessionNum', () => {
      plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      plansStore.publishPlan({ sessionNum: 2, html: SAMPLE_HTML, title: 'B' });
      const onlyOne = plansStore.listPlans({ sessionNum: 1 });
      expect(onlyOne.length).toBe(1);
      expect(onlyOne[0].title).toBe('A');
    });

    it('filters by status', () => {
      const a = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      plansStore.publishPlan({ sessionNum: 2, html: SAMPLE_HTML, title: 'B' });
      plansStore.archivePlan(a.planId);
      const open = plansStore.listPlans({ status: 'open' });
      const archived = plansStore.listPlans({ status: 'archived' });
      expect(open.length).toBe(1);
      expect(archived.length).toBe(1);
      expect(archived[0].title).toBe('A');
    });

    it('status=all returns both open and archived', () => {
      const a = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      plansStore.publishPlan({ sessionNum: 2, html: SAMPLE_HTML, title: 'B' });
      plansStore.archivePlan(a.planId);
      expect(plansStore.listPlans({ status: 'all' }).length).toBe(2);
    });

    it('unarchivePlan flips status back to open', () => {
      const p = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      plansStore.archivePlan(p.planId);
      expect(plansStore.getPlan(p.planId).meta.status).toBe('archived');
      plansStore.unarchivePlan(p.planId);
      expect(plansStore.getPlan(p.planId).meta.status).toBe('open');
    });

    it('archivePlan / unarchivePlan return false for missing planId', () => {
      expect(plansStore.archivePlan('nope')).toBe(false);
      expect(plansStore.unarchivePlan('nope')).toBe(false);
    });

    it('includes openCommentCount per plan', () => {
      plansStore.publishPlan({ sessionNum: 1, html: HTML_WITH_COMMENTS, title: 'A' });
      const list = plansStore.listPlans();
      expect(list[0].openCommentCount).toBe(2);
    });

    it('filters by sourceTaskId', () => {
      plansStore.publishPlan({
        sessionNum: 1,
        html: SAMPLE_HTML,
        title: 'A',
        sourceTaskId: 'task-1',
      });
      plansStore.publishPlan({
        sessionNum: 1,
        html: SAMPLE_HTML,
        title: 'B',
        sourceTaskId: 'task-2',
      });
      plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'C', sourceTaskId: null });
      const t1 = plansStore.listPlans({ sourceTaskId: 'task-1' });
      expect(t1.length).toBe(1);
      expect(t1[0].title).toBe('A');
      const t3 = plansStore.listPlans({ sourceTaskId: 'task-3' });
      expect(t3.length).toBe(0);
    });
  });

  describe('sourceTaskId stamping', () => {
    it('stamps sourceTaskId on first publish', () => {
      const r = plansStore.publishPlan({
        sessionNum: 1,
        html: SAMPLE_HTML,
        title: 'A',
        sourceTaskId: 'task-abc',
      });
      const meta = plansStore.getPlan(r.planId).meta;
      expect(meta.sourceTaskId).toBe('task-abc');
    });

    it('defaults sourceTaskId to null when not provided', () => {
      const r = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      const meta = plansStore.getPlan(r.planId).meta;
      expect(meta.sourceTaskId).toBeNull();
    });

    it('does NOT overwrite sourceTaskId on republish', () => {
      const v1 = plansStore.publishPlan({
        sessionNum: 1,
        html: SAMPLE_HTML,
        title: 'A',
        sourceTaskId: 'task-orig',
      });
      plansStore.publishPlan({
        planId: v1.planId,
        html: '<p>v2</p>',
        sourceTaskId: 'task-different',
      });
      const meta = plansStore.getPlan(v1.planId).meta;
      expect(meta.sourceTaskId).toBe('task-orig');
    });
  });

  describe('deletePlan', () => {
    it('removes the plan directory and returns true', () => {
      const r = plansStore.publishPlan({ sessionNum: 1, html: SAMPLE_HTML, title: 'A' });
      expect(fs.existsSync(path.join(tmpDir, r.planId))).toBe(true);
      expect(plansStore.deletePlan(r.planId)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, r.planId))).toBe(false);
      expect(plansStore.getPlan(r.planId)).toBeNull();
    });

    it('returns false when the plan does not exist', () => {
      expect(plansStore.deletePlan('nope')).toBe(false);
    });
  });
});
