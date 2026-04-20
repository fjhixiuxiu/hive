import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'events';

vi.mock('../../src/core/log.js', () => ({
  default: { info: vi.fn(), error: vi.fn() },
  info: vi.fn(),
  error: vi.fn(),
}));

const ProjectManager = (await import('../../src/core/pm.js')).default || (await import('../../src/core/pm.js'));

function createMockTaskQueue() {
  const tq = new EventEmitter();
  tq.tasks = new Map();
  tq.config = {};
  tq.router = { listAllSessions: vi.fn().mockResolvedValue([]) };
  tq.createTask = vi.fn().mockReturnValue({ id: '1', text: '', status: 'queued' });
  tq.completeTask = vi.fn();
  tq.pushFeed = vi.fn();
  tq._saveState = vi.fn();
  tq._pmManager = null;
  tq.dispatchLock = new Set();
  tq.activeTaskBySession = new Map();
  tq.designations = new Map();
  tq.checklistTemplates = new Map();
  tq.getQueuePosition = vi.fn().mockReturnValue(1);
  return tq;
}

// ── _fetchJira ──────────────────────────────────────────

describe('PM source: _fetchJira', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  it('throws when JIRA credentials are missing', async () => {
    await expect(pm._fetchJira({ jql: '' }))
      .rejects.toThrow('JIRA credentials not configured');
  });

  it('throws when only some JIRA credentials are set', async () => {
    process.env.JIRA_BASE_URL = 'https://jira.example.com';
    // missing JIRA_EMAIL and JIRA_API_TOKEN
    await expect(pm._fetchJira({ jql: '' }))
      .rejects.toThrow('JIRA credentials not configured');
  });

  it('calls _httpRequest with correct URL, auth, and JQL body', async () => {
    process.env.JIRA_BASE_URL = 'https://jira.example.com';
    process.env.JIRA_EMAIL = 'user@example.com';
    process.env.JIRA_API_TOKEN = 'tok123';

    pm._httpRequest = vi.fn().mockResolvedValue({
      issues: [
        {
          key: 'DEV-100',
          fields: {
            summary: 'Fix login bug',
            issuetype: { name: 'Bug' },
            customfield_10016: 3,
          },
        },
      ],
    });

    const result = await pm._fetchJira({ jql: 'project = DEV' });

    expect(pm._httpRequest).toHaveBeenCalledOnce();
    const [url, headers, body] = pm._httpRequest.mock.calls[0];
    expect(url).toBe('https://jira.example.com/rest/api/3/search/jql');
    expect(headers.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('user@example.com:tok123');
    const parsedBody = JSON.parse(body);
    expect(parsedBody.jql).toBe('project = DEV');
    expect(parsedBody.fields).toContain('summary');
    expect(parsedBody.maxResults).toBe(50);
  });

  it('maps JIRA issues to { key, summary, issueType, storyPoints }', async () => {
    process.env.JIRA_BASE_URL = 'https://jira.example.com';
    process.env.JIRA_EMAIL = 'u@e.com';
    process.env.JIRA_API_TOKEN = 'tok';

    pm._httpRequest = vi.fn().mockResolvedValue({
      issues: [
        {
          key: 'DEV-1',
          fields: { summary: 'First', issuetype: { name: 'Story' }, customfield_10016: 5 },
        },
        {
          key: 'DEV-2',
          fields: { summary: 'Second', issuetype: null, customfield_10016: null },
        },
      ],
    });

    const result = await pm._fetchJira({ jql: '' });
    expect(result).toEqual([
      { key: 'DEV-1', summary: 'First', issueType: 'Story', storyPoints: 5 },
      { key: 'DEV-2', summary: 'Second', issueType: '', storyPoints: null },
    ]);
  });

  it('returns empty array when no issues', async () => {
    process.env.JIRA_BASE_URL = 'https://jira.example.com';
    process.env.JIRA_EMAIL = 'u@e.com';
    process.env.JIRA_API_TOKEN = 'tok';

    pm._httpRequest = vi.fn().mockResolvedValue({});
    const result = await pm._fetchJira({ jql: '' });
    expect(result).toEqual([]);
  });
});

// ── _fetchGithubIssues ──────────────────────────────────

describe('PM source: _fetchGithubIssues', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
    process.env.GITHUB_TOKEN = 'ghp_test';
    pm._httpRequest = vi.fn().mockResolvedValue([]);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.GITHUB_TOKEN;
  });

  it('throws when repo is missing', async () => {
    await expect(pm._fetchGithubIssues({}))
      .rejects.toThrow('GitHub repo not configured');
  });

  it('builds correct URL with labels and state', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([]);
    await pm._fetchGithubIssues({ repo: 'org/repo', labels: 'bug,urgent', state: 'open' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('repos/org/repo/issues');
    expect(url).toContain('labels=bug%2Curgent');
    expect(url).toContain('state=open');
    expect(url).toContain('per_page=50');
  });

  it('filters out pull requests from issues endpoint', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'Issue', user: { login: 'alice' }, labels: [] },
      { number: 2, title: 'PR', user: { login: 'bob' }, labels: [], pull_request: {} },
    ]);

    const result = await pm._fetchGithubIssues({ repo: 'org/repo' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#1');
  });

  it('applies author filter (case-insensitive)', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'By alice', user: { login: 'Alice' }, labels: [] },
      { number: 2, title: 'By bob', user: { login: 'bob' }, labels: [] },
    ]);

    const result = await pm._fetchGithubIssues({ repo: 'org/repo', author: 'alice' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#1');
  });

  it('applies excludeLabels filter (case-insensitive)', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'Keep', user: { login: 'a' }, labels: [{ name: 'bug' }] },
      { number: 2, title: 'Exclude', user: { login: 'b' }, labels: [{ name: 'WontFix' }] },
    ]);

    const result = await pm._fetchGithubIssues({ repo: 'org/repo', excludeLabels: 'wontfix' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#1');
  });

  it('maps issues to { key, summary, issueType, storyPoints }', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 42, title: 'My Issue', user: { login: 'dev' }, labels: [] },
    ]);

    const result = await pm._fetchGithubIssues({ repo: 'org/repo' });
    expect(result).toEqual([
      { key: 'org/repo#42', summary: 'My Issue', issueType: 'issue', storyPoints: null },
    ]);
  });
});

// ── _fetchGithubPrs ─────────────────────────────────────

describe('PM source: _fetchGithubPrs', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.GITHUB_TOKEN;
  });

  it('throws when repo is missing', async () => {
    await expect(pm._fetchGithubPrs({}))
      .rejects.toThrow('GitHub repo not configured');
  });

  it('uses Pulls API when no labels filter', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 10, title: 'PR 10', base: { ref: 'main' }, user: { login: 'dev' }, draft: false },
    ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo' });

    // Should call Pulls API for both main and master (default bases)
    expect(pm._httpRequest).toHaveBeenCalledTimes(2);
    const url1 = pm._httpRequest.mock.calls[0][0];
    expect(url1).toContain('/pulls?');
    expect(url1).toContain('base=main');
  });

  it('delegates to search API when labels filter is present', async () => {
    pm._fetchGithubPrsViaSearch = vi.fn().mockResolvedValue([]);
    await pm._fetchGithubPrs({ repo: 'org/repo', labels: 'needs-review' });
    expect(pm._fetchGithubPrsViaSearch).toHaveBeenCalledOnce();
  });

  it('delegates to search API when excludeLabels filter is present', async () => {
    pm._fetchGithubPrsViaSearch = vi.fn().mockResolvedValue([]);
    await pm._fetchGithubPrs({ repo: 'org/repo', excludeLabels: 'skip' });
    expect(pm._fetchGithubPrsViaSearch).toHaveBeenCalledOnce();
  });

  it('filters out draft PRs', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'Ready', base: { ref: 'main' }, user: { login: 'dev' }, draft: false },
      { number: 2, title: 'Draft', base: { ref: 'main' }, user: { login: 'dev' }, draft: true },
    ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'main' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#1');
  });

  it('filters by custom base branches', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 1, title: 'To develop', base: { ref: 'develop' }, user: { login: 'dev' }, draft: false },
      ])
      .mockResolvedValueOnce([
        { number: 2, title: 'To release', base: { ref: 'release' }, user: { login: 'dev' }, draft: false },
      ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'develop,release' });
    expect(pm._httpRequest).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('applies author filter (case-insensitive)', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'By alice', base: { ref: 'main' }, user: { login: 'Alice' }, draft: false },
      { number: 2, title: 'By bob', base: { ref: 'main' }, user: { login: 'Bob' }, draft: false },
    ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'main', author: 'alice' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#1');
  });

  it('maps PRs to { key, summary, issueType: "pr", storyPoints: null }', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 55, title: 'My PR', base: { ref: 'main' }, user: { login: 'dev' }, draft: false },
    ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'main' });
    expect(result).toEqual([
      { key: 'org/repo#55', summary: 'My PR', issueType: 'pr', storyPoints: null },
    ]);
  });

  it('matches PRs using regex base patterns', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'Release PR', base: { ref: 'releases/4.1.0' }, user: { login: 'dev' }, draft: false },
      { number: 2, title: 'Hotfix PR', base: { ref: 'hotfix/urgent' }, user: { login: 'dev' }, draft: false },
      { number: 3, title: 'Feature PR', base: { ref: 'feature/new' }, user: { login: 'dev' }, draft: false },
    ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'releases/.*' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#1');
  });

  it('supports mix of literal and regex base entries', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        // All PRs fetched for regex path
        { number: 1, title: 'Release PR', base: { ref: 'releases/4.1.0' }, user: { login: 'dev' }, draft: false },
        { number: 2, title: 'Main PR', base: { ref: 'main' }, user: { login: 'dev' }, draft: false },
        { number: 3, title: 'Feature PR', base: { ref: 'feature/x' }, user: { login: 'dev' }, draft: false },
      ])
      .mockResolvedValueOnce([
        // Literal 'main' fetch
        { number: 2, title: 'Main PR', base: { ref: 'main' }, user: { login: 'dev' }, draft: false },
      ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'main, releases/.*' });
    // Should include main (literal) and releases/4.1.0 (regex), deduplicated
    expect(result).toHaveLength(2);
    const keys = result.map(r => r.key);
    expect(keys).toContain('org/repo#1');
    expect(keys).toContain('org/repo#2');
  });

  it('deduplicates PRs fetched from both literal and regex paths', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        // All PRs (regex path)
        { number: 5, title: 'PR 5', base: { ref: 'develop' }, user: { login: 'dev' }, draft: false },
      ])
      .mockResolvedValueOnce([
        // Literal 'develop' fetch — same PR
        { number: 5, title: 'PR 5', base: { ref: 'develop' }, user: { login: 'dev' }, draft: false },
      ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'develop, dev.*' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#5');
  });

  it('regex with no matches returns empty', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'PR 1', base: { ref: 'main' }, user: { login: 'dev' }, draft: false },
    ]);

    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'releases/.*' });
    expect(result).toHaveLength(0);
  });

  it('falls back to literal if regex is invalid', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue([
      { number: 1, title: 'PR 1', base: { ref: 'bad[regex' }, user: { login: 'dev' }, draft: false },
    ]);

    // Invalid regex like "bad[regex" should be treated as a literal
    const result = await pm._fetchGithubPrs({ repo: 'org/repo', base: 'bad[regex' });
    // It will try to fetch with literal base "bad[regex" via Pulls API
    expect(pm._httpRequest).toHaveBeenCalled();
    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('base=bad');
  });
});

// ── _fetchGithubPrsViaSearch ────────────────────────────

describe('PM source: _fetchGithubPrsViaSearch', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.GITHUB_TOKEN;
  });

  it('builds correct search query with labels', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'needs-review,urgent' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('search/issues');
    expect(url).toContain('is%3Apr');
    expect(url).toContain('repo%3Aorg%2Frepo');
    expect(url).toContain('label%3Aneeds-review');
    expect(url).toContain('label%3Aurgent');
    expect(url).toContain('-is%3Adraft');
  });

  it('quotes labels with spaces', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'needs review' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('label%3A%22needs+review%22');
  });

  it('adds excludeLabels as negated labels', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', excludeLabels: 'wip,draft' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('-label%3Awip');
    expect(url).toContain('-label%3Adraft');
  });

  it('includes state, base, and author in query', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({
      repo: 'org/repo',
      labels: 'x',
      state: 'open',
      base: 'main',
      author: 'alice',
    });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('is%3Aopen');
    expect(url).toContain('base%3Amain');
    expect(url).toContain('author%3Aalice');
  });

  it('maps search results to standard format', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({
      items: [
        { number: 99, title: 'Search Result PR' },
      ],
    });

    const result = await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x' });
    expect(result).toEqual([
      { key: 'org/repo#99', summary: 'Search Result PR', issueType: 'pr', storyPoints: null },
    ]);
  });

  it('handles missing items gracefully', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({});
    const result = await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x' });
    expect(result).toEqual([]);
  });

  it('does not include base: qualifier for multiple base entries', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x', base: 'main, develop' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).not.toContain('base%3A');
  });

  it('does not include base: qualifier for regex base patterns', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x', base: 'releases/.*' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).not.toContain('base%3A');
  });

  it('includes base: qualifier for single literal base', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ items: [] });
    await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x', base: 'develop' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('base%3Adevelop');
  });

  it('filters results client-side when base has regex patterns', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce({
        items: [
          { number: 10, title: 'Release PR' },
          { number: 11, title: 'Feature PR' },
        ],
      })
      // Individual PR fetches for base ref checking
      .mockResolvedValueOnce({ base: { ref: 'releases/4.2.0' } })
      .mockResolvedValueOnce({ base: { ref: 'feature/x' } });

    const result = await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x', base: 'releases/.*' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('org/repo#10');
  });

  it('filters results client-side for multiple literal bases', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce({
        items: [
          { number: 1, title: 'Main PR' },
          { number: 2, title: 'Develop PR' },
          { number: 3, title: 'Other PR' },
        ],
      })
      .mockResolvedValueOnce({ base: { ref: 'main' } })
      .mockResolvedValueOnce({ base: { ref: 'develop' } })
      .mockResolvedValueOnce({ base: { ref: 'feature/x' } });

    const result = await pm._fetchGithubPrsViaSearch({ repo: 'org/repo', labels: 'x', base: 'main, develop' });
    expect(result).toHaveLength(2);
    const keys = result.map(r => r.key);
    expect(keys).toContain('org/repo#1');
    expect(keys).toContain('org/repo#2');
  });
});

// ── _fetchJenkins ───────────────────────────────────────

describe('PM source: _fetchJenkins', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.JENKINS_URL;
    delete process.env.JENKINS_USER;
    delete process.env.JENKINS_API_TOKEN;
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.JENKINS_URL;
    delete process.env.JENKINS_USER;
    delete process.env.JENKINS_API_TOKEN;
  });

  it('throws when Jenkins credentials are missing', async () => {
    await expect(pm._fetchJenkins({ jobPath: 'my-job' }))
      .rejects.toThrow('Jenkins credentials not configured');
  });

  it('throws when jobPath is missing', async () => {
    process.env.JENKINS_URL = 'https://ci.example.com';
    process.env.JENKINS_USER = 'admin';
    process.env.JENKINS_API_TOKEN = 'tok';
    await expect(pm._fetchJenkins({}))
      .rejects.toThrow('Jenkins job path not configured');
  });

  it('builds correct URL and uses Basic auth', async () => {
    process.env.JENKINS_URL = 'https://ci.example.com';
    process.env.JENKINS_USER = 'admin';
    process.env.JENKINS_API_TOKEN = 'tok';

    pm._httpRequest = vi.fn().mockResolvedValue({ builds: [] });
    await pm._fetchJenkins({ jobPath: 'my-job' });

    const [url, headers] = pm._httpRequest.mock.calls[0];
    expect(url).toContain('/job/my-job/api/json');
    expect(url).toContain('tree=builds');
    const decoded = Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('admin:tok');
  });

  it('returns only failed builds', async () => {
    process.env.JENKINS_URL = 'https://ci.example.com';
    process.env.JENKINS_USER = 'admin';
    process.env.JENKINS_API_TOKEN = 'tok';

    pm._httpRequest = vi.fn().mockResolvedValue({
      builds: [
        { number: 100, result: 'SUCCESS', timestamp: 1000, url: '' },
        { number: 99, result: 'FAILURE', timestamp: 999, url: '' },
        { number: 98, result: 'FAILURE', timestamp: 998, url: '' },
        { number: 97, result: 'UNSTABLE', timestamp: 997, url: '' },
      ],
    });

    const result = await pm._fetchJenkins({ jobPath: 'my-job' });
    expect(result).toHaveLength(2);
    expect(result[0].key).toBe('jenkins-99');
    expect(result[0].summary).toContain('Build #99 failed');
    expect(result[1].key).toBe('jenkins-98');
  });

  it('returns empty array when no builds', async () => {
    process.env.JENKINS_URL = 'https://ci.example.com';
    process.env.JENKINS_USER = 'admin';
    process.env.JENKINS_API_TOKEN = 'tok';

    pm._httpRequest = vi.fn().mockResolvedValue({});
    const result = await pm._fetchJenkins({ jobPath: 'my-job' });
    expect(result).toEqual([]);
  });
});

// ── _fetchZoho ──────────────────────────────────────────

describe('PM source: _fetchZoho', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-07T12:00:00Z') });
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
    process.env.ZOHO_DESK_API_TOKEN = 'zoho_tok';
    process.env.ZOHO_DESK_ORG_ID = 'org123';
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.ZOHO_DESK_API_TOKEN;
    delete process.env.ZOHO_DESK_ORG_ID;
  });

  it('throws when ZOHO_DESK_ORG_ID is missing', async () => {
    delete process.env.ZOHO_DESK_ORG_ID;
    await expect(pm._fetchZoho({}))
      .rejects.toThrow('ZOHO_DESK_ORG_ID not configured');
  });

  it('uses search endpoint when query is provided', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ data: [] });
    await pm._fetchZoho({ query: 'login error' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('/tickets/search');
    expect(url).toContain('searchStr=login+error');
  });

  it('uses list endpoint when no query', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ data: [] });
    await pm._fetchZoho({});

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('/api/v1/tickets?');
    expect(url).not.toContain('search');
  });

  it('passes department and status params', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ data: [] });
    await pm._fetchZoho({ department: 'dept1', status: 'Open' });

    const url = pm._httpRequest.mock.calls[0][0];
    expect(url).toContain('departmentId=dept1');
    expect(url).toContain('status=Open');
  });

  it('sends correct auth headers', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({ data: [] });
    await pm._fetchZoho({});

    const headers = pm._httpRequest.mock.calls[0][1];
    expect(headers.Authorization).toBe('Zoho-oauthtoken zoho_tok');
    expect(headers.orgId).toBe('org123');
  });

  it('maps tickets to standard format', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({
      data: [
        { ticketNumber: '5001', subject: 'Cannot login', id: 'abc' },
      ],
    });

    const result = await pm._fetchZoho({});
    expect(result).toEqual([
      { key: 'zoho-5001', summary: 'Cannot login', issueType: 'ticket', storyPoints: null },
    ]);
  });

  it('uses ticket id when ticketNumber is missing', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({
      data: [{ id: 'xyz', subject: 'Problem' }],
    });

    const result = await pm._fetchZoho({});
    expect(result[0].key).toBe('zoho-xyz');
  });

  it('filters by since date', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({
      data: [
        { ticketNumber: '1', subject: 'Old', createdTime: '2026-03-01T00:00:00Z' },
        { ticketNumber: '2', subject: 'New', createdTime: '2026-03-07T10:00:00Z' },
      ],
    });

    const result = await pm._fetchZoho({ since: '2026-03-06' });
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('zoho-2');
  });

  it('returns all tickets when no since filter', async () => {
    pm._httpRequest = vi.fn().mockResolvedValue({
      data: [
        { ticketNumber: '1', subject: 'Old', createdTime: '2025-01-01T00:00:00Z' },
        { ticketNumber: '2', subject: 'New', createdTime: '2026-03-07T10:00:00Z' },
      ],
    });

    const result = await pm._fetchZoho({});
    expect(result).toHaveLength(2);
  });
});

// ── _fetchReReviews ─────────────────────────────────────

describe('PM source: _fetchReReviews', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-07T12:00:00Z') });
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
    process.env.GITHUB_TOKEN = 'ghp_test';
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.GITHUB_TOKEN;
  });

  it('throws when repo is missing', async () => {
    await expect(pm._fetchReReviews({ reviewer: 'alice' }, '1'))
      .rejects.toThrow('GitHub repo not configured');
  });

  it('throws when reviewer is missing', async () => {
    await expect(pm._fetchReReviews({ repo: 'org/repo' }, '1'))
      .rejects.toThrow('Reviewer username not configured');
  });

  it('skips draft PRs', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 1, title: 'Draft PR', draft: true, updated_at: '2026-03-07T11:00:00Z' },
      ]);

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    expect(result).toEqual([]);
    // Should not fetch comments for draft PRs
    expect(pm._httpRequest).toHaveBeenCalledTimes(1);
  });

  it('detects trigger phrase in comment and returns result', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 10, title: 'My PR', draft: false, updated_at: '2026-03-07T11:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { id: 500, body: 'Ready for review please', user: { login: 'dev1' } },
      ]);

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('re-review-org/repo#10-500');
    expect(result[0].summary).toContain('Re-review PR #10');
  });

  it('uses custom trigger phrases', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 10, title: 'PR', draft: false, updated_at: '2026-03-07T11:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { id: 501, body: 'custom-trigger here', user: { login: 'dev1' } },
      ]);

    const result = await pm._fetchReReviews(
      { repo: 'org/repo', reviewer: 'alice', triggerPhrases: 'custom-trigger' },
      '1',
    );
    expect(result).toHaveLength(1);
  });

  it('skips bot comments (bee emoji prefix)', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 10, title: 'PR', draft: false, updated_at: '2026-03-07T11:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { id: 600, body: '\u{1F41D} Already queued for review', user: { login: 'hive' } },
      ]);

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    expect(result).toEqual([]);
  });

  it('skips [bot] user comments', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 10, title: 'PR', draft: false, updated_at: '2026-03-07T11:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { id: 601, body: 'ready for review', user: { login: 'codecov[bot]', type: 'Bot' } },
      ]);

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    expect(result).toEqual([]);
  });

  it('skips long comments (>500 chars) as likely bot-generated', async () => {
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 10, title: 'PR', draft: false, updated_at: '2026-03-07T11:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { id: 602, body: 'ready for review ' + 'x'.repeat(500), user: { login: 'dev1' } },
      ]);

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    expect(result).toEqual([]);
  });

  it('marks _alreadyQueued when active task exists for PR', async () => {
    // Add an active task with the PR reference
    taskQueue.tasks.set('existing', { id: 'existing', status: 'dispatched', text: 'org/repo#10 review' });

    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce([
        { number: 10, title: 'PR', draft: false, updated_at: '2026-03-07T11:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { id: 700, body: 'ready for review', user: { login: 'dev1' } },
      ]);

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    expect(result).toHaveLength(1);
    expect(result[0]._alreadyQueued).toBe(true);
  });

  it('paginates when >100 open PRs', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1, title: `PR ${i + 1}`, draft: false, updated_at: '2026-03-07T11:00:00Z',
    }));
    const page2 = [
      { number: 101, title: 'PR 101', draft: false, updated_at: '2026-03-07T11:00:00Z' },
    ];
    // Page 1 PRs, Page 2 PRs, then 101 comment fetches
    pm._httpRequest = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValue([]); // all comment fetches return empty

    const result = await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, '1');
    // First two calls are PR pagination
    expect(pm._httpRequest.mock.calls[0][0]).toContain('page=1');
    expect(pm._httpRequest.mock.calls[1][0]).toContain('page=2');
  });

  it('updates _reReviewPollTimes after each run', async () => {
    pm._httpRequest = vi.fn().mockResolvedValueOnce([]); // no PRs

    await pm._fetchReReviews({ repo: 'org/repo', reviewer: 'alice' }, 'pm-42');
    expect(pm._reReviewPollTimes['pm-42']).toBeDefined();
    expect(pm._reReviewPollTimes['pm-42']).toBeGreaterThan(0);
  });
});

// ── _githubHeaders ──────────────────────────────────────

describe('PM helpers: _githubHeaders', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.GITHUB_TOKEN;
  });

  it('throws when GITHUB_TOKEN is missing', () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => pm._githubHeaders()).toThrow('GITHUB_TOKEN not configured');
  });

  it('returns correct headers when token is set', () => {
    process.env.GITHUB_TOKEN = 'ghp_abc123';
    const headers = pm._githubHeaders();
    expect(headers.Authorization).toBe('Bearer ghp_abc123');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['User-Agent']).toBe('hive-pm');
  });
});

// ── _parsePRFromKey ─────────────────────────────────────

describe('PM helpers: _parsePRFromKey', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
  });

  it('parses re-review key', () => {
    const result = pm._parsePRFromKey('re-review-org/repo#123-456');
    expect(result).toEqual({ repo: 'org/repo', prNumber: 123 });
  });

  it('parses simple repo#number key', () => {
    const result = pm._parsePRFromKey('org/repo#42');
    expect(result).toEqual({ repo: 'org/repo', prNumber: 42 });
  });

  it('returns null for non-matching key', () => {
    expect(pm._parsePRFromKey('DEV-123')).toBeNull();
    expect(pm._parsePRFromKey('zoho-5001')).toBeNull();
  });
});

// ── _hasActiveTaskForPR ─────────────────────────────────

describe('PM helpers: _hasActiveTaskForPR', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
  });

  it('returns true when queued task contains PR pattern', () => {
    taskQueue.tasks.set('1', { id: '1', status: 'queued', text: 'Review org/repo#55 please' });
    expect(pm._hasActiveTaskForPR('org/repo', 55)).toBe(true);
  });

  it('returns true when dispatched task contains PR pattern', () => {
    taskQueue.tasks.set('1', { id: '1', status: 'dispatched', text: 'org/repo#55' });
    expect(pm._hasActiveTaskForPR('org/repo', 55)).toBe(true);
  });

  it('returns false for completed tasks', () => {
    taskQueue.tasks.set('1', { id: '1', status: 'completed', text: 'org/repo#55' });
    expect(pm._hasActiveTaskForPR('org/repo', 55)).toBe(false);
  });

  it('returns false when no matching task', () => {
    taskQueue.tasks.set('1', { id: '1', status: 'queued', text: 'something else' });
    expect(pm._hasActiveTaskForPR('org/repo', 55)).toBe(false);
  });
});

// ── enrichTaskText / _buildFullText ─────────────────────

describe('PM helpers: enrichTaskText', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
  });

  it('appends MCP instructions for non-PM tasks', () => {
    const result1 = pm.enrichTaskText({ text: 'hello', source: 'slack:bob' });
    expect(result1).toContain('hello');
    expect(result1).toContain('hive_get_task');
    const result2 = pm.enrichTaskText({ text: 'hello' });
    expect(result2).toContain('hello');
    expect(result2).toContain('hive_get_task');
  });

  it('appends MCP instructions when PM not found', () => {
    const result = pm.enrichTaskText({ text: 'hello', source: 'pm:NonExistent' });
    expect(result).toContain('hello');
    expect(result).toContain('hive_get_task');
  });

  it('appends instructions when PM has them', () => {
    pm.create({ name: 'Test', instructions: 'Be thorough' });
    const result = pm.enrichTaskText({ text: 'Do the thing', source: 'pm:Test' });
    expect(result).toContain('Do the thing');
    expect(result).toContain('Instructions: Be thorough');
  });

  it('appends MCP instructions when mcpEnabled', () => {
    pm.create({ name: 'MCP Test', mcpEnabled: true });
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:MCP Test' });
    expect(result).toContain('hive_get_task');
    expect(result).toContain('hive_post_update');
  });

  it('appends learning section when learningEnabled with prompt', () => {
    pm.create({ name: 'Learn', learningEnabled: true, learningPrompt: 'patterns and root causes' });
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:Learn' });
    expect(result).toContain('hive_report_learnings');
    expect(result).toContain('patterns and root causes');
  });

  it('does not inject PM memory into task prompt (pulled via hive_get_knowledge instead)', () => {
    const created = pm.create({ name: 'MemPM', learningEnabled: true, learningPrompt: 'insights' });
    pm.addLearnings(created.id, ['Known pattern A', 'Known pattern B']);
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:MemPM' });
    expect(result).not.toContain('Known pattern A');
    expect(result).not.toContain('Institutional Knowledge');
    expect(result).toContain('hive_report_learnings');
  });

  it('appends single Slack user ID contact section', () => {
    pm.create({ name: 'SlackPM', slackUserId: 'U01ABC23DEF' });
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:SlackPM' });
    expect(result).toContain('PM Slack Contact');
    expect(result).toContain('`U01ABC23DEF`');
    expect(result).toContain('send a Slack DM to this user ID');
  });

  it('appends multiple Slack user ID contact section', () => {
    pm.create({ name: 'MultiSlack', slackUserId: 'U01ABC23DEF, U04XYZ78GHI' });
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:MultiSlack' });
    expect(result).toContain('PM Slack Contacts');
    expect(result).toContain('`U01ABC23DEF`');
    expect(result).toContain('`U04XYZ78GHI`');
    expect(result).toContain('send a Slack DM to each of these user IDs');
  });

  it('does not append Slack section when slackUserId is not set', () => {
    pm.create({ name: 'NoSlack' });
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:NoSlack' });
    expect(result).not.toContain('PM Slack Contact');
    expect(result).not.toContain('Slack User ID');
  });

  it('handles whitespace-only and empty entries in comma-separated IDs', () => {
    pm.create({ name: 'TrimSlack', slackUserId: ' U01ABC , , U02DEF ' });
    const result = pm.enrichTaskText({ text: 'task', source: 'pm:TrimSlack' });
    expect(result).toContain('`U01ABC`');
    expect(result).toContain('`U02DEF`');
    expect(result).not.toContain('``');
  });
});

// ── _seedChecklist ──────────────────────────────────────

describe('PM helpers: _seedChecklist', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
  });

  it('does nothing when no checklistTemplate', () => {
    const task = { id: '1' };
    pm._seedChecklist({}, task);
    expect(task.checklist).toBeUndefined();
  });

  it('does nothing when template not found', () => {
    const task = { id: '1' };
    pm._seedChecklist({ checklistTemplate: 'nonexistent' }, task);
    expect(task.checklist).toBeUndefined();
  });

  it('populates task.checklist from template', () => {
    taskQueue.checklistTemplates.set('tpl1', {
      items: ['Step 1', 'Step 2', 'Step 3'],
    });
    const task = { id: '1' };
    pm._seedChecklist({ checklistTemplate: 'tpl1' }, task);

    expect(task.checklist).toHaveLength(3);
    expect(task.checklist[0].text).toBe('Step 1');
    expect(task.checklist[0].checked).toBe(false);
    expect(task.checklist[0].id).toBeDefined();
    expect(task.checklist[1].text).toBe('Step 2');
    expect(task.checklist[2].text).toBe('Step 3');
  });

  it('emits task:updated and saves state', () => {
    taskQueue.checklistTemplates.set('tpl1', { items: ['A'] });
    const emitSpy = vi.fn();
    taskQueue.on('task:updated', emitSpy);

    const task = { id: '1' };
    pm._seedChecklist({ checklistTemplate: 'tpl1' }, task);
    expect(emitSpy).toHaveBeenCalledWith(task);
    expect(taskQueue._saveState).toHaveBeenCalled();
  });
});

// ── _getZohoToken ───────────────────────────────────────

describe('PM helpers: _getZohoToken', () => {
  let pm, taskQueue;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-03-07T12:00:00Z') });
    taskQueue = createMockTaskQueue();
    pm = new ProjectManager(taskQueue);
  });

  afterEach(() => {
    pm.stopAll();
    vi.useRealTimers();
    delete process.env.ZOHO_DESK_API_TOKEN;
    delete process.env.ZOHO_DESK_CLIENT_ID;
    delete process.env.ZOHO_DESK_CLIENT_SECRET;
    delete process.env.ZOHO_DESK_REFRESH_TOKEN;
  });

  it('returns cached token when still valid', async () => {
    pm._zohoAccessToken = 'cached_token';
    pm._zohoTokenExpiry = Date.now() + 60000; // valid for 1 more minute
    const result = await pm._getZohoToken();
    expect(result).toBe('cached_token');
  });

  it('returns static token when set and no cached token', async () => {
    process.env.ZOHO_DESK_API_TOKEN = 'static_tok';
    const result = await pm._getZohoToken();
    expect(result).toBe('static_tok');
  });

  it('returns static token when cached token is expired', async () => {
    pm._zohoAccessToken = 'old';
    pm._zohoTokenExpiry = Date.now() - 1000; // expired
    process.env.ZOHO_DESK_API_TOKEN = 'static_tok';
    const result = await pm._getZohoToken();
    expect(result).toBe('static_tok');
  });
});
