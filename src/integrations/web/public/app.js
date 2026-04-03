(function() {
  'use strict';

  // ── Clipboard: enable Cmd+C / Ctrl+C copy from xterm terminals ──
  function enableTerminalCopy(terminal) {
    terminal.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && terminal.hasSelection()) {
        navigator.clipboard.writeText(terminal.getSelection());
        return false; // prevent xterm from handling it
      }
      return true;
    });
  }

  // ── Theme ────────────────────────────────────────
  const XTERM_DARK = { background: '#0f0f23', foreground: '#e2e2f0', cursor: '#e2e2f0', black: '#282a36', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' };
  const XTERM_LIGHT = { background: '#f5f5f7', foreground: '#1d1d2b', cursor: '#1d1d2b', black: '#e0e0e6', red: '#d93025', green: '#1a8f3f', yellow: '#9a7b00', blue: '#7c3aed', magenta: '#c72880', cyan: '#0277a8', white: '#1d1d2b', brightBlack: '#6e7191', brightRed: '#e8453a', brightGreen: '#2da653', brightYellow: '#b08f00', brightBlue: '#9058f0', brightMagenta: '#d94095', brightCyan: '#0892c4', brightWhite: '#1d1d2b' };
  let currentTheme = localStorage.getItem('hive:theme') || 'dark';

  // Apply saved theme immediately (prevent dark flash on light theme)
  document.documentElement.setAttribute('data-theme', currentTheme);

  // ── State ─────────────────────────────────────────
  let ws = null;
  let authenticated = false;

  // ── Loading screen controller ──────────────────
  const loadingScreen = document.getElementById("loading-screen");
  const loadingSvg = loadingScreen.querySelector(".hive-logo-svg");
  const loadingStages = ["connecting", "fleet", "tasks", "automations", "pms"];
  const loadingHexMap = { connecting: [0], fleet: [1, 2], tasks: [3], automations: [4], pms: [5, 6] };
  const loadingDone = new Set();
  let loadingActive = false;
  let initialLoadComplete = false;

  function showLoadingScreen() {
    loadingActive = true;
    loadingDone.clear();
    loadingSvg.classList.remove("done");
    loadingSvg.querySelectorAll(".cell").forEach(c => c.classList.remove("on"));
    loadingScreen.querySelectorAll(".loading-step").forEach(s => {
      s.className = "loading-step";
      s.querySelector(".loading-step-icon").innerHTML = '<span class="loading-dot"></span>';
      s.querySelector(".loading-step-count").textContent = "";
    });
    loadingScreen.classList.remove("fade-out");
    loadingScreen.classList.add("visible");
    // Mark connecting as active immediately
    completeLoadingStage("connecting", "");
  }

  function completeLoadingStage(stage, count) {
    if (!loadingActive || loadingDone.has(stage)) return;
    loadingDone.add(stage);
    const step = loadingScreen.querySelector('.loading-step[data-stage="' + stage + '"]');
    if (step) {
      step.className = "loading-step done";
      step.querySelector(".loading-step-icon").innerHTML = '<span class="loading-check">&#10003;</span>';
      if (count) step.querySelector(".loading-step-count").textContent = count;
    }
    // Light up hexes
    const hexes = loadingHexMap[stage] || [];
    hexes.forEach(h => {
      const cell = loadingSvg.querySelector('.cell[data-hex="' + h + '"]');
      if (cell) cell.classList.add("on");
    });
    // Activate next pending stage
    const nextStage = loadingStages.find(s => !loadingDone.has(s));
    if (nextStage) {
      const nextStep = loadingScreen.querySelector('.loading-step[data-stage="' + nextStage + '"]');
      if (nextStep) {
        nextStep.className = "loading-step active";
        nextStep.querySelector(".loading-step-icon").innerHTML = '<span class="loading-spinner"></span>';
      }
    }
    // All done?
    if (loadingStages.every(s => loadingDone.has(s))) {
      loadingSvg.classList.add("done");
      setTimeout(hideLoadingScreen, 400);
    }
  }

  function hideLoadingScreen() {
    loadingActive = false;
    initialLoadComplete = true;
    loadingScreen.classList.add("fade-out");
    setTimeout(() => {
      loadingScreen.classList.remove("visible", "fade-out");
    }, 300);
  }

  let currentSession = null;
  let mode = 'ask';
  let askPending = false;
  let fleetData = [];
  let linkTemplates = {};
  let term = null;
  let fitAddon = null;
  // Card terminals for Live mode: Map<"sessionNum:pane", {term, fit, lastContent, opened}>
  const cardTerminals = new Map();
  // IntersectionObserver: subscribe visible cards, pause off-screen ones
  const cardTerminalObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const num = entry.target.dataset.session;
      if (!num) continue;
      if (entry.isIntersecting) {
        requestAnimationFrame(() => attachCardTerminal(num, 'claude', null));
      } else {
        pauseCardTerminal(num);
      }
    }
  }, { rootMargin: '200px', threshold: 0 });
  let tasks = [];
  let workStates = [];
  let autoSessions = new Set();
  let feedEntries = [];
  let feedHasMore = false;
  let lastSeenFeedId = null;
  let pendingApprovals = [];
  let rules = [];
  let checklistTemplates = [];
  let checklistPopupTaskId = null;
  let unreadFeedCount = 0;
  let activeTab = 'fleet-panel';
  let previousTab = 'fleet-panel'; // remember which tab was active before session view
  let taskMode = 'auto';
  let vimMode = false;
  let taskAutoComplete = true;
  let autoCreateSessions = false;
  let manualTarget = null;
  let activeTaskTab = 'inprogress';
  let tasksViewMode = 'list'; // 'list' or 'board'
  let boardPmFilter = new Set(); // empty = All PMs, non-empty = selected PM ids
  let boardPrevStatuses = new Map(); // taskId → previous status for FLIP animation
  let taskSearchQuery = '';
  let taskSourceFilter = new Set(); // empty = show all; non-empty = show only matching sources
  let selectedTaskIds = new Set();
  let tasksSessionNum = null;
  let taskStatusFilter = null; // null = show all, 'waiting', 'working'
  let gitFilesSidebarOpen = localStorage.getItem('gitFilesSidebarOpen') === 'true';
  let planSidebarOpen = false;
  let contextActiveTab = null; // null = auto-select first, or 'plan'/'output'
  let planPollTimer = null;          // interval for polling plan file
  let sessionContexts = {};          // session num -> { plan: path, pr: url, ... }
  let tasksSessionTerm = null;
  let tasksSessionFit = null;
  let tasksSessionMode = 'ask';
  let tsActivePane = null;
  let tsSessionPanes = [];
  let tsClaudePaneIdx = null;
  let editingTaskId = null;
  let tasksSelectedTaskId = null;
  let tsUserScrolledUp = false;
  let tsPendingContent = null;
  let tsLastContent = '';
  let tsActiveTab = 'terminal'; // 'terminal' or 'git'
  let tsCommands = []; // cached slash commands for tasks cmd-bar
  let paneCols = 0;    // last known tmux pane cols for main session terminal
  let tsPaneCols = 0;  // last known tmux pane cols for tasks session terminal
  let designations = {};  // { num: string }
  let designationDefs = []; // [{ name, agentFiles, description, color }]
  let consoleAvailable = false;
  let consoleOpen = false;
  let consoleSessionWorking = false;
  let consoleTerm = null;
  let consoleFit = null;
  let consoleLastContent = '';
  let consoleScrolledUp = false;
  let consolePending = null;
  let consoleWriting = false;

  // Color map: name → { css var, rgba bg }
  const DESIG_COLORS = {
    purple: { fg: 'var(--purple)', bg: 'rgba(189,147,249,0.15)', hex: '#bd93f9' },
    cyan:   { fg: 'var(--cyan)',   bg: 'rgba(139,233,253,0.15)', hex: '#8be9fd' },
    green:  { fg: 'var(--green)',  bg: 'rgba(80,250,123,0.15)',  hex: '#50fa7b' },
    orange: { fg: 'var(--orange)', bg: 'rgba(255,184,108,0.2)',  hex: '#ffb86c' },
    pink:   { fg: 'var(--pink)',   bg: 'rgba(255,121,198,0.15)', hex: '#ff79c6' },
    red:    { fg: 'var(--red)',    bg: 'rgba(255,85,85,0.15)',   hex: '#ff5555' },
    yellow: { fg: 'var(--yellow)', bg: 'rgba(241,250,140,0.15)', hex: '#f1fa8c' },
  };
  function getDesigColor(desigName) {
    const def = designationDefs.find(d => d.name === desigName);
    const colorVal = def && def.color;
    if (colorVal && DESIG_COLORS[colorVal]) return DESIG_COLORS[colorVal];
    if (colorVal && colorVal.startsWith('#')) {
      return { fg: colorVal, bg: colorVal + '26', hex: colorVal };
    }
    return DESIG_COLORS['orange'];
  }
  let agentRoots = [];      // array of scan paths
  let agentFilesList = [];  // cached scan results
  let spawnSlotMin = 1;
  let spawnBaseDir = '~/ai-dev';
  let spawnSlotMax = 32;
  let spawnedAgentsList = [];
  let spawningSessions = new Map(); // num → { name } for in-flight spawns
  let pmList = [];        // PM objects from server
  let editingPmId = null; // PM being edited (null = creating new)
  let activePmTab = 'source';
  let activeSessionTab = 'terminal'; // 'terminal', 'git', or 'comments'
  let activePane = null;       // current pane index (null = claudePane default)
  let sessionPanes = [];       // discovered panes from terminal:panes response
  let claudePaneIdx = null;    // the configured claudePane index for the current session
  let fleetSearchTimer = null; // debounce timer for fleet search
  let myPermissions = []; // current user's permissions (empty = legacy token mode, all allowed)
  let allUsers = []; // all users (admin only)
  let showNavButtons = localStorage.getItem('hive_show_nav_buttons') !== 'false';
  let showFleetStrip = localStorage.getItem('hive_show_fleet_strip') === 'true';
  let fleetViewMode = localStorage.getItem('hive_fleet_view') || 'grid';
  // Migrate old 'terminals' mode → grid + live
  if (fleetViewMode === 'terminals') { fleetViewMode = 'grid'; localStorage.setItem('hive_fleet_view', 'grid'); }
  let liveTerminals = localStorage.getItem('hive_live_terminals') === 'true';
  let gridCols = localStorage.getItem('hive_grid_cols') || 'auto';

  // ── DOM refs ──────────────────────────────────────
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const authScreen = $('#auth-screen');
  const authInput = $('#auth-input');
  const authError = $('#auth-error');
  const connBar = $('#conn-bar');
  const mainView = $('#main-view');
  const grid = $('#grid');
  const fleetSearchInput = $('#fleet-search-input');
  const fleetSearchClear = $('#fleet-search-clear');
  const fleetSearchResults = $('#fleet-search-results');
  const sessionPanel = $('#session-panel');
  const backBtn = $('#back-btn');
  const sessionTitle = $('#session-title');
  const sessionBranch = $('#session-branch');
  const termWrap = $('#terminal-wrap');
  const modeToggle = $('#mode-toggle');
  const msgInput = $('#msg-input');
  const sendBtn = $('#send-btn');
  const toasts = $('#toasts');
  const quickTarget = $('#quick-target');
  const quickMode = $('#quick-mode');
  const quickInput = $('#quick-input');
  const quickSendEl = $('#quick-send');
  const quickAllBtn = $('#quick-all');
  const tasksScroll = $('#tasks-scroll');
  const feedScroll = $('#feed-scroll');
  const fleetBadge = $('#fleet-badge');
  let quickSessions = new Set(); // multi-select session numbers (strings)
  let quickSendMode = 'tell';
  const msgHistory = {};
  let msgHistoryIdx = -1;
  let msgHistoryDraft = '';
  const MSG_HISTORY_MAX = 10;
  try { const saved = localStorage.getItem('hive_msg_history'); if (saved) Object.assign(msgHistory, JSON.parse(saved)); } catch(e) {}

  // ── Setup wizard ──────────────────────────────────
  const setupWizard = $('#setup-wizard');
  const setupHiveName = $('#setup-hive-name');
  const setupNameValidation = $('#setup-name-validation');
  const setupRepoPath = $('#setup-repo-path');
  const setupPathValidation = $('#setup-path-validation');
  const setupSharedRepo = $('#setup-shared-repo');
  const setupAgentCount = $('#setup-agent-count');
  const setupCountDisplay = $('#setup-count-display');
  const setupNamesGrid = $('#setup-names-grid');
  const setupReviewTable = $('#setup-review-table');
  const setupBackBtn = $('#setup-back-btn');
  const setupNextBtn = $('#setup-next-btn');
  const setupSkipBtn = $('#setup-skip-btn');
  const setupSourceLocal = $('#setup-source-local');
  const setupSourceGit = $('#setup-source-git');
  const setupLocalFields = $('#setup-local-fields');
  const setupGitFields = $('#setup-git-fields');
  const setupGitTarget = $('#setup-git-target');
  const setupGitTargetValidation = $('#setup-git-target-validation');

  let setupCurrentStep = 0;
  let setupHiveNameValid = true; // empty is valid (optional)
  let setupPathValid = false;
  let setupPathResolved = '';
  let setupPathHasGit = false;
  let setupLaunching = false;
  let setupValidateTimer = null;
  let setupSourceMode = 'local'; // 'local' | 'git'
  let setupGitBaseDirValid = false;
  let setupGitValidateTimer = null;

  function setupUpdateDots() {
    $$('.setup-step-dot').forEach(dot => {
      const s = parseInt(dot.dataset.step);
      dot.classList.toggle('active', s === setupCurrentStep);
      dot.classList.toggle('done', s < setupCurrentStep);
    });
  }

  function setupShowStep(step) {
    setupCurrentStep = step;
    $$('.setup-step').forEach(el => el.classList.toggle('active', parseInt(el.dataset.step) === step));
    setupUpdateDots();
    setupBackBtn.style.display = step > 0 ? '' : 'none';
    if (step === 4) {
      setupNextBtn.textContent = 'Launch Fleet';
      setupNextBtn.classList.remove('primary');
      setupNextBtn.classList.add('launch');
      setupNextBtn.disabled = false;
      setupBuildReview();
    } else {
      setupNextBtn.textContent = 'Next';
      setupNextBtn.classList.remove('launch');
      setupNextBtn.classList.add('primary');
    }
    // Step 0: hive name (optional — always valid, but validate format if non-empty)
    if (step === 0) setupNextBtn.disabled = !setupHiveNameValid;
    // Step 1: disable Next until path/base-dir validates
    if (step === 1) setupNextBtn.disabled = setupSourceMode === 'local' ? !setupPathValid : !setupGitBaseDirValid;
    // Step 2/3: always enabled
    if (step === 2 || step === 3) { setupNextBtn.disabled = false; setupBuildNamesGrid(); }
  }

  function setupBuildNamesGrid() {
    const count = parseInt(setupAgentCount.value);
    setupNamesGrid.innerHTML = '';
    const showGitUrl = setupSourceMode === 'git';
    for (let i = 1; i <= count; i++) {
      const existing = setupNamesGrid.querySelector(`[data-slot="${i}"]`);
      const val = existing ? existing.value : `Slot ${i}`;
      const div = document.createElement('div');
      let html = `<div class="setup-name-label">Agent ${i}</div><input class="setup-name-input" data-slot="${i}" value="${esc(val)}" maxlength="30">`;
      if (showGitUrl) {
        const existingGit = setupNamesGrid.querySelector(`[data-git-slot="${i}"]`);
        const gitVal = existingGit ? existingGit.value : '';
        html += `<input class="setup-git-url-small" data-git-slot="${i}" value="${esc(gitVal)}" placeholder="git@github.com:org/repo.git" spellcheck="false" autocomplete="off">`;
      }
      div.innerHTML = html;
      setupNamesGrid.appendChild(div);
    }
  }

  function setupBuildReview() {
    const hiveName = setupHiveName.value.trim();
    const count = parseInt(setupAgentCount.value);
    const shared = setupSharedRepo.checked;
    const names = [];
    setupNamesGrid.querySelectorAll('.setup-name-input').forEach(inp => {
      names.push(inp.value.trim() || `Slot ${inp.dataset.slot}`);
    });
    const prefix = hiveName ? hiveName + '-' : '';
    const sessionExample = `${prefix}1, ${prefix}2, ...`;
    const isGit = setupSourceMode === 'git';
    const repoPath = isGit ? setupGitTarget.value.trim() : setupRepoPath.value.trim();
    // Collect per-agent git URLs
    const agentGitLines = [];
    if (isGit) {
      setupNamesGrid.querySelectorAll('.setup-git-url-small').forEach(inp => {
        const url = inp.value.trim();
        const slot = inp.dataset.gitSlot;
        const name = names[parseInt(slot) - 1] || `Slot ${slot}`;
        if (url) agentGitLines.push(`${name}: ${url}`);
      });
    }
    setupReviewTable.innerHTML = `
      ${hiveName ? `<tr><td>Hive name</td><td>${esc(hiveName)}</td></tr>` : ''}
      <tr><td>Sessions</td><td>${esc(sessionExample)}</td></tr>
      <tr><td>Source</td><td>${isGit ? 'Git clone' : 'Local path'}</td></tr>
      <tr><td>${isGit ? 'Base dir' : 'Repo path'}</td><td>${esc(repoPath)}</td></tr>
      <tr><td>Mode</td><td>${shared ? 'Shared (single directory)' : 'Numbered (path + N suffix)'}</td></tr>
      <tr><td>Agents</td><td>${count}</td></tr>
      <tr><td>Names</td><td>${names.map(n => esc(n)).join(', ')}</td></tr>
      ${agentGitLines.length ? `<tr><td>Git repos</td><td>${agentGitLines.map(l => esc(l)).join('<br>')}</td></tr>` : ''}
    `;
  }

  function handleSetupPathValidation(msg) {
    setupPathValid = msg.valid;
    setupPathResolved = msg.resolved || '';
    setupPathHasGit = msg.hasGit || false;
    const v = setupPathValidation;
    if (msg.valid && msg.hasGit) {
      v.textContent = 'Valid git repository';
      v.className = 'setup-validation ok';
      setupRepoPath.className = 'setup-input valid';
    } else if (msg.valid) {
      v.textContent = 'Directory exists (no .git found — that\'s OK)';
      v.className = 'setup-validation warn';
      setupRepoPath.className = 'setup-input valid';
    } else {
      v.textContent = 'Directory not found';
      v.className = 'setup-validation err';
      setupRepoPath.className = 'setup-input invalid';
    }
    if (setupCurrentStep === 1 && setupSourceMode === 'local') setupNextBtn.disabled = !msg.valid;
  }

  // Hive name validation (optional, but must be valid format if non-empty)
  const HIVE_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
  setupHiveName.addEventListener('input', () => {
    const val = setupHiveName.value.trim();
    if (!val) {
      setupHiveNameValid = true;
      setupNameValidation.textContent = 'Optional — leave empty for bare session numbers (1, 2, ...)';
      setupNameValidation.className = 'setup-validation';
      setupHiveName.className = 'setup-input';
    } else if (HIVE_NAME_RE.test(val)) {
      setupHiveNameValid = true;
      setupNameValidation.textContent = `Sessions will be named ${val}-1, ${val}-2, ...`;
      setupNameValidation.className = 'setup-validation ok';
      setupHiveName.className = 'setup-input valid';
    } else {
      setupHiveNameValid = false;
      setupNameValidation.textContent = 'Letters, numbers, and hyphens only. Must start/end with letter or number.';
      setupNameValidation.className = 'setup-validation err';
      setupHiveName.className = 'setup-input invalid';
    }
    if (setupCurrentStep === 0) setupNextBtn.disabled = !setupHiveNameValid;
  });

  // Debounced path validation
  setupRepoPath.addEventListener('input', () => {
    clearTimeout(setupValidateTimer);
    const val = setupRepoPath.value.trim();
    if (!val) {
      setupPathValid = false;
      setupPathValidation.textContent = '';
      setupPathValidation.className = 'setup-validation';
      setupRepoPath.className = 'setup-input';
      setupNextBtn.disabled = true;
      return;
    }
    setupValidateTimer = setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'setup:validate-path', path: val }));
      }
    }, 400);
  });

  // Source mode toggle (Local path / Git clone)
  function setupSetSourceMode(mode) {
    setupSourceMode = mode;
    const isGit = mode === 'git';
    setupLocalFields.style.display = isGit ? 'none' : '';
    setupGitFields.style.display = isGit ? '' : 'none';
    $('#setup-source-local-label').classList.toggle('active', !isGit);
    $('#setup-source-git-label').classList.toggle('active', isGit);
    if (setupCurrentStep === 1) {
      setupNextBtn.disabled = isGit ? !setupGitBaseDirValid : !setupPathValid;
    }
  }
  setupSourceLocal.addEventListener('change', () => setupSetSourceMode('local'));
  setupSourceGit.addEventListener('change', () => setupSetSourceMode('git'));

  // Git base directory validation (debounced — just checks directory exists)
  setupGitTarget.addEventListener('input', () => {
    clearTimeout(setupGitValidateTimer);
    const val = setupGitTarget.value.trim();
    if (!val) {
      setupGitBaseDirValid = false;
      setupGitTargetValidation.textContent = '';
      setupGitTargetValidation.className = 'setup-validation';
      setupGitTarget.className = 'setup-input';
      if (setupCurrentStep === 1 && setupSourceMode === 'git') setupNextBtn.disabled = true;
      return;
    }
    setupGitValidateTimer = setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'setup:validate-path', path: val }));
      }
    }, 400);
  });

  function handleSetupGitBaseDirValidation(msg) {
    setupGitBaseDirValid = msg.valid;
    if (msg.valid) {
      setupGitTargetValidation.textContent = 'Directory exists — repos will be cloned here';
      setupGitTargetValidation.className = 'setup-validation ok';
      setupGitTarget.className = 'setup-input valid';
    } else {
      setupGitTargetValidation.textContent = 'Directory not found';
      setupGitTargetValidation.className = 'setup-validation err';
      setupGitTarget.className = 'setup-input invalid';
    }
    if (setupCurrentStep === 1 && setupSourceMode === 'git') setupNextBtn.disabled = !msg.valid;
  }

  setupAgentCount.addEventListener('input', () => {
    setupCountDisplay.textContent = setupAgentCount.value;
  });

  setupNextBtn.addEventListener('click', () => {
    if (setupCurrentStep < 4) {
      setupShowStep(setupCurrentStep + 1);
    } else {
      // Launch
      setupLaunching = true;
      setupNextBtn.disabled = true;
      setupNextBtn.innerHTML = '<span class="setup-spinner"></span>Launching...';
      const count = parseInt(setupAgentCount.value);
      const roles = {};
      setupNamesGrid.querySelectorAll('.setup-name-input').forEach(inp => {
        roles[parseInt(inp.dataset.slot)] = inp.value.trim() || `Slot ${inp.dataset.slot}`;
      });
      const isGit = setupSourceMode === 'git';
      const payload = {
        type: 'setup:launch',
        hiveName: setupHiveName.value.trim(),
        repoDir: isGit ? setupGitTarget.value.trim() : setupRepoPath.value.trim(),
        agentCount: count,
        sharedRepo: setupSharedRepo.checked,
        roles,
      };
      if (isGit) {
        // Collect per-agent git URLs
        const perAgentGitUrls = {};
        setupNamesGrid.querySelectorAll('.setup-git-url-small').forEach(inp => {
          const v = inp.value.trim();
          if (v) perAgentGitUrls[inp.dataset.gitSlot] = v;
        });
        payload.perAgentGitUrls = perAgentGitUrls;
      }
      ws.send(JSON.stringify(payload));
    }
  });

  setupBackBtn.addEventListener('click', () => {
    if (setupCurrentStep > 0) setupShowStep(setupCurrentStep - 1);
  });

  setupSkipBtn.addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'setup:skip' }));
    }
  });

  $('#setup-use-existing-btn').addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'setup:skip' }));
    }
    $('#setup-existing-warning').style.display = 'none';
  });

  $('#setup-start-fresh-btn').addEventListener('click', () => {
    if (!confirm('This will overwrite your existing hive.config.js and may create duplicate tmux sessions. Are you sure?')) return;
    $('#setup-existing-warning').style.display = 'none';
    $$('.setup-steps, .setup-body, .setup-footer').forEach(el => el.style.display = '');
  });

  // ── Auth management ──────────────────────────────
  const TOKEN_KEY = 'hive_token';
  let token = localStorage.getItem(TOKEN_KEY);
  let currentUser = null; // { login, name, avatar } from OAuth, or null for token auth

  // Check if we have OAuth cookie auth (page wouldn't load without it when OAuth is enabled)
  // Try connecting immediately — if OAuth is active, cookie handles auth
  // If token mode, show token prompt only if no saved token
  fetch('/auth/me').then(r => r.json()).then(data => {
    if (data.authenticated) {
      // OAuth mode — already authenticated via cookie
      currentUser = { login: data.login, name: data.name, avatar: data.avatar };
      token = 'cookie'; // marker so connect() works
      authScreen.style.display = 'none';
      connect();
    } else if (token) {
      // Legacy token mode — have saved token
      authScreen.style.display = 'none';
      connect();
    }
    // Otherwise show auth screen (token mode, no saved token)
  }).catch(() => {
    // /auth/me failed — legacy mode, try saved token
    if (token) {
      authScreen.style.display = 'none';
      connect();
    }
  });

  authInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      token = authInput.value.trim();
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
        authError.style.display = 'none';
        connect();
      }
    }
  });

  // ── WebSocket connection ──────────────────────────
  let reconnectTimer = null;
  let lastMessageTime = 0;  // timestamp of last message received from server
  let pongTimer = null;     // timeout waiting for pong response

  function forceReconnect() {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    if (ws) { try { ws.onclose = null; ws.close(); } catch(_) {} ws = null; }
    connBar.className = 'disconnected';
    authenticated = false;
    connect();
  }

  // Queue of callbacks to run after reconnect completes (auth + fleet received)
  let onReconnectCallbacks = [];

  // Returns true if WS is connected and recently active (not zombie).
  // Hive broadcasts fleet data every ~15s, so 30s of silence = dead.
  // Pass an optional callback to run after reconnect if socket was dead.
  function isAlive(onReconnect) {
    if (!ws || ws.readyState !== 1) {
      if (onReconnect) onReconnectCallbacks.push(onReconnect);
      if (!ws || ws.readyState > 1) connect();
      return false;
    }
    if (lastMessageTime && Date.now() - lastMessageTime > 30000) {
      if (onReconnect) onReconnectCallbacks.push(onReconnect);
      forceReconnect();
      return false;
    }
    return true;
  }

  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hive:theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.innerHTML = theme === 'light' ? '&#9728;' : '&#9790;';
    // Update meta theme-color for mobile browser chrome
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f5f5f7' : '#0f0f23';
    // Update all xterm instances
    const xt = theme === 'light' ? XTERM_LIGHT : XTERM_DARK;
    if (term) term.options.theme = xt;
    if (consoleTerm) consoleTerm.options.theme = xt;
    if (mtgTerm) mtgTerm.options.theme = xt;
    if (tasksSessionTerm) tasksSessionTerm.options.theme = xt;
    if (taskDetailTerm) taskDetailTerm.options.theme = xt;
  }

  function connect() {
    if (ws && ws.readyState <= 1) return;
    connBar.className = 'connecting';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => {
      lastMessageTime = Date.now();
      console.time('auth→fleet');
      // Cookie auth: server reads JWT from upgrade request headers automatically
      // Token auth: send token in message
      ws.send(JSON.stringify({ type: 'auth', token: token === 'cookie' ? '' : token }));
    };
    ws.onmessage = (e) => { lastMessageTime = Date.now(); handleMessage(JSON.parse(e.data)); };
    ws.onclose = () => { connBar.className = 'disconnected'; authenticated = false; askPending = false; msgInput.disabled = false; sendBtn.disabled = false; scheduleReconnect(); };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (token) connect(); }, 3000);
  }

  // Reconnect when returning from sleep/background
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !token) return;
    if (!ws || ws.readyState > 1) {
      connect();
      return;
    }
    // If no message received in 30s, socket is definitely dead
    const stale = Date.now() - lastMessageTime > 30000;
    if (stale) {
      forceReconnect();
      return;
    }
    // Socket might be ok — ping it and wait for pong
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (_) {
      forceReconnect();
      return;
    }
    // If no pong within 3s, force reconnect
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      pongTimer = null;
      forceReconnect();
    }, 3000);
  });

  // ── URL routing ─────────────────────────────────
  const TAB_TO_HASH = {
    'fleet-panel': '/fleet', 'tasks-panel': '/tasks', 'feed-panel': '/feed',
    'voice-panel': '/voice', 'ideas-panel': '/ideas', 'more-panel': '/admin', 'session-panel': '/session',
  };
  const HASH_TO_TAB = {};
  for (const [tab, hash] of Object.entries(TAB_TO_HASH)) HASH_TO_TAB[hash] = tab;

  function hashFromState() {
    if (activeTab === 'session-panel' && currentSession) return `/session/${currentSession}`;
    if (activeTab === 'tasks-panel') {
      if (tasksViewMode === 'board') return '/tasks/board';
      if (tasksSelectedTaskId) return `/tasks/${tasksSelectedTaskId}`;
      return '/tasks';
    }
    return TAB_TO_HASH[activeTab] || '/fleet';
  }

  function pushHash() {
    const h = '#' + hashFromState();
    if (location.hash !== h) history.pushState(null, '', h);
  }

  function applyHash() {
    const raw = (location.hash || '#/fleet').slice(1); // strip '#'
    const sessionMatch = raw.match(/^\/session\/(\d+)$/);
    if (sessionMatch) {
      const num = sessionMatch[1];
      const s = fleetData.find(x => String(x.num) === num);
      if (s) { openSession(s, true); return; }
      // Session not found yet — store pending, will apply after fleet data arrives
      pendingRouteSession = num;
      switchTab('fleet-panel', true);
      return;
    }
    if (raw === '/tasks/board') {
      switchTab('tasks-panel', true);
      if (tasksViewMode !== 'board') {
        tasksViewMode = 'board';
        document.querySelectorAll('.tasks-view-btn').forEach(b => b.classList.toggle('active', b.dataset.tasksView === 'board'));
        document.getElementById('tasks-panes').style.display = 'none';
        document.getElementById('tasks-board').style.display = '';
        document.getElementById('tasks-create-btn-board').style.display = '';
        document.getElementById('tasks-ws-config-btn').style.display = '';
        document.getElementById('board-pm-wrap').style.display = '';
        populateBoardPmSelect();
        renderTaskBoard();
      }
      return;
    }
    const taskMatch = raw.match(/^\/tasks\/(.+)$/);
    if (taskMatch) {
      pendingRouteTask = taskMatch[1];
      switchTab('tasks-panel', true);
      selectTaskById(pendingRouteTask);
      return;
    }
    const tab = HASH_TO_TAB[raw];
    if (tab) { switchTab(tab, true); }
    else { switchTab('fleet-panel', true); }
  }

  let pendingRouteSession = null;
  let pendingRouteTask = null;

  window.addEventListener('popstate', () => { if (authenticated) applyHash(); });

  // ── Navigation ────────────────────────────────────
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tab, fromRoute) {
    activeTab = tab;
    // Hide session panel if switching away
    if (tab !== 'session-panel' && currentSession) {
      // Keep session open — just show the other tab over it
    }
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.panel').forEach(p => {
      if (p.id === 'session-panel') {
        // Session panel stays visible if active, hides otherwise
        p.classList.toggle('active', tab === 'session-panel');
      } else {
        p.classList.toggle('active', p.id === tab);
      }
    });
    if (tab === 'feed-panel') {
      if (feedEntries.length) lastSeenFeedId = feedEntries[feedEntries.length - 1].id;
      unreadFeedCount = 0; updateFeedBadge();
    }
    if (tab === 'tasks-panel') {
      // Re-subscribe if we had a session open (preserve active pane)
      if (tasksSessionNum) {
        const resubTasks = () => {
          if (!ws || ws.readyState !== 1 || !tasksSessionNum) return;
          const m = { type: 'terminal:subscribe', session: tasksSessionNum };
          if (tsActivePane !== null) m.pane = tsActivePane;
          ws.send(JSON.stringify(m));
        };
        if (isAlive(resubTasks)) resubTasks();
      }
      requestAnimationFrame(() => fitTasksTerminal());
      renderTasks();
    } else {
      // Unsubscribe from tasks session when leaving
      if (tasksSessionNum && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal:unsubscribe' }));
      }
    }
    // Stop plan polling when leaving session/tasks panels
    if (tab !== 'session-panel' && tab !== 'tasks-panel') stopPlanPolling();
    if (tab === 'session-panel' && planSidebarOpen) startPlanPolling();
    if (tab === 'fleet-panel') renderGrid();
    if (tab === 'ideas-panel' && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'idea:list' }));
    if (tab === 'voice-panel') initVoicePanel();
    else if (mtgDetailOpen) {
      // Close meeting detail when leaving voice panel
      closeMeetingDetail();
    }
    if (tab === 'more-panel') { renderDesignationGrid(); renderAgentRoots(); renderDesigDefs(); renderPMs(); renderUsers(); renderChecklistTemplates(); }
    const spawnBtn = document.getElementById('spawn-btn');
    if (spawnBtn) spawnBtn.classList.toggle('visible', tab === 'fleet-panel');
    // shutdown + restart buttons are inside fleet-panel, no toggle needed
    if (tab === 'session-panel' && term && fitAddon && activeSessionTab === 'terminal') {
      requestAnimationFrame(() => fitTerminal());
      // Re-subscribe in case tasks panel took over the subscription (preserve active pane)
      if (currentSession) {
        const resubscribe = () => {
          if (!ws || ws.readyState !== 1 || !currentSession) return;
          const m = { type: 'terminal:subscribe', session: currentSession };
          if (activePane !== null) m.pane = activePane;
          ws.send(JSON.stringify(m));
        };
        if (isAlive(resubscribe)) resubscribe();
      }
    }
    if (!fromRoute) pushHash();
  }

  function updateFeedBadge() {
    const badge = $('#feed-badge');
    if (unreadFeedCount > 0) { badge.textContent = unreadFeedCount > 99 ? '99+' : unreadFeedCount; badge.classList.add('visible'); }
    else { badge.classList.remove('visible'); }
  }

  function updateTasksBadge() {
    const badge = $('#tasks-badge');
    const queued = tasks.filter(t => t.status === 'queued').length;
    if (queued > 0) { badge.textContent = queued; badge.classList.add('visible'); }
    else { badge.classList.remove('visible'); }
  }

  function updateUserBadge() {
    const badge = $('#user-badge');
    if (!currentUser) { badge.style.display = 'none'; return; }
    badge.style.display = 'flex';
    const avatar = $('#user-avatar');
    if (currentUser.avatar) { avatar.src = currentUser.avatar; avatar.style.display = 'block'; }
    else { avatar.style.display = 'none'; }
  }

  // ── Permission helpers ───────────────────────────
  function hasPerm(cap) {
    // Legacy token mode (no OAuth / no permissions sent) = all allowed
    if (!myPermissions.length) return true;
    if (myPermissions.includes('admin')) return true;
    return myPermissions.includes(cap);
  }

  function applyPermissionGates() {
    // Create task button
    const createBtn = document.getElementById('tasks-create-btn');
    if (createBtn) createBtn.classList.toggle('perm-hidden', !hasPerm('create-tasks'));

    // Quick-send bar (fleet panel)
    const quickBar = document.getElementById('quick-bar');
    if (quickBar) quickBar.classList.toggle('perm-hidden', !hasPerm('send-messages'));

    // Session input bar
    const inputBar = document.getElementById('input-bar');
    if (inputBar) inputBar.classList.toggle('perm-hidden', !hasPerm('send-messages'));

    // Session keys bar
    const keysBar = document.getElementById('keys-bar');
    if (keysBar) keysBar.classList.toggle('perm-hidden', !hasPerm('send-messages'));

    // Restart button
    const restartBtn = document.getElementById('restart-btn');
    if (restartBtn) restartBtn.classList.toggle('perm-hidden', !hasPerm('restart'));

    // Kill button (same permission as restart)
    const killBtn = document.getElementById('kill-btn');
    if (killBtn) killBtn.classList.toggle('perm-hidden', !hasPerm('restart'));

    // Track button (attach task)
    const trackBtn = document.getElementById('track-btn');
    if (trackBtn) trackBtn.classList.toggle('perm-hidden', !hasPerm('create-tasks'));

    // Tasks session input (sidebar in tasks panel)
    const tsInput = document.getElementById('tasks-session-input');
    if (tsInput) tsInput.classList.toggle('perm-hidden', !hasPerm('send-messages'));

    // Tasks session keys
    const tsKeys = document.getElementById('tasks-session-keys');
    if (tsKeys) tsKeys.classList.toggle('perm-hidden', !hasPerm('send-messages'));

    // Broadcast section in more panel
    const broadcastSection = document.getElementById('broadcast-section');
    if (broadcastSection) broadcastSection.classList.toggle('perm-hidden', !hasPerm('send-messages'));

    // Spawn + Shutdown buttons
    const spawnBtn = document.getElementById('spawn-btn');
    if (spawnBtn && !hasPerm('admin')) spawnBtn.classList.add('perm-hidden');
    const shutdownAllBtn = document.getElementById('shutdown-all-btn');
    if (shutdownAllBtn && !hasPerm('admin')) shutdownAllBtn.classList.add('perm-hidden');
    const restartAllBtn = document.getElementById('restart-all-btn');
    if (restartAllBtn && !hasPerm('restart')) restartAllBtn.classList.add('perm-hidden');

    // Users tab + panel in More (tab controls panel visibility)
    const usersTab = document.querySelector('[data-more-tab="more-users"]');
    if (usersTab) usersTab.classList.toggle('perm-hidden', !hasPerm('admin'));
    const usersPanel = document.getElementById('more-users');
    if (usersPanel) usersPanel.classList.toggle('perm-hidden', !hasPerm('admin'));

    // Cmd bar (slash commands)
    const cmdBar = document.getElementById('cmd-bar');
    if (cmdBar) cmdBar.classList.toggle('perm-hidden', !hasPerm('send-messages'));
  }

  // ── Message handling ──────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case 'auth':
        if (msg.ok) {
          authenticated = true; connBar.className = 'connected';
          if (msg.user) currentUser = msg.user;
          if (msg.permissions) { myPermissions = msg.permissions; applyPermissionGates(); }
          authScreen.style.display = 'none'; mainView.style.display = 'flex';
          if (!initialLoadComplete) showLoadingScreen();
          renderGrid();
          updateUserBadge();
          if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
          applyHash();
        } else {
          token = null; localStorage.removeItem(TOKEN_KEY);
          authScreen.style.display = 'flex'; mainView.style.display = 'none';
          authError.style.display = 'block'; authInput.value = ''; authInput.focus();
        }
        break;
      case 'pong':
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
        break;
      // -- Setup wizard messages --
      case 'setup:required':
        authScreen.style.display = 'none'; mainView.style.display = 'none';
        setupWizard.classList.add('visible');
        if (msg.existingState) {
          const s = msg.existingState;
          const parts = [];
          if (s.sessions) parts.push(`${s.sessions} session(s)`);
          if (s.tasks) parts.push(`${s.tasks} task(s)`);
          if (s.designations) parts.push(`${s.designations} designation(s)`);
          $('#setup-warning-details').textContent = parts.join(', ') + '. Running setup will overwrite your configuration.';
          $('#setup-existing-warning').style.display = '';
          $$('.setup-steps, .setup-body, .setup-footer').forEach(el => el.style.display = 'none');
        }
        break;
      case 'setup:validate-path:result':
        if (setupSourceMode === 'git') {
          handleSetupGitBaseDirValidation(msg);
        } else {
          handleSetupPathValidation(msg);
        }
        break;
      case 'setup:complete':
        setupWizard.classList.remove('visible');
        mainView.style.display = 'flex';
        renderGrid();
        showToast('Setup complete', msg.sessionsCreated > 0 ? `${msg.sessionsCreated} session(s) created` : 'Ready to go', 'success');
        break;
      case 'setup:error':
        setupLaunching = false;
        setupNextBtn.disabled = false;
        setupNextBtn.textContent = 'Launch Fleet';
        showToast('Setup error', msg.error, 'error');
        break;
      case 'config':
        linkTemplates = msg.links || {};
        if (msg.spawnBaseDir) spawnBaseDir = msg.spawnBaseDir;
        if (msg.hiveName) {
          document.getElementById('sidebar-logo').innerHTML =
            '<img src="/icon-192.png" alt="hive" style="width:28px;height:28px;vertical-align:middle;margin-bottom:2px"> hive<br><span style="font-size:11px;color:var(--green);font-weight:400">' + esc(msg.hiveName) + '</span>';
        }
        break;
      case 'commands:list': tsCommands = msg.commands || []; renderCommands(tsCommands); break;
      case 'fleet:search:result':
        renderFleetSearchResults(msg.query, msg.results);
        break;
      case 'fleet:status':
        console.timeEnd('auth→fleet');
        console.log(`fleet:status received — ${msg.sessions.length} sessions, previews: ${msg.sessions.filter(s => s.preview).length}`);
        console.time('auth→fleet');
        fleetData = msg.sessions;
        if (loadingActive) completeLoadingStage('fleet', msg.sessions.length + ' sessions');
        // Clear spawning placeholders for sessions that now exist
        for (const s of fleetData) spawningSessions.delete(s.num);
        if (activeTab === 'fleet-panel') renderGrid();
        renderAutoGrid();
        updateSidebarSummary();
        if (activeTab === 'session-panel') updateSessionStatusLine();
        if (activeTab === 'tasks-panel') { updateTasksStatusLine(); updateTaskHexIcons(); }
        updateOffBanners();
        // Update session header activity timestamp
        if (currentSession) {
          const cs = fleetData.find(x => String(x.num) === currentSession);
          if (cs && cs.lastActivity) {
            document.getElementById('session-activity').textContent = `active ${timeAgo(cs.lastActivity)}`;
          }
        }
        // Update session nav strip and idle button
        if (activeTab === 'session-panel') { updateMiniFleetStrip(); updateNavIdleButton(); }
        // Auto-refresh git tab if active
        if (activeTab === 'session-panel' && activeSessionTab === 'git' && currentSession && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'git:info', session: currentSession }));
        }
        // Apply pending session route from URL
        if (pendingRouteSession) {
          const s = fleetData.find(x => String(x.num) === pendingRouteSession);
          if (s) { pendingRouteSession = null; openSession(s, true); }
        }
        // Flush any queued actions from reconnect (e.g. user clicked a session while socket was dead)
        if (onReconnectCallbacks.length) {
          const cbs = onReconnectCallbacks.splice(0);
          cbs.forEach(cb => { try { cb(); } catch(_) {} });
        }
        updateConsoleBtnLogo();
        break;
      case 'terminal:panes':
        if (currentSession === String(msg.session)) {
          sessionPanes = msg.panes || [];
          claudePaneIdx = (typeof msg.claudePane === 'number') ? msg.claudePane : null;
          if (activePane === null && claudePaneIdx !== null) activePane = claudePaneIdx;
          renderPaneTabs();
        }
        if (tasksSessionNum === String(msg.session)) {
          tsSessionPanes = msg.panes || [];
          tsClaudePaneIdx = (typeof msg.claudePane === 'number') ? msg.claudePane : null;
          if (tsActivePane === null && tsClaudePaneIdx !== null) tsActivePane = tsClaudePaneIdx;
          renderPaneTabs('ts');
        }
        if (taskDetailSession && taskDetailSession === String(msg.session)) {
          tdSessionPanes = msg.panes || [];
          tdClaudePaneIdx = (typeof msg.claudePane === 'number') ? msg.claudePane : null;
          if (tdActivePane === null && tdClaudePaneIdx !== null) tdActivePane = tdClaudePaneIdx;
          renderPaneTabs('td');
        }
        break;
      case 'terminal:data':
        // Route data to each terminal independently — never use break inside these blocks
        // (break would exit the entire switch, starving downstream terminals)
        if (term && currentSession === String(msg.session)) {
          const paneOk = !(typeof msg.pane === 'number' && activePane !== null && msg.pane !== activePane);
          if (paneOk) {
            if (msg.cols && msg.cols > 0) { paneCols = msg.cols; if (msg.cols !== term.cols) term.resize(msg.cols, term.rows); }
            if (msg.content !== lastContent) {
              if (userScrolledUp) { pendingContent = msg.content; }
              else { writeTerminalContent(msg.content); }
            }
          }
        }
        if (tasksSessionTerm && tasksSessionNum === String(msg.session) && activeTab === 'tasks-panel') {
          const paneOk = !(typeof msg.pane === 'number' && tsActivePane !== null && msg.pane !== tsActivePane);
          if (paneOk) {
            if (msg.cols && msg.cols > 0) { tsPaneCols = msg.cols; if (msg.cols !== tasksSessionTerm.cols) tasksSessionTerm.resize(msg.cols, tasksSessionTerm.rows); }
            if (msg.content !== tsLastContent) {
              if (tsUserScrolledUp) { tsPendingContent = msg.content; }
              else { writeTasksSessionContent(msg.content); }
            }
          }
        }
        // Task detail slide-out terminal
        if (taskDetailTerm && taskDetailSession && String(msg.session) === taskDetailSession) {
          const tdPaneOk = !(typeof msg.pane === 'number' && tdActivePane !== null && msg.pane !== tdActivePane);
          if (tdPaneOk && msg.content !== taskDetailLastContent) {
            if (msg.cols && msg.cols > 0 && msg.cols !== taskDetailTerm.cols) taskDetailTerm.resize(msg.cols, taskDetailTerm.rows);
            if (taskDetailScrolledUp) {
              taskDetailPending = msg.content;
            } else {
              writeTaskDetailContent(msg.content);
            }
          }
        }
        // Console (Session 0) terminal data
        if (consoleTerm && consoleOpen && String(msg.session) === 'hive-console') {
          if (msg.content !== consoleLastContent) {
            if (consoleScrolledUp) {
              consolePending = msg.content;
            } else {
              writeConsoleContent(msg.content);
            }
          }
        }
        // Voice session terminal data (meeting detail panel)
        if (mtgTerm && mtgDetailOpen && String(msg.session) === 'hive-voice') {
          if (msg.cols && msg.cols > 0 && msg.cols !== mtgTerm.cols) mtgTerm.resize(msg.cols, mtgTerm.rows);
          if (msg.content !== mtgLastContent) {
            if (mtgScrolledUp) { mtgPending = msg.content; }
            else { writeMtgContent(msg.content); }
          }
        }
        // Card terminal data (terminals view mode)
        if (msg.card && typeof msg.pane === 'number') {
          // Try exact pane key first; fall back to 'claude' sentinel for the default pane
          const ct = cardTerminals.get(`${msg.session}:${msg.pane}`) || cardTerminals.get(`${msg.session}:claude`);
          if (ct && ct.term && msg.content !== ct.lastContent) {
            ct.lastContent = msg.content;
            if (msg.cols && msg.cols > 0 && msg.cols !== ct.term.cols) ct.term.resize(msg.cols, ct.term.rows);
            if (ct._raf) cancelAnimationFrame(ct._raf);
            ct._raf = requestAnimationFrame(() => {
              ct._raf = null;
              ct.term.reset();
              ct.term.write(msg.content, () => ct.term.scrollToBottom());
            });
          }
        }
        break;
      case 'ask:stream': break;
      case 'ask:done':
        if (String(msg.session) === 'hive-console') {
          consoleSessionWorking = false;
          updateConsoleBtnLogo();
          if (!msg.success) showToast('Console', msg.error || 'Failed', 'error');
          break;
        }
        askPending = false; msgInput.disabled = false; sendBtn.disabled = false; msgInput.focus();
        if (tsPendingSession && String(msg.session) === tsPendingSession) {
          tsPendingSession = null;
          if (!msg.success) { showToast('Failed', msg.error || 'Ask failed', 'error'); tsMsgInput.value = tsLastSentMessage; }
        } else {
          if (msg.success) { const dur = msg.duration ? `${Math.round(msg.duration / 1000)}s` : ''; showToast('Done', `Session ${msg.session} responded ${dur}`, 'success'); }
          else { showToast('Error', msg.error || 'Ask failed', 'error'); msgInput.value = lastSentMessage; }
        }
        break;
      case 'tell:done':
        if (String(msg.session) === 'hive-console') break;
        if (tsPendingSession && String(msg.session) === tsPendingSession) {
          tsPendingSession = null;
          if (!msg.success) { showToast('Failed', msg.error || 'Tell failed', 'error'); tsMsgInput.value = tsLastSentMessage; }
        } else {
          if (msg.success) showToast('Sent', `Message sent to session ${msg.session}`, 'success');
          else { showToast('Error', msg.error || 'Tell failed', 'error'); msgInput.value = lastSentMessage; }
        }
        break;
      case 'console:status':
        consoleAvailable = !!msg.available;
        document.getElementById('console-btn').style.display = consoleAvailable ? 'flex' : 'none';
        break;
      case 'notify': handleNotify(msg); break;
      case 'restart:done':
        showToast('Restarted', `Session ${msg.session}`, 'success');
        fleet.invalidateCache && fleet.invalidateCache();
        // Reset start buttons
        document.querySelectorAll('.off-start-btn').forEach(b => { b.disabled = false; b.textContent = 'Start Claude'; });
        // Banner will hide on next fleet:status update
        break;
      case 'kill:done': closeSession(); showToast('Closed', `Session ${msg.session} killed`, 'success'); break;
      case 'shutdown:all:done':
        showToast('Shutdown complete', `${msg.killed} session(s) killed${msg.failed ? `, ${msg.failed} failed` : ''}`, msg.failed ? 'warning' : 'success');
        break;
      case 'keys:done': break;
      case 'error':
        // Suppress noisy permission toasts — only show for explicit user actions
        if (msg.message && msg.message.startsWith('Permission denied')) {
          console.warn('[hive]', msg.message);
        } else {
          showToast('Error', msg.message, 'error');
        }
        break;
      case 'workStates:list':
        workStates = msg.states || [];
        renderBoardColumns();
        if (tasksViewMode === 'board') renderTaskBoard();
        break;
      case 'tasks:list':
        tasks = msg.tasks || []; renderTasks(); updateTasksBadge();
        if (loadingActive) { const _q = msg.tasks ? msg.tasks.filter(t => t.status === 'queued').length : 0, _a = msg.tasks ? msg.tasks.filter(t => t.status === 'dispatched').length : 0; completeLoadingStage('tasks', _q + ' queued, ' + _a + ' active'); }
        if (pendingRouteTask) { selectTaskById(pendingRouteTask); pendingRouteTask = null; }
        break;
      case 'task:created': case 'task:dispatched': case 'task:completed': case 'task:failed': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task);
        renderTasks(); updateTasksBadge(); updateChecklistButtons(); updateActionsButton(); updateTsNavButtons(); updateSessionTaskButtons();
        // Auto-advance when a viewed task is completed/failed
        if (msg.type === 'task:completed' || msg.type === 'task:failed') {
          const doneId = msg.task.id;
          const doneSession = msg.task.assignedTo ? String(msg.task.assignedTo) : null;
          // Task detail slide-out: auto-advance to next task
          if (taskDetailTaskId === doneId) {
            setTimeout(() => navigateTaskDetail(1), 300);
          }
          // Task sheet: if this task was selected, advance to next dispatched task
          if (tasksSelectedTaskId === doneId) {
            const navList = tasks.filter(t => t.status === 'dispatched' && t.id !== doneId);
            if (navList.length > 0) {
              setTimeout(() => selectTaskById(navList[0].id), 200);
            } else {
              tasksSelectedTaskId = null;
              updateTsNavButtons();
            }
          }
          // Session view: if viewing the session that just freed up, show next task or refresh
          if (doneSession && currentSession === doneSession) {
            const nextTask = tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === doneSession);
            if (nextTask) {
              // A new task was auto-dispatched to this session
              openTaskSession(doneSession);
            }
            // Otherwise updateSessionTaskButtons already hid the done/requeue buttons
          }
        }
        // Task detail slide-out: refresh toolbar if the viewed task was updated
        if (taskDetailTaskId === msg.task.id) {
          openTaskDetail(msg.task.id); // re-render with updated data
        }
        break;
      }
      case 'task:updated': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task);
        renderTasks(); updateTasksBadge(); updateChecklistButtons(); updateActionsButton(); refreshChecklistPopup(); updateSessionTaskButtons(); break;
      }
      case 'task:cancelled': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks.splice(idx, 1);
        selectedTaskIds.delete(msg.task.id);
        renderTasks(); updateTasksBadge(); updateSessionTaskButtons(); break;
      }
      case 'task:requeued': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task);
        renderTasks(); updateTasksBadge(); updateTsNavButtons(); updateSessionTaskButtons(); break;
      }
      case 'task:snoozed': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task);
        renderTasks(); updateTasksBadge(); updateSessionTaskButtons(); break;
      }
      case 'task:unsnoozed': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task);
        renderTasks(); updateTasksBadge(); updateSessionTaskButtons(); break;
      }
      case 'task:pending-complete': {
        const idx = tasks.findIndex(t => t.id === msg.task.id);
        if (idx >= 0) tasks[idx] = msg.task; else tasks.unshift(msg.task);
        renderTasks(); updateTasksBadge(); updateSessionTaskButtons();
        showToast('Pending Approval', `Task on S:${msg.task.assignedTo} awaiting human approval`, 'warning');
        break;
      }
      case 'task:snapshot': {
        showTaskSnapshotContent(msg.taskId, msg.content, msg.cols);
        break;
      }
      case 'task:action:result': {
        document.querySelectorAll(`.actions-popup-item[data-task-id="${msg.taskId}"]`).forEach(b => b.classList.remove('loading'));
        if (msg.ok) {
          showToast('Action Complete', msg.message || 'Done', 'success');
        } else {
          showToast('Action Failed', msg.error || 'Unknown error', 'error');
        }
        break;
      }
      case 'auto:status': autoSessions = new Set(msg.sessions || []); renderAutoGrid(); if (activeTab === 'fleet-panel') renderGrid(); break;
      case 'feed:entries': feedEntries = msg.entries || []; feedHasMore = msg.hasMore || false; renderFeed(); break;
      case 'feed:new':
        feedEntries.push(msg.entry); if (feedEntries.length > 200) feedEntries.shift();
        if (activeTab === 'feed-panel') {
          renderFeedEntry(msg.entry, true);
        } else {
          unreadFeedCount++; updateFeedBadge();
        }
        break;
      case 'approval:new': pendingApprovals.push(msg.approval); break;
      case 'approval:resolved': { const ai = pendingApprovals.findIndex(a => a.id === msg.approval.id); if (ai >= 0) pendingApprovals.splice(ai, 1); break; }
      case 'approvals:list': pendingApprovals = msg.approvals || []; break;
      case 'broadcast:done': showToast('Broadcast', `${msg.sent} sent, ${msg.failed} failed`, msg.failed ? 'error' : 'success'); break;
      case 'rules:list': rules = msg.rules || []; renderRules(); break;
      case 'checklistTemplates:list':
        checklistTemplates = msg.templates || [];
        if (activeTab === 'more-panel') renderChecklistTemplates();
        updatePmChecklistTplSelector();
        break;
      case 'designations:status':
        designations = msg.designations || {};
        if (loadingActive) completeLoadingStage('automations', '');
        renderDesignationGrid(); updateDesignationSelector(); updatePmDesignationSelector();
        if (activeTab === 'fleet-panel') renderGrid();
        break;
      case 'designationDefs:list':
        designationDefs = msg.defs || [];
        renderDesignationGrid(); updateDesignationSelector(); updatePmDesignationSelector();
        if (activeTab === 'more-panel') renderDesigDefs();
        break;
      case 'agentRoots:list':
        agentRoots = msg.roots || [];
        if (activeTab === 'more-panel') renderAgentRoots();
        break;
      case 'agentFiles:list':
        agentFilesList = msg.files || [];
        if (activeTab === 'more-panel') { renderAgentRoots(); renderDesigDefs(); }
        break;
      case 'vim:status': vimMode = msg.enabled; updateVimToggles(); break;
      case 'taskAutoComplete:status': {
        taskAutoComplete = msg.enabled;
        const btn = document.getElementById('toggle-task-autocomplete');
        if (btn) btn.classList.toggle('on', taskAutoComplete);
        break;
      }
      case 'autoCreateSessions:status': {
        autoCreateSessions = msg.enabled;
        const btn = document.getElementById('toggle-auto-create-sessions');
        if (btn) btn.classList.toggle('on', autoCreateSessions);
        break;
      }
      case 'spawn:slots':
        if (msg.slotMin !== undefined) spawnSlotMin = msg.slotMin;
        if (msg.slotMax !== undefined) spawnSlotMax = msg.slotMax;
        if (msg.repoBase) {
          const base = msg.repoBase.replace(/^\/Users\/[^/]+/, '~');
          document.getElementById('spawn-base-dir').value = base;
        }
        renderSpawnSlots(msg.slots || [], msg.slotMin, msg.slotMax);
        break;
      case 'spawn:config':
        if (msg.min !== undefined) spawnSlotMin = msg.min;
        if (msg.max !== undefined) spawnSlotMax = msg.max;
        if (msg.spawnBaseDir) spawnBaseDir = msg.spawnBaseDir;
        break;
      case 'spawn:done':
        if (spawnToast) { spawnToast.remove(); spawnToast = null; }
        // Clear spawning placeholder — try exact num first, then 'pending'
        if (msg.num && spawningSessions.has(msg.num)) spawningSessions.delete(msg.num);
        else spawningSessions.delete('pending');
        if (msg.success) showToast('Spawned', `Session ${msg.num} at ${msg.repoDir || ''}`, 'success');
        else showToast('Spawn failed', msg.error || 'Unknown error', 'error');
        if (activeTab === 'fleet-panel') renderGrid();
        closeSpawnDialog();
        break;
      case 'spawnedAgents:list':
        spawnedAgentsList = msg.agents || [];
        updateRespawnButton();
        break;
      case 'respawn:done': {
        if (spawnToast) { spawnToast.remove(); spawnToast = null; }
        spawningSessions.clear();
        const rCount = (msg.respawned || []).length;
        const sCount = (msg.skipped || []).length;
        const fCount = (msg.failed || []).length;
        if (fCount > 0) showToast('Respawn partial', `${rCount} respawned, ${sCount} skipped, ${fCount} failed`, 'error');
        else if (rCount > 0) showToast('Respawn done', `${rCount} respawned, ${sCount} already running`, 'success');
        else showToast('Respawn', `All ${sCount} sessions already running`, 'success');
        if (activeTab === 'fleet-panel') renderGrid();
        closeSpawnDialog();
        break;
      }
      case 'pm:list': pmList = msg.pms || []; renderPMs();
        if (tasksViewMode === 'board') { populateBoardPmSelect(); renderBoardColumns(); renderTaskBoard(); }
        if (loadingActive) completeLoadingStage('pms', (msg.pms || []).length + ' active');
        break;
      case 'pm:created': showToast('PM Created', msg.pm.name, 'success'); break;
      case 'pm:error': showToast('PM Error', `${msg.id}: ${msg.error}`, 'error'); break;
      case 'pm:export:result':
      case 'pm:skills':
        handleExportMessage(msg); break;
      case 'context:all':
        sessionContexts = msg.contexts || {};
        updatePlanSidebar();
        break;
      case 'context:updated':
        if (msg.session != null) {
          if (Object.keys(msg.context).length === 0) delete sessionContexts[msg.session];
          else sessionContexts[msg.session] = msg.context;
          updatePlanSidebar();
        }
        break;
      case 'context:data':
        if (msg.session != null) {
          sessionContexts[msg.session] = msg.context || {};
          updatePlanSidebar();
        }
        break;
      case 'plan:file':
        renderPlanContent(msg);
        break;
      case 'user:permissions':
        myPermissions = msg.permissions || [];
        applyPermissionGates();
        renderTasks(); // re-render to show/hide cancel buttons etc.
        break;
      case 'users:list':
        allUsers = msg.users || [];
        if (activeTab === 'more-panel') renderUsers();
        break;
      case 'users:updated': {
        const idx = allUsers.findIndex(u => u.login === msg.user.login);
        if (idx >= 0) allUsers[idx] = msg.user; else allUsers.push(msg.user);
        if (activeTab === 'more-panel') renderUsers();
        break;
      }
      case 'integration:status': {
        const ints = msg.integrations || {};
        for (const [name, info] of Object.entries(ints)) {
          if (info.configured) {
            setIntegrationStatus(name, 'configured', 'Configured');
          } else {
            setIntegrationStatus(name, '', 'Not configured');
          }
        }
        break;
      }
      case 'integration:saved': {
        setIntegrationStatus(msg.integration, 'configured', 'Configured (restart to apply)');
        setIntegrationResult(msg.integration, 'Saved', false);
        showToast('Integration', `${msg.integration} credentials saved. Restart to apply.`, 'success');
        break;
      }
      case 'integration:test:result': {
        if (msg.ok) {
          setIntegrationStatus(msg.integration, 'connected', 'Connected');
          setIntegrationResult(msg.integration, msg.detail, false);
        } else {
          setIntegrationStatus(msg.integration, 'error', 'Error');
          setIntegrationResult(msg.integration, msg.error, true);
        }
        break;
      }
      case 'mcp:deployed': {
        const restartMsg = msg.restarted ? `, ${msg.restarted} restarted via WS` : '';
        document.getElementById('mcp-result').textContent = `Deployed to ${msg.count} session(s)${restartMsg}`;
        const remaining = msg.count - (msg.restarted || 0);
        if (remaining > 0) {
          showMcpRestartConfirm(remaining);
        }
        break;
      }
      case 'restart:all:done':
        showToast('Restarting All', `${msg.restarted} session(s) restarting${msg.failed ? `, ${msg.failed} failed` : ''} — claude --continue`, msg.failed ? 'warning' : 'success');
        break;
      case 'mcp:removed':
        document.getElementById('mcp-result').textContent = `Removed from ${msg.count} session(s)`;
        break;
      case 'mcp:status':
        renderMcpTools(msg.enabledTools || MCP_TOOLS.map(t => t.name));
        break;
      case 'task:comment:added': {
        const t = tasks.find(x => x.id === msg.taskId);
        if (t) {
          if (!t.comments) t.comments = [];
          t.comments.push(msg.comment);
          renderTasks();
          renderCommentPanel(msg.taskId);
        }
        break;
      }
      case 'task:comment:deleted': {
        const t = tasks.find(x => x.id === msg.taskId);
        if (t && t.comments) {
          t.comments = t.comments.filter(c => c.id !== msg.commentId);
          renderTasks();
          renderCommentPanel(msg.taskId);
        }
        break;
      }
      case 'git:info':
        if (currentSession === String(msg.session)) {
          renderGitPanel(msg, 'git-sidebar');
          renderGitFilesSidebar(msg, 'git-files-list');
        }
        if (tasksSessionNum === String(msg.session) && activeTab === 'tasks-panel') {
          renderGitPanel(msg, 'ts-git-sidebar');
          renderGitFilesSidebar(msg, 'ts-git-files-list');
        }
        if (taskDetailSession && taskDetailSession === String(msg.session)) {
          renderGitPanel(msg, 'td-git-sidebar');
          document.getElementById('td-git-section').style.display = '';
        }
        break;
      case 'git:diff':
        if (currentSession === String(msg.session)) {
          showDiffViewer(msg.file, msg.diff, 'git-diff');
          if (gitFilesSidebarOpen) showSidebarDiff(msg.file, msg.diff);
        }
        if (tasksSessionNum === String(msg.session) && activeTab === 'tasks-panel') {
          showDiffViewer(msg.file, msg.diff, 'ts-git-diff');
          if (gitFilesSidebarOpen) showSidebarDiff(msg.file, msg.diff, 'ts');
        }
        if (taskDetailSession && taskDetailSession === String(msg.session)) {
          showDiffViewer(msg.file, msg.diff, 'td-git-diff');
        }
        break;
      case 'git:commit':
        if (currentSession === String(msg.session)) {
          expandCommitRow(msg.hash, msg.files, 'git-sidebar', currentSession);
          expandCommitRow(msg.hash, msg.files, 'git-files-list', currentSession);
        }
        if (tasksSessionNum === String(msg.session) && activeTab === 'tasks-panel') {
          expandCommitRow(msg.hash, msg.files, 'ts-git-sidebar', tasksSessionNum);
          expandCommitRow(msg.hash, msg.files, 'ts-git-files-list', tasksSessionNum);
        }
        if (taskDetailSession && taskDetailSession === String(msg.session)) {
          expandCommitRow(msg.hash, msg.files, 'td-git-sidebar', taskDetailSession);
        }
        break;
      case 'idea:list':
        renderIdeas(msg.ideas || []);
        break;
      case 'idea:created':
        showToast('Idea Created', `#${msg.issue.number} ${msg.issue.title}`, 'success');
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'idea:list' }));
        break;
      case 'idea:error':
        showToast('Idea Error', msg.error, 'error');
        break;
      // ── Voice agent ───────────────────────────
      case 'voice:status': updateVoiceStatus(msg.status); break;
      case 'voice:joining': updateVoiceJoining(msg.url); break;
      case 'voice:meetings': renderMeetingList(msg.meetings, msg.status); break;
      case 'voice:meeting:detail': renderMtgDetail(msg.meeting); break;
      case 'voice:transcript': break; // replaced by voice:meeting:detail
      case 'voice:transcript:entry': appendVoiceTranscript(msg.entry); break;
      case 'voice:response': appendVoiceResponse(msg.text); break;
      case 'voice:speaking': updateVoiceSpeaking(msg.speaking); break;
      case 'voice:task-created': showVoiceTaskToast(msg.task); break;
      case 'voice:error': showToast('Voice Error', msg.error, 'error'); break;
      case 'voice:debug': updateVoiceDebug(msg.debug); break;
      case 'update:status': {
        const branchEl = document.getElementById('update-branch');
        const commitEl = document.getElementById('update-commit');
        const timeEl = document.getElementById('update-time');
        const sel = document.getElementById('update-branch-select');
        if (branchEl) branchEl.textContent = msg.branch;
        if (commitEl) commitEl.textContent = msg.hash + ' — ' + msg.subject;
        if (timeEl) timeEl.textContent = msg.timeAgo;
        if (sel) {
          sel.innerHTML = '';
          (msg.remoteBranches || []).forEach(b => {
            const opt = document.createElement('option');
            opt.value = b; opt.textContent = b;
            if (b === msg.branch) opt.selected = true;
            sel.appendChild(opt);
          });
        }
        const btn = document.getElementById('update-pull-btn');
        if (btn) { btn.disabled = false; btn.textContent = 'Pull & Restart'; }
        break;
      }
      case 'update:log': {
        const logEl = document.getElementById('update-log');
        const wrap = document.getElementById('update-log-wrap');
        if (logEl) {
          logEl.textContent += '[' + msg.step + '] ' + msg.output + '\n';
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        }
        break;
      }
      case 'update:error': {
        const logEl = document.getElementById('update-log');
        const wrap = document.getElementById('update-log-wrap');
        if (logEl) {
          logEl.textContent += '\u274C ERROR: ' + msg.error + '\n';
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        }
        const btn = document.getElementById('update-pull-btn');
        if (btn) { btn.disabled = false; btn.textContent = 'Pull & Restart'; btn.style.background = 'var(--red)'; }
        showToast('Update Error', msg.error, 'error');
        break;
      }
      case 'update:restarting': {
        const logEl = document.getElementById('update-log');
        const wrap = document.getElementById('update-log-wrap');
        if (logEl) {
          logEl.textContent += '\u21BB Restarting hive... connection will drop briefly.\n';
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        }
        const btn = document.getElementById('update-pull-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Restarting...'; }
        const rbtn = document.getElementById('update-restart-btn');
        if (rbtn) { rbtn.disabled = true; rbtn.textContent = 'Restarting...'; }
        break;
      }
    }
  }

  function updateSidebarSummary() {
    const total = fleetData.length;
    const work = fleetData.filter(s => s.state === 'working').length;
    if (fleetBadge) {
      if (total > 0) {
        fleetBadge.textContent = work > 0 ? `${work}/${total}` : String(total);
        fleetBadge.className = 'fleet-badge';
        fleetBadge.style.display = '';
      } else {
        fleetBadge.style.display = 'none';
      }
    }
  }

  // ── Hive loader SVG ──────────────────────────
  function hiveLoaderHtml(text) {
    return `<div class="hive-loader">
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <style>
          .cell { fill: none; stroke: var(--dim); stroke-width: 1.5; opacity: 0.3; }
          .pulse { fill: none; stroke: var(--purple); stroke-width: 2; opacity: 0;
            animation: hivePulse 2.4s ease-in-out infinite; }
          @keyframes hivePulse { 0%,100% { opacity: 0; } 30%,70% { opacity: 0.9; } }
        </style>
        <g transform="translate(50,50)">
          <!-- center hex -->
          <polygon class="cell" points="0,-12 10.4,-6 10.4,6 0,12 -10.4,6 -10.4,-6"/>
          <polygon class="pulse" points="0,-12 10.4,-6 10.4,6 0,12 -10.4,6 -10.4,-6" style="animation-delay:0s"/>
          <!-- top -->
          <polygon class="cell" points="0,-33 10.4,-27 10.4,-15 0,-9 -10.4,-15 -10.4,-27" />
          <polygon class="pulse" points="0,-33 10.4,-27 10.4,-15 0,-9 -10.4,-15 -10.4,-27" style="animation-delay:0.3s"/>
          <!-- top-right -->
          <polygon class="cell" points="18,-22.5 28.4,-16.5 28.4,-4.5 18,1.5 7.6,-4.5 7.6,-16.5" />
          <polygon class="pulse" points="18,-22.5 28.4,-16.5 28.4,-4.5 18,1.5 7.6,-4.5 7.6,-16.5" style="animation-delay:0.6s"/>
          <!-- bottom-right -->
          <polygon class="cell" points="18,1.5 28.4,7.5 28.4,19.5 18,25.5 7.6,19.5 7.6,7.5" />
          <polygon class="pulse" points="18,1.5 28.4,7.5 28.4,19.5 18,25.5 7.6,19.5 7.6,7.5" style="animation-delay:0.9s"/>
          <!-- bottom -->
          <polygon class="cell" points="0,12 10.4,18 10.4,30 0,36 -10.4,30 -10.4,18" />
          <polygon class="pulse" points="0,12 10.4,18 10.4,30 0,36 -10.4,30 -10.4,18" style="animation-delay:1.2s"/>
          <!-- bottom-left -->
          <polygon class="cell" points="-18,1.5 -7.6,7.5 -7.6,19.5 -18,25.5 -28.4,19.5 -28.4,7.5" />
          <polygon class="pulse" points="-18,1.5 -7.6,7.5 -7.6,19.5 -18,25.5 -28.4,19.5 -28.4,7.5" style="animation-delay:1.5s"/>
          <!-- top-left -->
          <polygon class="cell" points="-18,-22.5 -7.6,-16.5 -7.6,-4.5 -18,1.5 -28.4,-4.5 -28.4,-16.5" />
          <polygon class="pulse" points="-18,-22.5 -7.6,-16.5 -7.6,-4.5 -18,1.5 -28.4,-4.5 -28.4,-16.5" style="animation-delay:1.8s"/>
        </g>
      </svg>
      <div class="hive-loader-text">${text || 'Loading...'}</div>
    </div>`;
  }

  // ── Fleet grid rendering ──────────────────────────
  function applyGridCols() {
    // Remove any existing cols-* class, then add the current one
    grid.classList.remove('cols-auto', 'cols-1', 'cols-2', 'cols-3', 'cols-4', 'cols-6');
    grid.classList.add(`cols-${gridCols}`);
  }

  function renderGrid() {
    // Live grid mode manages its own DOM diffing — never wipe the grid
    if (liveTerminals && fleetViewMode === 'grid') {
      if (fleetData.length === 0) {
        grid.innerHTML = hiveLoaderHtml('Loading sessions...');
        grid.className = 'grid live';
        return;
      }
      renderLiveGrid();
      return;
    }

    // Switching away from live grid — tear down card terminals
    if (grid.classList.contains('live')) {
      for (const s of fleetData) unsubscribeCardTerminals(s.num);
    }

    grid.innerHTML = '';
    grid.className = '';
    grid.classList.add(fleetViewMode); // 'grid', 'list', 'swimlane', or 'columns'
    if (fleetViewMode === 'grid') applyGridCols();

    if (fleetData.length === 0) {
      grid.innerHTML = hiveLoaderHtml('Loading sessions...');
      return;
    }

    if (fleetViewMode === 'grid') {
      for (const s of fleetData) renderFleetCard(s);
    } else if (fleetViewMode === 'list') {
      renderFleetList();
    } else {
      // Swimlane / Columns — group by designation
      const groups = {};
      const unassigned = [];
      const hasAnyDesig = Object.keys(designations).length > 0;
      for (const s of fleetData) {
        const desig = designations[s.num];
        if (desig) (groups[desig] = groups[desig] || []).push(s);
        else unassigned.push(s);
      }
      const groupOrder = Object.keys(groups);
      if (hasAnyDesig && unassigned.length) groupOrder.push(null);

      if (!hasAnyDesig) {
        // No designations — fall back to flat grid
        grid.innerHTML = '';
        grid.className = 'grid';
        for (const s of fleetData) renderFleetCard(s);
      } else if (fleetViewMode === 'columns') {
        // Vertical columns
        for (const gName of groupOrder) {
          const sessions = gName ? groups[gName] : unassigned;
          const col = document.createElement('div');
          col.className = 'fleet-column';
          const label = document.createElement('div');
          label.className = 'fleet-col-label';
          if (gName) {
            const gc = getDesigColor(gName);
            label.style.color = gc.fg;
            label.style.background = gc.bg;
            label.textContent = gName;
          } else {
            label.style.color = 'var(--dim)';
            label.textContent = 'Unassigned';
          }
          col.appendChild(label);
          const cards = document.createElement('div');
          cards.className = 'fleet-col-cards';
          for (const s of sessions) renderFleetCard(s, cards);
          col.appendChild(cards);
          grid.appendChild(col);
        }
      } else {
        // Horizontal swimlanes
        for (const gName of groupOrder) {
          const sessions = gName ? groups[gName] : unassigned;
          const lane = document.createElement('div');
          lane.className = 'fleet-swimlane';
          const label = document.createElement('div');
          label.className = 'fleet-lane-label';
          if (gName) {
            const gc = getDesigColor(gName);
            label.style.color = gc.fg;
            label.style.background = gc.bg;
            label.textContent = gName;
          } else {
            label.style.color = 'var(--dim)';
            label.textContent = 'Unassigned';
          }
          lane.appendChild(label);
          for (const s of sessions) renderFleetCard(s, lane);
          grid.appendChild(lane);
        }
      }
    }

    // Render spawning placeholder cards
    for (const [key, info] of spawningSessions) {
      if (key !== 'pending' && fleetData.find(s => s.num === key)) continue;
      const card = document.createElement('div');
      card.className = 'card spawning';
      const numLabel = key === 'pending' ? '?' : key;
      card.innerHTML = `<div class="card-top"><span class="card-num">${numLabel}</span><span class="card-branch">spawning...</span></div>
        ${hiveLoaderHtml('Cloning & starting...')}`;
      grid.appendChild(card);
    }

    if (quickSessions.size) highlightQuickCard();
  }

  function fleetHexSvg(state, size) {
    const sz = size || 20;
    const cls = state === 'working' ? 'logo-animated' : state === 'idle' ? 'logo-green' : 'logo-purple';
    return `<svg class="hive-logo ${cls}" width="${sz}" height="${sz}" viewBox="0 0 100 100"><g transform="translate(50,50)" fill="none" stroke-width="2"><polygon points="0,-12 10.4,-6 10.4,6 0,12 -10.4,6 -10.4,-6"/><polygon points="0,-33 10.4,-27 10.4,-15 0,-9 -10.4,-15 -10.4,-27"/><polygon points="18,-22.5 28.4,-16.5 28.4,-4.5 18,1.5 7.6,-4.5 7.6,-16.5"/><polygon points="18,1.5 28.4,7.5 28.4,19.5 18,25.5 7.6,19.5 7.6,7.5"/><polygon points="0,12 10.4,18 10.4,30 0,36 -10.4,30 -10.4,18"/><polygon points="-18,1.5 -7.6,7.5 -7.6,19.5 -18,25.5 -28.4,19.5 -28.4,7.5"/><polygon points="-18,-22.5 -7.6,-16.5 -7.6,-4.5 -18,1.5 -28.4,-4.5 -28.4,-16.5"/></g></svg>`;
  }

  // ── Shared card helpers ──────────────────────────
  function cardGitHtml(git) {
    if (!git) return '';
    const parts = [];
    if (git.staged) parts.push(`<span style="color:var(--green)">+${git.staged}</span>`);
    if (git.modified) parts.push(`<span style="color:var(--orange)">~${git.modified}</span>`);
    if (git.untracked) parts.push(`<span style="color:var(--red)">?${git.untracked}</span>`);
    return parts.length ? parts.join(' ') : '';
  }

  function cardPrHtml(pr) {
    if (!pr || !pr.prNum) return { pr: '', ci: '', review: '' };
    const prStr = `#${pr.prNum}`;
    let ciStr = '';
    if (pr.ciResult === 'success') ciStr = '<span class="card-ci pass">CI ✓</span>';
    else if (pr.ciResult === 'failure') ciStr = '<span class="card-ci fail">CI ✗</span>';
    else if (pr.ciResult) ciStr = '<span class="card-ci pending">CI …</span>';
    let revStr = '';
    if (pr.review === 'approved') revStr = '<span class="card-review approved">✓ Approved</span>';
    else if (pr.review === 'changes_requested') revStr = '<span class="card-review changes">! Changes</span>';
    return { pr: prStr, ci: ciStr, review: revStr };
  }

  // ── Grid card (compact tile) ──────────────────────
  function renderFleetCard(s, container) {
    const card = document.createElement('div');
    card.className = `card ${s.state === 'off' ? 'off' : ''}`;
    card.dataset.session = s.num;
    const branch = shortBranch(s.branch);
    const activityHtml = s.lastActivity ? `<span class="card-activity">${timeAgo(s.lastActivity)}</span>` : '';
    const desig = designations[s.num];
    const dc = desig ? getDesigColor(desig) : null;
    if (dc) card.style.borderLeft = `3px solid ${dc.fg}`;

    const git = s.git || {};
    const gitStr = cardGitHtml(git);
    const { pr: prStr, ci: ciStr, review: revStr } = cardPrHtml(s.pr);

    // Build meta row: git stats, PR#, CI, review, activity
    let metaParts = '';
    if (gitStr) metaParts += `<span class="card-git">${gitStr}</span>`;
    if (prStr) metaParts += `<span class="card-pr">${prStr}</span>`;
    if (ciStr) metaParts += ciStr;
    if (revStr) metaParts += revStr;
    metaParts += activityHtml;

    const previewHtml = s.preview ? `<div class="card-preview">${esc(s.preview)}</div>` : '';
    const offOverlay = s.state === 'off' ? `<div class="card-off-overlay"><button class="start-btn" data-session="${s.num}">Start</button></div>` : '';

    card.innerHTML = `${offOverlay}
      <div class="card-top">
        <span class="card-hex">${fleetHexSvg(s.state)}</span>
        <span class="card-num">${s.num}</span>
        <span class="card-branch">${esc(branch)}</span>
      </div>
      ${previewHtml}
      <div class="card-meta">${metaParts}</div>`;

    wireFleetCard(card, s);
    (container || grid).appendChild(card);
  }

  // ── Live grid (live panes in each card) ──────────
  function renderLiveGrid() {
    grid.className = 'grid live';
    applyGridCols();

    // Remove any non-card leftovers from other views (list table, loader, etc.)
    Array.from(grid.children).forEach(el => {
      if (!el.classList.contains('card') || !el.dataset.session) el.remove();
    });

    const currentNums = new Set(fleetData.map(s => String(s.num)));

    // Remove cards for sessions that left the fleet and dispose their terminals
    grid.querySelectorAll('.card[data-session]').forEach(card => {
      const num = card.dataset.session;
      if (!currentNums.has(num)) {
        unsubscribeCardTerminals(num);
        card.remove();
      }
    });

    // Update existing expanded cards, or replace compact cards / create new ones
    for (const s of fleetData) {
      const existing = grid.querySelector(`.card[data-session="${s.num}"]`);
      if (existing && existing.querySelector('.card-terminals-row')) {
        // Already expanded — just refresh metadata
        updateExpandedCardMeta(existing, s);
      } else {
        // Compact card from another view, or missing — replace with expanded version
        if (existing) {
          cardTerminalObserver.unobserve(existing);
          existing.remove();
        }
        renderExpandedCard(s);
      }
    }
    // IntersectionObserver handles subscriptions as cards enter/leave the viewport
  }

  function renderExpandedCard(s) {
    const card = document.createElement('div');
    card.className = `card ${s.state === 'off' ? 'off' : ''}`;
    card.dataset.session = s.num;
    const desig = designations[s.num];
    const dc = desig ? getDesigColor(desig) : null;
    if (dc) card.style.borderLeft = `3px solid ${dc.fg}`;

    const branch = shortBranch(s.branch);
    const gitStr = cardGitHtml(s.git || {});
    const { pr: prStr, ci: ciStr, review: revStr } = cardPrHtml(s.pr);
    const activityHtml = s.lastActivity ? `<span class="card-activity">${timeAgo(s.lastActivity)}</span>` : '';
    let metaParts = '';
    if (gitStr) metaParts += `<span class="card-git">${gitStr}</span>`;
    if (prStr) metaParts += `<span class="card-pr">${prStr}</span>`;
    if (ciStr) metaParts += ciStr;
    if (revStr) metaParts += revStr;
    metaParts += activityHtml;

    card.innerHTML = `
      <div class="card-top">
        <span class="card-hex">${fleetHexSvg(s.state)}</span>
        <span class="card-num">${s.num}</span>
        <span class="card-branch">${esc(branch)}</span>
      </div>
      <div class="card-meta">${metaParts}</div>
      <div class="card-terminals-row">
        <div class="card-term-section">
          <div class="card-term-label">Claude</div>
          <div class="card-terminal" id="card-term-${s.num}-claude"></div>
        </div>
      </div>`;

    card.querySelector('.card-top').addEventListener('click', () => openSession(s));
    const numEl = card.querySelector('.card-num');
    if (numEl) numEl.addEventListener('click', (e) => { e.stopPropagation(); selectQuickSession(s.num); });
    const termRow = card.querySelector('.card-terminals-row');
    if (termRow) termRow.addEventListener('click', (e) => { e.stopPropagation(); focusCardSession(s.num); });

    if (s.state === 'off') {
      const overlay = document.createElement('div');
      overlay.className = 'card-off-overlay';
      overlay.innerHTML = `<button class="start-btn" data-session="${s.num}">Start</button>`;
      overlay.querySelector('.start-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ws || ws.readyState !== 1) return;
        e.target.disabled = true; e.target.textContent = 'Starting...';
        ws.send(JSON.stringify({ type: 'restart', session: String(s.num) }));
      });
      card.appendChild(overlay);
    }

    grid.appendChild(card);
    cardTerminalObserver.observe(card);
  }

  function attachCardTerminal(sessionNum, label, paneIdx) {
    const key = `${sessionNum}:${paneIdx ?? 'claude'}`;
    const container = document.getElementById(`card-term-${sessionNum}-${label}`);
    if (!container) return;

    let ct = cardTerminals.get(key);
    if (!ct) {
      // First time: create and open the terminal
      const t = new Terminal({
        theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
        fontSize: fleetFontSize,
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        disableStdin: true,
        scrollback: 500,
        convertEol: true,
        allowProposedApi: true,
      });
      const f = new FitAddon.FitAddon();
      t.loadAddon(f);
      ct = { term: t, fit: f, lastContent: '', opened: false };
      cardTerminals.set(key, ct);
    }

    if (!ct.opened) {
      ct.term.open(container);
      ct.opened = true;
    } else if (ct.term.element && ct.term.element.parentElement !== container) {
      // DOM was recreated (e.g. card re-rendered) — move the existing xterm element
      container.innerHTML = '';
      container.appendChild(ct.term.element);
    }
    // Retry fit after paint — xterm canvas needs a visible, sized container
    try { ct.fit.fit(); } catch (_) {}
    setTimeout(() => { try { ct.fit.fit(); } catch (_) {} }, 100);

    // Always send subscribe — handles both initial attach and reconnect
    if (ws && ws.readyState === 1) {
      const subMsg = { type: 'terminal:subscribe', session: String(sessionNum), card: true };
      if (typeof paneIdx === 'number') subMsg.pane = paneIdx;
      ws.send(JSON.stringify(subMsg));
    }
  }

  function updateExpandedCardMeta(card, s) {
    const hexEl = card.querySelector('.card-hex');
    if (hexEl) hexEl.innerHTML = fleetHexSvg(s.state);
    card.classList.toggle('off', s.state === 'off');

    const branch = shortBranch(s.branch);
    const branchEl = card.querySelector('.card-branch');
    if (branchEl) branchEl.textContent = branch;

    const metaEl = card.querySelector('.card-meta');
    if (metaEl) {
      const gitStr = cardGitHtml(s.git || {});
      const { pr: prStr, ci: ciStr, review: revStr } = cardPrHtml(s.pr);
      const activityHtml = s.lastActivity ? `<span class="card-activity">${timeAgo(s.lastActivity)}</span>` : '';
      let metaParts = '';
      if (gitStr) metaParts += `<span class="card-git">${gitStr}</span>`;
      if (prStr) metaParts += `<span class="card-pr">${prStr}</span>`;
      if (ciStr) metaParts += ciStr;
      if (revStr) metaParts += revStr;
      metaParts += activityHtml;
      metaEl.innerHTML = metaParts;
    }
  }

  function unsubscribeCardTerminals(sessionNum) {
    const prefix = `${sessionNum}:`;
    const keysToRemove = [...cardTerminals.keys()].filter(k => k.startsWith(prefix));
    for (const key of keysToRemove) {
      const ct = cardTerminals.get(key);
      if (ct && ct.term) { try { ct.term.dispose(); } catch (_) {} }
      cardTerminals.delete(key);
      if (ws && ws.readyState === 1) {
        const pane = key.slice(prefix.length);
        const msg = { type: 'terminal:card:unsubscribe', session: String(sessionNum) };
        if (pane !== 'claude') msg.pane = parseInt(pane, 10);
        ws.send(JSON.stringify(msg));
      }
    }
    // Unobserve the card DOM element if still present
    const card = grid.querySelector(`.card[data-session="${sessionNum}"]`);
    if (card) cardTerminalObserver.unobserve(card);
  }

  // Stop server polling for a card without disposing the terminal DOM
  function pauseCardTerminal(sessionNum) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:card:unsubscribe', session: String(sessionNum) }));
    }
  }

  // ── List table ───────────────────────────────────
  function renderFleetList() {
    const table = document.createElement('table');
    table.className = 'fleet-table';
    table.innerHTML = `<thead><tr>
      <th></th><th>#</th><th>Branch</th><th>Status</th><th>Git</th><th>PR</th><th>CI</th><th>Review</th><th>Preview</th><th>Active</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');

    for (const s of fleetData) {
      const tr = document.createElement('tr');
      tr.className = `fleet-row ${s.state === 'off' ? 'off' : ''}`;
      tr.dataset.session = s.num;
      const desig = designations[s.num];
      const dc = desig ? getDesigColor(desig) : null;
      if (dc) tr.style.borderLeft = `3px solid ${dc.fg}`;

      const branch = shortBranch(s.branch);
      const stateColor = s.state === 'working' ? 'var(--green)' : s.state === 'idle' ? 'var(--purple)' : 'var(--dim)';
      const gitStr = cardGitHtml(s.git);
      const { pr: prStr, ci: ciStr, review: revStr } = cardPrHtml(s.pr);
      const preview = s.preview ? esc(s.preview.substring(0, 50)) : '';
      const activity = s.lastActivity ? timeAgo(s.lastActivity) : '';
      const actionHtml = s.state === 'off' ? `<button class="start-btn" data-session="${s.num}">Start</button>` : '';

      tr.innerHTML = `
        <td class="col-hex">${fleetHexSvg(s.state, 16)}</td>
        <td class="col-num">${s.num}</td>
        <td class="col-branch">${esc(branch)}</td>
        <td class="col-state" style="color:${stateColor}">${s.state}</td>
        <td class="col-git">${gitStr}</td>
        <td class="col-pr">${prStr}</td>
        <td class="col-ci">${ciStr}</td>
        <td class="col-review">${revStr}</td>
        <td class="col-preview">${preview}</td>
        <td class="col-activity">${activity}</td>
        <td class="col-action">${actionHtml}</td>`;

      wireFleetCard(tr, s);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    grid.appendChild(table);
  }

  // ── Shared event wiring for fleet cards/rows ──────
  function wireFleetCard(el, s) {
    if (s.state === 'off') {
      const startBtn = el.querySelector('.start-btn');
      if (startBtn) startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!ws || ws.readyState !== 1) return;
        startBtn.disabled = true;
        startBtn.textContent = 'Starting...';
        ws.send(JSON.stringify({ type: 'restart', session: String(s.num) }));
      });
    }
    const numEl = el.querySelector('.card-num') || el.querySelector('.row-num');
    if (numEl) numEl.addEventListener('click', (e) => { e.stopPropagation(); selectQuickSession(s.num); });
    el.addEventListener('click', () => openSession(s));
  }

  // ── Fleet search ────────────────────────────────
  fleetSearchInput.addEventListener('input', () => {
    const q = fleetSearchInput.value.trim();
    fleetSearchClear.style.display = q ? '' : 'none';
    clearTimeout(fleetSearchTimer);
    if (!q) {
      fleetSearchResults.style.display = 'none';
      fleetSearchResults.innerHTML = '';
      return;
    }
    fleetSearchResults.style.display = '';
    fleetSearchResults.innerHTML = '<div class="fleet-search-loading">Searching...</div>';
    fleetSearchTimer = setTimeout(() => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'fleet:search', query: q }));
      }
    }, 400);
  });

  fleetSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      fleetSearchInput.value = '';
      fleetSearchClear.style.display = 'none';
      fleetSearchResults.style.display = 'none';
      fleetSearchResults.innerHTML = '';
      fleetSearchInput.blur();
    }
  });

  fleetSearchClear.addEventListener('click', () => {
    fleetSearchInput.value = '';
    fleetSearchClear.style.display = 'none';
    fleetSearchResults.style.display = 'none';
    fleetSearchResults.innerHTML = '';
    fleetSearchInput.focus();
  });

  // ── Fleet view toggle ──────────────────────────────
  function updateGridControls() {
    const isGrid = fleetViewMode === 'grid';
    document.getElementById('fleet-cols-toggle').style.display = isGrid ? '' : 'none';
    fleetLiveBtn.style.display = isGrid ? '' : 'none';
  }

  document.querySelectorAll('.fleet-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      fleetViewMode = btn.dataset.view;
      localStorage.setItem('hive_fleet_view', fleetViewMode);
      document.querySelectorAll('.fleet-view-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === fleetViewMode));
      updateGridControls();
      renderGrid();
    });
  });
  // Apply saved state on load
  document.querySelectorAll('.fleet-view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === fleetViewMode));

  // ── Grid column count toggle ───────────────────────
  document.querySelectorAll('.fleet-cols-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      gridCols = btn.dataset.cols;
      localStorage.setItem('hive_grid_cols', gridCols);
      document.querySelectorAll('.fleet-cols-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.cols === gridCols));
      if (fleetViewMode === 'grid') applyGridCols();
    });
  });
  // Apply saved state on load
  document.querySelectorAll('.fleet-cols-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.cols === gridCols));

  // ── Live terminals toggle ──────────────────────────
  const fleetLiveBtn = document.getElementById('fleet-live-btn');
  fleetLiveBtn.addEventListener('click', () => {
    liveTerminals = !liveTerminals;
    localStorage.setItem('hive_live_terminals', liveTerminals);
    fleetLiveBtn.classList.toggle('active', liveTerminals);
    document.getElementById('fleet-font-controls').style.display = liveTerminals ? '' : 'none';
    renderGrid();
  });
  // Apply saved state on load
  fleetLiveBtn.classList.toggle('active', liveTerminals);
  document.getElementById('fleet-font-controls').style.display = liveTerminals ? '' : 'none';
  updateGridControls();

  function renderFleetSearchResults(query, results) {
    if (!query || fleetSearchInput.value.trim() !== query) return; // stale result
    fleetSearchResults.style.display = '';
    if (results.length === 0) {
      fleetSearchResults.innerHTML = '<div class="fleet-search-no-results">No sessions match "' + esc(query) + '"</div>';
      return;
    }
    const queryRe = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    fleetSearchResults.innerHTML = results.map(r => {
      const stateCls = r.state === 'idle' ? 'state-idle' : r.state === 'working' ? 'state-working' : 'state-off';
      const matchHtml = (r.matchLines || []).map(l =>
        '<div class="result-match">' + esc(l).replace(queryRe, '<mark>$1</mark>') + '</div>'
      ).join('');
      return `<div class="fleet-search-result" data-num="${r.num}">
        <div class="result-header">
          <span class="result-num">${r.num}</span>
          <span class="result-branch">${esc(shortBranch(r.branch))}</span>
          <span class="result-state ${stateCls}">${r.state}</span>
        </div>
        ${matchHtml}
      </div>`;
    }).join('');
    // Click to open session
    fleetSearchResults.querySelectorAll('.fleet-search-result').forEach(el => {
      el.addEventListener('click', () => {
        const num = el.dataset.num;
        const s = fleetData.find(x => String(x.num) === num);
        if (s) openSession(s);
      });
    });
  }

  function shortBranch(branch) { if (!branch) return 'master'; const short = branch.replace(/^[^/]+\//, ''); return short.length > 28 ? short.substring(0, 25) + '...' : short; }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Session detail view ───────────────────────────
  var userScrolledUp = false;
  var pendingContent = null;
  var lastContent = '';

  function openSession(s, fromRoute) {
    currentSession = String(s.num);
    paneCols = 0; // reset until we get pane width from server
    sessionTitle.textContent = `Session ${s.num}`;
    sessionBranch.textContent = shortBranch(s.branch);
    updateSessionStatusLine();
    document.getElementById('session-activity').textContent = s.lastActivity ? `active ${timeAgo(s.lastActivity)}` : '';
    previousTab = activeTab;
    userScrolledUp = false;
    pendingContent = null;
    lastContent = '';
    // Reset pane state — always start expanded
    activePane = null;
    sessionPanes = [];
    claudePaneIdx = null;
    panesCollapsed = false;
    tsPanesCollapsed = false;
    renderPaneTabs();
    updateInputForPane(true); // reset input to Claude mode
    // Reset to terminal tab
    activeSessionTab = 'terminal';
    $$('.session-tab').forEach(t => t.classList.toggle('active', t.dataset.stab === 'terminal'));
    document.getElementById('session-terminal-content').classList.add('active');
    document.getElementById('session-git-content').classList.remove('active');
    closeAllCommentsDrawers();
    // Update plan sidebar for this session
    updatePlanSidebar();
    if (planSidebarOpen) startPlanPolling();
    // Render comments for the tracked task and update badge
    const sessionTask = tasks.find(t => t.assignedTo === s.num);
    if (sessionTask) renderCommentPanel(sessionTask.id, 'session');
    updateCommentBadge('session', sessionTask);
    updateChecklistButtons();
    updateActionsButton();
    updateSessionTaskButtons();
    updateOffBanners();

    if (!term) {
      term = new Terminal({
        theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
        fontSize: sessionFontSize, fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        disableStdin: true, scrollback: 5000, convertEol: true, allowProposedApi: true,
      });
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
      enableTerminalCopy(term);
      term.open(termWrap);
      term.element.addEventListener('wheel', () => { setTimeout(checkScrollPosition, 50); });
      let touchStartY = 0;
      term.element.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
      term.element.addEventListener('touchend', (e) => { const dy = touchStartY - (e.changedTouches[0] || {}).clientY; if (Math.abs(dy) > 20) { setTimeout(checkScrollPosition, 150); setTimeout(checkScrollPosition, 500); } });
    }

    // Show session panel
    switchTab('session-panel', fromRoute);
    if (!fromRoute) pushHash();
    requestAnimationFrame(() => {
      fitTerminal();
      term.clear();
      // Subscribe after fit so cols/rows reflect actual terminal size
      const subscribeSession = () => {
        if (!ws || ws.readyState !== 1 || !currentSession) return;
        ws.send(JSON.stringify({ type: 'terminal:subscribe', session: currentSession, cols: term.cols, rows: term.rows }));
        ws.send(JSON.stringify({ type: 'terminal:panes', session: currentSession }));
        ws.send(JSON.stringify({ type: 'git:info', session: currentSession }));
      };
      if (isAlive(subscribeSession)) {
        subscribeSession();
      }
      applyGitFilesSidebarState('session');
      setTimeout(() => { const el = document.getElementById('terminal-wrap'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, 100);
    });
    applyNavPreferences();
  }

  var writingContent = false;

  function checkScrollPosition() {
    if (!term || writingContent) return;
    const buf = term.buffer.active;
    const linesFromBottom = buf.baseY - buf.viewportY;
    if (linesFromBottom <= 3 && userScrolledUp) {
      userScrolledUp = false; scrollIndicator(false);
      if (pendingContent !== null) { writeTerminalContent(pendingContent); pendingContent = null; }
    } else if (linesFromBottom > 3) { userScrolledUp = true; scrollIndicator(true); }
  }

  var _termWriteRAF = null;
  function writeTerminalContent(content) {
    if (!term) return;
    lastContent = content; writingContent = true;
    // Coalesce rapid updates — only the last content wins
    if (_termWriteRAF) cancelAnimationFrame(_termWriteRAF);
    _termWriteRAF = requestAnimationFrame(() => {
      _termWriteRAF = null;
      term.reset();
      term.write(content, () => {
        term.scrollToBottom();
        writingContent = false;
      });
    });
  }

  // ── Pane tabs (multi-pane terminal viewer) ───────
  var panesCollapsed = false;  // always start expanded — collapsed is per-session toggle only
  var tsPanesCollapsed = false;

  // ctx: undefined/'main' for session panel, 'ts' for tasks panel, 'td' for task detail
  function renderPaneTabs(ctx) {
    const isTd = (ctx === 'td');
    const isTs = (ctx === 'ts');
    const barId = isTd ? 'td-pane-tabs' : isTs ? 'ts-pane-tabs' : 'pane-tabs';
    const panes = isTd ? tdSessionPanes : isTs ? tsSessionPanes : sessionPanes;
    const curActive = isTd ? tdActivePane : isTs ? tsActivePane : activePane;
    const claudeIdx = isTd ? tdClaudePaneIdx : isTs ? tsClaudePaneIdx : claudePaneIdx;
    const collapsed = isTd ? false : isTs ? tsPanesCollapsed : panesCollapsed;
    const bar = document.getElementById(barId);
    if (!bar) return;
    const hasPanes = panes.length > 1;

    // Update Terminal tab text with arrow hint
    const termTabAttr = isTs ? 'tstab' : 'stab';
    const termTab = document.querySelector(`[data-${termTabAttr}="terminal"]`);
    if (termTab) {
      const arrow = collapsed ? '&#9656;' : '&#9662;';
      termTab.innerHTML = hasPanes ? `Terminal <span class="pane-arrow">${arrow}</span>` : 'Terminal';
    }

    if (!hasPanes) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = collapsed ? 'none' : 'flex';
    bar.innerHTML = '';
    const sorted = [...panes].sort((a, b) => a.index - b.index);
    const shellPaneCount = sorted.filter(p => p.index !== claudeIdx).length;
    let shellCount = 0;
    sorted.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'pane-tab' + ((curActive === p.index) ? ' active' : '');
      btn.dataset.paneIdx = p.index;
      let label;
      if (p.index === claudeIdx) {
        label = 'Claude';
      } else {
        shellCount++;
        const cmdName = (p.command || 'shell').replace(/^-/, '');
        label = shellPaneCount > 1 ? `${capitalize(cmdName)} ${shellCount}` : capitalize(cmdName);
      }
      btn.innerHTML = label;
      btn.addEventListener('click', () => switchPane(p.index, ctx));
      bar.appendChild(btn);
    });
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function togglePanesCollapsed() {
    panesCollapsed = !panesCollapsed;
    tsPanesCollapsed = panesCollapsed;
    localStorage.setItem('hive:panesCollapsed', panesCollapsed ? '1' : '0');
    renderPaneTabs();
    renderPaneTabs('ts');
  }

  function switchPane(paneIdx, ctx) {
    const isTd = (ctx === 'td');
    const isTs = (ctx === 'ts');
    const curActive = isTd ? tdActivePane : isTs ? tsActivePane : activePane;
    if (!isTd) {
      const diffPaneId = isTs ? 'ts-sidebar-diff-pane' : 'sidebar-diff-pane';
      const diffVisible = document.getElementById(diffPaneId).classList.contains('active');
      if (paneIdx === curActive && !diffVisible) return;
      switchFromDiffPane(ctx);
    } else {
      if (paneIdx === curActive) return;
    }

    const claudeIdx = isTd ? tdClaudePaneIdx : isTs ? tsClaudePaneIdx : claudePaneIdx;
    const isClaudePane = (paneIdx === claudeIdx);
    const barId = isTd ? 'td-pane-tabs' : isTs ? 'ts-pane-tabs' : 'pane-tabs';
    const sessionNum = isTd ? taskDetailSession : isTs ? tasksSessionNum : currentSession;

    if (isTd) { tdActivePane = paneIdx; } else if (isTs) { tsActivePane = paneIdx; } else { activePane = paneIdx; }

    // Update pane tab active state
    document.querySelectorAll(`#${barId} .pane-tab`).forEach(t => {
      t.classList.toggle('active', parseInt(t.dataset.paneIdx) === paneIdx);
    });

    // Re-subscribe to the new pane
    if (paneIdx !== curActive && ws && ws.readyState === 1 && sessionNum) {
      if (isTd) {
        taskDetailScrolledUp = false; taskDetailPending = null; taskDetailLastContent = '';
        if (taskDetailTerm) taskDetailTerm.clear();
      } else if (isTs) {
        tsUserScrolledUp = false; tsPendingContent = null; tsLastContent = '';
        if (tasksSessionTerm) tasksSessionTerm.clear();
      } else {
        userScrolledUp = false; pendingContent = null; lastContent = '';
        if (term) term.clear();
      }
      ws.send(JSON.stringify({ type: 'terminal:subscribe', session: sessionNum, pane: paneIdx }));
    }

    updateInputForPane(isClaudePane, ctx);
  }

  function updateInputForPane(isClaudePane, ctx) {
    const isTd = (ctx === 'td');
    const isTs = (ctx === 'ts');
    const inputId = isTd ? 'task-detail-input' : isTs ? 'ts-msg-input' : 'msg-input';
    const toggleId = isTd ? 'task-detail-mode-toggle' : isTs ? 'ts-mode-toggle' : 'mode-toggle';
    const msgInputEl = document.getElementById(inputId);
    const modeToggleEl = document.getElementById(toggleId);
    if (!msgInputEl || !modeToggleEl) return;
    if (isClaudePane) {
      msgInputEl.placeholder = 'Message Claude...';
      modeToggleEl.style.display = '';
    } else {
      msgInputEl.placeholder = 'Run command in shell...';
      modeToggleEl.style.display = 'none';
    }
  }

  // ── Session status line (shared) ─────────────────
  function renderStatusChips(sessionNum) {
    const s = fleetData.find(x => String(x.num) === String(sessionNum));
    if (!s) return '';
    const chips = [];
    const branch = s.branch || '';

    // History chip (only if history exists for this session)
    const h = msgHistory[String(s.num)] || [];
    if (h.length) {
      chips.push(`<span class="status-chip history-chip-btn" data-action="show-history" data-session="${s.num}">History</span>`);
    }

    // Mode chip (Auto/Manual)
    const isAuto = autoSessions.has(s.num);
    const modeClass = isAuto ? 'mode-auto' : 'mode-manual';
    const modeLabel = isAuto ? 'Auto' : 'Manual';
    chips.push(`<span class="status-chip ${modeClass}" data-action="toggle-auto" data-session="${s.num}">${modeLabel}</span>`);

    // Designation chip
    const desig = designations[s.num] || '';
    if (desig) {
      const dc = getDesigColor(desig);
      chips.push(`<span class="status-chip desig" style="background:${dc.bg};color:${dc.fg}" data-action="pick-desig" data-session="${s.num}">${esc(desig)}</span>`);
    } else {
      chips.push(`<span class="status-chip desig" style="background:rgba(98,114,164,0.15);color:var(--dim)" data-action="pick-desig" data-session="${s.num}">No Desig</span>`);
    }

    // PR chip
    if (s.pr && s.pr.prNum) {
      const prUrl = linkTemplates.pr ? linkTemplates.pr.replace('${prNum}', s.pr.prNum) : null;
      if (prUrl) {
        chips.push(`<a class="status-chip pr" href="${prUrl}" target="_blank">PR #${s.pr.prNum}</a>`);
      } else {
        chips.push(`<span class="status-chip pr">PR #${s.pr.prNum}</span>`);
      }
    }

    // JIRA chips — extract DEV-XXXXX from branch name
    const jiraMatches = branch.match(/DEV-\d+/g);
    if (jiraMatches) {
      for (const ticket of jiraMatches) {
        const jiraUrl = `https://vivtechnologies.atlassian.net/browse/${ticket}`;
        chips.push(`<a class="status-chip jira" href="${jiraUrl}" target="_blank">${ticket}</a>`);
      }
    }

    // CI chip
    if (s.pr && s.pr.ciResult) {
      const ciUrl = (linkTemplates.ci && s.pr.ciBuild) ? linkTemplates.ci.replace('${prNum}', s.pr.prNum).replace('${ciBuild}', s.pr.ciBuild) : null;
      const cls = s.pr.ciResult === 'SUCCESS' ? 'ci-pass' : s.pr.ciResult === 'FAILURE' ? 'ci-fail' : 'ci-run';
      const label = s.pr.ciResult === 'SUCCESS' ? 'CI Passing' : s.pr.ciResult === 'FAILURE' ? 'CI Failed' : 'CI Running';
      if (ciUrl) {
        chips.push(`<a class="status-chip ${cls}" href="${ciUrl}" target="_blank">${label}</a>`);
      } else {
        chips.push(`<span class="status-chip ${cls}">${label}</span>`);
      }
    }

    // Review chip
    if (s.pr && s.pr.review) {
      if (s.pr.review === 'APPROVED') {
        chips.push(`<span class="status-chip review-ok">Review Approved</span>`);
      } else if (s.pr.review === 'CHANGES_REQUESTED') {
        chips.push(`<span class="status-chip review-chg">Changes Requested</span>`);
      }
    }

    return chips.join('');
  }

  function updateSessionStatusLine() {
    const bar = document.getElementById('session-status-line');
    if (!bar) return;
    bar.innerHTML = currentSession ? renderStatusChips(currentSession) : '';
  }

  function updateTasksStatusLine() {
    const bar = document.getElementById('ts-status-line');
    if (!bar) return;
    bar.innerHTML = tasksSessionNum ? renderStatusChips(tasksSessionNum) : '';
  }

  function updateOffBanners() {
    // Session panel
    const sBanner = document.getElementById('session-off-banner');
    const termWrapEl = document.getElementById('terminal-wrap');
    if (sBanner && currentSession) {
      // Non-fleet sessions (PM sessions, voice, etc.) — never show off banner
      const isNonFleet = String(currentSession).startsWith('hive-');
      const s = isNonFleet ? null : fleetData.find(x => String(x.num) === currentSession);
      const isOff = s && s.state === 'off';
      sBanner.classList.toggle('visible', isOff);
      if (termWrapEl) termWrapEl.style.display = isOff ? 'none' : '';
    }
    // Tasks panel
    const tBanner = document.getElementById('ts-off-banner');
    const tsTermEl = document.getElementById('tasks-session-terminal');
    if (tBanner && tasksSessionNum) {
      const s = fleetData.find(x => String(x.num) === String(tasksSessionNum));
      const isOff = s && s.state === 'off';
      tBanner.classList.toggle('visible', isOff);
      if (tsTermEl) tsTermEl.style.display = isOff ? 'none' : '';
    }
  }

  // ── Status chip click handlers (delegated) ─────
  function closeDesigPopover() {
    const existing = document.querySelector('.desig-popover');
    if (existing) existing.remove();
  }

  function showDesigPopover(chip, sessionNum) {
    closeDesigPopover();
    const rect = chip.getBoundingClientRect();
    const popover = document.createElement('div');
    popover.className = 'desig-popover';
    popover.style.left = rect.left + 'px';
    popover.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    const desigNames = getDesignationNames();
    for (const d of desigNames) {
      const item = document.createElement('div');
      item.className = 'desig-popover-item';
      if (d) {
        const dc = getDesigColor(d);
        item.style.color = dc.fg;
      } else {
        item.style.color = 'var(--dim)';
      }
      item.textContent = d || '— None —';
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'designation:set', session: sessionNum, designation: d }));
        closeDesigPopover();
      });
      popover.appendChild(item);
    }
    document.body.appendChild(popover);
  }

  function handleStatusChipClick(e) {
    const chip = e.target.closest('[data-action]');
    if (!chip) return;
    const action = chip.dataset.action;
    const sessionNum = Number(chip.dataset.session);
    if (action === 'toggle-auto') {
      toggleAutoLocal(sessionNum);
      updateSessionStatusLine();
      updateTasksStatusLine();
    } else if (action === 'pick-desig') {
      e.stopPropagation();
      showDesigPopover(chip, sessionNum);
    } else if (action === 'show-history') {
      e.stopPropagation();
      showHistoryPopover(chip, sessionNum);
    }
  }

  function closeHistoryPopover() {
    const existing = document.querySelector('.history-popover');
    if (existing) existing.remove();
  }

  function showHistoryPopover(chip, sessionNum) {
    closeHistoryPopover();
    closeDesigPopover();
    const h = msgHistory[String(sessionNum)] || [];
    if (!h.length) return;
    const rect = chip.getBoundingClientRect();
    const popover = document.createElement('div');
    popover.className = 'history-popover';
    popover.style.left = rect.left + 'px';
    popover.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    const items = h.slice().reverse(); // newest first
    for (const m of items) {
      const item = document.createElement('div');
      item.className = 'history-popover-item';
      item.textContent = m;
      item.title = m;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        // Fill the correct input based on which panel is active
        if (activeTab === 'session-panel') {
          msgInput.value = m; msgInput.focus();
        } else if (activeTab === 'tasks-panel') {
          tsMsgInput.value = m; tsMsgInput.focus();
        }
        closeHistoryPopover();
      });
      popover.appendChild(item);
    }
    document.body.appendChild(popover);
  }

  document.getElementById('session-status-line').addEventListener('click', handleStatusChipClick);
  document.getElementById('ts-status-line').addEventListener('click', handleStatusChipClick);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.desig-popover') && !e.target.closest('[data-action="pick-desig"]')) closeDesigPopover();
    if (!e.target.closest('.history-popover') && !e.target.closest('[data-action="show-history"]')) closeHistoryPopover();
  });

  // Fit terminal to container, but use pane cols if wider (prevents ANSI line wrapping artifacts)
  function fitTerminal() {
    if (!term || !fitAddon) return;
    fitAddon.fit();
    if (paneCols > 0 && paneCols > term.cols) term.resize(paneCols, term.rows);
  }
  function fitTasksTerminal() {
    if (!tasksSessionTerm || !tasksSessionFit) return;
    tasksSessionFit.fit();
    if (tsPaneCols > 0 && tsPaneCols > tasksSessionTerm.cols) tasksSessionTerm.resize(tsPaneCols, tasksSessionTerm.rows);
  }

  // ── Console (Session 0) ───────────────────────────────
  function openConsole() {
    consoleOpen = true;
    document.getElementById('console-panel').classList.add('open');
    document.getElementById('console-overlay').classList.add('open');
    document.getElementById('console-btn').classList.add('active');
    updateConsoleBtnLogo();
    if (!consoleTerm) {
      consoleTerm = new Terminal({
        theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
        fontSize: 12, fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        disableStdin: true, scrollback: 5000, convertEol: true, allowProposedApi: true,
      });
      consoleFit = new FitAddon.FitAddon();
      consoleTerm.loadAddon(consoleFit);
      consoleTerm.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
      enableTerminalCopy(consoleTerm);
      consoleTerm.open(document.getElementById('console-terminal'));
      // Scroll lock: detect user scrolling up
      consoleTerm.element.addEventListener('wheel', () => { setTimeout(checkConsoleScroll, 50); });
      let consoleTouchStartY = 0;
      consoleTerm.element.addEventListener('touchstart', (e) => { consoleTouchStartY = e.touches[0].clientY; }, { passive: true });
      consoleTerm.element.addEventListener('touchend', (e) => {
        const dy = consoleTouchStartY - (e.changedTouches[0] || {}).clientY;
        if (Math.abs(dy) > 20) { setTimeout(checkConsoleScroll, 150); setTimeout(checkConsoleScroll, 500); }
      });
    }
    requestAnimationFrame(() => {
      consoleFit.fit();
      consoleTerm.clear();
      consoleLastContent = '';
      consoleScrolledUp = false;
      consolePending = null;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal:subscribe', session: 'hive-console', cols: consoleTerm.cols, rows: consoleTerm.rows }));
        // Resize tmux pane to match xterm cols
        ws.send(JSON.stringify({ type: 'terminal:resize', session: 'hive-console', cols: consoleTerm.cols, rows: consoleTerm.rows }));
      }
    });
    document.getElementById('console-input').focus();
  }

  function closeConsole() {
    consoleOpen = false;
    document.getElementById('console-panel').classList.remove('open');
    document.getElementById('console-overlay').classList.remove('open');
    document.getElementById('console-btn').classList.remove('active');
    updateConsoleBtnLogo();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe', session: 'hive-console' }));
    }
  }

  function toggleConsole() {
    if (consoleOpen) closeConsole();
    else openConsole();
  }

  function checkConsoleScroll() {
    if (!consoleTerm || consoleWriting) return;
    const buf = consoleTerm.buffer.active;
    const linesFromBottom = buf.baseY - buf.viewportY;
    if (linesFromBottom <= 3 && consoleScrolledUp) {
      consoleScrolledUp = false;
      consoleScrollIndicator(false);
      if (consolePending !== null) { writeConsoleContent(consolePending); consolePending = null; }
    } else if (linesFromBottom > 3) {
      consoleScrolledUp = true;
      consoleScrollIndicator(true);
    }
  }

  var _consWriteRAF = null;
  function writeConsoleContent(content) {
    if (!consoleTerm) return;
    consoleLastContent = content;
    consoleWriting = true;
    if (_consWriteRAF) cancelAnimationFrame(_consWriteRAF);
    _consWriteRAF = requestAnimationFrame(() => {
      _consWriteRAF = null;
      consoleTerm.reset();
      consoleTerm.write(content, () => {
        consoleTerm.scrollToBottom();
        consoleWriting = false;
      });
    });
  }

  function consoleScrollIndicator(show) {
    let el = document.getElementById('console-scroll-pause');
    const termContainer = document.getElementById('console-terminal');
    if (show && !el) {
      el = document.createElement('div');
      el.id = 'console-scroll-pause';
      el.className = 'scroll-pause-btn';
      el.setAttribute('data-tooltip', 'Scroll to bottom');
      el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      el.addEventListener('click', () => {
        consoleScrolledUp = false;
        consoleScrollIndicator(false);
        if (consoleTerm) consoleTerm.scrollToBottom();
        if (consolePending !== null) { writeConsoleContent(consolePending); consolePending = null; }
      });
      if (termContainer) { termContainer.style.position = 'relative'; termContainer.appendChild(el); }
    } else if (!show && el) { el.remove(); }
  }

  function updateConsoleBtnLogo() {
    const logo = document.querySelector('#console-btn .hive-logo');
    if (!logo) return;
    logo.classList.remove('logo-purple', 'logo-green', 'logo-animated');
    if (consoleOpen) {
      logo.classList.add('logo-green');
    } else if (consoleSessionWorking) {
      logo.classList.add('logo-animated');
    } else {
      logo.classList.add('logo-purple');
    }
  }

  const consoleAttachedImages = [];
  const consoleAttachmentStrip = document.getElementById('console-attachment-strip');

  function sendConsoleMessage() {
    const input = document.getElementById('console-input');
    const text = input.value.trim();
    const hasImages = consoleAttachedImages.length > 0;
    if (!text && !hasImages) return;
    if (!ws || ws.readyState !== 1) return;
    let message = text;
    if (hasImages) {
      const paths = consoleAttachedImages.map(i => i.path).join(', ');
      const prefix = `[Attached images: ${paths}]`;
      message = text ? `${prefix}\n\n${text}` : `${prefix}\n\nLook at the attached screenshot.`;
      clearAttachments(consoleAttachedImages, consoleAttachmentStrip);
    }
    ws.send(JSON.stringify({ type: 'ask', session: 'hive-console', message }));
    consoleSessionWorking = true;
    updateConsoleBtnLogo();
    pushMsgHistory('hive-console', text);
    consoleHistoryIdx = -1;
    consoleHistoryDraft = '';
    input.value = '';
  }

  let consoleHistoryIdx = -1;
  let consoleHistoryDraft = '';

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });
  applyTheme(currentTheme); // set icon and xterm themes on load

  // ── Font size controls ──────────────────────────────
  const FONT_MIN = 8, FONT_MAX = 24;
  const savedSessionFont = parseInt(localStorage.getItem('hive:fontSize:session'), 10) || 13;
  const savedTsFont = parseInt(localStorage.getItem('hive:fontSize:tasks'), 10) || 13;
  const savedFleetFont = parseInt(localStorage.getItem('hive:fontSize:fleet'), 10) || 11;
  const savedTdFont = parseInt(localStorage.getItem('hive:fontSize:taskDetail'), 10) || 12;
  let sessionFontSize = savedSessionFont;
  let tsFontSize = savedTsFont;
  let fleetFontSize = savedFleetFont;
  let tdFontSize = savedTdFont;

  function updateFontLabel(id, size) {
    const el = document.getElementById(id);
    if (el) el.textContent = size;
  }

  function applySessionFontSize(size) {
    sessionFontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    localStorage.setItem('hive:fontSize:session', sessionFontSize);
    updateFontLabel('session-font-label', sessionFontSize);
    if (term) {
      term.options.fontSize = sessionFontSize;
      requestAnimationFrame(() => fitTerminal());
    }
  }

  function applyTsFontSize(size) {
    tsFontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    localStorage.setItem('hive:fontSize:tasks', tsFontSize);
    updateFontLabel('ts-font-label', tsFontSize);
    if (tasksSessionTerm) {
      tasksSessionTerm.options.fontSize = tsFontSize;
      requestAnimationFrame(() => fitTasksTerminal());
    }
  }

  function applyFleetFontSize(size) {
    fleetFontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    localStorage.setItem('hive:fontSize:fleet', fleetFontSize);
    updateFontLabel('fleet-font-label', fleetFontSize);
    for (const ct of cardTerminals.values()) {
      ct.term.options.fontSize = fleetFontSize;
      try { ct.fit.fit(); } catch (_) {}
    }
  }

  function applyTdFontSize(size) {
    tdFontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    localStorage.setItem('hive:fontSize:taskDetail', tdFontSize);
    updateFontLabel('td-font-label', tdFontSize);
    if (taskDetailTerm) {
      taskDetailTerm.options.fontSize = tdFontSize;
      try { taskDetailFitAddon.fit(); } catch (_) {}
    }
  }

  // Initialize labels
  updateFontLabel('session-font-label', sessionFontSize);
  updateFontLabel('ts-font-label', tsFontSize);
  updateFontLabel('fleet-font-label', fleetFontSize);
  updateFontLabel('td-font-label', tdFontSize);

  // Wire up click handlers via event delegation
  document.getElementById('session-font-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    applySessionFontSize(sessionFontSize + (btn.dataset.action === 'font-up' ? 1 : -1));
  });
  document.getElementById('ts-font-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    applyTsFontSize(tsFontSize + (btn.dataset.action === 'font-up' ? 1 : -1));
  });
  document.getElementById('fleet-font-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    applyFleetFontSize(fleetFontSize + (btn.dataset.action === 'font-up' ? 1 : -1));
  });
  document.getElementById('td-font-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    applyTdFontSize(tdFontSize + (btn.dataset.action === 'font-up' ? 1 : -1));
  });

  // Console event listeners
  document.getElementById('console-btn').addEventListener('click', toggleConsole);
  document.getElementById('console-close').addEventListener('click', closeConsole);
  document.getElementById('console-overlay').addEventListener('click', closeConsole);
  document.getElementById('console-send').addEventListener('click', sendConsoleMessage);
  document.getElementById('console-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendConsoleMessage(); return; }
    const input = document.getElementById('console-input');
    const h = msgHistory['hive-console'] || [];
    if (e.key === 'ArrowUp') {
      if (input.value.lastIndexOf('\n', input.selectionStart - 1) !== -1) return;
      if (!h.length) return;
      e.preventDefault();
      if (consoleHistoryIdx === -1) consoleHistoryDraft = input.value;
      if (consoleHistoryIdx < h.length - 1) consoleHistoryIdx++;
      input.value = h[h.length - 1 - consoleHistoryIdx];
    } else if (e.key === 'ArrowDown') {
      if (input.value.indexOf('\n', input.selectionStart) !== -1) return;
      if (consoleHistoryIdx <= -1) return;
      e.preventDefault();
      consoleHistoryIdx--;
      input.value = consoleHistoryIdx === -1 ? consoleHistoryDraft : h[h.length - 1 - consoleHistoryIdx];
    }
  });
  // Keyboard shortcut: Escape to close (only when input not focused)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && consoleOpen) { e.preventDefault(); closeConsole(); }
  });

  // Console keys bar — send raw tmux keys
  document.querySelectorAll('[data-console-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'keys', session: 'hive-console', keys: [btn.dataset.consoleKey], pane: 1 }));
    });
  });

  // Console image drag-drop / paste
  setupDragDrop(document.getElementById('console-input'), consoleAttachedImages, consoleAttachmentStrip);

  function scrollIndicator(show) {
    let el = document.getElementById('scroll-pause');
    if (show && !el) {
      el = document.createElement('div'); el.id = 'scroll-pause';
      el.setAttribute('data-tooltip', 'Scroll to bottom');
      el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      el.addEventListener('click', () => { userScrolledUp = false; scrollIndicator(false); if (term) term.scrollToBottom(); if (pendingContent !== null) { writeTerminalContent(pendingContent); pendingContent = null; } });
      termWrap.appendChild(el);
    } else if (!show && el) { el.remove(); }
  }

  function closeSession() {
    if (ws && ws.readyState === 1 && currentSession) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe' }));
    }
    currentSession = null;
    askPending = false; msgInput.disabled = false; sendBtn.disabled = false; msgInput.value = '';
    switchTab(previousTab); // switchTab pushes hash
  }

  backBtn.addEventListener('click', closeSession);

  // ── Session navigation (Prev / Next / Next Idle / Mini fleet strip) ──
  function getSortedSessionList() {
    return fleetData.filter(s => s.state !== 'off').sort((a, b) => a.num - b.num);
  }

  function navigateToSession(s) {
    // Preserve previousTab so back button still returns to fleet grid
    const savedPrev = previousTab;
    openSession(s);
    previousTab = savedPrev;
  }

  function navPrev() {
    const sorted = getSortedSessionList();
    if (sorted.length === 0) return;
    const idx = sorted.findIndex(s => String(s.num) === currentSession);
    const prev = idx <= 0 ? sorted[sorted.length - 1] : sorted[idx - 1];
    navigateToSession(prev);
  }

  function navNext() {
    const sorted = getSortedSessionList();
    if (sorted.length === 0) return;
    const idx = sorted.findIndex(s => String(s.num) === currentSession);
    const next = idx < 0 || idx >= sorted.length - 1 ? sorted[0] : sorted[idx + 1];
    navigateToSession(next);
  }

  function navNextIdle() {
    const sorted = getSortedSessionList();
    if (sorted.length === 0) return;
    const idx = sorted.findIndex(s => String(s.num) === currentSession);
    // Search forward from current position, wrapping around
    for (let i = 1; i <= sorted.length; i++) {
      const candidate = sorted[(idx + i) % sorted.length];
      if (candidate.state === 'idle') { navigateToSession(candidate); return; }
    }
  }

  function navNextDesig() {
    const curDesig = designations[currentSession] || '';
    const sorted = getSortedSessionList();
    if (sorted.length === 0) return;
    const idx = sorted.findIndex(s => String(s.num) === currentSession);
    for (let i = 1; i <= sorted.length; i++) {
      const candidate = sorted[(idx + i) % sorted.length];
      const candDesig = designations[candidate.num] || '';
      if (candDesig === curDesig && String(candidate.num) !== currentSession) {
        navigateToSession(candidate);
        return;
      }
    }
  }

  function updateNavIdleButton() {
    const btn = document.getElementById('nav-next-idle');
    const hasIdle = fleetData.some(s => s.state === 'idle' && String(s.num) !== currentSession);
    btn.disabled = !hasIdle;
  }

  function updateNavDesigButton() {
    const btn = document.getElementById('nav-next-desig');
    const curDesig = designations[currentSession] || '';
    const label = curDesig || 'Unassigned';
    btn.textContent = 'Next ' + label;
    if (curDesig) {
      const dc = getDesigColor(curDesig);
      btn.style.color = dc.fg;
    } else {
      btn.style.color = '';
    }
    const hasSibling = fleetData.some(s => String(s.num) !== currentSession && (designations[s.num] || '') === curDesig);
    btn.disabled = !hasSibling;
  }

  function updateMiniFleetStrip() {
    const strip = document.getElementById('mini-fleet-strip');
    if (!showFleetStrip || activeTab !== 'session-panel') { strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    const sorted = fleetData.slice().sort((a, b) => a.num - b.num);
    strip.innerHTML = '';
    sorted.forEach(s => {
      const box = document.createElement('div');
      box.className = 'mini-fleet-box';
      if (s.state === 'idle') box.classList.add('s-idle');
      else if (s.state === 'working') box.classList.add('s-working');
      else box.classList.add('s-off');
      if (String(s.num) === currentSession) box.classList.add('current');
      box.textContent = s.num;
      const desig = designations[s.num];
      if (desig) {
        const dc = getDesigColor(desig);
        box.style.borderTopColor = dc.fg;
        box.style.borderTopWidth = '2px';
      }
      if (autoSessions.has(s.num)) {
        box.style.borderBottomColor = 'var(--cyan)';
        box.style.borderBottomWidth = '2px';
      }
      if (s.state !== 'off') {
        box.addEventListener('click', () => navigateToSession(s));
      }
      strip.appendChild(box);
    });
    // Scroll current into view
    const cur = strip.querySelector('.current');
    if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function applyNavPreferences() {
    const navBar = document.getElementById('session-nav-bar');
    const strip = document.getElementById('mini-fleet-strip');
    if (activeTab === 'session-panel') {
      navBar.style.display = showNavButtons ? 'flex' : 'none';
      if (showNavButtons) { updateNavIdleButton(); updateNavDesigButton(); }
      strip.style.display = showFleetStrip ? 'flex' : 'none';
      if (showFleetStrip) updateMiniFleetStrip();
    } else {
      navBar.style.display = 'none';
      strip.style.display = 'none';
    }
  }

  // Nav button click handlers
  document.getElementById('nav-prev').addEventListener('click', navPrev);
  document.getElementById('nav-next').addEventListener('click', navNext);
  document.getElementById('nav-next-idle').addEventListener('click', navNextIdle);
  document.getElementById('nav-next-desig').addEventListener('click', navNextDesig);

  // More tab toggle handlers
  document.getElementById('toggle-nav-buttons').addEventListener('click', function() {
    showNavButtons = !showNavButtons;
    localStorage.setItem('hive_show_nav_buttons', showNavButtons);
    this.classList.toggle('on', showNavButtons);
    applyNavPreferences();
  });
  document.getElementById('toggle-fleet-strip').addEventListener('click', function() {
    showFleetStrip = !showFleetStrip;
    localStorage.setItem('hive_show_fleet_strip', showFleetStrip);
    this.classList.toggle('on', showFleetStrip);
    applyNavPreferences();
  });
  document.getElementById('toggle-task-autocomplete').addEventListener('click', function() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'taskAutoComplete:toggle' }));
  });
  document.getElementById('toggle-auto-create-sessions').addEventListener('click', function() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'autoCreateSessions:toggle' }));
  });
  // Initialize toggle button states
  document.getElementById('toggle-nav-buttons').classList.toggle('on', showNavButtons);
  document.getElementById('toggle-fleet-strip').classList.toggle('on', showFleetStrip);

  // ── Session tab switching ──────────────────────
  $$('.session-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (!tab.dataset.stab) return; // skip non-tab buttons (e.g. comments toggle)
      // Toggle pane bar when clicking Terminal tab while already on Terminal
      if (tab.dataset.stab === 'terminal' && activeSessionTab === 'terminal' && sessionPanes.length > 1) {
        togglePanesCollapsed();
        return;
      }
      activeSessionTab = tab.dataset.stab;
      $$('.session-tab').forEach(t => t.classList.toggle('active', t.dataset.stab === activeSessionTab));
      document.getElementById('session-terminal-content').classList.toggle('active', activeSessionTab === 'terminal');
      document.getElementById('session-git-content').classList.toggle('active', activeSessionTab === 'git');
      if (activeSessionTab === 'terminal' && term && fitAddon) {
        requestAnimationFrame(() => fitTerminal());
      }
      if (activeSessionTab === 'git' && currentSession && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'git:info', session: currentSession }));
      }
    });
  });

  // ── Git files sidebar toggle ─────────────────────
  document.getElementById('git-files-toggle').addEventListener('click', () => toggleGitFilesSidebar('session'));
  document.getElementById('ts-git-files-toggle').addEventListener('click', () => toggleGitFilesSidebar('ts'));
  document.querySelectorAll('.git-files-close').forEach(btn => {
    btn.addEventListener('click', () => {
      closeSidebarDiff(btn.dataset.target);
      toggleGitFilesSidebar(btn.dataset.target);
    });
  });

  // ── Git files sidebar resize drag ───────────────
  document.querySelectorAll('.git-files-resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = handle.dataset.target;
      const sidebarId = target === 'ts' ? 'ts-git-files-sidebar' : 'git-files-sidebar';
      const sidebar = document.getElementById(sidebarId);
      if (!sidebar) return;
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startW = sidebar.offsetWidth;
      function onMove(ev) {
        const newW = Math.max(120, startW + (ev.clientX - startX));
        sidebar.style.width = newW + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('gitFilesSidebarWidth', sidebar.style.width);
        // Refit terminal after resize
        if (target === 'session') { if (term && fitAddon) requestAnimationFrame(() => fitTerminal()); }
        else { requestAnimationFrame(() => fitTasksTerminal()); }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
  // Restore saved width
  const savedSidebarW = localStorage.getItem('gitFilesSidebarWidth');
  if (savedSidebarW) {
    const sb1 = document.getElementById('git-files-sidebar');
    const sb2 = document.getElementById('ts-git-files-sidebar');
    if (sb1) sb1.style.width = savedSidebarW;
    if (sb2) sb2.style.width = savedSidebarW;
  }

  // ── Tasks panes resize drag ────────────────────
  (function() {
    const handle = document.querySelector('.tasks-panes-resize');
    const listPane = document.querySelector('.tasks-list-pane');
    if (!handle || !listPane) return;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging');
      const container = listPane.parentElement;
      const startX = e.clientX;
      const startW = listPane.offsetWidth;
      function onMove(ev) {
        const maxW = container.offsetWidth * 0.6;
        const newW = Math.max(200, Math.min(maxW, startW + (ev.clientX - startX)));
        listPane.style.width = newW + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('tasksListPaneWidth', listPane.style.width);
        if (typeof fitTasksTerminal === 'function') requestAnimationFrame(() => fitTasksTerminal());
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // Restore saved width
    const savedW = localStorage.getItem('tasksListPaneWidth');
    if (savedW) listPane.style.width = savedW;
  })();

  // ── Plan sidebar toggle ─────────────────────────
  document.getElementById('plan-toggle').addEventListener('click', () => togglePlanSidebar('session'));
  document.getElementById('ts-plan-toggle').addEventListener('click', () => togglePlanSidebar('ts'));
  document.querySelectorAll('.plan-sidebar-close').forEach(btn => {
    btn.addEventListener('click', () => closePlanSidebar(btn.dataset.target));
  });

  function togglePlanSidebar(target) {
    planSidebarOpen = !planSidebarOpen;
    // Mutual exclusion: close git sidebar when opening plan
    if (planSidebarOpen && gitFilesSidebarOpen) {
      gitFilesSidebarOpen = false;
      localStorage.setItem('gitFilesSidebarOpen', false);
      applyGitFilesSidebarState(target);
      closeSidebarDiff(target);
    }
    applyPlanSidebarState(target);
    if (planSidebarOpen) {
      startPlanPolling();
    } else {
      stopPlanPolling();
    }
    // Refit terminal
    if (target === 'session') { if (term && fitAddon) requestAnimationFrame(() => fitTerminal()); }
    else { requestAnimationFrame(() => fitTasksTerminal()); }
  }

  function closePlanSidebar(target) {
    planSidebarOpen = false;
    applyPlanSidebarState(target);
    stopPlanPolling();
    // Refit terminal
    if (target === 'session') { if (term && fitAddon) requestAnimationFrame(() => fitTerminal()); }
    else { requestAnimationFrame(() => fitTasksTerminal()); }
  }

  function applyPlanSidebarState(target) {
    if (target === 'session' || target === 'both') {
      const sb = document.getElementById('plan-sidebar');
      const btn = document.getElementById('plan-toggle');
      if (sb) sb.style.display = planSidebarOpen ? '' : 'none';
      if (btn) btn.classList.toggle('active', planSidebarOpen);
    }
    if (target === 'ts' || target === 'both') {
      const sb = document.getElementById('ts-plan-sidebar');
      const btn = document.getElementById('ts-plan-toggle');
      if (sb) sb.style.display = planSidebarOpen ? '' : 'none';
      if (btn) btn.classList.toggle('active', planSidebarOpen);
    }
  }

  function getPlanPathForSession(sessionNum) {
    const ctx = sessionContexts[sessionNum];
    return ctx?.plan || null;
  }

  function updatePlanSidebar() {
    const num = currentSession || tasksSessionNum;
    const ctx = num ? (sessionContexts[num] || {}) : {};
    const planPath = ctx.plan || null;
    const planText = ctx.planText || null;
    const output = ctx.output || null;
    const hasPlan = planPath || planText;
    // Path line
    const pathEl = document.getElementById('plan-sidebar-path');
    const tsPathEl = document.getElementById('ts-plan-sidebar-path');
    if (pathEl) pathEl.textContent = planPath || '';
    if (tsPathEl) tsPathEl.textContent = planPath || '';
    // Context links
    const contextHtml = buildContextLinks(ctx);
    const ctxEl = document.getElementById('plan-sidebar-context');
    const tsCtxEl = document.getElementById('ts-plan-sidebar-context');
    if (ctxEl) ctxEl.innerHTML = contextHtml;
    if (tsCtxEl) tsCtxEl.innerHTML = contextHtml;
    // Build tabs
    const tabs = [];
    if (hasPlan) tabs.push('plan');
    if (output) tabs.push('output');
    // Render tab bar (only if multiple tabs)
    const tabsHtml = tabs.length > 1
      ? tabs.map(t => {
          const active = (contextActiveTab === t || (!contextActiveTab && t === tabs[0])) ? ' active' : '';
          const label = t === 'plan' ? 'Plan' : 'Output';
          return `<button class="plan-sidebar-tab${active}" data-ctx-tab="${t}">${label}</button>`;
        }).join('')
      : '';
    const tabsEl = document.getElementById('plan-sidebar-tabs');
    const tsTabsEl = document.getElementById('ts-plan-sidebar-tabs');
    if (tabsEl) tabsEl.innerHTML = tabsHtml;
    if (tsTabsEl) tsTabsEl.innerHTML = tabsHtml;
    // Wire tab clicks
    document.querySelectorAll('.plan-sidebar-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        contextActiveTab = btn.dataset.ctxTab;
        updatePlanSidebar();
      });
    });
    if (!planSidebarOpen) return;
    // Determine which tab to show
    const activeTab = contextActiveTab && tabs.includes(contextActiveTab) ? contextActiveTab : tabs[0];
    if (!activeTab) {
      setBodyHtml('<div class="plan-sidebar-empty">No context set.<br>Agent will populate this when work begins.</div>');
      return;
    }
    if (activeTab === 'plan') {
      if (planPath) {
        requestPlanFile();
      } else if (planText) {
        setBodyHtml(renderMarkdown(planText));
      }
    } else if (activeTab === 'output') {
      setBodyHtml(renderMarkdown(output));
    }
  }

  function renderMarkdown(text) {
    return typeof marked !== 'undefined' && marked.parse
      ? marked.parse(text)
      : text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  function setBodyHtml(html) {
    const body = document.getElementById('plan-sidebar-body');
    const tsBody = document.getElementById('ts-plan-sidebar-body');
    if (body) body.innerHTML = html;
    if (tsBody) tsBody.innerHTML = html;
  }

  function buildContextLinks(ctx) {
    const links = [];
    if (ctx.pr) {
      const prMatch = ctx.pr.match(/\/pull\/(\d+)/);
      const label = prMatch ? `PR #${prMatch[1]}` : 'PR';
      links.push(`<a href="${esc(ctx.pr)}" target="_blank">${label}</a>`);
    }
    if (ctx.jira) {
      const jiraBase = 'https://mavencare.atlassian.net/browse/';
      const href = ctx.jira.startsWith('http') ? ctx.jira : jiraBase + ctx.jira;
      links.push(`<a href="${esc(href)}" target="_blank">${esc(ctx.jira)}</a>`);
    }
    if (ctx.branch) {
      links.push(`<a href="#" onclick="return false" style="color:var(--dim);cursor:default">${esc(ctx.branch)}</a>`);
    }
    return links.join('');
  }

  function requestPlanFile() {
    const num = currentSession || tasksSessionNum;
    const planPath = getPlanPathForSession(num);
    if (!planPath || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'plan:read', session: num, path: planPath }));
  }

  function renderPlanContent(msg) {
    if (!msg.path) return;
    if (msg.error || msg.content == null) {
      setBodyHtml(`<div class="plan-sidebar-empty">Could not read plan file.<br><code>${msg.error || 'File not found'}</code></div>`);
      return;
    }
    setBodyHtml(renderMarkdown(msg.content));
  }

  function startPlanPolling() {
    stopPlanPolling();
    requestPlanFile();
    planPollTimer = setInterval(requestPlanFile, 3000);
  }

  function stopPlanPolling() {
    if (planPollTimer) { clearInterval(planPollTimer); planPollTimer = null; }
  }

  // Plan sidebar resize drag
  document.querySelectorAll('.plan-sidebar-resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = handle.dataset.target;
      const sidebarId = target === 'ts' ? 'ts-plan-sidebar' : 'plan-sidebar';
      const sidebar = document.getElementById(sidebarId);
      if (!sidebar) return;
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startW = sidebar.offsetWidth;
      function onMove(ev) {
        // Plan sidebar is on the right — dragging left increases width
        const newW = Math.max(160, startW - (ev.clientX - startX));
        sidebar.style.width = newW + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem('planSidebarWidth', sidebar.style.width);
        if (target === 'session') { if (term && fitAddon) requestAnimationFrame(() => fitTerminal()); }
        else { requestAnimationFrame(() => fitTasksTerminal()); }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
  // Restore saved plan sidebar width
  const savedPlanW = localStorage.getItem('planSidebarWidth');
  if (savedPlanW) {
    const psb1 = document.getElementById('plan-sidebar');
    const psb2 = document.getElementById('ts-plan-sidebar');
    if (psb1) psb1.style.width = savedPlanW;
    if (psb2) psb2.style.width = savedPlanW;
  }

  // ── Comments drawer toggle ─────────────────────
  function closeAllCommentsDrawers() {
    document.querySelectorAll('.comments-drawer').forEach(d => d.classList.remove('open'));
  }

  function toggleCommentsDrawer(drawerId, toggleBtnId) {
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;
    const isOpen = drawer.classList.contains('open');
    closeAllCommentsDrawers();
    if (!isOpen) {
      // Populate before opening
      if (drawerId === 'session-comments-drawer' && currentSession) {
        const task = tasks.find(t => t.assignedTo === Number(currentSession));
        if (task) renderCommentPanel(task.id, 'session');
      } else if (drawerId === 'ts-comments-drawer' && commentPanelTaskId) {
        renderCommentPanel(commentPanelTaskId, 'tasks');
      }
      drawer.classList.add('open');
    }
  }

  document.getElementById('session-comments-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCommentsDrawer('session-comments-drawer', 'session-comments-toggle');
  });
  document.getElementById('ts-comments-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCommentsDrawer('ts-comments-drawer', 'ts-comments-toggle');
  });

  // Close drawer on outside click
  document.addEventListener('click', (e) => {
    if (e.target.closest('.comments-drawer') || e.target.closest('.comments-toggle-btn')) return;
    closeAllCommentsDrawers();
  });

  // ── Auto-grow textareas ────────────────────────
  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
  [msgInput, document.getElementById('task-dialog-text')].forEach(el => {
    if (!el) return;
    el.addEventListener('input', () => autoGrow(el));
  });

  // ── Key buttons + restart ───────────────────────
  $$('.key-btn').forEach(btn => {
    if (btn.classList.contains('vim-toggle')) return; // handled separately
    if (btn.dataset.consoleKey) return; // handled by console keys bar
    btn.addEventListener('click', () => {
      if (!currentSession || !ws || ws.readyState !== 1) return;
      const keysMsg = { type: 'keys', session: currentSession, keys: [btn.dataset.key] };
      if (activePane !== null) keysMsg.pane = activePane;
      ws.send(JSON.stringify(keysMsg));
    });
  });

  // ── VIM toggle ────────────────────────────────
  function updateVimToggles() {
    $$('.vim-toggle').forEach(btn => btn.classList.toggle('active', vimMode));
  }
  $$('.vim-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      vimMode = !vimMode;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'vim:toggle', enabled: vimMode }));
      updateVimToggles();
      showToast(vimMode ? 'VIM mode ON' : 'VIM mode OFF', '', 'success');
    });
  });

  function updateSessionTaskButtons() {
    const trackBtn = document.getElementById('track-btn');
    const requeueBtn = document.getElementById('session-task-requeue');
    const doneBtn = document.getElementById('session-task-done');
    const cancelBtn = document.getElementById('session-task-cancel');
    if (!currentSession) {
      trackBtn.style.display = ''; requeueBtn.style.display = 'none';
      doneBtn.style.display = 'none'; cancelBtn.style.display = 'none';
      return;
    }
    const activeTask = tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === currentSession);
    if (activeTask) {
      trackBtn.style.display = 'none';
      requeueBtn.style.display = '';
      doneBtn.style.display = '';
      cancelBtn.style.display = '';
    } else {
      trackBtn.style.display = '';
      requeueBtn.style.display = 'none';
      doneBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
    }
  }

  document.getElementById('session-task-requeue').addEventListener('click', () => {
    if (!currentSession || !ws || ws.readyState !== 1) return;
    const task = tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === currentSession);
    if (!task) return;
    openTaskConfirmDialog('requeue', task.id);
  });

  document.getElementById('session-task-done').addEventListener('click', () => {
    if (!currentSession || !ws || ws.readyState !== 1) return;
    const task = tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === currentSession);
    if (!task) return;
    ws.send(JSON.stringify({ type: 'task:complete', taskId: task.id }));
    showToast('Task Done', `Marked as done`, 'success');
  });

  document.getElementById('session-task-cancel').addEventListener('click', () => {
    if (!currentSession || !ws || ws.readyState !== 1) return;
    const task = tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === currentSession);
    if (!task) return;
    openTaskConfirmDialog('cancel', task.id);
  });

  $('#track-btn').addEventListener('click', () => {
    if (!currentSession || !ws || ws.readyState !== 1) return;
    const s = fleetData.find(x => String(x.num) === currentSession);
    const branch = s ? s.branch : '';
    const pr = s && s.pr ? s.pr.prNum : null;
    const defaultText = pr ? `Working on PR #${pr} (${branch})` : branch ? `Working on ${branch}` : `Tracking session ${currentSession}`;
    const text = prompt('Task description:', defaultText);
    if (!text) return;
    ws.send(JSON.stringify({ type: 'task:attach', text, session: Number(currentSession), meta: { pr } }));
    showToast('Tracked', `Task attached to session ${currentSession}`, 'success');
  });

  $('#restart-btn').addEventListener('click', () => {
    if (!currentSession || !ws || ws.readyState !== 1) return;
    if (!confirm(`Restart Claude in session ${currentSession}?`)) return;
    ws.send(JSON.stringify({ type: 'restart', session: currentSession }));
    showToast('Restarting', `Session ${currentSession}`, 'success');
  });

  function handleStartClaude(btn, sessionNum) {
    if (!ws || ws.readyState !== 1) return;
    btn.disabled = true;
    btn.textContent = 'Starting...';
    ws.send(JSON.stringify({ type: 'restart', session: String(sessionNum) }));
    showToast('Starting Claude', `Session ${sessionNum}`, 'success');
  }
  document.getElementById('session-off-start').addEventListener('click', () => {
    handleStartClaude(document.getElementById('session-off-start'), currentSession);
  });
  document.getElementById('ts-off-start').addEventListener('click', () => {
    handleStartClaude(document.getElementById('ts-off-start'), tasksSessionNum);
  });

  $('#kill-btn').addEventListener('click', () => {
    if (!currentSession || !ws || ws.readyState !== 1) return;
    if (!confirm(`Kill session ${currentSession}? This will destroy the tmux session.`)) return;
    ws.send(JSON.stringify({ type: 'kill', session: currentSession }));
    showToast('Closing', `Session ${currentSession}`, 'success');
  });

  // ── Command buttons ────────────────────────────
  var cmdBar = null;
  function renderCommands(commands) {
    if (!cmdBar) cmdBar = document.getElementById('cmd-bar');
    if (!cmdBar) return;
    cmdBar.innerHTML = '';
    for (const cmd of commands) {
      const btn = document.createElement('button'); btn.className = 'cmd-btn'; btn.textContent = '/' + cmd.name;
      if (cmd.description) btn.setAttribute('data-tooltip', cmd.description);
      btn.addEventListener('click', () => {
        if (!currentSession || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'tell', session: currentSession, message: '/' + cmd.name }));
        showToast('Command sent', `/${cmd.name} → session ${currentSession}`, 'success');
      });
      cmdBar.appendChild(btn);
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (term && fitAddon && activeTab === 'session-panel' && activeSessionTab === 'terminal') {
      fitTerminal();
      // Debounce: resize tmux pane to match after user stops resizing
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (ws && ws.readyState === 1 && currentSession && term) {
          ws.send(JSON.stringify({ type: 'terminal:resize', session: currentSession, cols: term.cols, rows: term.rows }));
        }
      }, 300);
    }
    if (tasksSessionFit && activeTab === 'tasks-panel') fitTasksTerminal();
    if (consoleFit && consoleOpen) consoleFit.fit();
  });

  // ── Input bar ─────────────────────────────────────
  modeToggle.addEventListener('click', () => {
    mode = mode === 'ask' ? 'tell' : 'ask';
    modeToggle.textContent = mode === 'ask' ? 'Ask' : 'Tell';
    modeToggle.className = mode === 'tell' ? 'tell' : '';
  });

  var lastSentMessage = '';
  function sendMessage() {
    const text = msgInput.value.trim();
    const hasImages = attachedImages.length > 0;
    if (!text && !hasImages) return;
    if (!currentSession) { showToast('Error', 'No session selected', 'error'); return; }
    if (!ws || ws.readyState !== 1) { showToast('Error', 'Not connected to server', 'error'); return; }
    let message = text;
    if (hasImages) {
      const paths = attachedImages.map(i => i.path).join(', ');
      const prefix = `[Attached images: ${paths}]`;
      message = text ? `${prefix}\n\n${text}` : `${prefix}\n\nLook at the attached screenshot.`;
      clearAttachments(attachedImages, attachmentStrip);
    }
    lastSentMessage = message;
    // If on a non-Claude pane, always send as tell with pane index (shell command)
    const isShellPane = (activePane !== null && activePane !== claudePaneIdx);
    if (isShellPane) {
      ws.send(JSON.stringify({ type: 'tell', session: currentSession, message, pane: activePane }));
    } else if (mode === 'ask') {
      ws.send(JSON.stringify({ type: 'ask', session: currentSession, message }));
    }
    else { ws.send(JSON.stringify({ type: 'tell', session: currentSession, message })); }
    pushMsgHistory(currentSession, text);
    msgHistoryIdx = -1;
    msgHistoryDraft = '';
    msgInput.value = '';
    msgInput.style.height = 'auto';
    updateSessionStatusLine();
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
    if (!currentSession) return;
    const h = msgHistory[currentSession] || [];
    if (e.key === 'ArrowUp') {
      // Only trigger history when cursor is on the first line
      if (msgInput.value.lastIndexOf('\n', msgInput.selectionStart - 1) !== -1) return;
      if (!h.length) return;
      e.preventDefault();
      if (msgHistoryIdx === -1) msgHistoryDraft = msgInput.value;
      if (msgHistoryIdx < h.length - 1) msgHistoryIdx++;
      msgInput.value = h[h.length - 1 - msgHistoryIdx];
    } else if (e.key === 'ArrowDown') {
      // Only trigger history when cursor is on the last line
      if (msgInput.value.indexOf('\n', msgInput.selectionStart) !== -1) return;
      if (msgHistoryIdx <= -1) return;
      e.preventDefault();
      msgHistoryIdx--;
      msgInput.value = msgHistoryIdx === -1 ? msgHistoryDraft : h[h.length - 1 - msgHistoryIdx];
    }
  });

  // ── Quick send from grid (multi-select) ──────────
  function selectQuickSession(num) {
    const key = String(num);
    if (quickSessions.has(key)) {
      quickSessions.delete(key);
    } else {
      quickSessions.add(key);
    }
    updateQuickBar();
    quickInput.focus();
  }

  // In Live view: click a card terminal to exclusively target that session
  function focusCardSession(num) {
    quickSessions.clear();
    quickSessions.add(String(num));
    updateQuickBar();
    // Highlight just this card
    grid.querySelectorAll('.card').forEach(c => c.classList.remove('card-focused'));
    const card = grid.querySelector(`.card[data-session="${num}"]`);
    if (card) card.classList.add('card-focused');
    quickInput.focus();
  }

  function updateQuickBar() {
    const count = quickSessions.size;
    quickAllBtn.classList.toggle('active', count > 0 && count === fleetData.length);
    if (count === 0) {
      quickTarget.textContent = '-'; quickTarget.classList.add('empty');
      quickInput.disabled = true; quickSendEl.disabled = true;
      quickInput.placeholder = 'Click session numbers to select...';
    } else {
      const nums = [...quickSessions].sort((a, b) => Number(a) - Number(b));
      quickTarget.textContent = count === 1 ? nums[0] : count; quickTarget.classList.remove('empty');
      quickInput.disabled = false; quickSendEl.disabled = false;
      quickInput.placeholder = count === 1 ? `Message session ${nums[0]}...` : `Broadcast to ${count} sessions (${nums.join(', ')})...`;
    }
    highlightQuickCard();
    msgHistoryIdx = -1; msgHistoryDraft = '';
    const historyKey = quickSessions.size === 1 ? [...quickSessions][0] : null;
    updateHistoryPill('quick-history-wrap', historyKey);
  }

  function highlightQuickCard() {
    grid.querySelectorAll('.card, .fleet-row').forEach(c => c.style.outline = '');
    for (const num of quickSessions) {
      const sel = grid.querySelector(`[data-session="${num}"]`);
      if (sel) sel.style.outline = '2px solid var(--purple)';
    }
  }

  quickTarget.addEventListener('click', () => {
    quickSessions.clear();
    updateQuickBar();
    quickInput.value = '';
    grid.querySelectorAll('.card, .fleet-row').forEach(c => c.style.outline = '');
    grid.querySelectorAll('.card-focused').forEach(c => c.classList.remove('card-focused'));
  });

  quickAllBtn.addEventListener('click', () => {
    if (quickSessions.size === fleetData.length) {
      quickSessions.clear();
    } else {
      quickSessions = new Set(fleetData.map(s => String(s.num)));
    }
    updateQuickBar();
    quickInput.focus();
  });

  quickMode.addEventListener('click', () => {
    quickSendMode = quickSendMode === 'tell' ? 'ask' : 'tell';
    quickMode.textContent = quickSendMode === 'tell' ? 'Tell' : 'Ask';
    quickMode.className = quickSendMode === 'ask' ? 'ask' : '';
  });

  function pushMsgHistory(session, text) {
    if (!text) return;
    if (!msgHistory[session]) msgHistory[session] = [];
    const h = msgHistory[session];
    if (h.length && h[h.length - 1] === text) return;
    h.push(text);
    if (h.length > MSG_HISTORY_MAX) h.shift();
    localStorage.setItem('hive_msg_history', JSON.stringify(msgHistory));
  }

  function updateHistoryPill(wrapId, session) {
    const wrap = document.getElementById(wrapId);
    const has = session && msgHistory[session] && msgHistory[session].length;
    wrap.style.display = has ? '' : 'none';
  }

  function toggleHistoryPopup(popupId, session, inputEl) {
    const popup = document.getElementById(popupId);
    if (popup.classList.contains('open')) { popup.classList.remove('open'); return; }
    // Close any other open popups
    document.querySelectorAll('.history-popup.open').forEach(p => p.classList.remove('open'));
    const h = (session && msgHistory[session]) || [];
    if (!h.length) return;
    const items = h.slice().reverse(); // newest first
    popup.innerHTML = items.map(m =>
      `<button class="history-popup-item" title="${esc(m)}">${esc(m)}</button>`
    ).join('');
    popup.querySelectorAll('.history-popup-item').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        inputEl.value = items[i];
        inputEl.focus();
        popup.classList.remove('open');
      });
    });
    popup.classList.add('open');
  }

  function quickSendMessage() {
    const text = quickInput.value.trim();
    if (!text || !quickSessions.size || !ws || ws.readyState !== 1) return;
    const nums = [...quickSessions];
    for (const session of nums) {
      if (quickSendMode === 'ask') { ws.send(JSON.stringify({ type: 'ask', session, message: text })); }
      else { ws.send(JSON.stringify({ type: 'tell', session, message: text })); }
      pushMsgHistory(session, text);
    }
    if (nums.length === 1) {
      showToast(quickSendMode === 'ask' ? 'Ask sent' : 'Sent', `Session ${nums[0]}`, 'success');
    } else {
      showToast(quickSendMode === 'ask' ? 'Ask broadcast' : 'Broadcast', `Sent to ${nums.length} sessions`, 'success');
    }
    msgHistoryIdx = -1;
    msgHistoryDraft = '';
    quickInput.value = '';
    const historyKey = quickSessions.size === 1 ? [...quickSessions][0] : null;
    updateHistoryPill('quick-history-wrap', historyKey);
  }

  quickSendEl.addEventListener('click', quickSendMessage);
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { quickSendMessage(); return; }
    if (quickSessions.size !== 1) return;
    const session = [...quickSessions][0];
    const h = msgHistory[session] || [];
    if (e.key === 'ArrowUp') {
      if (!h.length) return;
      e.preventDefault();
      if (msgHistoryIdx === -1) msgHistoryDraft = quickInput.value;
      if (msgHistoryIdx < h.length - 1) msgHistoryIdx++;
      quickInput.value = h[h.length - 1 - msgHistoryIdx];
    } else if (e.key === 'ArrowDown') {
      if (msgHistoryIdx <= -1) return;
      e.preventDefault();
      msgHistoryIdx--;
      quickInput.value = msgHistoryIdx === -1 ? msgHistoryDraft : h[h.length - 1 - msgHistoryIdx];
    }
  });

  document.getElementById('quick-history-btn').addEventListener('click', () => {
    const historyKey = quickSessions.size === 1 ? [...quickSessions][0] : null;
    toggleHistoryPopup('quick-history-popup', historyKey, quickInput);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.history-pill-wrap')) {
      document.querySelectorAll('.history-popup.open').forEach(p => p.classList.remove('open'));
    }
  });

  // ── Tasks panel ───────────────────────────────────
  $$('.tasks-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTaskTab = tab.dataset.tab;
      selectedTaskIds.clear();
      tasksSelectedTaskId = null;
      taskStatusFilter = null; // reset sub-filter on tab switch
      // Reset dropdown label and active state
      document.getElementById('ip-tab-label').textContent = 'In Progress';
      document.querySelectorAll('.ip-status-option').forEach(b => b.classList.toggle('active', b.dataset.status === ''));
      document.getElementById('ip-status-dropdown').classList.remove('open');
      $$('.tasks-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTaskTab));
      // Close live session when switching to queued/snoozed tab
      if (activeTaskTab === 'queued') {
        closeTaskSession();
        showTasksEmptyState('Select an in-progress task to view its session');
      } else if (activeTaskTab === 'snoozed') {
        closeTaskSession();
        showTasksEmptyState('Snoozed tasks will return to queue when their timer expires');
      } else if (activeTaskTab === 'completed') {
        closeTaskSession();
        showTasksEmptyState('Click a completed task to view its snapshot');
      }
      renderTasks();
    });
  });

  // ── In Progress status dropdown ────────
  const ipTabBtn = document.getElementById('ip-tab-btn');
  const ipTabLabel = document.getElementById('ip-tab-label');
  const ipTabCaret = document.getElementById('ip-tab-caret');
  const ipDropdown = document.getElementById('ip-status-dropdown');
  // Clicking the caret toggles the dropdown
  ipTabCaret.addEventListener('click', (e) => {
    e.stopPropagation();
    // If not on inprogress tab, switch to it first
    if (activeTaskTab !== 'inprogress') {
      activeTaskTab = 'inprogress';
      taskStatusFilter = null;
      $$('.tasks-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTaskTab));
      renderTasks();
    }
    ipDropdown.classList.toggle('open');
  });
  // Clicking the label area resets to All (if already on tab) or switches to tab
  ipTabBtn.addEventListener('click', (e) => {
    // If caret was clicked, it already handled it
    if (e.target === ipTabCaret || e.target.closest('.ip-tab-caret')) return;
    ipDropdown.classList.remove('open');
    if (activeTaskTab === 'inprogress' && taskStatusFilter) {
      // Reset to All
      e.stopPropagation();
      taskStatusFilter = null;
      document.querySelectorAll('.ip-status-option').forEach(b => b.classList.toggle('active', b.dataset.status === ''));
      ipTabLabel.textContent = 'In Progress';
      renderTasks();
    }
    // Otherwise the .tasks-tab handler switches to the tab normally
  });
  document.querySelectorAll('.ip-status-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      taskStatusFilter = btn.dataset.status || null;
      document.querySelectorAll('.ip-status-option').forEach(b =>
        b.classList.toggle('active', b.dataset.status === (taskStatusFilter || '')));
      ipDropdown.classList.remove('open');
      // Update tab label
      ipTabLabel.textContent = taskStatusFilter ? (taskStatusFilter.charAt(0).toUpperCase() + taskStatusFilter.slice(1)) : 'In Progress';
      renderTasks();
    });
  });
  // Close dropdown on outside click
  document.addEventListener('click', () => ipDropdown.classList.remove('open'));

  // ── Task search ─────────────────────────────────
  const taskSearchInput = document.getElementById('tasks-search-input');
  const taskSearchClear = document.getElementById('tasks-search-clear');

  taskSearchInput.addEventListener('input', () => {
    taskSearchQuery = taskSearchInput.value.trim();
    taskSearchClear.style.display = taskSearchQuery ? '' : 'none';
    renderTasks();
  });
  taskSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { taskSearchInput.value = ''; taskSearchQuery = ''; taskSearchClear.style.display = 'none'; renderTasks(); }
  });
  taskSearchClear.addEventListener('click', () => {
    taskSearchInput.value = ''; taskSearchQuery = ''; taskSearchClear.style.display = 'none'; renderTasks();
  });

  // ── Task dialog (create/edit) ────────────────────
  const taskDialog = document.getElementById('task-dialog');
  const taskDialogPicker = document.getElementById('task-dialog-picker');

  document.getElementById('tasks-create-btn').addEventListener('click', () => openTaskDialog(null));

  document.getElementById('task-dialog-auto-btn').addEventListener('click', () => {
    taskMode = 'auto'; manualTarget = null;
    document.getElementById('task-dialog-auto-btn').classList.add('selected');
    document.getElementById('task-dialog-manual-btn').classList.remove('selected');
    document.getElementById('task-dialog-require-human-close').checked = false;
    taskDialogPicker.classList.remove('visible');
  });
  document.getElementById('task-dialog-manual-btn').addEventListener('click', () => {
    taskMode = 'manual';
    document.getElementById('task-dialog-manual-btn').classList.add('selected');
    document.getElementById('task-dialog-auto-btn').classList.remove('selected');
    document.getElementById('task-dialog-require-human-close').checked = true;
    taskDialogPicker.classList.add('visible');
    renderDialogSessionPicker();
  });

  function renderDialogSessionPicker() {
    taskDialogPicker.innerHTML = '';
    const sessions = fleetData;
    for (const s of sessions) {
      const activeTask = tasks.find(t => t.assignedTo === s.num && (t.status === 'dispatched' || t.status === 'queued'));
      const busy = s.state !== 'idle' || !!activeTask;
      const btn = document.createElement('button');
      btn.className = `picker-btn${manualTarget === s.num ? ' selected' : ''}${busy ? ' disabled' : ''}`;
      btn.textContent = s.num;
      if (busy) {
        btn.title = activeTask ? `Busy: ${activeTask.text}` : `State: ${s.state}`;
      } else {
        btn.addEventListener('click', () => { manualTarget = s.num; taskDialogPicker.querySelectorAll('.picker-btn').forEach(b => b.classList.remove('selected')); btn.classList.add('selected'); });
      }
      taskDialogPicker.appendChild(btn);
    }
    if (!sessions.length) taskDialogPicker.innerHTML = '<span style="color:var(--dim);font-size:12px;padding:8px">No sessions available</span>';
  }

  function openTaskDialog(taskId) {
    editingTaskId = taskId;
    const textEl = document.getElementById('task-dialog-text');
    const desigEl = document.getElementById('task-dialog-designation');
    const titleEl = document.getElementById('task-dialog-title');
    const saveBtn = document.getElementById('task-dialog-save');

    if (taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      titleEl.textContent = 'Edit Task';
      saveBtn.textContent = 'Save';
      textEl.value = task.text;
      desigEl.value = task.designation || '';
      taskMode = task.mode || 'auto';
      manualTarget = task.targetSession || null;
      document.getElementById('task-dialog-require-human-close').checked = !!task.requireHumanClose;
    } else {
      titleEl.textContent = 'Create Task';
      saveBtn.textContent = 'Create';
      textEl.value = '';
      desigEl.value = '';
      taskMode = 'auto';
      manualTarget = null;
      document.getElementById('task-dialog-require-human-close').checked = true; // manual default
    }
    document.getElementById('task-dialog-auto-btn').classList.toggle('selected', taskMode === 'auto');
    document.getElementById('task-dialog-manual-btn').classList.toggle('selected', taskMode === 'manual');
    taskDialogPicker.classList.toggle('visible', taskMode === 'manual');
    if (taskMode === 'manual') renderDialogSessionPicker();
    taskDialog.classList.add('visible');
    textEl.focus();
  }

  document.getElementById('task-dialog-save').addEventListener('click', () => {
    const text = document.getElementById('task-dialog-text').value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    if (taskMode === 'manual' && !manualTarget) { showToast('Select session', 'Tap an idle session number', 'error'); return; }
    const desig = document.getElementById('task-dialog-designation').value || undefined;

    const requireHumanClose = document.getElementById('task-dialog-require-human-close').checked;
    if (editingTaskId) {
      ws.send(JSON.stringify({ type: 'task:update', taskId: editingTaskId, updates: { text, mode: taskMode, targetSession: taskMode === 'manual' ? manualTarget : null, designation: desig || null, requireHumanClose } }));
      showToast('Task updated', text.substring(0, 40), 'success');
    } else {
      ws.send(JSON.stringify({ type: 'task:create', text, mode: taskMode, targetSession: taskMode === 'manual' ? manualTarget : undefined, designation: desig, requireHumanClose }));
      showToast('Task created', text.substring(0, 40), 'success');
    }
    taskDialog.classList.remove('visible');
    editingTaskId = null;
  });
  document.getElementById('task-dialog-cancel').addEventListener('click', () => { taskDialog.classList.remove('visible'); editingTaskId = null; });
  document.getElementById('task-dialog-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.getElementById('task-dialog-save').click(); }
  });

  // ── Assign dialog ──────────────────────────────────
  let assigningTaskId = null;
  const assignDialog = document.getElementById('assign-dialog');
  const assignSessionSel = document.getElementById('assign-dialog-session');

  function openAssignDialog(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    assigningTaskId = taskId;
    document.getElementById('assign-dialog-task').textContent = task.text;
    // Populate dropdown: idle sessions with no active task
    const activeTaskSessions = new Set(tasks.filter(t => t.status === 'dispatched').map(t => t.assignedTo));
    const available = fleetData.filter(s => s.state === 'idle' && !activeTaskSessions.has(s.num)).sort((a, b) => a.num - b.num);
    assignSessionSel.innerHTML = '';
    if (!available.length) {
      assignSessionSel.innerHTML = '<option value="">No available sessions</option>';
    } else {
      for (const s of available) {
        assignSessionSel.innerHTML += `<option value="${s.num}">S:${s.num} — ${s.branch ? esc(shortBranch(s.branch)) : 'master'}</option>`;
      }
    }
    assignDialog.classList.add('visible');
  }

  document.getElementById('assign-dialog-submit').addEventListener('click', () => {
    const sessionNum = parseInt(assignSessionSel.value);
    if (!sessionNum || !assigningTaskId || !ws || ws.readyState !== 1) {
      showToast('No session', 'Select an available session', 'error');
      return;
    }
    ws.send(JSON.stringify({ type: 'task:dispatch', taskId: assigningTaskId, session: sessionNum }));
    showToast('Assigning', `Dispatching to session ${sessionNum}`, 'success');
    assignDialog.classList.remove('visible');
    assigningTaskId = null;
  });

  document.getElementById('assign-dialog-cancel').addEventListener('click', () => {
    assignDialog.classList.remove('visible');
    assigningTaskId = null;
  });

  // ── Tasks session pane ─────────────────────────────
  function ensureTasksSessionTerm() {
    const container = document.getElementById('tasks-session-terminal');
    if (tasksSessionTerm) return;
    container.innerHTML = '';
    tasksSessionTerm = new Terminal({
      theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
      fontSize: tsFontSize, fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      disableStdin: true, scrollback: 5000, convertEol: true, allowProposedApi: true,
    });
    tasksSessionFit = new FitAddon.FitAddon();
    tasksSessionTerm.loadAddon(tasksSessionFit);
    tasksSessionTerm.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
    enableTerminalCopy(tasksSessionTerm);
    tasksSessionTerm.open(container);
    // Wire scroll-pause detection
    tasksSessionTerm.element.addEventListener('wheel', () => { setTimeout(tsCheckScroll, 50); });
    let tsTouchStartY = 0;
    tasksSessionTerm.element.addEventListener('touchstart', (e) => { tsTouchStartY = e.touches[0].clientY; }, { passive: true });
    tasksSessionTerm.element.addEventListener('touchend', (e) => { const dy = tsTouchStartY - (e.changedTouches[0] || {}).clientY; if (Math.abs(dy) > 20) { setTimeout(tsCheckScroll, 150); setTimeout(tsCheckScroll, 500); } });
    requestAnimationFrame(() => fitTasksTerminal());
  }

  var tsWriting = false;
  function tsCheckScroll() {
    if (!tasksSessionTerm || tsWriting) return;
    const buf = tasksSessionTerm.buffer.active;
    const linesFromBottom = buf.baseY - buf.viewportY;
    if (linesFromBottom <= 3 && tsUserScrolledUp) {
      tsUserScrolledUp = false; tsScrollIndicator(false);
      if (tsPendingContent !== null) { writeTasksSessionContent(tsPendingContent); tsPendingContent = null; }
    } else if (linesFromBottom > 3) { tsUserScrolledUp = true; tsScrollIndicator(true); }
  }

  function tsScrollIndicator(show) {
    const container = document.getElementById('tasks-session-terminal');
    let el = container.querySelector('.ts-scroll-pause');
    if (show && !el) {
      el = document.createElement('div'); el.className = 'ts-scroll-pause';
      el.setAttribute('data-tooltip', 'Scroll to bottom');
      el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      el.addEventListener('click', () => { tsUserScrolledUp = false; tsScrollIndicator(false); if (tasksSessionTerm) tasksSessionTerm.scrollToBottom(); if (tsPendingContent !== null) { writeTasksSessionContent(tsPendingContent); tsPendingContent = null; } });
      container.appendChild(el);
    } else if (!show && el) { el.remove(); }
  }

  var _tsWriteRAF = null;
  function writeTasksSessionContent(content) {
    ensureTasksSessionTerm();
    tsLastContent = content; tsWriting = true;
    if (_tsWriteRAF) cancelAnimationFrame(_tsWriteRAF);
    _tsWriteRAF = requestAnimationFrame(() => {
      _tsWriteRAF = null;
      tasksSessionTerm.reset();
      tasksSessionTerm.write(content, () => {
        tasksSessionTerm.scrollToBottom();
        tsWriting = false;
      });
    });
  }

  function renderTsCmdBar() {
    const bar = document.getElementById('ts-cmd-bar');
    bar.innerHTML = '';
    for (const cmd of tsCommands) {
      const btn = document.createElement('button'); btn.className = 'cmd-btn'; btn.textContent = '/' + cmd.name;
      if (cmd.description) btn.setAttribute('data-tooltip', cmd.description);
      btn.addEventListener('click', () => {
        if (!tasksSessionNum || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'tell', session: tasksSessionNum, message: '/' + cmd.name }));
        showToast('Command sent', `/${cmd.name} → session ${tasksSessionNum}`, 'success');
      });
      bar.appendChild(btn);
    }
  }

  function showTsSessionControls(interactive) {
    const termContent = document.getElementById('ts-terminal-content');
    const keysBar = document.getElementById('tasks-session-keys');
    const cmdBar = document.getElementById('ts-cmd-bar');
    const inputBar = document.getElementById('tasks-session-input');
    const tabs = document.getElementById('tasks-session-tabs');
    const openBtn = document.getElementById('ts-open-session');

    termContent.style.display = '';
    termContent.classList.add('active');
    document.getElementById('tasks-session-empty').style.display = 'none';
    document.getElementById('tasks-session-header').style.display = '';

    // Checklist/actions bar is always visible when a task is selected
    updateChecklistButtons();
    updateActionsButton();

    // Always show tabs (checklist tab needs it); hide interactive-only controls
    tabs.style.display = '';
    if (interactive) {
      keysBar.style.display = '';
      cmdBar.style.display = '';
      inputBar.style.display = '';
      openBtn.style.display = '';
      renderTsCmdBar();
    } else {
      keysBar.style.display = 'none';
      cmdBar.style.display = 'none';
      inputBar.style.display = 'none';
      openBtn.style.display = 'none';
    }
    // Reset to terminal tab
    tsActiveTab = 'terminal';
    document.querySelectorAll('[data-tstab]').forEach(t => t.classList.toggle('active', t.dataset.tstab === 'terminal'));
    termContent.classList.add('active');
    document.getElementById('ts-git-content').style.display = 'none';
    document.getElementById('ts-git-content').classList.remove('active');
    closeAllCommentsDrawers();
  }

  function openTaskSession(sessionNum) {
    const sameSession = tasksSessionNum === String(sessionNum);
    // Unsubscribe from previous (even if same — forces re-subscribe for fresh data)
    if (tasksSessionNum && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe' }));
    }
    tasksSessionNum = String(sessionNum);
    if (!sameSession) {
      tsPaneCols = 0; // reset until we get pane width from server
      tsUserScrolledUp = false; tsPendingContent = null; tsLastContent = '';
      tsActivePane = null; tsSessionPanes = []; tsClaudePaneIdx = null;
      renderPaneTabs('ts');
      ensureTasksSessionTerm();
    }

    // Update header
    const session = fleetData.find(s => s.num === sessionNum);
    document.getElementById('tasks-session-title').textContent = `Session ${sessionNum}`;
    document.getElementById('tasks-session-branch').textContent = session ? `— ${shortBranch(session.branch)}` : '';

    updateOffBanners();

    // Wire open button
    document.getElementById('ts-open-session').onclick = () => {
      const s = fleetData.find(x => x.num === sessionNum);
      if (s) openSession(s);
    };

    // Clear snapshot styling
    document.getElementById('snapshot-banner').classList.remove('visible');
    document.getElementById('snapshot-banner').textContent = '';
    document.querySelector('.tasks-session-terminal').classList.remove('snapshot-dimmed');

    showTsSessionControls(true);
    updateTasksStatusLine();
    updateChecklistButtons();
    updateActionsButton();

    // Subscribe after fit so content arrives into a properly-sized terminal
    requestAnimationFrame(() => {
      fitTasksTerminal();
      const subscribeTasks = () => {
        if (!ws || ws.readyState !== 1 || !tasksSessionNum) return;
        const subMsg = { type: 'terminal:subscribe', session: tasksSessionNum };
        if (sameSession && tsActivePane !== null) subMsg.pane = tsActivePane;
        ws.send(JSON.stringify(subMsg));
        ws.send(JSON.stringify({ type: 'terminal:panes', session: tasksSessionNum }));
        ws.send(JSON.stringify({ type: 'git:info', session: tasksSessionNum }));
      };
      if (isAlive(subscribeTasks)) {
        subscribeTasks();
      }
    });
    msgHistoryIdx = -1; msgHistoryDraft = '';
    updateTasksStatusLine();
    applyGitFilesSidebarState('ts');
    updatePlanSidebar();
    if (planSidebarOpen) startPlanPolling();
    requestAnimationFrame(() => fitTasksTerminal());
    setTimeout(() => { const el = document.getElementById('tasks-session-terminal'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, 100);
  }

  function closeTaskSession() {
    if (tasksSessionNum && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe' }));
    }
    tasksSessionNum = null;
    tsUserScrolledUp = false; tsPendingContent = null; tsLastContent = '';
    tsActivePane = null; tsSessionPanes = []; tsClaudePaneIdx = null;
    renderPaneTabs('ts');
    updateInputForPane(true, 'ts');
    updateTasksStatusLine();
    msgHistoryIdx = -1; msgHistoryDraft = '';
    updateTasksStatusLine();
  }

  function showTasksEmptyState(message) {
    const emptyEl = document.getElementById('tasks-session-empty');
    emptyEl.textContent = message;
    emptyEl.style.display = '';
    document.getElementById('ts-terminal-content').style.display = 'none';
    document.getElementById('ts-git-content').style.display = 'none';
    document.getElementById('tasks-session-keys').style.display = 'none';
    document.getElementById('ts-cmd-bar').style.display = 'none';
    document.getElementById('tasks-session-input').style.display = 'none';
    document.getElementById('tasks-session-tabs').style.display = 'none';
    document.getElementById('ts-open-session').style.display = 'none';
    document.getElementById('ts-checklist-tab').style.display = 'none';
    document.getElementById('ts-actions-tab').style.display = 'none';
    closeActionsPopup();
  }

  function showTaskSnapshot(taskId) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'task:snapshot', taskId }));
    ensureTasksSessionTerm();
    const task = tasks.find(t => t.id === taskId);
    const completedAgo = task && task.completedAt ? ` \u00b7 ${timeAgo(task.completedAt)}` : '';
    document.getElementById('tasks-session-title').textContent = task
      ? `Snapshot \u2014 Session ${task.assignedTo || '?'}${completedAgo}`
      : 'Completed';
    document.getElementById('tasks-session-branch').textContent = '';
    document.getElementById('tasks-session-header').style.display = '';
    // Show snapshot banner
    const banner = document.getElementById('snapshot-banner');
    if (task && task.snapshot) {
      banner.textContent = 'This is a saved snapshot \u2014 the session may have moved on';
      banner.classList.add('visible');
    } else {
      banner.classList.remove('visible');
      banner.textContent = '';
    }
    document.querySelector('.tasks-session-terminal').classList.add('snapshot-dimmed');
    showTsSessionControls(false); // read-only
    // Unsubscribe from live session
    if (tasksSessionNum && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe' }));
    }
    tasksSessionNum = null;
    updatePlanSidebar();
    requestAnimationFrame(() => fitTasksTerminal());
  }

  function showTaskSnapshotContent(taskId, content, cols) {
    ensureTasksSessionTerm();
    if (!content) {
      tasksSessionTerm.reset();
      tasksSessionTerm.write('\r\n  No snapshot saved for this task\r\n');
      return;
    }
    if (cols && cols > 0) { tsPaneCols = cols; if (cols !== tasksSessionTerm.cols) tasksSessionTerm.resize(cols, tasksSessionTerm.rows); }
    tasksSessionTerm.reset();
    tasksSessionTerm.write(content);
    requestAnimationFrame(() => tasksSessionTerm.scrollToBottom());
  }

  // ── Tasks session tab switching ──────────────────
  document.querySelectorAll('[data-tstab]').forEach(tab => {
    tab.addEventListener('click', () => {
      // Toggle pane bar when clicking Terminal tab while already on Terminal
      if (tab.dataset.tstab === 'terminal' && tsActiveTab === 'terminal' && tsSessionPanes.length > 1) {
        togglePanesCollapsed();
        return;
      }
      tsActiveTab = tab.dataset.tstab;
      document.querySelectorAll('[data-tstab]').forEach(t => t.classList.toggle('active', t.dataset.tstab === tsActiveTab));
      const termContent = document.getElementById('ts-terminal-content');
      const gitContent = document.getElementById('ts-git-content');
      termContent.classList.toggle('active', tsActiveTab === 'terminal');
      termContent.style.display = tsActiveTab === 'terminal' ? '' : 'none';
      gitContent.classList.toggle('active', tsActiveTab === 'git');
      gitContent.style.display = tsActiveTab === 'git' ? '' : 'none';
      // Show/hide keys + cmd + input bars (only for terminal tab)
      document.getElementById('tasks-session-keys').style.display = tsActiveTab === 'terminal' ? '' : 'none';
      document.getElementById('ts-cmd-bar').style.display = tsActiveTab === 'terminal' ? '' : 'none';
      document.getElementById('tasks-session-input').style.display = tsActiveTab === 'terminal' ? '' : 'none';
      if (tsActiveTab === 'terminal') {
        requestAnimationFrame(() => fitTasksTerminal());
      }
      if (tsActiveTab === 'git' && tasksSessionNum && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'git:info', session: tasksSessionNum }));
      }
    });
  });

  // Wire keys bar for tasks session
  document.querySelectorAll('.ts-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!tasksSessionNum || !ws || ws.readyState !== 1) return;
      const tsKeysMsg = { type: 'keys', session: tasksSessionNum, keys: [btn.dataset.key] };
      if (tsActivePane !== null) tsKeysMsg.pane = tsActivePane;
      ws.send(JSON.stringify(tsKeysMsg));
    });
  });

  // Wire mode toggle + send for tasks session
  const tsModeToggle = document.getElementById('ts-mode-toggle');
  var tsMsgInput = document.getElementById('ts-msg-input');
  const tsSendBtn = document.getElementById('ts-send-btn');
  tsMsgInput.addEventListener('input', () => autoGrow(tsMsgInput));

  // ── Image drag-drop / paste upload ───────────────────
  const attachmentStrip = document.getElementById('attachment-strip');
  const tsAttachmentStrip = document.getElementById('ts-attachment-strip');
  const attachedImages = [];
  const tsAttachedImages = [];

  async function uploadImage(file, targetArray, stripEl) {
    try {
      const res = await fetch('/upload/image', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json();
      if (data.success) {
        targetArray.push({ path: data.path, filename: data.filename, previewUrl: URL.createObjectURL(file) });
        renderAttachments(targetArray, stripEl);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    }
  }

  function renderAttachments(arr, stripEl) {
    stripEl.innerHTML = '';
    stripEl.classList.toggle('has-items', arr.length > 0);
    arr.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'attachment-thumb';
      thumb.innerHTML = `<img src="${img.previewUrl}"><span class="attachment-name">${img.filename}</span><button class="attachment-remove">\u00d7</button>`;
      thumb.querySelector('.attachment-remove').addEventListener('click', () => {
        URL.revokeObjectURL(img.previewUrl);
        arr.splice(i, 1);
        renderAttachments(arr, stripEl);
      });
      stripEl.appendChild(thumb);
    });
  }

  function clearAttachments(arr, stripEl) {
    arr.forEach(img => URL.revokeObjectURL(img.previewUrl));
    arr.length = 0;
    renderAttachments(arr, stripEl);
  }

  function handleImageFiles(files, targetArray, stripEl) {
    for (const file of files) {
      if (file.type.startsWith('image/')) uploadImage(file, targetArray, stripEl);
    }
  }

  function setupDragDrop(textarea, targetArray, stripEl) {
    textarea.addEventListener('dragover', (e) => { e.preventDefault(); textarea.classList.add('drag-over'); });
    textarea.addEventListener('dragleave', () => { textarea.classList.remove('drag-over'); });
    textarea.addEventListener('drop', (e) => {
      e.preventDefault();
      textarea.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        handleImageFiles(e.dataTransfer.files, targetArray, stripEl);
        return;
      }
      // Board card drop — look up task and insert its text
      const taskId = e.dataTransfer.getData('text/plain');
      const task = taskId && tasks.find(t => t.id === taskId);
      if (task) {
        const insert = task.text || taskId;
        textarea.value = textarea.value ? textarea.value + '\n' + insert : insert;
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
      }
    });
    textarea.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) {
        const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
        if (imageFiles.length) {
          e.preventDefault();
          handleImageFiles(imageFiles, targetArray, stripEl);
        }
      }
    });
  }

  const tdAttachmentStrip = document.getElementById('td-attachment-strip');
  const tdAttachedImages = [];
  setupDragDrop(msgInput, attachedImages, attachmentStrip);
  setupDragDrop(tsMsgInput, tsAttachedImages, tsAttachmentStrip);
  setupDragDrop(document.getElementById('task-detail-input'), tdAttachedImages, tdAttachmentStrip);

  tsModeToggle.addEventListener('click', () => {
    tasksSessionMode = tasksSessionMode === 'ask' ? 'tell' : 'ask';
    tsModeToggle.textContent = tasksSessionMode === 'ask' ? 'Ask' : 'Tell';
    tsModeToggle.classList.toggle('tell', tasksSessionMode === 'tell');
  });

  var tsLastSentMessage = '';
  var tsPendingSession = null; // track which session the tasks panel sent to

  function sendTasksMessage() {
    const text = tsMsgInput.value.trim();
    const hasImages = tsAttachedImages.length > 0;
    if ((!text && !hasImages) || !tasksSessionNum || !ws || ws.readyState !== 1) return;
    let message = text;
    if (hasImages) {
      const paths = tsAttachedImages.map(i => i.path).join(', ');
      const prefix = `[Attached images: ${paths}]`;
      message = text ? `${prefix}\n\n${text}` : `${prefix}\n\nLook at the attached screenshot.`;
      clearAttachments(tsAttachedImages, tsAttachmentStrip);
    }
    tsLastSentMessage = text;
    tsPendingSession = tasksSessionNum;
    const tsIsShellPane = (tsActivePane !== null && tsActivePane !== tsClaudePaneIdx);
    if (tsIsShellPane) {
      ws.send(JSON.stringify({ type: 'tell', session: tasksSessionNum, message, pane: tsActivePane }));
    } else {
      ws.send(JSON.stringify({ type: tasksSessionMode, session: tasksSessionNum, message }));
    }
    pushMsgHistory(tasksSessionNum, text);
    msgHistoryIdx = -1;
    msgHistoryDraft = '';
    tsMsgInput.value = '';
    tsMsgInput.style.height = 'auto';
    updateTasksStatusLine();
    showToast('Sent', `${tasksSessionMode === 'ask' ? 'Ask' : 'Tell'} → session ${tasksSessionNum}`, 'success');
  }
  tsSendBtn.addEventListener('click', sendTasksMessage);
  tsMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTasksMessage(); return; }
    if (!tasksSessionNum) return;
    const h = msgHistory[tasksSessionNum] || [];
    if (e.key === 'ArrowUp') {
      if (tsMsgInput.value.lastIndexOf('\n', tsMsgInput.selectionStart - 1) !== -1) return;
      if (!h.length) return;
      e.preventDefault();
      if (msgHistoryIdx === -1) msgHistoryDraft = tsMsgInput.value;
      if (msgHistoryIdx < h.length - 1) msgHistoryIdx++;
      tsMsgInput.value = h[h.length - 1 - msgHistoryIdx];
    } else if (e.key === 'ArrowDown') {
      if (tsMsgInput.value.indexOf('\n', tsMsgInput.selectionStart) !== -1) return;
      if (msgHistoryIdx <= -1) return;
      e.preventDefault();
      msgHistoryIdx--;
      tsMsgInput.value = msgHistoryIdx === -1 ? msgHistoryDraft : h[h.length - 1 - msgHistoryIdx];
    }
  });

  // ── Select a task by ID (for URL deep-linking) ─────
  function selectTaskById(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    // Switch to the correct task tab
    if (task.status === 'dispatched') activeTaskTab = 'inprogress';
    else if (task.status === 'queued') activeTaskTab = 'queued';
    else activeTaskTab = 'completed';
    tasksSelectedTaskId = task.id;
    $$('.tasks-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTaskTab));
    renderTasks();
    // Load session/snapshot + comments
    if (task.status === 'dispatched' && task.assignedTo) {
      openTaskSession(task.assignedTo);
    } else if (task.status === 'completed' || task.status === 'failed') {
      showTaskSnapshot(task.id);
    } else if (task.status === 'queued' && task.actions && task.actions.length) {
      // Show session panel tabs for queued tasks with actions
      document.getElementById('tasks-session-tabs').style.display = '';
      document.getElementById('tasks-session-empty').style.display = 'none';
      document.getElementById('tasks-session-title').textContent = `PR #${(task.actionContext && task.actionContext.prNumber) || ''}`;
    }
    renderCommentPanel(task.id);
    updateChecklistButtons();
    updateActionsButton();
    autoOpenActionsPopup();
    // Scroll selected card into view
    requestAnimationFrame(() => {
      const card = tasksScroll.querySelector(`.task-card[data-id="${taskId}"]`);
      if (card) card.scrollIntoView({ block: 'nearest' });
    });
    updateTsNavButtons();
  }

  function getTaskNavList() {
    return tasks.filter(t => t.status === 'dispatched');
  }

  function updateTsNavButtons() {
    const navList = getTaskNavList();
    const cur = tasksSelectedTaskId ? tasks.find(t => t.id === tasksSelectedTaskId) : null;
    const isDispatched = cur && cur.status === 'dispatched';
    const hasMultiple = navList.length > 1;
    const prevBtn = document.getElementById('ts-nav-prev');
    const nextBtn = document.getElementById('ts-nav-next');
    const requeueBtn = document.getElementById('ts-nav-requeue');
    const doneBtn = document.getElementById('ts-nav-done');
    // Show buttons only when a task session is open
    const show = !!tasksSelectedTaskId && isDispatched;
    prevBtn.style.display = show ? '' : 'none';
    nextBtn.style.display = show ? '' : 'none';
    requeueBtn.style.display = show ? '' : 'none';
    doneBtn.style.display = show ? '' : 'none';
    prevBtn.disabled = !hasMultiple;
    nextBtn.disabled = !hasMultiple;
    requeueBtn.disabled = !isDispatched;
    doneBtn.disabled = !isDispatched;
  }

  function tsNavPrev() {
    const navList = getTaskNavList();
    if (navList.length < 2) return;
    const idx = navList.findIndex(t => t.id === tasksSelectedTaskId);
    const prev = idx <= 0 ? navList[navList.length - 1] : navList[idx - 1];
    selectTaskById(prev.id);
  }

  function tsNavNext() {
    const navList = getTaskNavList();
    if (navList.length < 2) return;
    const idx = navList.findIndex(t => t.id === tasksSelectedTaskId);
    const next = idx < 0 || idx >= navList.length - 1 ? navList[0] : navList[idx + 1];
    selectTaskById(next.id);
  }

  function tsNavRequeue() {
    const cur = tasksSelectedTaskId ? tasks.find(t => t.id === tasksSelectedTaskId) : null;
    if (!cur || cur.status !== 'dispatched' || !ws || ws.readyState !== 1) return;
    openTaskConfirmDialog('requeue', cur.id);
  }

  function tsNavDone() {
    const cur = tasksSelectedTaskId ? tasks.find(t => t.id === tasksSelectedTaskId) : null;
    if (!cur || cur.status !== 'dispatched' || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'task:complete', taskId: cur.id }));
    showToast('Task Done', `Marked "${cur.title || cur.id}" as done`, 'success');
    // Auto-advance handled centrally by task:completed WS handler
  }

  // ── Source filter dropdown ───────────────────────────
  function renderFilterChips() {
    const wrap = document.getElementById('tasks-filter-wrap');
    const btn = document.getElementById('tasks-filter-btn');
    const dropdown = document.getElementById('tasks-filter-dropdown');

    const sourceCounts = new Map();
    for (const t of tasks) {
      if (t.source) sourceCounts.set(t.source, (sourceCounts.get(t.source) || 0) + 1);
    }
    if (sourceCounts.size <= 1) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    for (const src of taskSourceFilter) {
      if (!sourceCounts.has(src)) taskSourceFilter.delete(src);
    }

    // Update button label
    if (taskSourceFilter.size === 0) {
      btn.textContent = `Sources (${sourceCounts.size})`;
      btn.classList.remove('has-filter');
    } else {
      btn.textContent = `Sources (${taskSourceFilter.size}/${sourceCounts.size})`;
      btn.classList.add('has-filter');
    }

    // Build dropdown options
    let html = '';
    for (const [src, count] of [...sourceCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const label = src.replace(/^pm:/, '');
      const checked = taskSourceFilter.has(src) ? 'checked' : '';
      html += `<label class="tasks-filter-option"><input type="checkbox" data-source="${esc(src)}" ${checked}><span>${esc(label)}</span><span class="filter-count">${count}</span></label>`;
    }
    dropdown.innerHTML = html;

    dropdown.querySelectorAll('input[data-source]').forEach(cb => {
      cb.addEventListener('change', () => {
        const src = cb.dataset.source;
        if (cb.checked) taskSourceFilter.add(src);
        else taskSourceFilter.delete(src);
        renderTasks();
      });
    });
  }

  // Toggle dropdown open/close
  document.getElementById('tasks-filter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('tasks-filter-dropdown').classList.toggle('open');
  });
  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tasks-filter-wrap')) {
      document.getElementById('tasks-filter-dropdown').classList.remove('open');
    }
  });

  // ── Render tasks ───────────────────────────────────
  function renderTasks() {
    // If in board mode, render board instead
    if (tasksViewMode === 'board') { renderTaskBoard(); return; }
    // Clean up selectedTaskIds for tasks that no longer exist
    const taskIds = new Set(tasks.map(t => t.id));
    for (const id of selectedTaskIds) { if (!taskIds.has(id)) selectedTaskIds.delete(id); }

    renderFilterChips();

    const q = taskSearchQuery.toLowerCase();
    const matchesSearch = (t) => !q || t.text.toLowerCase().includes(q) || (t.source || '').toLowerCase().includes(q) || (t.designation || '').toLowerCase().includes(q) || String(t.assignedTo || '').includes(q);
    const matchesFilter = (t) => taskSourceFilter.size === 0 || taskSourceFilter.has(t.source);
    const matchesStatus = (t) => {
      if (!taskStatusFilter) return true;
      const s = fleetData.find(x => x.num === t.assignedTo);
      if (taskStatusFilter === 'working') return s && s.state === 'working';
      if (taskStatusFilter === 'waiting') return !s || s.state !== 'working';
      return true;
    };
    const allDispatched = tasks.filter(t => t.status === 'dispatched' && matchesSearch(t) && matchesFilter(t));
    const dispatched = allDispatched.filter(matchesStatus);
    const queued = tasks.filter(t => t.status === 'queued' && matchesSearch(t) && matchesFilter(t));
    const snoozed = tasks.filter(t => t.status === 'snoozed' && matchesSearch(t) && matchesFilter(t));
    const completed = tasks.filter(t => (t.status === 'completed' || t.status === 'failed') && matchesSearch(t) && matchesFilter(t));

    // Update dropdown option counts
    if (activeTaskTab === 'inprogress') {
      const waitingCount = allDispatched.filter(t => { const s = fleetData.find(x => x.num === t.assignedTo); return !s || s.state !== 'working'; }).length;
      const workingCount = allDispatched.length - waitingCount;
      document.querySelectorAll('.ip-status-option').forEach(b => {
        if (b.dataset.status === '') b.textContent = `All (${allDispatched.length})`;
        else if (b.dataset.status === 'waiting') b.textContent = `Waiting (${waitingCount})`;
        else if (b.dataset.status === 'working') b.textContent = `Working (${workingCount})`;
      });
    }

    let html = '';
    let visibleTasks = [];

    if (activeTaskTab === 'inprogress') {
      if (dispatched.length) {
        for (const t of dispatched) html += taskCardHtml(t, 'inprogress');
      } else {
        html = '<div class="feed-empty">No tasks in progress.</div>';
      }
      visibleTasks = dispatched;
    } else if (activeTaskTab === 'queued') {
      if (queued.length) {
        for (const t of queued) html += taskCardHtml(t, 'queued');
      } else {
        html = '<div class="feed-empty">No queued tasks.</div>';
      }
      visibleTasks = queued;
    } else if (activeTaskTab === 'snoozed') {
      if (snoozed.length) {
        for (const t of snoozed) html += taskCardHtml(t, 'snoozed');
      } else {
        html = '<div class="feed-empty">No snoozed tasks.</div>';
      }
      visibleTasks = snoozed;
    } else {
      if (completed.length) {
        for (const t of completed) html += taskCardHtml(t, 'completed');
      } else {
        html = '<div class="feed-empty">No completed tasks yet.</div>';
      }
      visibleTasks = completed;
    }
    tasksScroll.innerHTML = html;

    // Wire cancel buttons (via confirm dialog)
    tasksScroll.querySelectorAll('.task-cancel').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTaskConfirmDialog('cancel', btn.dataset.id);
      });
    });

    // Wire requeue buttons (via confirm dialog)
    tasksScroll.querySelectorAll('.task-requeue-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTaskConfirmDialog('requeue', btn.dataset.id);
      });
    });

    // Wire snooze buttons (via confirm dialog with duration picker)
    tasksScroll.querySelectorAll('.task-snooze-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTaskConfirmDialog('snooze', btn.dataset.id);
      });
    });

    // Wire wake buttons (snoozed tab — immediate unsnooze)
    tasksScroll.querySelectorAll('.task-wake-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:unsnooze', taskId: btn.dataset.id }));
        showToast('Woke up', 'Task returned to queue', 'success');
      });
    });

    // Wire done buttons (in-progress tab)
    tasksScroll.querySelectorAll('.task-done-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:complete', taskId: btn.dataset.id }));
      });
    });

    // Wire approve buttons (pending-complete tasks)
    tasksScroll.querySelectorAll('.task-approve-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:approve-complete', taskId: btn.dataset.id }));
        showToast('Approved', 'Task completion approved', 'success');
      });
    });

    // Wire reject buttons (pending-complete tasks)
    tasksScroll.querySelectorAll('.task-reject-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:reject-complete', taskId: btn.dataset.id }));
        showToast('Rejected', 'Task continues — session notified', 'success');
      });
    });

    // Wire edit buttons (queued tab)
    tasksScroll.querySelectorAll('.task-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); openTaskDialog(btn.dataset.id); });
    });

    // Wire assign buttons (queued tab)
    tasksScroll.querySelectorAll('.task-assign-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAssignDialog(btn.dataset.id);
      });
    });

    // Wire resume buttons (completed tab)
    tasksScroll.querySelectorAll('.task-resume-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const taskId = btn.dataset.id;
        const sessionNum = parseInt(btn.dataset.session, 10);
        const task = tasks.find(t => t.id === taskId);
        if (!task) return;

        // Validate session state — offer to start Claude if off
        const session = fleetData.find(s => s.num === sessionNum);
        if (!session || session.state === 'off') {
          if (confirm(`Claude is not running in session ${sessionNum}. Start it now?`)) {
            ws.send(JSON.stringify({ type: 'restart', session: String(sessionNum) }));
            showToast('Starting Claude', `Session ${sessionNum} — try resuming after it starts`, 'success');
          }
          return;
        }

        // Check if session already has an active task
        const busyTask = tasks.find(t => t.status === 'dispatched' && t.assignedTo === sessionNum);
        if (busyTask) {
          showToast('Cannot resume', `Session ${sessionNum} is busy with another task`, 'error');
          return;
        }

        // Determine if we need to send /resume (a different task ran after this one)
        const laterTask = tasks.find(t =>
          t.assignedTo === sessionNum &&
          t.id !== taskId &&
          (t.status === 'completed' || t.status === 'failed') &&
          t.completedAt && task.completedAt &&
          t.completedAt > task.completedAt
        );

        ws.send(JSON.stringify({ type: 'task:resume', taskId, sendResume: !!laterTask }));
        showToast('Resuming', `Task resumed on session ${sessionNum}`, 'success');

        // Switch to In Progress tab
        activeTaskTab = 'inprogress';
        document.querySelectorAll('.tasks-tab').forEach(tab =>
          tab.classList.toggle('active', tab.dataset.tab === 'inprogress'));
        renderTasks();
      });
    });

    // Wire card clicks
    tasksScroll.querySelectorAll('.task-card').forEach(card => {
      card.addEventListener('click', () => {
        const task = tasks.find(t => t.id === card.dataset.id);
        if (!task) return;

        if (activeTaskTab === 'inprogress' && task.status === 'dispatched' && task.assignedTo) {
          // On mobile, open full session panel
          if (window.innerWidth < 900) {
            const s = fleetData.find(x => x.num === task.assignedTo);
            if (s) openSession(s);
            return;
          }
          // Desktop: load in tasks session pane
          tasksSelectedTaskId = task.id;
          openTaskSession(task.assignedTo);
          renderCommentPanel(task.id);
          updateChecklistButtons();
          updateActionsButton();
          autoOpenActionsPopup();
          // Update selection highlight
          tasksScroll.querySelectorAll('.task-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
        } else if (activeTaskTab === 'completed' && (task.status === 'completed' || task.status === 'failed')) {
          tasksSelectedTaskId = task.id;
          showTaskSnapshot(task.id);
          renderCommentPanel(task.id);
          updateChecklistButtons();
          updateActionsButton();
          autoOpenActionsPopup();
          // Update selection highlight
          tasksScroll.querySelectorAll('.task-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
        } else if (activeTaskTab === 'queued') {
          tasksSelectedTaskId = task.id;
          renderCommentPanel(task.id);
          updateChecklistButtons();
          updateActionsButton();
          // Show session panel tabs if task has actions
          if (task.actions && task.actions.length) {
            document.getElementById('tasks-session-tabs').style.display = '';
            document.getElementById('tasks-session-empty').style.display = 'none';
            document.getElementById('tasks-session-title').textContent = `PR #${(task.actionContext && task.actionContext.prNumber) || ''}`;
          }
          autoOpenActionsPopup();
          tasksScroll.querySelectorAll('.task-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
        }
        pushHash();
      });
    });

    // Wire checkboxes
    tasksScroll.querySelectorAll('.task-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        if (cb.checked) selectedTaskIds.add(cb.dataset.id);
        else selectedTaskIds.delete(cb.dataset.id);
        updateTasksBulkBar();
      });
      cb.addEventListener('click', (e) => e.stopPropagation());
    });
    updateTasksBulkBar();
  }

  function updateTasksBulkBar() {
    const bar = document.getElementById('tasks-bulk-bar');
    const count = selectedTaskIds.size;
    document.getElementById('tasks-bulk-count').textContent = `${count} selected`;
    const cancelBtn = document.getElementById('tasks-bulk-cancel');
    const requeueBtn = document.getElementById('tasks-bulk-requeue');
    const doneBtn = document.getElementById('tasks-bulk-done');
    if (count === 0) {
      cancelBtn.disabled = true; requeueBtn.disabled = true; doneBtn.disabled = true;
      cancelBtn.style.display = ''; requeueBtn.style.display = ''; doneBtn.style.display = '';
      doneBtn.textContent = 'Mark Done';
    } else {
      const hasQueued = [...selectedTaskIds].some(id => { const t = tasks.find(x => x.id === id); return t && t.status === 'queued'; });
      const hasDispatched = [...selectedTaskIds].some(id => { const t = tasks.find(x => x.id === id); return t && t.status === 'dispatched'; });
      const hasSnoozed = [...selectedTaskIds].some(id => { const t = tasks.find(x => x.id === id); return t && t.status === 'snoozed'; });
      const hasCompleted = [...selectedTaskIds].some(id => { const t = tasks.find(x => x.id === id); return t && (t.status === 'completed' || t.status === 'failed'); });
      cancelBtn.style.display = (hasQueued || hasDispatched || hasSnoozed) ? '' : 'none';
      cancelBtn.disabled = false;
      requeueBtn.style.display = hasDispatched ? '' : 'none';
      requeueBtn.disabled = false;
      doneBtn.style.display = (hasDispatched || hasCompleted) ? '' : 'none';
      doneBtn.disabled = false;
      doneBtn.textContent = hasDispatched ? 'Mark Done' : 'Clear';
    }
  }

  // Bulk action handlers
  document.getElementById('tasks-bulk-cancel').addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    for (const id of selectedTaskIds) {
      const t = tasks.find(x => x.id === id);
      if (t && (t.status === 'queued' || t.status === 'dispatched' || t.status === 'snoozed')) {
        ws.send(JSON.stringify({ type: 'task:cancel', taskId: id }));
      }
    }
    showToast('Bulk Cancel', `Cancelling ${selectedTaskIds.size} task(s)`, 'success');
    selectedTaskIds.clear();
    updateTasksBulkBar();
  });

  document.getElementById('tasks-bulk-requeue').addEventListener('click', () => {
    if (!ws || ws.readyState !== 1) return;
    let count = 0;
    for (const id of selectedTaskIds) {
      const t = tasks.find(x => x.id === id);
      if (t && t.status === 'dispatched') {
        ws.send(JSON.stringify({ type: 'task:requeue', taskId: id }));
        count++;
      }
    }
    if (count) showToast('Bulk Requeue', `Requeuing ${count} task(s)`, 'success');
    selectedTaskIds.clear();
    updateTasksBulkBar();
  });

  document.getElementById('tasks-bulk-done').addEventListener('click', () => {
    let doneCount = 0, clearCount = 0;
    for (const id of selectedTaskIds) {
      const t = tasks.find(x => x.id === id);
      if (!t) continue;
      if (t.status === 'dispatched' && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'task:complete', taskId: id }));
        doneCount++;
      } else if (t.status === 'completed' || t.status === 'failed') {
        const idx = tasks.indexOf(t);
        if (idx >= 0) tasks.splice(idx, 1);
        clearCount++;
      }
    }
    if (doneCount) showToast('Bulk Done', `Marking ${doneCount} task(s) as done`, 'success');
    if (clearCount) showToast('Cleared', `Removed ${clearCount} task(s)`, 'success');
    selectedTaskIds.clear();
    updateTasksBulkBar();
    renderTasks();
    updateTasksBadge();
  });

  // ── Tasks view toggle (List / Board) ────────────────
  document.querySelectorAll('.tasks-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.tasksView;
      if (mode === tasksViewMode) return;
      tasksViewMode = mode;
      document.querySelectorAll('.tasks-view-btn').forEach(b => b.classList.toggle('active', b.dataset.tasksView === mode));
      const panes = document.getElementById('tasks-panes');
      const board = document.getElementById('tasks-board');
      const createBoardBtn = document.getElementById('tasks-create-btn-board');
      const wsConfigBtn = document.getElementById('tasks-ws-config-btn');
      const pmWrap = document.getElementById('board-pm-wrap');
      if (mode === 'board') {
        panes.style.display = 'none';
        board.style.display = '';
        createBoardBtn.style.display = '';
        wsConfigBtn.style.display = '';
        pmWrap.style.display = '';
        populateBoardPmSelect();
        renderTaskBoard();
      } else {
        board.style.display = 'none';
        panes.style.display = '';
        createBoardBtn.style.display = 'none';
        wsConfigBtn.style.display = 'none';
        pmWrap.style.display = 'none';
        renderTasks();
      }
      pushHash();
    });
  });

  document.getElementById('tasks-create-btn-board').addEventListener('click', () => openTaskDialog(null));

  // ── Board PM multi-select ─────────────────────────
  const boardPmBtn = document.getElementById('board-pm-btn');
  var boardPmDropdown = document.getElementById('board-pm-dropdown');

  if (boardPmBtn) boardPmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    boardPmDropdown.classList.toggle('open');
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => boardPmDropdown && boardPmDropdown.classList.remove('open'));
  if (boardPmDropdown) boardPmDropdown.addEventListener('click', (e) => e.stopPropagation());

  function populateBoardPmSelect() {
    if (!boardPmDropdown) return;
    boardPmDropdown.innerHTML = '';
    for (const pm of pmList) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = pm.id;
      cb.checked = boardPmFilter.has(pm.id);
      cb.addEventListener('change', () => {
        if (cb.checked) boardPmFilter.add(pm.id);
        else boardPmFilter.delete(pm.id);
        updateBoardPmBtnLabel();
        renderBoardColumns();
        renderTaskBoard();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(pm.name));
      boardPmDropdown.appendChild(lbl);
    }
    // Remove stale selections (PM deleted)
    for (const id of boardPmFilter) {
      if (!pmList.some(p => p.id === id)) boardPmFilter.delete(id);
    }
    updateBoardPmBtnLabel();
  }

  function updateBoardPmBtnLabel() {
    if (!boardPmBtn) return;
    if (!boardPmFilter.size) {
      boardPmBtn.textContent = 'All PMs';
    } else if (boardPmFilter.size === 1) {
      const pm = pmList.find(p => p.id === [...boardPmFilter][0]);
      boardPmBtn.textContent = pm ? pm.name : 'All PMs';
    } else {
      boardPmBtn.textContent = `${boardPmFilter.size} PMs`;
    }
  }

  /** Get the active work states for the current board view */
  function activeBoardStates() {
    if (!boardPmFilter.size) return workStates; // All PMs → global states
    if (boardPmFilter.size === 1) {
      // Single PM: use its boardStates if defined
      const pm = pmList.find(p => p.id === [...boardPmFilter][0]);
      if (!pm || !pm.boardStates || !pm.boardStates.length) return workStates;
      return pm.boardStates
        .map(bs => {
          const global = workStates.find(ws => ws.id === bs.stateId);
          if (!global) return null;
          return { ...global, autoOnStatus: bs.autoOnStatus || [] };
        })
        .filter(Boolean);
    }
    // Multiple PMs: merge — union of all board states across selected PMs
    const stateMap = new Map(); // stateId → { ...global, autoOnStatus: merged[] }
    for (const pmId of boardPmFilter) {
      const pm = pmList.find(p => p.id === pmId);
      const pmStates = pm && pm.boardStates && pm.boardStates.length ? pm.boardStates : null;
      if (!pmStates) {
        // PM has no custom boardStates → include all global states
        for (const ws of workStates) {
          if (!stateMap.has(ws.id)) stateMap.set(ws.id, { ...ws, autoOnStatus: [...(ws.autoOnStatus || [])] });
          else {
            const existing = stateMap.get(ws.id);
            for (const s of (ws.autoOnStatus || [])) { if (!existing.autoOnStatus.includes(s)) existing.autoOnStatus.push(s); }
          }
        }
      } else {
        for (const bs of pmStates) {
          const global = workStates.find(ws => ws.id === bs.stateId);
          if (!global) continue;
          if (!stateMap.has(bs.stateId)) {
            stateMap.set(bs.stateId, { ...global, autoOnStatus: [...(bs.autoOnStatus || [])] });
          } else {
            const existing = stateMap.get(bs.stateId);
            for (const s of (bs.autoOnStatus || [])) { if (!existing.autoOnStatus.includes(s)) existing.autoOnStatus.push(s); }
          }
        }
      }
    }
    // Preserve global ordering
    return workStates.filter(ws => stateMap.has(ws.id)).map(ws => stateMap.get(ws.id));
  }

  // ── Tasks kanban board renderer ────────────────────

  /** Build board column DOM from active board states */
  function renderBoardColumns() {
    const board = document.getElementById('tasks-board');
    if (!board) return;
    board.innerHTML = '';
    const states = activeBoardStates();
    for (const wState of states) {
      const col = document.createElement('div');
      col.className = 'tasks-board-col';
      col.dataset.col = wState.id;
      col.innerHTML = `
        <div class="tasks-board-col-header" style="border-bottom-color:${wState.color}">
          <span class="tasks-board-col-title">${esc(wState.label)}</span>
          <span class="tasks-board-col-count" id="board-count-${wState.id}">0</span>
        </div>
        <div class="tasks-board-col-cards" id="board-cards-${wState.id}"></div>
      `;
      board.appendChild(col);
    }
  }

  /** Get auto-on-status mappings for a task: PM-specific first, then global fallback */
  function autoStatesForTask(task) {
    // Check if task's source PM has boardStates
    if (task.source) {
      const pmName = task.source.replace(/^pm:/, '');
      const pm = pmList.find(p => p.name === pmName);
      if (pm && pm.boardStates && pm.boardStates.length) {
        return pm.boardStates.map(bs => {
          const g = workStates.find(ws => ws.id === bs.stateId);
          return g ? { id: g.id, autoOnStatus: bs.autoOnStatus || [] } : null;
        }).filter(Boolean);
      }
    }
    // Fall back to global workStates
    return workStates;
  }

  /** Compute effective board column: manual override wins, then PM autoOnStatus, then global, then first col */
  function effectiveWorkState(task) {
    const states = activeBoardStates();
    // Manual override takes priority (user dragged/set explicitly)
    if (task.workStateManual && task.workState && states.some(ws => ws.id === task.workState)) {
      return task.workState;
    }
    // Auto-mapping: PM-specific first, then global
    const autoStates = autoStatesForTask(task);
    for (const ws of autoStates) {
      if (ws.autoOnStatus && ws.autoOnStatus.includes(task.status)) {
        // Only return if this state exists in the active board
        if (states.some(s => s.id === ws.id)) return ws.id;
      }
    }
    // Fall back to stored workState if it exists in active board
    if (task.workState && states.some(ws => ws.id === task.workState)) return task.workState;
    return states[0]?.id || null;
  }

  function renderTaskBoard() {
    const states = activeBoardStates();
    if (!states.length) return;
    // Ensure columns exist (idempotent)
    if (!document.getElementById(`board-cards-${states[0].id}`)) renderBoardColumns();
    const q = taskSearchQuery.toLowerCase();
    const matchesSearch = (t) => !q || t.text.toLowerCase().includes(q) || (t.source || '').toLowerCase().includes(q) || (t.designation || '').toLowerCase().includes(q) || String(t.assignedTo || '').includes(q) || (t.assignee || '').toLowerCase().includes(q);

    // Filter tasks by selected PMs (empty = all)
    let pmFilteredTasks = tasks;
    if (boardPmFilter.size) {
      const pmNames = new Set();
      for (const id of boardPmFilter) {
        const pm = pmList.find(p => p.id === id);
        if (pm) pmNames.add(pm.name);
      }
      pmFilteredTasks = tasks.filter(t => pmNames.has((t.source || '').replace(/^pm:/, '')));
    }

    // Group tasks by effective work state (dynamic resolution)
    const grouped = new Map();
    for (const wState of states) grouped.set(wState.id, []);
    // Include all non-cancelled tasks
    const visible = pmFilteredTasks.filter(t => t.status !== 'cancelled' && matchesSearch(t));
    for (const t of visible) {
      const col = effectiveWorkState(t);
      if (col && grouped.has(col)) grouped.get(col).push(t);
    }

    // Build new state map for animation diffing (use effective, not stored)
    const newStatuses = new Map();
    for (const t of pmFilteredTasks) newStatuses.set(t.id, effectiveWorkState(t) || '');

    // Snapshot existing card positions for FLIP
    const oldRects = new Map();
    document.querySelectorAll('.board-card').forEach(el => {
      oldRects.set(el.dataset.id, el.getBoundingClientRect());
    });

    // Detect movers (workState changed since last render)
    const movers = new Set();
    for (const [id, wst] of newStatuses) {
      const prev = boardPrevStatuses.get(id);
      if (prev !== undefined && prev !== wst) movers.add(id);
    }

    // Render each column
    for (const wState of states) {
      renderBoardCol(wState.id, grouped.get(wState.id) || []);
    }

    // FLIP animate movers
    document.querySelectorAll('.board-card').forEach(el => {
      const id = el.dataset.id;
      const oldRect = oldRects.get(id);
      if (movers.has(id) && oldRect) {
        const newRect = el.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          el.style.transition = 'none';
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.35s ease';
            el.style.transform = '';
            el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
          });
        }
      } else if (movers.has(id)) {
        el.classList.add('board-card-enter');
        el.addEventListener('animationend', () => el.classList.remove('board-card-enter'), { once: true });
      }
    });

    boardPrevStatuses = newStatuses;
  }

  function renderBoardCol(colId, taskList) {
    const container = document.getElementById(`board-cards-${colId}`);
    const countEl = document.getElementById(`board-count-${colId}`);
    if (!container || !countEl) return;
    countEl.textContent = taskList.length;

    container.innerHTML = '';

    // Drop target: attach once so empty columns accept drops
    if (!container._dropWired) {
      container._dropWired = true;
      container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; container.classList.add('board-col-drop-target'); });
      container.addEventListener('dragleave', (e) => { if (!container.contains(e.relatedTarget)) container.classList.remove('board-col-drop-target'); });
      container.addEventListener('drop', (e) => {
        e.preventDefault();
        container.classList.remove('board-col-drop-target');
        const taskId = e.dataTransfer.getData('text/plain');
        if (!taskId || colId === effectiveWorkState(tasks.find(t => t.id === taskId) || {})) return;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'task:update', taskId, updates: { workState: colId } }));
        }
        // Optimistic update
        const task = tasks.find(t => t.id === taskId);
        if (task) { task.workState = colId; task.workStateManual = true; }
        renderTaskBoard();
        if (taskDetailTaskId === taskId) openTaskDetail(taskId);
      });
    }

    if (!taskList.length) {
      container.innerHTML = '<div class="board-card-empty">Drop here</div>';
      return;
    }

    for (const t of taskList) {
      const el = document.createElement('div');
      el.className = `board-card${tasksSelectedTaskId === t.id ? ' selected' : ''}`;
      el.dataset.id = t.id;
      el.dataset.status = t.status;
      el.draggable = true;

      const sourceLabel = t.source ? t.source.replace(/^pm:/, '') : '';
      const pmdc = t.designation ? getDesigColor(t.designation) : null;
      const desigBadge = t.designation ? `<span class="task-designation" style="background:${pmdc.bg};color:${pmdc.fg}">${esc(t.designation)}</span>` : '';
      const sourceBadge = sourceLabel ? `<span class="task-source-badge">${esc(sourceLabel)}</span>` : '';
      const sessionBadge = t.assignedTo ? `<span class="task-session-badge">S:${t.assignedTo}</span>` : '';
      const statusDot = `<span class="board-card-status s-${t.status}"></span>`;
      const initials = t.assignee ? t.assignee.slice(0, 2).toUpperCase() : '';
      const assigneeBadge = initials ? `<span class="board-card-assignee">${esc(initials)}</span>` : '';
      const timeStr = t.status === 'dispatched' ? timeAgo(t.dispatchedAt || t.createdAt) : timeAgo(t.createdAt);

      el.innerHTML = `
        <div class="board-card-title">${esc(t.text)}</div>
        <div class="board-card-meta">${statusDot}${desigBadge}${sourceBadge}${sessionBadge}<span>${timeStr}</span>${assigneeBadge}</div>
      `;

      // Drag start
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        el.classList.add('board-card-dragging');
        // Highlight all column drop zones
        document.querySelectorAll('.tasks-board-col-cards').forEach(c => c.classList.add('board-col-drop-ready'));
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('board-card-dragging');
        document.querySelectorAll('.tasks-board-col-cards').forEach(c => {
          c.classList.remove('board-col-drop-ready', 'board-col-drop-target');
        });
      });

      el.addEventListener('click', () => openTaskDetail(t.id));
      container.appendChild(el);
    }
  }

  // ── Task detail slide-out (board view) ───────────
  var taskDetailTaskId = null;
  var taskDetailTerm = null;
  var taskDetailFitAddon = null;
  var taskDetailSession = null;
  var taskDetailLastContent = '';
  var taskDetailScrolledUp = false;
  var taskDetailPending = null;
  var taskDetailWriting = false;
  let taskDetailMode = 'ask'; // 'ask' or 'tell'
  let tdHistoryIdx = -1;
  let tdHistoryDraft = '';
  var tdActivePane = null;
  var tdSessionPanes = [];
  var tdClaudePaneIdx = null;

  function openTaskDetail(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // Clean up previous session subscription if switching tasks
    if (taskDetailSession && taskDetailSession !== String(task.assignedTo || '')) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal:unsubscribe', session: taskDetailSession }));
      }
      taskDetailSession = null;
      taskDetailLastContent = '';
    }

    taskDetailTaskId = taskId;
    tasksSelectedTaskId = taskId;

    // Highlight on board
    document.querySelectorAll('.board-card').forEach(c => c.classList.toggle('selected', c.dataset.id === taskId));

    // Header: title + meta
    document.getElementById('task-detail-title').textContent = task.text;
    const sourceLabel = task.source ? task.source.replace(/^pm:/, '') : '';
    const pmdc = task.designation ? getDesigColor(task.designation) : null;
    const desigHtml = task.designation ? `<span class="task-designation" style="background:${pmdc.bg};color:${pmdc.fg}">${esc(task.designation)}</span>` : '';
    const sourceHtml = sourceLabel ? `<span class="task-source-badge">${esc(sourceLabel)}</span>` : '';
    const sessionHtml = task.assignedTo ? `<span class="task-session-badge">S:${task.assignedTo}</span>` : '';
    const timeHtml = `<span>${timeAgo(task.createdAt)}</span>`;
    document.getElementById('task-detail-meta').innerHTML = [desigHtml, sourceHtml, sessionHtml, timeHtml].filter(Boolean).join('');

    // Toolbar: actions
    let actionsHtml = '';
    if (task.status === 'dispatched') {
      actionsHtml = `
        <button class="task-detail-action primary" data-action="done">Done</button>
        <button class="task-detail-action" data-action="requeue">Requeue</button>
        <button class="task-detail-action" data-action="snooze">Snooze</button>
        <button class="task-detail-action" data-action="rename">Rename</button>
        <button class="task-detail-action danger" data-action="cancel">Cancel</button>
      `;
    } else if (task.status === 'queued') {
      actionsHtml = `
        <button class="task-detail-action primary" data-action="assign">Assign</button>
        <button class="task-detail-action" data-action="edit">Edit</button>
        <button class="task-detail-action" data-action="snooze">Snooze</button>
        <button class="task-detail-action" data-action="rename">Rename</button>
        <button class="task-detail-action danger" data-action="cancel">Cancel</button>
      `;
    } else if (task.status === 'snoozed') {
      const wakeTime = task.snoozedUntil ? new Date(task.snoozedUntil).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      actionsHtml = `
        ${wakeTime ? `<span style="font-size:11px;color:var(--yellow)">Wakes ${wakeTime}</span>` : ''}
        <button class="task-detail-action primary" data-action="wake">Wake Now</button>
        <button class="task-detail-action" data-action="rename">Rename</button>
        <button class="task-detail-action danger" data-action="cancel">Cancel</button>
      `;
    } else {
      actionsHtml = task.assignedTo ? `<button class="task-detail-action" data-action="resume">Resume</button>` : '';
    }
    const actionsEl = document.getElementById('task-detail-actions');
    actionsEl.innerHTML = actionsHtml;
    actionsEl.querySelectorAll('.task-detail-action').forEach(btn => {
      btn.addEventListener('click', () => handleTaskDetailAction(btn.dataset.action, task));
    });

    // Context actions button (right side, after Open Session)
    const ctxBtn = document.getElementById('task-detail-ctx-actions');
    if (task.actions && task.actions.length) {
      ctxBtn.textContent = `\u26A1 Actions (${task.actions.length})`;
      ctxBtn.style.display = '';
      ctxBtn.onclick = () => renderActionsPopup(task.id, ctxBtn);
    } else {
      ctxBtn.style.display = 'none';
      ctxBtn.onclick = null;
    }

    // Work state button
    const wsBtn = document.getElementById('task-detail-work-state');
    const wsState = workStates.find(w => w.id === task.workState);
    wsBtn.textContent = wsState ? wsState.label : (task.workState || 'Set state');
    wsBtn.style.background = wsState ? wsState.color + '33' : '';
    wsBtn.style.color = wsState ? wsState.color : 'var(--dim)';
    wsBtn.onclick = (e) => { e.stopPropagation(); showWorkStateDropdown(task.id, wsBtn); };

    // Assignee button
    const assignBtn = document.getElementById('task-detail-assignee');
    assignBtn.textContent = task.assignee || '';
    assignBtn.onclick = (e) => { e.stopPropagation(); promptAssignee(task.id, assignBtn); };

    // Toolbar: checklist progress
    const checklistEl = document.getElementById('task-detail-checklist');
    if (task.checklist && task.checklist.length) {
      const done = task.checklist.filter(c => c.done).length;
      checklistEl.textContent = `Checklist ${done}/${task.checklist.length}`;
      checklistEl.style.color = done === task.checklist.length ? 'var(--green)' : 'var(--dim)';
    } else {
      checklistEl.textContent = '';
    }

    // Toolbar: open session button
    const openBtn = document.getElementById('task-detail-open-session');
    const isDispatched = task.status === 'dispatched' && task.assignedTo;
    openBtn.style.display = isDispatched ? '' : 'none';
    openBtn.onclick = isDispatched ? () => {
      closeTaskDetail();
      const s = fleetData.find(x => x.num === task.assignedTo);
      if (s) openSession(s);
    } : null;

    // Terminal + input: show for dispatched tasks
    const termContainer = document.getElementById('task-detail-terminal');
    const keysBar = document.getElementById('task-detail-keys');
    const cmdBarEl = document.getElementById('task-detail-cmd-bar');
    const inputBar = document.getElementById('task-detail-input-bar');

    if (isDispatched) {
      termContainer.style.display = '';
      keysBar.style.display = '';
      inputBar.style.display = '';
      // Dispose old terminal and create fresh — xterm open() can only be called once
      if (taskDetailTerm) {
        taskDetailTerm.dispose();
        taskDetailTerm = null;
        taskDetailFitAddon = null;
      }
      termContainer.innerHTML = '';
      taskDetailTerm = new Terminal({
        fontSize: tdFontSize, fontFamily: "'SF Mono', Menlo, Monaco, monospace",
        theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
        scrollback: 5000, convertEol: true, cursorBlink: false, disableStdin: true,
      });
      taskDetailFitAddon = new FitAddon.FitAddon();
      taskDetailTerm.loadAddon(taskDetailFitAddon);
      taskDetailTerm.open(termContainer);
      taskDetailLastContent = '';
      taskDetailScrolledUp = false;
      taskDetailPending = null;
      // Scroll lock: detect user scrolling up
      taskDetailTerm.element.addEventListener('wheel', () => { setTimeout(checkTaskDetailScroll, 50); });
      let tdTouchStartY = 0;
      taskDetailTerm.element.addEventListener('touchstart', (e) => { tdTouchStartY = e.touches[0].clientY; }, { passive: true });
      taskDetailTerm.element.addEventListener('touchend', (e) => {
        const dy = tdTouchStartY - (e.changedTouches[0] || {}).clientY;
        if (Math.abs(dy) > 20) { setTimeout(checkTaskDetailScroll, 150); setTimeout(checkTaskDetailScroll, 500); }
      });
      taskDetailSession = String(task.assignedTo);
      tdActivePane = null; tdSessionPanes = []; tdClaudePaneIdx = null;
      renderPaneTabs('td');
      document.getElementById('task-detail-input').value = '';
      // Render slash command bar (reuse tsCommands from tasks session)
      renderTaskDetailCmdBar();
      // Subscribe immediately so data starts flowing
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal:subscribe', session: task.assignedTo }));
        ws.send(JSON.stringify({ type: 'terminal:panes', session: task.assignedTo }));
        ws.send(JSON.stringify({ type: 'git:info', session: task.assignedTo }));
      }
      // Delay fit until panel is fully visible
      const panelOpen = document.getElementById('task-detail-panel').classList.contains('open');
      setTimeout(() => {
        try { taskDetailFitAddon.fit(); } catch(_) {}
      }, panelOpen ? 50 : 300);
    } else {
      termContainer.style.display = 'none';
      keysBar.style.display = 'none';
      cmdBarEl.innerHTML = '';
      inputBar.style.display = 'none';
      taskDetailSession = null;
    }

    // Nav buttons
    updateTaskDetailNav();

    // Show panel
    document.getElementById('task-detail-panel').classList.add('open');
    document.getElementById('task-detail-overlay').classList.add('open');
  }

  function showWorkStateDropdown(taskId, anchorBtn) {
    // Close existing
    document.querySelectorAll('.work-state-dropdown').forEach(d => d.remove());
    const dropdown = document.createElement('div');
    dropdown.className = 'work-state-dropdown';
    const task = tasks.find(t => t.id === taskId);
    for (const wState of workStates) {
      const opt = document.createElement('button');
      opt.className = `work-state-option${task && task.workState === wState.id ? ' active' : ''}`;
      opt.innerHTML = `<span class="work-state-dot" style="background:${wState.color}"></span>${esc(wState.label)}`;
      opt.addEventListener('click', () => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'task:update', taskId, updates: { workState: wState.id } }));
        }
        // Optimistic update
        if (task) task.workState = wState.id;
        dropdown.remove();
        openTaskDetail(taskId); // re-render
        renderTaskBoard();
      });
      dropdown.appendChild(opt);
    }
    anchorBtn.parentElement.style.position = 'relative';
    anchorBtn.parentElement.appendChild(dropdown);
    // Position below the button
    const rect = anchorBtn.getBoundingClientRect();
    const parentRect = anchorBtn.parentElement.getBoundingClientRect();
    dropdown.style.left = (rect.left - parentRect.left) + 'px';
    // Close on click outside
    setTimeout(() => {
      const close = (e) => { if (!dropdown.contains(e.target) && e.target !== anchorBtn) { dropdown.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
  }

  function promptAssignee(taskId, anchorBtn) {
    const task = tasks.find(t => t.id === taskId);
    const current = task ? (task.assignee || '') : '';
    // Simple inline input
    const existing = document.querySelector('.assignee-input-inline');
    if (existing) existing.remove();
    const input = document.createElement('input');
    input.className = 'assignee-input-inline';
    input.type = 'text';
    input.value = current;
    input.placeholder = 'Initials...';
    input.style.cssText = 'width:60px;padding:3px 6px;font-size:var(--fs-sm);background:var(--bg);border:1px solid var(--bg3);color:var(--fg);border-radius:6px;font-weight:700;text-transform:uppercase;';
    const commit = () => {
      const val = input.value.trim().slice(0, 10);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'task:update', taskId, updates: { assignee: val || null } }));
      }
      if (task) task.assignee = val || null;
      input.replaceWith(anchorBtn);
      openTaskDetail(taskId);
      renderTaskBoard();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { input.replaceWith(anchorBtn); } });
    input.addEventListener('blur', commit);
    anchorBtn.replaceWith(input);
    input.focus();
    input.select();
  }

  // ── Work States config modal ─────────────────────
  let wsConfigDraft = [];

  document.getElementById('tasks-ws-config-btn').addEventListener('click', openWsConfig);
  document.getElementById('ws-config-close').addEventListener('click', closeWsConfig);
  document.getElementById('ws-config-cancel').addEventListener('click', closeWsConfig);
  document.getElementById('ws-config-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'ws-config-overlay') closeWsConfig();
  });
  document.getElementById('ws-config-add').addEventListener('click', () => {
    const id = 'state-' + Date.now().toString(36);
    wsConfigDraft.push({ id, label: 'New State', color: '#6272a4' });
    renderWsConfigRows();
  });
  let wsConfigMode = 'global'; // 'global' or pm id

  document.getElementById('ws-config-save').addEventListener('click', () => {
    if (wsConfigMode === 'global') {
      syncWsConfigDraft();
      const states = wsConfigDraft.filter(s => s.label);
      if (!states.length) return;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'workStates:set', states }));
      }
    } else {
      // Per-PM: save boardStates
      const boardStates = [];
      document.querySelectorAll('.ws-pm-state-row').forEach(row => {
        const cb = row.querySelector('.ws-pm-state-cb');
        if (!cb.checked) return;
        const chips = row.querySelectorAll('.ws-auto-chip.active');
        boardStates.push({
          stateId: row.dataset.stateId,
          autoOnStatus: Array.from(chips).map(c => c.dataset.status),
        });
      });
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'pm:update', id: wsConfigMode, updates: { boardStates } }));
      }
    }
    closeWsConfig();
  });

  function openWsConfig() {
    if (boardPmFilter.size === 1) {
      const pmId = [...boardPmFilter][0];
      wsConfigMode = pmId;
      const pm = pmList.find(p => p.id === pmId);
      document.querySelector('.ws-config-title').textContent = pm ? `${pm.name} — Board States` : 'Board States';
      document.getElementById('ws-config-add').style.display = 'none';
      renderWsPmRows(pm);
    } else if (boardPmFilter.size > 1) {
      // Multi-PM merged view: show global config
      wsConfigMode = 'global';
      document.querySelector('.ws-config-title').textContent = 'Work States (Merged View)';
      document.getElementById('ws-config-add').style.display = '';
      wsConfigDraft = workStates.map(s => ({ ...s, autoOnStatus: [...(s.autoOnStatus || [])] }));
      renderWsConfigRows();
    } else {
      wsConfigMode = 'global';
      document.querySelector('.ws-config-title').textContent = 'Work States';
      document.getElementById('ws-config-add').style.display = '';
      wsConfigDraft = workStates.map(s => ({ ...s, autoOnStatus: [...(s.autoOnStatus || [])] }));
      renderWsConfigRows();
    }
    document.getElementById('ws-config-overlay').style.display = '';
  }

  function closeWsConfig() {
    document.getElementById('ws-config-overlay').style.display = 'none';
  }

  const TASK_STATUSES = ['queued', 'dispatched', 'completed', 'failed', 'snoozed', 'cancelled'];

  /** Render per-PM board state config: checkboxes for each global state + autoOnStatus chips */
  function renderWsPmRows(pm) {
    const body = document.getElementById('ws-config-body');
    body.innerHTML = '';
    const pmStates = (pm && pm.boardStates) || [];
    const pmMap = new Map(pmStates.map(bs => [bs.stateId, bs]));
    for (const gs of workStates) {
      const pmState = pmMap.get(gs.id);
      const active = !!pmState || !pmStates.length; // if no boardStates defined, all checked by default
      const auto = pmState ? (pmState.autoOnStatus || []) : (gs.autoOnStatus || []);
      const row = document.createElement('div');
      row.className = 'ws-pm-state-row';
      row.dataset.stateId = gs.id;
      const chipsHtml = TASK_STATUSES.map(st =>
        `<button class="ws-auto-chip${auto.includes(st) ? ' active' : ''}" data-status="${st}">${st}</button>`
      ).join('');
      row.innerHTML = `
        <div class="ws-pm-state-main">
          <input type="checkbox" class="ws-pm-state-cb" ${active ? 'checked' : ''}>
          <span class="work-state-dot" style="background:${gs.color}"></span>
          <span class="ws-pm-state-label">${esc(gs.label)}</span>
        </div>
        <div class="ws-auto-row" style="padding-left:32px">
          <span class="ws-auto-label">Auto-set on:</span>
          ${chipsHtml}
        </div>
      `;
      row.querySelectorAll('.ws-auto-chip').forEach(chip => {
        chip.addEventListener('click', (e) => { e.preventDefault(); chip.classList.toggle('active'); });
      });
      body.appendChild(row);
    }
  }

  function renderWsConfigRows() {
    const body = document.getElementById('ws-config-body');
    body.innerHTML = '';
    wsConfigDraft.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'ws-config-row';
      row.dataset.stateId = s.id;
      row.draggable = true;
      const auto = s.autoOnStatus || [];
      const chipsHtml = TASK_STATUSES.map(st =>
        `<button class="ws-auto-chip${auto.includes(st) ? ' active' : ''}" data-status="${st}">${st}</button>`
      ).join('');
      row.innerHTML = `
        <div class="ws-config-row-main">
          <span class="ws-config-drag">&#9776;</span>
          <input type="color" class="ws-config-color" value="${s.color}">
          <input type="text" class="ws-config-label" value="${esc(s.label)}" placeholder="State name">
          <button class="ws-config-delete" title="Remove">&times;</button>
        </div>
        <div class="ws-auto-row">
          <span class="ws-auto-label">Auto-set on:</span>
          ${chipsHtml}
        </div>
      `;
      // Chip toggle handlers
      row.querySelectorAll('.ws-auto-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          chip.classList.toggle('active');
        });
      });
      // Delete handler
      row.querySelector('.ws-config-delete').addEventListener('click', () => {
        syncWsConfigDraft();
        wsConfigDraft.splice(idx, 1);
        renderWsConfigRows();
      });
      // Drag-and-drop reorder
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', idx);
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        if (isNaN(fromIdx) || fromIdx === idx) return;
        syncWsConfigDraft();
        const [item] = wsConfigDraft.splice(fromIdx, 1);
        wsConfigDraft.splice(idx, 0, item);
        renderWsConfigRows();
      });
      body.appendChild(row);
    });
  }

  function syncWsConfigDraft() {
    const rows = document.querySelectorAll('.ws-config-row');
    rows.forEach((row, i) => {
      if (wsConfigDraft[i]) {
        wsConfigDraft[i].label = row.querySelector('.ws-config-label').value.trim() || wsConfigDraft[i].label;
        wsConfigDraft[i].color = row.querySelector('.ws-config-color').value;
        const chips = row.querySelectorAll('.ws-auto-chip.active');
        wsConfigDraft[i].autoOnStatus = Array.from(chips).map(c => c.dataset.status);
      }
    });
  }

  function checkTaskDetailScroll() {
    if (!taskDetailTerm || taskDetailWriting) return;
    const buf = taskDetailTerm.buffer.active;
    const linesFromBottom = buf.baseY - buf.viewportY;
    if (linesFromBottom <= 3 && taskDetailScrolledUp) {
      taskDetailScrolledUp = false;
      taskDetailScrollIndicator(false);
      if (taskDetailPending !== null) { writeTaskDetailContent(taskDetailPending); taskDetailPending = null; }
    } else if (linesFromBottom > 3) {
      taskDetailScrolledUp = true;
      taskDetailScrollIndicator(true);
    }
  }

  var _tdWriteRAF = null;
  function writeTaskDetailContent(content) {
    if (!taskDetailTerm) return;
    taskDetailLastContent = content;
    taskDetailWriting = true;
    if (_tdWriteRAF) cancelAnimationFrame(_tdWriteRAF);
    _tdWriteRAF = requestAnimationFrame(() => {
      _tdWriteRAF = null;
      taskDetailTerm.reset();
      taskDetailTerm.write(content, () => {
        taskDetailTerm.scrollToBottom();
        taskDetailWriting = false;
      });
    });
  }

  function taskDetailScrollIndicator(show) {
    let el = document.getElementById('task-detail-scroll-pause');
    const termContainer = document.getElementById('task-detail-terminal');
    if (show && !el) {
      el = document.createElement('div');
      el.id = 'task-detail-scroll-pause';
      el.className = 'scroll-pause-btn';
      el.setAttribute('data-tooltip', 'Scroll to bottom');
      el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      el.addEventListener('click', () => {
        taskDetailScrolledUp = false;
        taskDetailScrollIndicator(false);
        if (taskDetailTerm) taskDetailTerm.scrollToBottom();
        if (taskDetailPending !== null) { writeTaskDetailContent(taskDetailPending); taskDetailPending = null; }
      });
      if (termContainer) { termContainer.style.position = 'relative'; termContainer.appendChild(el); }
    } else if (!show && el) { el.remove(); }
  }

  function closeTaskDetail() {
    document.getElementById('task-detail-panel').classList.remove('open');
    document.getElementById('task-detail-overlay').classList.remove('open');
    if (taskDetailSession && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe', session: taskDetailSession }));
    }
    if (taskDetailTerm) {
      taskDetailTerm.dispose();
      taskDetailTerm = null;
      taskDetailFitAddon = null;
    }
    taskDetailSession = null;
    taskDetailTaskId = null;
    taskDetailLastContent = '';
    taskDetailScrolledUp = false;
    taskDetailPending = null;
    tdActivePane = null; tdSessionPanes = []; tdClaudePaneIdx = null;
    renderPaneTabs('td');
    // Reset git section
    const gitSection = document.getElementById('td-git-section');
    gitSection.style.display = 'none';
    gitSection.classList.remove('open');
    document.getElementById('td-git-sidebar').innerHTML = '';
    document.getElementById('td-git-diff-header').style.display = 'none';
    document.getElementById('td-git-diff-content').innerHTML = '<div class="git-empty">Select a file to view diff</div>';
  }

  function updateTaskDetailNav() {
    const allTasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
    const idx = allTasks.findIndex(t => t.id === taskDetailTaskId);
    document.getElementById('task-detail-prev').disabled = idx <= 0;
    document.getElementById('task-detail-next').disabled = idx < 0 || idx >= allTasks.length - 1;
  }

  function handleTaskDetailAction(action, task) {
    if (!ws || ws.readyState !== 1) return;
    switch (action) {
      case 'done':
        ws.send(JSON.stringify({ type: 'task:complete', taskId: task.id }));
        navigateTaskDetail(1); // auto-advance to next
        break;
      case 'requeue':
        openTaskConfirmDialog('requeue', task.id);
        break;
      case 'snooze':
        openTaskConfirmDialog('snooze', task.id);
        break;
      case 'cancel':
        openTaskConfirmDialog('cancel', task.id);
        break;
      case 'wake':
        ws.send(JSON.stringify({ type: 'task:unsnooze', taskId: task.id }));
        showToast('Woke up', 'Task returned to queue', 'success');
        break;
      case 'assign':
        openAssignDialog(task.id);
        break;
      case 'edit':
        openTaskDialog(task.id);
        break;
      case 'rename':
        openRenameDialog(task.id);
        break;
      case 'resume':
        if (task.assignedTo) {
          ws.send(JSON.stringify({ type: 'task:resume', taskId: task.id, sendResume: false }));
          showToast('Resuming', `Task resumed on session ${task.assignedTo}`, 'success');
        }
        break;
    }
  }

  function navigateTaskDetail(dir) {
    const allTasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
    const idx = allTasks.findIndex(t => t.id === taskDetailTaskId);
    const next = allTasks[idx + dir];
    if (next) {
      openTaskDetail(next.id);
    } else {
      closeTaskDetail();
    }
  }

  document.getElementById('task-detail-close').addEventListener('click', closeTaskDetail);
  document.getElementById('task-detail-overlay').addEventListener('click', closeTaskDetail);
  document.getElementById('task-detail-prev').addEventListener('click', () => navigateTaskDetail(-1));
  document.getElementById('task-detail-next').addEventListener('click', () => navigateTaskDetail(1));

  // Task detail: Git section toggle
  document.getElementById('td-git-toggle').addEventListener('click', () => {
    document.getElementById('td-git-section').classList.toggle('open');
  });

  // Task detail: Ask/Tell mode toggle
  const tdModeToggle = document.getElementById('task-detail-mode-toggle');
  tdModeToggle.addEventListener('click', () => {
    taskDetailMode = taskDetailMode === 'ask' ? 'tell' : 'ask';
    tdModeToggle.textContent = taskDetailMode === 'ask' ? 'Ask' : 'Tell';
    tdModeToggle.classList.toggle('tell', taskDetailMode === 'tell');
  });

  // Task detail: slash command bar
  function renderTaskDetailCmdBar() {
    const bar = document.getElementById('task-detail-cmd-bar');
    bar.innerHTML = '';
    // Reuse tsCommands (slash commands cached from session)
    const cmds = tsCommands.length ? tsCommands : [];
    for (const cmd of cmds) {
      const btn = document.createElement('button'); btn.className = 'cmd-btn'; btn.textContent = '/' + cmd.name;
      if (cmd.description) btn.setAttribute('data-tooltip', cmd.description);
      btn.addEventListener('click', () => {
        if (!taskDetailSession || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'tell', session: taskDetailSession, message: '/' + cmd.name }));
        showToast('Command sent', `/${cmd.name} → session ${taskDetailSession}`, 'success');
      });
      bar.appendChild(btn);
    }
  }

  // Task detail: send message to session
  function sendTaskDetailMessage() {
    const input = document.getElementById('task-detail-input');
    const text = input.value.trim();
    const hasImages = tdAttachedImages.length > 0;
    if ((!text && !hasImages) || !taskDetailSession || !ws || ws.readyState !== 1) return;
    let message = text;
    if (hasImages) {
      const paths = tdAttachedImages.map(i => i.path).join(', ');
      const prefix = `[Attached images: ${paths}]`;
      message = text ? `${prefix}\n\n${text}` : `${prefix}\n\nLook at the attached screenshot.`;
      clearAttachments(tdAttachedImages, tdAttachmentStrip);
    }
    const isShellPane = (tdActivePane !== null && tdActivePane !== tdClaudePaneIdx);
    const msgType = taskDetailMode === 'ask' ? 'ask' : 'tell';
    if (isShellPane) {
      ws.send(JSON.stringify({ type: 'tell', session: taskDetailSession, message, pane: tdActivePane }));
    } else {
      ws.send(JSON.stringify({ type: msgType, session: taskDetailSession, message }));
    }
    pushMsgHistory(taskDetailSession, text);
    tdHistoryIdx = -1;
    tdHistoryDraft = '';
    input.value = '';
    showToast('Sent', `${msgType === 'ask' ? 'Asked' : 'Told'} session ${taskDetailSession}`, 'success');
  }
  document.getElementById('task-detail-send').addEventListener('click', sendTaskDetailMessage);


  document.getElementById('task-detail-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTaskDetailMessage(); return; }
    if (e.key === 'Escape') { closeTaskDetail(); return; }
    // Up/Down arrow history
    const input = e.target;
    const h = msgHistory[taskDetailSession] || [];
    if (!h.length) return;
    if (e.key === 'ArrowUp') {
      const beforeCursor = input.value.substring(0, input.selectionStart);
      if (beforeCursor.includes('\n')) return; // not on first line
      e.preventDefault();
      if (tdHistoryIdx === -1) tdHistoryDraft = input.value;
      if (tdHistoryIdx < h.length - 1) tdHistoryIdx++;
      input.value = h[h.length - 1 - tdHistoryIdx];
    } else if (e.key === 'ArrowDown') {
      const afterCursor = input.value.substring(input.selectionEnd);
      if (afterCursor.includes('\n')) return; // not on last line
      if (tdHistoryIdx <= -1) return;
      e.preventDefault();
      tdHistoryIdx--;
      input.value = tdHistoryIdx === -1 ? tdHistoryDraft : h[h.length - 1 - tdHistoryIdx];
    }
  });

  // Task detail: key buttons
  document.querySelectorAll('[data-td-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!taskDetailSession || !ws || ws.readyState !== 1) return;
      const key = btn.dataset.tdKey;
      const keysMsg = { type: 'keys', session: taskDetailSession, keys: [key === 'c-c' ? 'C-c' : key] };
      if (tdActivePane !== null) keysMsg.pane = tdActivePane;
      ws.send(JSON.stringify(keysMsg));
    });
  });

  // Task nav buttons
  document.getElementById('ts-nav-prev').addEventListener('click', tsNavPrev);
  document.getElementById('ts-nav-next').addEventListener('click', tsNavNext);
  document.getElementById('ts-nav-requeue').addEventListener('click', tsNavRequeue);
  document.getElementById('ts-nav-done').addEventListener('click', tsNavDone);

  function taskHexSvg(t) {
    // Convention: purple=default, animated=working, green=selected (via CSS)
    if (t.status === 'dispatched') {
      const s = fleetData.find(x => x.num === t.assignedTo);
      return fleetHexSvg(s && s.state === 'working' ? 'working' : 'off');
    }
    return fleetHexSvg('off'); // purple for queued/snoozed/completed/failed
  }

  // Update task hex icons in-place when fleet state changes (without full re-render)
  function updateTaskHexIcons() {
    if (activeTab !== 'tasks-panel') return;
    tasksScroll.querySelectorAll('.task-card').forEach(card => {
      const t = tasks.find(x => x.id === card.dataset.id);
      if (!t || t.status !== 'dispatched') return;
      const hexEl = card.querySelector('.task-hex');
      if (hexEl) hexEl.innerHTML = taskHexSvg(t);
    });
  }

  function taskCardHtml(t, tabType) {
    const ago = timeAgo(t.createdAt);
    const selected = tasksSelectedTaskId === t.id ? ' selected' : '';
    const sourceLabel = t.source ? t.source.replace(/^pm:/, '') : '';
    const sourceBadge = sourceLabel ? `<span class="task-source-badge">${esc(sourceLabel)}</span>` : '';
    const checked = selectedTaskIds.has(t.id) ? ' checked' : '';
    const hex = taskHexSvg(t);

    // Pending-complete indicator
    let pendingBadge = '';
    if (t.pendingResult) {
      pendingBadge = `<span class="task-wait" style="color:var(--yellow);font-weight:600">pending approval</span>`;
    }

    // Waiting indicator for dispatched tasks
    let waitBadge = '';
    if (tabType === 'inprogress' && t.lastActivityAt) {
      const waitMs = Date.now() - t.lastActivityAt;
      const waitMin = Math.round(waitMs / 60000);
      const s = fleetData.find(x => x.num === t.assignedTo);
      const isIdle = s && s.state !== 'working';
      if (isIdle && waitMin >= 1) {
        const waitStr = waitMin >= 60 ? `${Math.round(waitMin / 60)}h` : `${waitMin}m`;
        const color = waitMin >= 15 ? 'var(--red)' : waitMin >= 5 ? 'var(--yellow)' : 'var(--dim)';
        waitBadge = `<span class="task-wait" style="color:${color}">waiting ${waitStr}</span>`;
      }
    }

    // Build actions (hidden by default, shown on hover/select)
    let actions = '';
    if (tabType === 'inprogress') {
      const sessionBadge = t.assignedTo ? `<span class="task-session-badge">S:${t.assignedTo}</span>` : '';
      const pendingBtns = t.pendingResult ? [
        hasPerm('cancel') ? `<button class="task-approve-btn" data-id="${t.id}" style="background:var(--green);color:#fff">Approve</button>` : '',
        hasPerm('cancel') ? `<button class="task-reject-btn" data-id="${t.id}" style="background:var(--red);color:#fff">Reject</button>` : '',
      ].filter(Boolean).join('') : '';
      const btns = [
        hasPerm('dispatch') ? `<button class="task-snooze-btn" data-id="${t.id}">Snooze</button>` : '',
        hasPerm('dispatch') ? `<button class="task-requeue-btn" data-id="${t.id}">Requeue</button>` : '',
        hasPerm('cancel') ? `<button class="task-done-btn" data-id="${t.id}">Done</button>` : '',
        hasPerm('cancel') ? `<button class="task-cancel" data-id="${t.id}">Cancel</button>` : '',
      ].filter(Boolean).join('');
      actions = `<div class="task-actions">${sessionBadge}${pendingBtns}${btns}</div>`;
    } else if (tabType === 'queued') {
      const btns = [
        hasPerm('create-tasks') ? `<button class="task-edit-btn" data-id="${t.id}">Edit</button>` : '',
        hasPerm('dispatch') ? `<button class="task-assign-btn" data-id="${t.id}">Assign</button>` : '',
        hasPerm('dispatch') ? `<button class="task-snooze-btn" data-id="${t.id}">Snooze</button>` : '',
        hasPerm('cancel') ? `<button class="task-cancel" data-id="${t.id}">Cancel</button>` : '',
      ].filter(Boolean).join('');
      actions = `<div class="task-actions">${btns}</div>`;
    } else if (tabType === 'snoozed') {
      const wakeTime = t.snoozedUntil ? new Date(t.snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const wakeDate = t.snoozedUntil && (t.snoozedUntil - Date.now() > 12 * 3600000) ? new Date(t.snoozedUntil).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '';
      const btns = [
        hasPerm('dispatch') ? `<button class="task-wake-btn" data-id="${t.id}">Wake</button>` : '',
        hasPerm('cancel') ? `<button class="task-cancel" data-id="${t.id}">Cancel</button>` : '',
      ].filter(Boolean).join('');
      actions = `<div class="task-actions"><span class="task-wake-time">wakes ${wakeDate}${wakeTime}</span>${btns}</div>`;
    } else {
      // completed
      const resumeBtn = t.assignedTo ? `<button class="task-resume-btn" data-id="${t.id}" data-session="${t.assignedTo}">Resume</button>` : '';
      if (resumeBtn) actions = `<div class="task-actions">${resumeBtn}</div>`;
    }

    // Time info
    let timeStr = ago;
    if (tabType === 'inprogress') timeStr = timeAgo(t.dispatchedAt || t.createdAt);
    else if (tabType === 'completed' && t.dispatchedAt && t.completedAt) {
      timeStr = `${Math.round((t.completedAt - t.dispatchedAt) / 60000)}m · ${ago}`;
    }

    return `<div class="task-card-row"><input type="checkbox" class="task-checkbox" data-id="${t.id}"${checked}><div class="task-card ${t.status}${selected}" data-id="${t.id}">
      <div class="task-top"><span class="task-hex">${hex}</span><div class="task-body"><div class="task-text">${esc(t.text)}</div><div class="task-info">${sourceBadge}${pendingBadge}${waitBadge}<span class="task-time">${timeStr}</span></div></div></div>${actions}</div></div>`;
  }

  // ── Comment panel (rendered into tab content divs) ─────
  var commentPanelTaskId = null;

  // target: 'tasks' (default) renders into #ts-comments-drawer, 'session' into #session-comments-drawer
  function renderCommentPanel(taskId, target) {
    if (!taskId) taskId = commentPanelTaskId;
    if (!taskId) return;
    commentPanelTaskId = taskId;
    const task = tasks.find(t => t.id === taskId);
    const comments = (task && task.comments) || [];

    // Render into both containers so switching between views stays in sync
    const containers = [];
    const tsEl = document.getElementById('ts-comments-drawer');
    const sessEl = document.getElementById('session-comments-drawer');
    if (tsEl) containers.push(tsEl);
    if (sessEl) containers.push(sessEl);
    if (!containers.length) return;

    // Build HTML
    let html = `<div class="comment-panel"><div class="comment-panel-title">Comments (${comments.length})</div>`;
    for (const c of comments) {
      const canDelete = currentUser && (c.author === currentUser.login || hasPerm('admin'));
      const delBtn = canDelete ? `<button class="comment-delete" data-task-id="${taskId}" data-comment-id="${c.id}" title="Delete">&times;</button>` : '';
      html += `<div class="comment-item">
        <div class="comment-body">
          <span class="comment-author">${esc(c.authorName || c.author)}</span>
          <span class="comment-time">${timeAgo(c.createdAt)}</span>
          <div class="comment-text">${esc(c.text)}</div>
        </div>
        ${delBtn}
      </div>`;
    }
    if (hasPerm('comment')) {
      html += `<div class="comment-input-row">
        <input class="comment-input" type="text" placeholder="Add a comment..." autocomplete="off">
        <button class="comment-send">Post</button>
      </div>`;
    }
    html += '</div>';

    for (const container of containers) {
      container.innerHTML = html;
      // Wire comment send
      const commentInput = container.querySelector('.comment-input');
      const commentSendBtn = container.querySelector('.comment-send');
      if (commentSendBtn && commentInput) {
        commentSendBtn.addEventListener('click', () => sendComment(taskId, commentInput));
        commentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendComment(taskId, commentInput); } });
      }
      // Wire delete buttons
      container.querySelectorAll('.comment-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'task:comment:delete', taskId: btn.dataset.taskId, commentId: btn.dataset.commentId }));
          }
        });
      });
    }

    // Update badges
    updateCommentBadge('tasks', task);
    updateCommentBadge('session', task);
  }

  function updateCommentBadge(target, task) {
    const count = (task && task.comments && task.comments.length) || 0;
    const label = count > 0 ? `Comments (${count})` : 'Comments';
    if (target === 'tasks') {
      const btn = document.getElementById('ts-comments-toggle');
      if (btn) { btn.style.display = task ? '' : 'none'; btn.textContent = label; btn.classList.toggle('has-comments', count > 0); }
    } else {
      const btn = document.getElementById('session-comments-toggle');
      if (btn) { btn.style.display = task ? '' : 'none'; btn.textContent = label; btn.classList.toggle('has-comments', count > 0); }
    }
  }

  function sendComment(taskId, inputEl) {
    const text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'task:comment:add', taskId, text }));
    inputEl.value = '';
  }

  // ── Admin panel (user permissions in More tab) ───
  var PERM_LABELS = {
    'view': 'View', 'comment': 'Comment', 'create-tasks': 'Create Tasks',
    'send-messages': 'Send Messages', 'cancel': 'Cancel', 'restart': 'Restart',
    'dispatch': 'Dispatch', 'admin': 'Admin',
  };

  function renderUsers() {
    const section = document.getElementById('admin-users-section');
    const list = document.getElementById('admin-users-list');
    if (!section || !list) return;
    if (!hasPerm('admin')) { section.classList.add('perm-hidden'); return; }
    section.classList.remove('perm-hidden');
    if (!allUsers.length) { list.innerHTML = '<div class="git-empty">No users registered yet.</div>'; return; }
    let html = '';
    for (const u of allUsers) {
      const avatarHtml = u.avatar ? `<img class="admin-user-avatar" src="${esc(u.avatar)}" alt="">` : '';
      const isSelf = currentUser && currentUser.login && u.login.toLowerCase() === currentUser.login.toLowerCase();
      const removeBtnHtml = isSelf ? '' : `<button class="admin-remove-user-btn" data-login="${esc(u.login)}" title="Remove user" style="background:none;border:none;color:#ff5555;cursor:pointer;font-size:16px;padding:2px 6px;line-height:1">&times;</button>`;
      let permsHtml = '';
      const isUserAdmin = u.permissions.includes('admin');
      const allPerms = ['admin', 'view', 'comment', 'create-tasks', 'send-messages', 'cancel', 'restart', 'dispatch'];
      for (const p of allPerms) {
        const active = u.permissions.includes(p);
        const cls = active ? (p === 'admin' ? 'active admin-perm' : 'active') : '';
        const hidden = p !== 'admin' && isUserAdmin ? ' style="display:none"' : '';
        permsHtml += `<span class="admin-perm-chip ${cls}" data-login="${esc(u.login)}" data-perm="${p}"${hidden}>${PERM_LABELS[p]}</span>`;
      }
      html += `<div class="admin-user-row">
        ${avatarHtml}
        <div class="admin-user-info">
          <div class="admin-user-name">${esc(u.name || u.login)}</div>
          <div class="admin-user-login">${esc(u.login)}</div>
        </div>
        <div class="admin-perms">${permsHtml}</div>
        ${removeBtnHtml}
      </div>`;
    }
    list.innerHTML = html;
    // Wire perm chip clicks
    list.querySelectorAll('.admin-perm-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const login = chip.dataset.login;
        const perm = chip.dataset.perm;
        const u = allUsers.find(x => x.login === login);
        if (!u) return;
        // Prevent self-demotion of admin
        if (login === (currentUser && currentUser.login) && perm === 'admin') {
          showToast('Denied', 'Cannot remove your own admin permission', 'error');
          return;
        }
        let newPerms;
        if (u.permissions.includes(perm)) {
          newPerms = u.permissions.filter(p => p !== perm);
        } else {
          newPerms = [...u.permissions, perm];
        }
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'users:setPermissions', login, permissions: newPerms }));
        }
      });
    });
    // Wire remove user buttons
    list.querySelectorAll('.admin-remove-user-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const login = btn.dataset.login;
        if (confirm(`Remove user "${login}"? They will no longer be able to log in.`)) {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'users:remove', login }));
          }
        }
      });
    });
  }

  // Wire add user form
  (function wireAddUserForm() {
    const btn = document.getElementById('admin-add-user-btn');
    const input = document.getElementById('admin-add-user-input');
    if (!btn || !input) return;
    function doAdd() {
      const login = input.value.trim();
      if (!login) return;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'users:add', login }));
        input.value = '';
      }
    }
    btn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
  })();

  // ── Checklist popup + templates ────────────────────

  function getActiveTaskForChecklist(context) {
    // context: 'session' or 'tasks'
    if (context === 'session' && currentSession) {
      return tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === String(currentSession));
    }
    if (context === 'tasks') {
      // Use the selected task in the tasks panel
      if (tasksSelectedTaskId) {
        return tasks.find(t => t.id === tasksSelectedTaskId);
      }
      // Fallback to dispatched task for session
      if (tasksSessionNum) {
        return tasks.find(t => t.status === 'dispatched' && String(t.assignedTo) === String(tasksSessionNum));
      }
    }
    return null;
  }

  function updateChecklistButtons() {
    ['session', 'tasks'].forEach(ctx => {
      const tab = document.getElementById(ctx === 'session' ? 'session-checklist-tab' : 'ts-checklist-tab');
      if (!tab) return;
      const task = getActiveTaskForChecklist(ctx);
      if (!task) { tab.style.display = 'none'; return; }
      tab.style.display = '';
      const cl = task.checklist || [];
      const done = cl.filter(i => i.checked).length;
      const total = cl.length;
      tab.textContent = total > 0 ? `Checklist (${done}/${total})` : 'Checklist';
      tab.className = 'session-tab checklist-tab';
      if (total > 0 && done === total) tab.classList.add('done');
      else if (total > 0 && done > 0) tab.classList.add('partial');
    });
  }

  function closeChecklistPopup() {
    checklistPopupTaskId = null;
    document.querySelectorAll('.checklist-popup').forEach(p => p.remove());
  }

  function renderChecklistPopup(taskId, anchorBtn) {
    closeChecklistPopup();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    checklistPopupTaskId = taskId;

    const popup = document.createElement('div');
    popup.className = 'checklist-popup';

    const cl = task.checklist || [];
    const done = cl.filter(i => i.checked).length;

    let html = `<div class="checklist-popup-header"><span>Checklist ${cl.length > 0 ? done + '/' + cl.length : ''}</span><button class="checklist-popup-close">&times;</button></div>`;
    html += '<div class="checklist-popup-items">';
    for (const item of cl) {
      html += `<div class="checklist-item" data-item-id="${item.id}">
        <input type="checkbox" ${item.checked ? 'checked' : ''}>
        <span class="checklist-item-text ${item.checked ? 'checked' : ''}">${esc(item.text)}</span>
        <button class="checklist-item-del" title="Remove">&times;</button>
      </div>`;
    }
    if (cl.length === 0) {
      html += '<div style="padding:12px;color:var(--dim);font-size:12px;text-align:center">No items yet. Add one below or use a template.</div>';
    }
    html += '</div>';
    html += `<div class="checklist-popup-add">
      <input type="text" placeholder="Add item..." autocomplete="off">
      <button>Add</button>
    </div>`;
    if (checklistTemplates.length > 0) {
      html += '<div class="checklist-popup-template"><select><option value="">Use template...</option>';
      for (const tpl of checklistTemplates) {
        html += `<option value="${esc(tpl.name)}">${esc(tpl.name)} (${tpl.items.length} items)</option>`;
      }
      html += '</select></div>';
    }
    popup.innerHTML = html;

    // Position anchored to the tab bar (drops down from tabs)
    const tabBar = anchorBtn.closest('.tasks-session-tabs, .session-tabs');
    if (tabBar) {
      tabBar.style.position = 'relative';
      tabBar.appendChild(popup);
    } else {
      anchorBtn.parentElement.style.position = 'relative';
      anchorBtn.parentElement.appendChild(popup);
    }

    // Wire events
    popup.querySelector('.checklist-popup-close').addEventListener('click', closeChecklistPopup);

    popup.querySelectorAll('.checklist-item input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const itemId = cb.closest('.checklist-item').dataset.itemId;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:checklist:toggle', taskId, itemId }));
      });
    });

    popup.querySelectorAll('.checklist-item-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const itemId = btn.closest('.checklist-item').dataset.itemId;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:checklist:remove', taskId, itemId }));
      });
    });

    const addInput = popup.querySelector('.checklist-popup-add input');
    const addBtn = popup.querySelector('.checklist-popup-add button');
    function doAdd() {
      const text = addInput.value.trim();
      if (!text) return;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:checklist:add', taskId, text }));
      addInput.value = '';
    }
    addBtn.addEventListener('click', doAdd);
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

    const tplSelect = popup.querySelector('.checklist-popup-template select');
    if (tplSelect) {
      tplSelect.addEventListener('change', () => {
        const templateName = tplSelect.value;
        if (!templateName) return;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'task:checklist:seed', taskId, templateName }));
        tplSelect.value = '';
      });
    }
  }

  // Wire checklist tab buttons
  document.getElementById('session-checklist-tab').addEventListener('click', (e) => {
    e.stopPropagation();
    const task = getActiveTaskForChecklist('session');
    if (!task) return;
    if (checklistPopupTaskId === task.id) { closeChecklistPopup(); return; }
    renderChecklistPopup(task.id, e.currentTarget);
  });

  document.getElementById('ts-checklist-tab').addEventListener('click', (e) => {
    e.stopPropagation();
    const task = getActiveTaskForChecklist('tasks');
    if (!task) return;
    if (checklistPopupTaskId === task.id) { closeChecklistPopup(); return; }
    renderChecklistPopup(task.id, e.currentTarget);
  });

  // Close popup on click outside
  document.addEventListener('click', (e) => {
    if (!checklistPopupTaskId) return;
    if (e.target.closest('.checklist-popup') || e.target.closest('.checklist-tab')) return;
    closeChecklistPopup();
  });

  // Re-render popup when task updates come in
  function refreshChecklistPopup() {
    if (!checklistPopupTaskId) return;
    const task = tasks.find(t => t.id === checklistPopupTaskId);
    if (!task) { closeChecklistPopup(); return; }
    const existingPopup = document.querySelector('.checklist-popup');
    if (!existingPopup) return;
    const anchorTab = existingPopup.parentElement.querySelector('.checklist-tab');
    if (anchorTab) renderChecklistPopup(checklistPopupTaskId, anchorTab);
  }

  // ── Actions popup (contextual task actions) ─────────
  let actionsPopupTaskId = null;
  let actionConfirmTaskId = null;
  let actionConfirmActionId = null;

  // Task confirm dialog state (cancel/requeue/snooze)
  let _confirmAction = null; // { type: 'cancel'|'requeue'|'snooze', taskId, durationMs? }

  function openTaskConfirmDialog(type, taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const titleEl = document.getElementById('task-confirm-title');
    const bodyEl = document.getElementById('task-confirm-body');
    const submitEl = document.getElementById('task-confirm-submit');
    const picker = document.getElementById('task-confirm-snooze-picker');
    const snippet = (task.text || '').slice(0, 80);
    _confirmAction = { type, taskId };
    if (type === 'cancel') {
      titleEl.textContent = 'Cancel Task';
      bodyEl.textContent = `Cancel "${snippet}"?`;
      submitEl.textContent = 'Cancel Task';
      submitEl.style.background = 'var(--red)';
      picker.style.display = 'none';
    } else if (type === 'requeue') {
      titleEl.textContent = 'Requeue Task';
      bodyEl.textContent = `Return "${snippet}" to the queue?`;
      submitEl.textContent = 'Requeue';
      submitEl.style.background = 'var(--orange)';
      picker.style.display = 'none';
    } else if (type === 'snooze') {
      titleEl.textContent = 'Snooze Task';
      bodyEl.textContent = `Snooze "${snippet}" for:`;
      submitEl.textContent = 'Snooze';
      submitEl.style.background = 'var(--cyan)';
      picker.style.display = '';
      _confirmAction.durationMs = 3600000; // default 1h
      // Reset preset selection
      picker.querySelectorAll('.snooze-preset-btn').forEach(b => b.classList.toggle('selected', b.dataset.ms === '3600000'));
      document.getElementById('snooze-custom-minutes').value = '';
    }
    document.getElementById('task-confirm-dialog').classList.add('visible');
  }

  function closeTaskConfirmDialog() {
    document.getElementById('task-confirm-dialog').classList.remove('visible');
    _confirmAction = null;
  }

  // Snooze preset buttons
  document.querySelectorAll('#task-confirm-snooze-picker .snooze-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#task-confirm-snooze-picker .snooze-preset-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('snooze-custom-minutes').value = '';
      if (_confirmAction) _confirmAction.durationMs = Number(btn.dataset.ms);
    });
  });

  document.getElementById('snooze-custom-minutes').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (val > 0 && _confirmAction) {
      _confirmAction.durationMs = val * 60000;
      document.querySelectorAll('#task-confirm-snooze-picker .snooze-preset-btn').forEach(b => b.classList.remove('selected'));
    }
  });

  document.getElementById('task-confirm-submit').addEventListener('click', () => {
    if (!_confirmAction || !ws || ws.readyState !== 1) return;
    const { type, taskId, durationMs } = _confirmAction;
    if (type === 'cancel') {
      ws.send(JSON.stringify({ type: 'task:cancel', taskId }));
      showToast('Cancelled', 'Task cancelled', 'success');
    } else if (type === 'requeue') {
      ws.send(JSON.stringify({ type: 'task:requeue', taskId }));
      showToast('Requeued', 'Task moved back to queue', 'success');
    } else if (type === 'snooze') {
      ws.send(JSON.stringify({ type: 'task:snooze', taskId, durationMs }));
      const label = durationMs >= 86400000 ? `${Math.round(durationMs / 86400000)}d` : durationMs >= 3600000 ? `${Math.round(durationMs / 3600000)}h` : `${Math.round(durationMs / 60000)}m`;
      showToast('Snoozed', `Task snoozed for ${label}`, 'success');
    }
    closeTaskConfirmDialog();
  });

  document.getElementById('task-confirm-cancel').addEventListener('click', closeTaskConfirmDialog);

  // --- Rename dialog ---
  function openRenameDialog(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const input = document.getElementById('task-rename-input');
    input.value = task.text || '';
    document.getElementById('task-rename-dialog').dataset.taskId = taskId;
    document.getElementById('task-rename-dialog').classList.add('visible');
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  function closeRenameDialog() {
    document.getElementById('task-rename-dialog').classList.remove('visible');
  }

  document.getElementById('task-rename-submit').addEventListener('click', () => {
    const dialog = document.getElementById('task-rename-dialog');
    const taskId = dialog.dataset.taskId;
    const newText = document.getElementById('task-rename-input').value.trim();
    if (!newText || !taskId || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'task:rename', taskId, text: newText }));
    showToast('Renamed', 'Task title updated', 'success');
    closeRenameDialog();
  });

  document.getElementById('task-rename-cancel').addEventListener('click', closeRenameDialog);

  document.getElementById('task-rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('task-rename-submit').click();
    } else if (e.key === 'Escape') {
      closeRenameDialog();
    }
  });

  function getActiveTaskForActions(ctx) {
    if (ctx === 'tasks') {
      return tasksSelectedTaskId ? tasks.find(t => t.id === tasksSelectedTaskId) : null;
    }
    return null;
  }

  function updateActionsButton() {
    const tab = document.getElementById('ts-actions-tab');
    if (!tab) return;
    const task = getActiveTaskForActions('tasks');
    if (!task || !task.actions || !task.actions.length) { tab.style.display = 'none'; return; }
    tab.style.display = '';
    tab.textContent = `\u26A1 Actions (${task.actions.length})`;
    tab.className = 'session-tab actions-tab';
  }

  function closeActionsPopup() {
    actionsPopupTaskId = null;
    document.querySelectorAll('.actions-popup').forEach(p => p.remove());
  }

  function renderActionsPopup(taskId, anchorBtn) {
    closeActionsPopup();
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.actions || !task.actions.length) return;
    actionsPopupTaskId = taskId;

    const popup = document.createElement('div');
    popup.className = 'actions-popup';

    let html = `<div class="actions-popup-header"><span>Actions</span><button class="actions-popup-close">&times;</button></div>`;
    html += '<div class="actions-popup-items">';
    for (const a of task.actions) {
      const confirmIcon = a.confirm ? '<span class="action-confirm-icon" title="Requires confirmation">\u26A0</span>' : '';
      html += `<button class="actions-popup-item" data-task-id="${task.id}" data-action-id="${a.id}" data-confirm="${!!a.confirm}" style="color:${a.color}"><span class="action-label">${esc(a.label)}</span>${confirmIcon}</button>`;
    }
    html += '</div>';
    popup.innerHTML = html;

    // Find best parent: task-detail toolbar, session tabs, or fallback
    const detailToolbar = anchorBtn.closest('#task-detail-toolbar');
    const tabBar = anchorBtn.closest('.tasks-session-tabs, .session-tabs');
    const parent = detailToolbar || tabBar || anchorBtn.parentElement;
    parent.style.position = 'relative';
    parent.appendChild(popup);

    popup.querySelector('.actions-popup-close').addEventListener('click', closeActionsPopup);

    popup.querySelectorAll('.actions-popup-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openActionConfirmDialog(btn.dataset.taskId, btn.dataset.actionId, btn.querySelector('.action-label').textContent);
      });
    });
  }

  function sendTaskAction(taskId, actionId, closeTask, btn) {
    if (!ws || ws.readyState !== 1) return;
    if (btn) btn.classList.add('loading');
    ws.send(JSON.stringify({ type: 'task:action', taskId, actionId, closeTask: !!closeTask }));
  }

  function openActionConfirmDialog(taskId, actionId, label) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    actionConfirmTaskId = taskId;
    actionConfirmActionId = actionId;

    const action = (task.actions || []).find(a => a.id === actionId);
    const title = action ? action.label : label;
    const ctx = task.actionContext || {};
    let detail = '';
    if (ctx.type === 'github-pr') detail = `PR #${ctx.prNumber} in ${ctx.repo}`;

    document.getElementById('action-confirm-title').textContent = `Confirm: ${title}`;
    document.getElementById('action-confirm-body').textContent = detail ? `This will ${title.toLowerCase()} for ${detail}` : `This will ${title.toLowerCase()} this task`;
    document.getElementById('action-confirm-submit').style.background = action ? action.color : 'var(--red)';
    document.getElementById('action-confirm-close-task').checked = true;
    document.getElementById('action-confirm-dialog').classList.add('visible');
  }

  document.getElementById('action-confirm-submit').addEventListener('click', () => {
    if (actionConfirmTaskId && actionConfirmActionId) {
      const btn = document.querySelector(`.actions-popup-item[data-task-id="${actionConfirmTaskId}"][data-action-id="${actionConfirmActionId}"]`);
      const closeTask = document.getElementById('action-confirm-close-task').checked;
      sendTaskAction(actionConfirmTaskId, actionConfirmActionId, closeTask, btn);
    }
    document.getElementById('action-confirm-dialog').classList.remove('visible');
    document.getElementById('action-confirm-close-task').checked = false;
    actionConfirmTaskId = null;
    actionConfirmActionId = null;
  });

  document.getElementById('action-confirm-cancel').addEventListener('click', () => {
    document.getElementById('action-confirm-dialog').classList.remove('visible');
    document.getElementById('action-confirm-close-task').checked = false;
    actionConfirmTaskId = null;
    actionConfirmActionId = null;
  });

  // Wire actions tab button
  document.getElementById('ts-actions-tab').addEventListener('click', (e) => {
    e.stopPropagation();
    const task = getActiveTaskForActions('tasks');
    if (!task) return;
    if (actionsPopupTaskId === task.id) { closeActionsPopup(); return; }
    renderActionsPopup(task.id, e.currentTarget);
  });

  // Close actions popup on click outside
  document.addEventListener('click', (e) => {
    if (!actionsPopupTaskId) return;
    if (e.target.closest('.actions-popup') || e.target.closest('.actions-tab') || e.target.closest('.td-actions-btn') || e.target.closest('#task-detail-ctx-actions')) return;
    if (e.target.closest('#action-confirm-dialog')) return;
    closeActionsPopup();
  });

  // Auto-open actions popup when task with actions is selected
  function autoOpenActionsPopup() {
    const task = getActiveTaskForActions('tasks');
    if (!task || !task.actions || !task.actions.length) { closeActionsPopup(); return; }
    const tab = document.getElementById('ts-actions-tab');
    if (tab && tab.style.display !== 'none') {
      renderActionsPopup(task.id, tab);
    }
  }

  // ── Checklist template management (More panel) ─────

  function renderChecklistTemplates() {
    const list = document.getElementById('checklist-tpl-list');
    if (!list) return;
    if (!checklistTemplates.length) {
      list.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:4px">No templates yet.</div>';
      return;
    }
    let html = '';
    for (const tpl of checklistTemplates) {
      html += `<div class="checklist-tpl-item" data-name="${esc(tpl.name)}">
        <span class="checklist-tpl-name">${esc(tpl.name)}</span>
        <span class="checklist-tpl-count">${tpl.items.length} item${tpl.items.length !== 1 ? 's' : ''}</span>
        <span class="checklist-tpl-actions">
          <button class="cl-tpl-edit" title="Edit">Edit</button>
          <button class="cl-tpl-del" title="Delete">&times;</button>
        </span>
      </div>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('.cl-tpl-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.closest('.checklist-tpl-item').dataset.name;
        const tpl = checklistTemplates.find(t => t.name === name);
        if (tpl) openChecklistTplDialog(tpl);
      });
    });
    list.querySelectorAll('.cl-tpl-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.closest('.checklist-tpl-item').dataset.name;
        if (confirm(`Delete template "${name}"?`)) {
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'checklistTemplate:delete', name }));
        }
      });
    });
  }

  let editingChecklistTplName = null;
  const checklistTplDialog = document.getElementById('checklist-tpl-dialog');

  document.getElementById('checklist-tpl-add-btn').addEventListener('click', () => openChecklistTplDialog(null));
  document.getElementById('checklist-tpl-cancel').addEventListener('click', closeChecklistTplDialog);
  checklistTplDialog.addEventListener('click', (e) => { if (e.target === checklistTplDialog) closeChecklistTplDialog(); });

  function openChecklistTplDialog(tpl) {
    editingChecklistTplName = tpl ? tpl.name : null;
    document.getElementById('checklist-tpl-dialog-title').textContent = tpl ? 'Edit Checklist Template' : 'New Checklist Template';
    document.getElementById('checklist-tpl-form-name').value = tpl ? tpl.name : '';
    document.getElementById('checklist-tpl-form-items').value = tpl ? tpl.items.join('\n') : '';
    checklistTplDialog.classList.add('visible');
  }

  function closeChecklistTplDialog() { checklistTplDialog.classList.remove('visible'); editingChecklistTplName = null; }

  document.getElementById('checklist-tpl-save').addEventListener('click', () => {
    const name = document.getElementById('checklist-tpl-form-name').value.trim();
    const itemsRaw = document.getElementById('checklist-tpl-form-items').value;
    const items = itemsRaw.split('\n').map(s => s.trim()).filter(Boolean);
    if (!name) { showToast('Error', 'Name required', 'error'); return; }
    if (!items.length) { showToast('Error', 'At least one item required', 'error'); return; }
    // If renaming, delete old first
    if (editingChecklistTplName && editingChecklistTplName !== name) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'checklistTemplate:delete', name: editingChecklistTplName }));
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'checklistTemplate:set', name, items }));
    closeChecklistTplDialog();
  });

  function updatePmChecklistTplSelector() {
    const sel = document.getElementById('pm-form-checklist-tpl');
    if (!sel) return;
    const val = sel.value;
    sel.innerHTML = '<option value="">None</option>';
    for (const tpl of checklistTemplates) {
      sel.innerHTML += `<option value="${esc(tpl.name)}">${esc(tpl.name)}</option>`;
    }
    sel.value = val;
  }

  // ── Notifications panel ──────────────────────────
  $('#feed-clear-btn').addEventListener('click', () => {
    feedEntries = [];
    feedScroll.innerHTML = '<div class="notif-empty">No notifications</div>';
    unreadFeedCount = 0; updateFeedBadge();
  });

  function renderFeed() {
    feedScroll.innerHTML = '';
    if (!feedEntries.length) {
      feedScroll.innerHTML = '<div class="notif-empty">No notifications</div>';
      return;
    }
    const reversed = [...feedEntries].reverse();
    let dividerPlaced = false;
    for (const entry of reversed) {
      if (!dividerPlaced && lastSeenFeedId && entry.id === lastSeenFeedId && reversed.indexOf(entry) > 0) {
        const divider = document.createElement('div');
        divider.className = 'notif-divider';
        divider.textContent = 'new';
        feedScroll.appendChild(divider);
        dividerPlaced = true;
      }
      renderFeedEntry(entry, false);
    }
    if (feedHasMore) {
      const loadBtn = document.createElement('button');
      loadBtn.className = 'notif-load-more';
      loadBtn.textContent = 'Load older';
      loadBtn.addEventListener('click', () => {
        if (ws && ws.readyState === 1 && feedEntries.length)
          ws.send(JSON.stringify({ type: 'feed:get', before: feedEntries[0].id, limit: 50 }));
      });
      feedScroll.appendChild(loadBtn);
    }
  }

  function renderFeedEntry(entry, prepend) {
    const el = document.createElement('div');
    el.className = `notif-item type-${entry.type}`;
    el.dataset.id = entry.id;

    // Icon by type
    const icons = { state: '⬤', task: '◆', ci: '⚙', approval: '⚑', broadcast: '📢' };
    const icon = icons[entry.type] || '•';

    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sessionBadge = entry.session ? `<span class="notif-session">${entry.session}</span>` : '';

    el.innerHTML = `
      <span class="notif-icon">${icon}</span>
      <div class="notif-body">
        <span class="notif-text">${esc(entry.detail)}</span>
        <span class="notif-time">${time}</span>
      </div>
      ${sessionBadge}`;

    // Click → open session
    if (entry.session) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const s = fleetData.find(x => x.num === parseInt(entry.session));
        if (s) openSession(s);
      });
    }

    if (prepend) feedScroll.insertBefore(el, feedScroll.firstChild);
    else feedScroll.appendChild(el);
  }

  // ── More panel inner tabs ──────────────────────────
  document.querySelectorAll('.more-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.more-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.more-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.moreTab).classList.add('active');
      if (tab.dataset.moreTab === 'more-update' && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'update:status' }));
      }
      if (tab.dataset.moreTab === 'more-automation') renderPMs();
    });
  });

  // ── Integrations ─────────────────────────────────
  const INT_FIELDS = {
    github: ['GITHUB_TOKEN'],
    jenkins: ['JENKINS_URL', 'JENKINS_USER', 'JENKINS_API_TOKEN'],
    slack: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    jira: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
  };

  function getIntegrationValues(name) {
    const values = {};
    const card = document.querySelector(`.integration-card[data-integration="${name}"]`);
    if (!card) return values;
    card.querySelectorAll('input[data-env]').forEach(inp => {
      if (inp.value.trim()) values[inp.dataset.env] = inp.value.trim();
    });
    return values;
  }

  function setIntegrationStatus(name, status, text) {
    const el = document.getElementById(name + '-status');
    if (!el) return;
    el.className = 'integration-status' + (status ? ' ' + status : '');
    el.textContent = text;
  }

  function setIntegrationResult(name, text, isError) {
    const el = document.getElementById(name + '-result');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? 'var(--red)' : 'var(--green)';
  }

  document.querySelectorAll('.int-save-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.integration;
      const values = getIntegrationValues(name);
      if (!Object.keys(values).length) return;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'integration:save', integration: name, values }));
      }
    });
  });

  document.querySelectorAll('.int-test-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.integration;
      const values = getIntegrationValues(name);
      if (!Object.keys(values).length) return;
      setIntegrationResult(name, 'Testing...', false);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'integration:test', integration: name, values }));
      }
    });
  });

  // ── MCP tools ───────────────────────────────────────
  var MCP_TOOLS = [
    { name: 'hive_get_task', desc: 'Get your currently assigned task from hive' },
    { name: 'hive_complete_task', desc: 'Mark your current task as complete' },
    { name: 'hive_post_update', desc: 'Post a status update to the hive activity feed' },
    { name: 'hive_get_sessions', desc: 'Get the status of all active sessions' },
    { name: 'hive_report_learnings', desc: 'Report learnings/insights discovered during this task' },
    { name: 'hive_get_context', desc: 'Get shared context for this session (plan file, PR, JIRA, etc.)' },
    { name: 'hive_set_context', desc: 'Share context with hive (plan file path, PR URL, JIRA key, etc.)' },
    { name: 'hive_share_knowledge', desc: 'Share an insight with the fleet knowledge base' },
    { name: 'hive_get_knowledge', desc: 'Query the fleet knowledge base for insights about files or domains' },
    { name: 'hive_set_working_dir', desc: 'Tell hive which git repo you are working in (e.g. a worktree)' },
    { name: 'hive_create_task', desc: 'Create a new task in the hive queue for another session to pick up' },
  ];

  function renderMcpTools(enabledTools) {
    const list = document.getElementById('mcp-tools-list');
    if (!list) return;
    list.innerHTML = MCP_TOOLS.map(t => `
      <div class="mcp-tool-card">
        <div class="mcp-tool-header">
          <span class="mcp-tool-name">${t.name}</span>
          <label class="mcp-toggle">
            <input type="checkbox" ${enabledTools.includes(t.name) ? 'checked' : ''} data-tool="${t.name}">
            <span class="mcp-toggle-slider"></span>
          </label>
        </div>
        <div class="mcp-tool-desc">${t.desc}</div>
      </div>
    `).join('');
  }

  // Initial render — all enabled by default
  renderMcpTools(MCP_TOOLS.map(t => t.name));

  document.getElementById('mcp-deploy-btn').addEventListener('click', () => {
    const enabled = [];
    document.querySelectorAll('#mcp-tools-list input[data-tool]').forEach(cb => {
      if (cb.checked) enabled.push(cb.dataset.tool);
    });
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'mcp:deploy', tools: enabled }));
    }
    document.getElementById('mcp-result').textContent = 'Deploying & restarting MCP...';
  });

  document.getElementById('mcp-remove-btn').addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'mcp:remove' }));
    }
    document.getElementById('mcp-result').textContent = 'Removing...';
  });

  // ── MCP Restart confirmation ──────────────────────
  var mcpRestartDialog = document.getElementById('mcp-restart-dialog');
  function showMcpRestartConfirm(count) {
    document.getElementById('mcp-restart-msg').textContent = count != null
      ? `MCP config deployed to ${count} session(s). Sessions need to restart to pick up the new tools.`
      : 'This will restart all fleet sessions with /exit + claude --continue.';
    mcpRestartDialog.classList.add('visible');
  }
  document.getElementById('mcp-restart-skip-btn').addEventListener('click', () => {
    mcpRestartDialog.classList.remove('visible');
  });
  mcpRestartDialog.addEventListener('click', (e) => { if (e.target === mcpRestartDialog) mcpRestartDialog.classList.remove('visible'); });
  document.getElementById('mcp-restart-confirm-btn').addEventListener('click', () => {
    mcpRestartDialog.classList.remove('visible');
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'restart:all' }));
      showToast('Restarting', 'Cycling all sessions — /exit + claude --continue...', 'info');
    }
  });

  // ── More panel ────────────────────────────────────
  function toggleAutoLocal(num) {
    if (autoSessions.has(num)) autoSessions.delete(num); else autoSessions.add(num);
    renderAutoGrid(); if (activeTab === 'fleet-panel') renderGrid();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'auto:toggle', session: num }));
  }

  function setAutoLocal(nums) {
    autoSessions = new Set(nums); renderAutoGrid(); if (activeTab === 'fleet-panel') renderGrid();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'auto:set', sessions: nums }));
  }

  function renderAutoGrid() {
    const autoChips = $('#auto-chips'); const manualChips = $('#manual-chips');
    if (!autoChips || !manualChips) return;
    autoChips.innerHTML = ''; manualChips.innerHTML = '';
    for (const s of fleetData) {
      const chip = document.createElement('button');
      const isAuto = autoSessions.has(s.num);
      chip.className = `mode-chip${isAuto ? ' auto' : ''}`; chip.textContent = s.num;
      const num = s.num;
      chip.addEventListener('click', () => toggleAutoLocal(num));
      if (isAuto) autoChips.appendChild(chip); else manualChips.appendChild(chip);
    }
    if (!autoChips.children.length) autoChips.innerHTML = '<span style="color:var(--dim);font-size:12px;padding:4px">Tap a session to move here</span>';
    if (!manualChips.children.length) manualChips.innerHTML = '<span style="color:var(--dim);font-size:12px;padding:4px">Tap a session to move here</span>';
  }

  $('#auto-all-btn').addEventListener('click', () => setAutoLocal(fleetData.map(s => s.num)));
  $('#manual-all-btn').addEventListener('click', () => setAutoLocal([]));

  // Broadcast
  $('#broadcast-send').addEventListener('click', () => {
    const message = $('#broadcast-input').value.trim(); const target = $('#broadcast-target').value;
    if (!message || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'broadcast', message, target }));
    $('#broadcast-input').value = '';
    showToast('Broadcasting', `"${message.substring(0, 30)}..." to ${target}`, 'success');
  });

  // Broadcast keys
  for (const btn of document.querySelectorAll('.broadcast-key-btn')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.bkey;
      const target = $('#broadcast-target').value;
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'broadcast:keys', keys: [key], target }));
      showToast('Keys broadcast', `${key} → ${target}`, 'success');
    });
  }

  // Auto-pilot rules
  function renderRules() {
    const list = $('#rules-list'); list.innerHTML = '';
    for (const rule of rules) {
      const row = document.createElement('div'); row.className = 'rule-row';
      row.innerHTML = `<span class="rule-name">${esc(rule.name)}</span><button class="rule-toggle${rule.enabled ? ' on' : ''}" data-id="${rule.id}"></button>`;
      row.querySelector('.rule-toggle').addEventListener('click', (e) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'rule:toggle', ruleId: rule.id }));
        e.target.classList.toggle('on');
      });
      list.appendChild(row);
    }
  }

  // ── Designation manager (More tab) ──────────────

  function getDesignationNames() {
    // Combine names from definitions + any currently assigned designations
    const names = new Set(designationDefs.map(d => d.name));
    for (const des of Object.values(designations)) {
      if (des) names.add(des);
    }
    return ['', ...Array.from(names).sort()];
  }

  function renderDesignationGrid() {
    const grid = document.getElementById('desig-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const desigNames = getDesignationNames();
    for (const s of fleetData) {
      const item = document.createElement('div'); item.className = 'desig-item';
      const cur = designations[s.num] || '';
      let opts = desigNames.map(d => `<option value="${d}"${d === cur ? ' selected' : ''}>${d || '—'}</option>`).join('');
      // Add current value if it's custom and not in the list
      if (cur && !desigNames.includes(cur)) {
        opts += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
      }
      item.innerHTML = `<span class="desig-num">${s.num}</span><select class="desig-select" data-num="${s.num}">${opts}</select>`;
      item.querySelector('.desig-select').addEventListener('change', (e) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'designation:set', session: s.num, designation: e.target.value }));
      });
      grid.appendChild(item);
    }
  }

  function updateDesignationSelector() {
    const sel = document.getElementById('task-dialog-designation');
    if (!sel) return;
    const desigNames = getDesignationNames().filter(Boolean);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Any</option>';
    for (const d of desigNames) {
      sel.innerHTML += `<option value="${esc(d)}"${d === cur ? ' selected' : ''}>${esc(d)}</option>`;
    }
  }

  function updatePmDesignationSelector() {
    const sel = document.getElementById('pm-form-designation');
    if (!sel) return;
    const desigNames = getDesignationNames().filter(Boolean);
    const cur = sel.value;
    sel.innerHTML = '<option value="">None</option>';
    for (const d of desigNames) {
      sel.innerHTML += `<option value="${esc(d)}"${d === cur ? ' selected' : ''}>${esc(d)}</option>`;
    }
  }

  function updatePmTargetSessionSelector() {
    const sel = document.getElementById('pm-form-target-session');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">None (route by designation)</option>';
    for (const s of fleetData) {
      sel.innerHTML += `<option value="${s.num}"${String(s.num) === cur ? ' selected' : ''}>Session ${s.num}${s.branch ? ' — ' + esc(s.branch) : ''}</option>`;
    }
  }

  // ── Agent Roots (More tab) ──────────────────────

  function renderAgentRoots() {
    const list = document.getElementById('agent-roots-list');
    if (!list) return;
    list.innerHTML = '';
    for (const root of agentRoots) {
      const row = document.createElement('div'); row.className = 'agent-root-row';
      row.innerHTML = `<span class="root-path">${esc(root)}</span><button>Remove</button>`;
      row.querySelector('button').addEventListener('click', () => {
        const updated = agentRoots.filter(r => r !== root);
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentRoots:set', roots: updated }));
      });
      list.appendChild(row);
    }
    const countEl = document.getElementById('agent-root-count');
    if (countEl) countEl.textContent = `${agentFilesList.length} agent file${agentFilesList.length !== 1 ? 's' : ''} found`;
  }

  document.getElementById('agent-root-add-btn').addEventListener('click', () => {
    const input = document.getElementById('agent-root-input');
    const val = input.value.trim();
    if (!val) return;
    const updated = [...agentRoots, val];
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentRoots:set', roots: updated }));
    input.value = '';
  });

  document.getElementById('agent-root-scan-btn').addEventListener('click', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'agentFiles:scan' }));
  });

  // ── Designation Definitions (More tab) ──────────

  function renderDesigDefs() {
    const list = document.getElementById('desig-defs-list');
    if (!list) return;
    list.innerHTML = '';
    for (const def of designationDefs) {
      const row = document.createElement('div'); row.className = 'desig-def-row';
      const fileCount = def.agentFiles ? def.agentFiles.length : 0;
      const ddc = DESIG_COLORS[def.color] || DESIG_COLORS.orange;
      row.innerHTML = `
        <span class="desig-def-name" style="color:${ddc.fg}">${esc(def.name)}</span>
        <span class="desig-def-files">${fileCount} agent file${fileCount !== 1 ? 's' : ''}${def.description ? ' — ' + esc(def.description) : ''}</span>
        <span class="desig-def-actions">
          <button class="edit-def">Edit</button>
          <button class="remove-def">Remove</button>
        </span>`;
      row.querySelector('.edit-def').addEventListener('click', () => openDesigDefDialog(def));
      row.querySelector('.remove-def').addEventListener('click', () => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'designationDef:remove', name: def.name }));
      });
      list.appendChild(row);
    }
  }

  // Designation definition dialog
  let editingDesigDef = null; // null = creating, object = editing
  let desigDefSelectedFiles = [];
  let desigDefSelectedColor = 'orange';

  document.getElementById('desig-def-add-btn').addEventListener('click', () => openDesigDefDialog(null));
  document.getElementById('desig-def-cancel').addEventListener('click', closeDesigDefDialog);
  document.getElementById('desig-def-dialog').addEventListener('click', (e) => { if (e.target.id === 'desig-def-dialog') closeDesigDefDialog(); });

  function openDesigDefDialog(def) {
    editingDesigDef = def;
    const nameInput = document.getElementById('desig-def-name');
    const descInput = document.getElementById('desig-def-description');
    const titleEl = document.getElementById('desig-def-dialog-title');

    if (def) {
      titleEl.textContent = 'Edit Designation';
      nameInput.value = def.name;
      nameInput.disabled = true;
      descInput.value = def.description || '';
      desigDefSelectedFiles = [...(def.agentFiles || [])];
      desigDefSelectedColor = def.color || 'orange';
    } else {
      titleEl.textContent = 'Add Designation';
      nameInput.value = '';
      nameInput.disabled = false;
      descInput.value = '';
      desigDefSelectedFiles = [];
      desigDefSelectedColor = 'orange';
    }
    renderDesigDefColorSwatches();
    renderDesigDefChips();
    renderDesigDefFilePicker();
    document.getElementById('desig-def-dialog').classList.add('visible');
    if (!def) nameInput.focus();
  }

  function renderDesigDefColorSwatches() {
    const container = document.getElementById('desig-def-color-swatches');
    const wheel = document.getElementById('desig-def-color-wheel');
    container.innerHTML = '';
    const isCustom = desigDefSelectedColor && desigDefSelectedColor.startsWith('#');
    for (const [name, c] of Object.entries(DESIG_COLORS)) {
      const swatch = document.createElement('div');
      swatch.className = 'desig-color-swatch' + (name === desigDefSelectedColor ? ' selected' : '');
      swatch.style.background = c.hex;
      swatch.title = name;
      swatch.addEventListener('click', () => {
        desigDefSelectedColor = name;
        wheel.value = c.hex;
        wheel.classList.remove('selected');
        renderDesigDefColorSwatches();
      });
      container.appendChild(swatch);
    }
    if (isCustom) {
      wheel.value = desigDefSelectedColor;
      wheel.classList.add('selected');
    } else {
      wheel.value = DESIG_COLORS[desigDefSelectedColor]?.hex || '#ffb86c';
      wheel.classList.remove('selected');
    }
  }

  document.getElementById('desig-def-color-wheel').addEventListener('input', (e) => {
    desigDefSelectedColor = e.target.value;
    e.target.classList.add('selected');
    document.querySelectorAll('#desig-def-color-swatches .desig-color-swatch').forEach(s => s.classList.remove('selected'));
  });

  function closeDesigDefDialog() {
    document.getElementById('desig-def-dialog').classList.remove('visible');
    editingDesigDef = null;
    desigDefSelectedFiles = [];
  }

  function renderDesigDefChips() {
    const chips = document.getElementById('desig-def-chips');
    chips.innerHTML = '';
    for (const filePath of desigDefSelectedFiles) {
      const name = filePath.split('/').pop();
      const chip = document.createElement('span'); chip.className = 'desig-file-chip';
      chip.innerHTML = `${esc(name)}<button title="${esc(filePath)}">&times;</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        desigDefSelectedFiles = desigDefSelectedFiles.filter(f => f !== filePath);
        renderDesigDefChips();
      });
      chips.appendChild(chip);
    }
  }

  function renderDesigDefFilePicker() {
    const picker = document.getElementById('desig-def-file-picker');
    if (!agentFilesList.length) {
      picker.innerHTML = '<option value="">No agent files — add roots in More tab first</option>';
      return;
    }
    picker.innerHTML = '<option value="">+ Add agent file...</option>';
    const selectedSet = new Set(desigDefSelectedFiles);
    let available = 0;
    for (const f of agentFilesList) {
      if (selectedSet.has(f.path)) continue;
      picker.innerHTML += `<option value="${esc(f.path)}">${esc(f.relativePath)}</option>`;
      available++;
    }
    if (!available && selectedSet.size) {
      picker.innerHTML = '<option value="">All files already added</option>';
    }
  }

  document.getElementById('desig-def-file-picker').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;
    desigDefSelectedFiles.push(val);
    renderDesigDefChips();
    renderDesigDefFilePicker();
    e.target.value = '';
  });

  document.getElementById('desig-def-save').addEventListener('click', () => {
    const name = document.getElementById('desig-def-name').value.trim();
    if (!name) { showToast('Error', 'Name required', 'error'); return; }
    const description = document.getElementById('desig-def-description').value.trim();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'designationDef:set', name, agentFiles: desigDefSelectedFiles, description, color: desigDefSelectedColor }));
    }
    closeDesigDefDialog();
  });

  // ── Spawn dialog ───────────────────────────────
  const spawnDialog = document.getElementById('spawn-dialog');
  const spawnBtn = document.getElementById('spawn-btn');
  let selectedSpawnSlot = null;
  var spawnToast = null;

  spawnBtn.addEventListener('click', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'spawn:slots' }));
    document.getElementById('spawn-name').value = '';
    document.getElementById('spawn-git-url').value = '';
    document.getElementById('spawn-base-dir').value = spawnBaseDir;
    document.getElementById('spawn-slot-min').value = spawnSlotMin;
    document.getElementById('spawn-slot-max').value = spawnSlotMax;
    selectedSpawnSlot = null;
    spawnDialog.classList.add('visible');
  });

  document.getElementById('spawn-cancel').addEventListener('click', closeSpawnDialog);
  spawnDialog.addEventListener('click', (e) => { if (e.target === spawnDialog) closeSpawnDialog(); });

  document.getElementById('spawn-slot-range-save').addEventListener('click', () => {
    const min = parseInt(document.getElementById('spawn-slot-min').value);
    const max = parseInt(document.getElementById('spawn-slot-max').value);
    if (!min || !max || min > max) { showToast('Error', 'Invalid slot range', 'error'); return; }
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'spawn:config', min, max }));
      // Refresh slots with new range
      ws.send(JSON.stringify({ type: 'spawn:slots' }));
    }
  });

  function getSpawnParams(slotNum) {
    const name = document.getElementById('spawn-name').value.trim();
    if (!name) { showToast('Error', 'Agent name is required', 'error'); return null; }
    const baseDir = document.getElementById('spawn-base-dir').value.trim() || '~/ai-dev';
    const gitUrl = document.getElementById('spawn-git-url').value.trim() || undefined;
    return { num: slotNum, baseDir, name, gitUrl };
  }

  document.getElementById('spawn-next').addEventListener('click', () => {
    const params = getSpawnParams(selectedSpawnSlot || undefined);
    if (!params) return;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'spawn', ...params }));
      // Track spawning session for grid placeholder
      const slotKey = params.num || 'pending';
      spawningSessions.set(slotKey, { name: params.name });
      if (activeTab === 'fleet-panel') renderGrid();
      if (spawnToast) spawnToast.remove();
      spawnToast = document.createElement('div');
      spawnToast.className = 'toast spawning';
      spawnToast.innerHTML = `<div class="toast-title">Spawning agent...</div><div class="toast-body">Cloning repository</div>`;
      toasts.appendChild(spawnToast);
      closeSpawnDialog();
    }
  });

  function closeSpawnDialog() { spawnDialog.classList.remove('visible'); selectedSpawnSlot = null; }

  // ── Shutdown All dialog ───────────────────────────
  const shutdownDialog = document.getElementById('shutdown-dialog');
  document.getElementById('shutdown-all-btn').addEventListener('click', () => {
    shutdownDialog.classList.add('visible');
  });
  document.getElementById('shutdown-cancel-btn').addEventListener('click', () => {
    shutdownDialog.classList.remove('visible');
  });
  shutdownDialog.addEventListener('click', (e) => { if (e.target === shutdownDialog) shutdownDialog.classList.remove('visible'); });
  document.getElementById('shutdown-confirm-btn').addEventListener('click', () => {
    shutdownDialog.classList.remove('visible');
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'shutdown:all' }));
      showToast('Shutting down', 'Killing all fleet sessions...', 'info');
    }
  });

  // ── Restart All button (fleet panel) ────────────
  document.getElementById('restart-all-btn').addEventListener('click', () => {
    showMcpRestartConfirm(null);
  });

  function updateRespawnButton() {
    const btn = document.getElementById('respawn-all-btn');
    if (spawnedAgentsList.length > 0) {
      btn.style.display = '';
      btn.textContent = `Respawn All (${spawnedAgentsList.length})`;
    } else {
      btn.style.display = 'none';
    }
  }

  document.getElementById('respawn-all-btn').addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'respawn:all' }));
      // Track respawning sessions for grid placeholders
      for (const a of spawnedAgentsList) {
        if (!fleetData.find(s => s.num === a.num)) {
          spawningSessions.set(a.num, { name: a.name || '' });
        }
      }
      if (activeTab === 'fleet-panel') renderGrid();
      if (spawnToast) spawnToast.remove();
      spawnToast = document.createElement('div');
      spawnToast.className = 'toast spawning';
      spawnToast.innerHTML = `<div class="toast-title">Respawning...</div><div class="toast-body">Restarting ${spawnedAgentsList.length} session(s)</div>`;
      toasts.appendChild(spawnToast);
      closeSpawnDialog();
    }
  });

  function renderSpawnSlots(available, slotMin, slotMax) {
    const grid = document.getElementById('slot-grid');
    grid.innerHTML = '';
    const avSet = new Set(available);
    selectedSpawnSlot = null;
    const lo = slotMin || spawnSlotMin || 1;
    const hi = slotMax || spawnSlotMax || 32;
    for (let i = lo; i <= hi; i++) {
      const btn = document.createElement('button');
      btn.className = `slot-btn${avSet.has(i) ? '' : ' occupied'}`;
      btn.textContent = i;
      if (avSet.has(i)) {
        btn.addEventListener('click', () => {
          selectedSpawnSlot = i;
          grid.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        });
      }
      grid.appendChild(btn);
    }
  }

  // ── PMs panel ──────────────────────────────────
  function renderPMs() {
    const grid = document.getElementById('pm-scroll');
    if (!grid) return;
    grid.innerHTML = '';

    // "New PM" card — always first
    const newCard = document.createElement('div');
    newCard.className = 'pm-card-new';
    newCard.innerHTML = '<span class="pm-new-icon">+</span><span class="pm-new-label">New PM</span>';
    newCard.addEventListener('click', () => openPmDialog(null));
    grid.appendChild(newCard);

    for (const pm of pmList) {
      const card = document.createElement('div');
      card.className = `pm-card${pm.enabled ? '' : ' disabled'}${pm.lastError ? ' has-error' : ''}`;
      const pmdc = pm.designation ? getDesigColor(pm.designation) : null;
      const desigBadge = pm.designation ? `<span class="task-designation" style="background:${pmdc.bg};color:${pmdc.fg}">${esc(pm.designation)}</span>` : '';
      const targetBadge = pm.targetSession ? `<span class="task-designation" style="background:rgba(139,233,253,0.15);color:var(--cyan)">→${pm.targetSession}</span>` : '';
      const isConfigOnly = pm.source.type === 'slack' || pm.source.type === 'github-mentions' || pm.source.type === 'slack-channel-monitor';
      const sched = isConfigOnly ? '' : pm.schedule ? 'cron: ' + esc(pm.schedule) : pm.pollInterval ? 'every ' + (pm.pollInterval < 60000 ? (pm.pollInterval/1000)+'s' : (pm.pollInterval/60000)+'m') : '';
      const lastPoll = pm.lastPoll ? timeAgo(pm.lastPoll) : 'never';
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <span class="pm-name" style="flex:1">${esc(pm.name)}</span>
          <button class="pm-export-btn" title="Export PM" style="background:none;border:none;cursor:pointer;color:var(--dim);font-size:14px;padding:2px 4px;border-radius:4px" onmouseover="this.style.color='var(--cyan)'" onmouseout="this.style.color='var(--dim)'">\u{1F4CB}</button>
          <button class="pm-toggle${pm.enabled ? ' on' : ''}"></button>
        </div>
        <div class="pm-badges">${desigBadge}${targetBadge}</div>
        <span class="pm-source">${pm.source.type}${sched ? ' · ' + sched : ''}</span>
        ${pm.lastError ? `<div class="pm-error">${esc(pm.lastError)}</div>` : ''}
        <div class="pm-stats">
          <span>${pm.tasksCreated || 0} tasks</span>
          <span>polled ${lastPoll}</span>
        </div>
      `;
      card.querySelector('.pm-export-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openPmExportDialog(pm);
      });
      card.querySelector('.pm-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pm:toggle', id: pm.id }));
      });
      card.addEventListener('click', () => openPmDialog(pm));
      if (pm.source.type === 'slack-channel-monitor' && pm.enabled) {
        card.classList.add('pm-card-monitor');
        const sessionLink = document.createElement('span');
        sessionLink.className = 'pm-session-link';
        sessionLink.textContent = 'session \u25B6';
        sessionLink.addEventListener('click', (e) => {
          e.stopPropagation();
          openPmSessionPanel(pm);
        });
        card.appendChild(sessionLink);
      }
      grid.appendChild(card);
    }
  }

  /**
   * Open the session panel to show a channel-monitor PM's Claude session.
   * Reuses the existing session panel with the PM's tmux session name.
   */
  function openPmSessionPanel(pm) {
    const sessionName = `hive-pm-${pm.id}`;
    // Ensure the session exists first
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'pm:ensure-session', id: pm.id }));
    }
    // Build a synthetic session object for openSession
    currentSession = sessionName;
    paneCols = 0;
    sessionTitle.textContent = pm.name;
    sessionBranch.textContent = 'channel monitor';
    updateSessionStatusLine();
    document.getElementById('session-activity').textContent = '';
    previousTab = activeTab;
    userScrolledUp = false;
    pendingContent = null;
    lastContent = '';
    activePane = null;
    sessionPanes = [];
    claudePaneIdx = null;
    panesCollapsed = false;
    tsPanesCollapsed = false;
    renderPaneTabs();
    updateInputForPane(true);
    activeSessionTab = 'terminal';
    $$('.session-tab').forEach(t => t.classList.toggle('active', t.dataset.stab === 'terminal'));
    document.getElementById('session-terminal-content').classList.add('active');
    document.getElementById('session-git-content').classList.remove('active');
    closeAllCommentsDrawers();
    // Hide the off-banner — PM sessions aren't in fleetData so default to showing terminal
    const offBanner = document.getElementById('session-off-banner');
    if (offBanner) offBanner.classList.remove('visible');
    if (termWrap) termWrap.style.display = '';
    switchTab('session-panel');
    if (!term) {
      term = new Terminal({
        theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
        fontSize: sessionFontSize, fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        disableStdin: true, scrollback: 5000, convertEol: true, allowProposedApi: true,
      });
      fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
      enableTerminalCopy(term);
      term.open(termWrap);
    }
    requestAnimationFrame(() => {
      fitTerminal();
      term.clear();
      const subscribe = () => {
        if (!ws || ws.readyState !== 1 || !currentSession) return;
        ws.send(JSON.stringify({ type: 'terminal:subscribe', session: currentSession, pane: 1, cols: term.cols, rows: term.rows }));
      };
      if (isAlive(subscribe)) subscribe();
    });
  }

  // PM form dialog
  const pmDialog = document.getElementById('pm-dialog');

  document.getElementById('pm-form-cancel').addEventListener('click', closePmDialog);
  pmDialog.addEventListener('click', (e) => { if (e.target === pmDialog) closePmDialog(); });
  document.getElementById('pm-form-rescan').addEventListener('click', () => {
    if (editingPmId && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pm:rescan', id: editingPmId }));
    closePmDialog();
  });
  document.getElementById('pm-form-reset').addEventListener('click', () => {
    if (editingPmId && confirm('This will forget all previously seen issues. The next poll will create tasks for everything matching the source query. Continue?')) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pm:reset', id: editingPmId }));
      closePmDialog();
    }
  });
  document.getElementById('pm-form-export').addEventListener('click', () => {
    if (editingPmId) {
      const pm = pmList.find(p => p.id === editingPmId);
      if (pm) { closePmDialog(); openPmExportDialog(pm); }
    }
  });
  document.getElementById('pm-form-delete').addEventListener('click', () => {
    if (editingPmId && confirm('Delete this PM?')) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'pm:delete', id: editingPmId }));
      closePmDialog();
    }
  });

  document.getElementById('pm-form-source').addEventListener('change', togglePmSourceFields);

  // Schedule tab toggle (interval vs cron)
  document.querySelectorAll('.pm-sched-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pm-sched-tab').forEach(t => {
        t.classList.remove('selected');
        t.style.background = 'var(--surface)'; t.style.color = 'var(--text)';
      });
      tab.classList.add('selected');
      tab.style.background = 'var(--accent)'; tab.style.color = '#fff';
      const mode = tab.dataset.mode;
      document.getElementById('pm-sched-interval').style.display = mode === 'interval' ? '' : 'none';
      document.getElementById('pm-sched-cron').style.display = mode === 'cron' ? '' : 'none';
      if (mode === 'interval') document.getElementById('pm-form-cron').value = '';
    });
  });

  // PM dialog tab switching
  document.querySelectorAll('.pm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activePmTab = tab.dataset.pmTab;
      document.querySelectorAll('.pm-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.pmTab === activePmTab));
      document.querySelectorAll('.pm-tab-content').forEach(c =>
        c.classList.toggle('active', c.dataset.pmTab === activePmTab));
    });
  });

  function togglePmSourceFields() {
    const type = document.getElementById('pm-form-source').value;
    const isGithub = type === 'github-issues' || type === 'github-prs' || type === 'github-re-reviews';
    const isReReviews = type === 'github-re-reviews';
    const types = ['jira', 'github', 'github-prs', 're-reviews', 'manual', 'command', 'script', 'jenkins', 'zoho', 'slack', 'slack-channel-monitor', 'github-mentions'];
    for (const t of types) {
      let show = false;
      if (t === type) show = true;
      else if (t === 'github' && isGithub) show = true;
      else if (t === 'github-prs' && type === 'github-prs') show = true;
      else if (t === 're-reviews' && isReReviews) show = true;
      const els = document.querySelectorAll(`.pm-fields-${t}`);
      els.forEach(el => el.style.display = show ? '' : 'none');
    }
    // Hide labels/state for re-reviews (not needed)
    if (isReReviews) {
      document.querySelectorAll('.pm-fields-github').forEach((el, i) => {
        // Show only the first github field (repo), hide labels and state
        if (i > 0) el.style.display = 'none';
      });
    }
    // Hide schedule for slack/github-mentions/channel-monitor (no polling); manual supports cron schedule
    const schedField = document.getElementById('pm-form-schedule-field');
    if (schedField) schedField.style.display = (type === 'slack' || type === 'github-mentions' || type === 'slack-channel-monitor') ? 'none' : '';
    const threshField = document.getElementById('pm-form-threshold').closest('.pm-form-field');
    if (threshField) threshField.style.display = (type === 'manual' || type === 'command' || type === 'script' || type === 'slack' || type === 'github-mentions' || type === 'slack-channel-monitor') ? 'none' : '';
    const instrField = document.getElementById('pm-form-instructions').closest('.pm-form-field');
    if (instrField) instrField.style.display = type === 'command' ? 'none' : '';
    const mcpField = document.getElementById('pm-form-mcp-field');
    if (mcpField) mcpField.style.display = type === 'command' ? 'none' : '';
    // Completion conditions: show for source types that support it
    const ccField = document.querySelector('.pm-fields-completion');
    const ccGithub = document.getElementById('pm-form-cc-github');
    const ccJira = document.getElementById('pm-form-cc-jira');
    if (ccField) {
      const isGhType = type === 'github-prs' || type === 'github-re-reviews' || type === 'github-issues';
      const isJiraType = type === 'jira';
      ccField.style.display = (isGhType || isJiraType) ? '' : 'none';
      if (ccGithub) ccGithub.style.display = isGhType ? '' : 'none';
      if (ccJira) ccJira.style.display = isJiraType ? '' : 'none';
    }
    // Continue conditions: same source types as completion
    const contField = document.querySelector('.pm-fields-continue');
    const contGithub = document.getElementById('pm-form-cont-github');
    const contJira = document.getElementById('pm-form-cont-jira');
    if (contField) {
      const isGhType = type === 'github-prs' || type === 'github-re-reviews' || type === 'github-issues';
      const isJiraType = type === 'jira';
      contField.style.display = (isGhType || isJiraType) ? '' : 'none';
      if (contGithub) contGithub.style.display = isGhType ? '' : 'none';
      if (contJira) contJira.style.display = isJiraType ? '' : 'none';
    }
    // Context actions: show for github PR types
    const actionsField = document.getElementById('pm-form-actions-field');
    if (actionsField) {
      const isGhPr = type === 'github-prs' || type === 'github-re-reviews';
      actionsField.style.display = isGhPr ? '' : 'none';
    }
  }

  document.getElementById('pm-form-save').addEventListener('click', () => {
    const sourceType = document.getElementById('pm-form-source').value;
    let source = { type: sourceType };
    switch (sourceType) {
      case 'jira':
        source.jql = document.getElementById('pm-form-jql').value.trim();
        if (!source.jql) { showToast('Error', 'JQL required', 'error'); return; }
        break;
      case 'github-issues':
      case 'github-prs':
        source.query = document.getElementById('pm-form-gh-query').value.trim();
        source.repo = document.getElementById('pm-form-gh-repo').value.trim();
        source.labels = document.getElementById('pm-form-gh-labels').value.trim();
        source.excludeLabels = document.getElementById('pm-form-gh-exclude-labels').value.trim();
        source.state = document.getElementById('pm-form-gh-state').value;
        source.author = document.getElementById('pm-form-gh-author').value.trim();
        if (sourceType === 'github-prs') {
          source.base = document.getElementById('pm-form-gh-base').value.trim();
        }
        if (!source.query && !source.repo) { showToast('Error', 'Search query or repo required', 'error'); return; }
        break;
      case 'github-re-reviews':
        source.repo = document.getElementById('pm-form-gh-repo').value.trim();
        source.reviewer = document.getElementById('pm-form-gh-reviewer').value.trim();
        source.triggerPhrases = document.getElementById('pm-form-gh-triggers').value.trim();
        if (!source.repo) { showToast('Error', 'Repo required', 'error'); return; }
        if (!source.reviewer) { showToast('Error', 'Reviewer username required', 'error'); return; }
        break;
      case 'command':
        source.command = document.getElementById('pm-form-command').value.trim();
        if (!source.command) { showToast('Error', 'Command required', 'error'); return; }
        if (!source.command.startsWith('/')) source.command = '/' + source.command;
        break;
      case 'script':
        source.script = document.getElementById('pm-form-script').value.trim();
        source.scriptAction = document.getElementById('pm-form-script-action').value;
        if (!source.script) { showToast('Error', 'Script required', 'error'); return; }
        break;
      case 'slack':
        source.channel = document.getElementById('pm-form-slack-channel').value.trim() || null;
        break;
      case 'slack-channel-monitor': {
        const chRaw = document.getElementById('pm-form-monitor-channels').value.trim();
        source.channels = chRaw ? chRaw.split(',').map(c => c.trim()).filter(Boolean) : [];
        if (!source.channels.length) { showToast('Error', 'At least one channel ID required', 'error'); return; }
        const monPrompt = document.getElementById('pm-form-monitor-prompt').value.trim();
        if (monPrompt) source.systemPrompt = monPrompt;
        source.threadDebounceMs = parseInt(document.getElementById('pm-form-monitor-debounce').value) || 60000;
        source.maxRelaysPerHour = parseInt(document.getElementById('pm-form-monitor-rate-limit').value) || 30;
        source.ignoreThreadsWithActiveTasks = true;
        source.ignoreBots = document.getElementById('pm-form-monitor-ignore-bots').checked;
        break;
      }
      case 'github-mentions':
        const reposRaw = document.getElementById('pm-form-gh-mentions-repos').value.trim();
        source.repos = reposRaw ? reposRaw.split(',').map(r => r.trim()).filter(Boolean) : [];
        if (!source.repos.length) { showToast('Error', 'At least one repo required', 'error'); return; }
        break;
      case 'manual':
        source.text = document.getElementById('pm-form-manual-text').value.trim();
        if (!source.text) { showToast('Error', 'Task text required', 'error'); return; }
        break;
      case 'jenkins':
        source.jobPath = document.getElementById('pm-form-jenkins-path').value.trim();
        if (!source.jobPath) { showToast('Error', 'Job path required', 'error'); return; }
        break;
      case 'zoho':
        source.department = document.getElementById('pm-form-zoho-dept').value.trim();
        source.status = document.getElementById('pm-form-zoho-status').value.trim();
        source.query = document.getElementById('pm-form-zoho-query').value.trim();
        const sinceVal = document.getElementById('pm-form-zoho-since').value;
        source.since = sinceVal ? new Date(sinceVal).toISOString() : new Date().toISOString();
        break;
    }
    const targetSessionVal = document.getElementById('pm-form-target-session').value;
    const cfg = {
      name: document.getElementById('pm-form-name').value.trim(),
      source,
      designation: document.getElementById('pm-form-designation').value || null,
      targetSession: targetSessionVal ? parseInt(targetSessionVal) : null,
      taskFormat: document.getElementById('pm-form-taskformat').value.trim() || null,
      instructions: document.getElementById('pm-form-instructions').value.trim(),
      mcpEnabled: document.getElementById('pm-form-mcp-enabled').checked,
      requireHumanClose: document.getElementById('pm-form-require-human-close').checked,
      learningEnabled: document.getElementById('pm-form-learning-enabled').checked,
      learningPrompt: document.getElementById('pm-form-learning-prompt').value.trim(),
      checklistTemplate: document.getElementById('pm-form-checklist-tpl').value || null,
      autoThreshold: parseInt(document.getElementById('pm-form-threshold').value) || 3,
      pollInterval: parseInt(document.getElementById('pm-form-interval').value) || 60000,
      schedule: document.getElementById('pm-form-cron').value.trim() || null,
      slackUserId: document.getElementById('pm-form-slack-user-id').value.trim() || null,
    };
    // Collect completion conditions
    const completionConditions = [];
    const isGhType = sourceType === 'github-prs' || sourceType === 'github-re-reviews' || sourceType === 'github-issues';
    if (isGhType) {
      const states = [];
      if (document.getElementById('pm-form-cc-merged').checked) states.push('merged');
      if (document.getElementById('pm-form-cc-closed').checked) states.push('closed');
      if (states.length) completionConditions.push({ type: 'github-pr-state', states });
    }
    if (sourceType === 'jira') {
      const raw = document.getElementById('pm-form-cc-jira-statuses').value.trim();
      if (raw) {
        const statuses = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length) completionConditions.push({ type: 'jira-status', statuses });
      }
    }
    cfg.completionConditions = completionConditions;
    // Collect continue conditions
    const continueConditions = [];
    if (isGhType && document.getElementById('pm-form-cont-pr-changes').checked) {
      continueConditions.push({ type: 'github-pr-changes', since: 'completion' });
    }
    if (sourceType === 'jira') {
      const rawCont = document.getElementById('pm-form-cont-jira-statuses').value.trim();
      if (rawCont) {
        const contStatuses = rawCont.split(',').map(s => s.trim()).filter(Boolean);
        if (contStatuses.length) continueConditions.push({ type: 'jira-status', statuses: contStatuses });
      }
    }
    cfg.continueConditions = continueConditions;
    // Collect allowed context actions
    if (isGhType) {
      const actionEls = document.querySelectorAll('#pm-form-actions input[data-action]');
      if (actionEls.length) {
        const selected = [];
        actionEls.forEach(cb => { if (cb.checked) selected.push(cb.dataset.action); });
        cfg.actions = selected.length < actionEls.length ? selected : null; // null = all
      }
    }
    if (!cfg.name) { showToast('Error', 'Name required', 'error'); return; }
    if (ws && ws.readyState === 1) {
      if (editingPmId) {
        ws.send(JSON.stringify({ type: 'pm:update', id: editingPmId, updates: cfg }));
      } else {
        ws.send(JSON.stringify({ type: 'pm:create', config: cfg }));
      }
    }
    closePmDialog();
  });

  function openPmDialog(pm) {
    editingPmId = pm ? pm.id : null;
    document.getElementById('pm-dialog-title').textContent = pm ? 'Edit Project Manager' : 'New Project Manager';
    document.getElementById('pm-form-name').value = pm ? pm.name : '';
    document.getElementById('pm-form-source').value = pm ? pm.source.type : 'jira';
    // Populate source-specific fields
    const src = pm ? pm.source : {};
    document.getElementById('pm-form-jql').value = src.jql || '';
    document.getElementById('pm-form-gh-query').value = src.query || '';
    document.getElementById('pm-form-gh-repo').value = src.repo || '';
    document.getElementById('pm-form-gh-labels').value = src.labels || '';
    document.getElementById('pm-form-gh-exclude-labels').value = src.excludeLabels || '';
    document.getElementById('pm-form-gh-state').value = src.state || 'open';
    document.getElementById('pm-form-gh-author').value = src.author || '';
    document.getElementById('pm-form-gh-base').value = src.base || '';
    document.getElementById('pm-form-gh-reviewer').value = src.reviewer || '';
    document.getElementById('pm-form-gh-triggers').value = src.triggerPhrases || '';
    document.getElementById('pm-form-command').value = src.command || '';
    document.getElementById('pm-form-script').value = src.script || '';
    document.getElementById('pm-form-script-action').value = src.scriptAction || 'feed';
    document.getElementById('pm-form-manual-text').value = src.text || '';
    document.getElementById('pm-form-slack-channel').value = src.channel || '';
    document.getElementById('pm-form-gh-mentions-repos').value = (src.repos || []).join(', ');
    document.getElementById('pm-form-monitor-channels').value = (src.channels || []).join(', ');
    document.getElementById('pm-form-monitor-prompt').value = src.systemPrompt || '';
    document.getElementById('pm-form-monitor-debounce').value = src.threadDebounceMs || 60000;
    document.getElementById('pm-form-monitor-rate-limit').value = src.maxRelaysPerHour || 30;
    document.getElementById('pm-form-monitor-ignore-bots').checked = src.ignoreBots !== false;
    document.getElementById('pm-form-jenkins-path').value = src.jobPath || '';
    document.getElementById('pm-form-zoho-dept').value = src.department || '';
    document.getElementById('pm-form-zoho-status').value = src.status || '';
    document.getElementById('pm-form-zoho-query').value = src.query || '';
    document.getElementById('pm-form-zoho-since').value = src.since ? src.since.slice(0, 10) : new Date().toISOString().slice(0, 10);
    updatePmDesignationSelector();
    document.getElementById('pm-form-designation').value = pm ? (pm.designation || '') : '';
    updatePmTargetSessionSelector();
    document.getElementById('pm-form-target-session').value = pm ? (pm.targetSession || '') : '';
    document.getElementById('pm-form-taskformat').value = pm ? (pm.taskFormat || '') : '';
    document.getElementById('pm-form-instructions').value = pm ? (pm.instructions || '') : '';
    document.getElementById('pm-form-mcp-enabled').checked = pm ? !!pm.mcpEnabled : false;
    document.getElementById('pm-form-require-human-close').checked = pm ? !!pm.requireHumanClose : false;
    document.getElementById('pm-form-learning-enabled').checked = pm ? !!pm.learningEnabled : false;
    document.getElementById('pm-form-learning-prompt').value = pm ? (pm.learningPrompt || '') : '';
    document.getElementById('pm-form-learning-prompt-wrap').style.display = (pm && pm.learningEnabled) ? '' : 'none';
    document.getElementById('pm-form-threshold').value = pm ? pm.autoThreshold : 3;
    document.getElementById('pm-form-slack-user-id').value = pm ? (pm.slackUserId || '') : '';
    document.getElementById('pm-form-interval').value = pm ? pm.pollInterval : 60000;
    document.getElementById('pm-form-cron').value = pm ? (pm.schedule || '') : '';
    // Set schedule tab state
    const hasCron = pm && pm.schedule;
    document.querySelectorAll('.pm-sched-tab').forEach(t => t.classList.toggle('selected', t.dataset.mode === (hasCron ? 'cron' : 'interval')));
    document.querySelectorAll('.pm-sched-tab').forEach(t => {
      if (t.classList.contains('selected')) { t.style.background = 'var(--accent)'; t.style.color = '#fff'; }
      else { t.style.background = 'var(--surface)'; t.style.color = 'var(--text)'; }
    });
    document.getElementById('pm-sched-interval').style.display = hasCron ? 'none' : '';
    document.getElementById('pm-sched-cron').style.display = hasCron ? '' : 'none';
    updatePmChecklistTplSelector();
    document.getElementById('pm-form-checklist-tpl').value = pm ? (pm.checklistTemplate || '') : '';
    // Populate completion conditions
    const cc = pm && pm.completionConditions ? pm.completionConditions : [];
    const ghCond = cc.find(c => c.type === 'github-pr-state');
    document.getElementById('pm-form-cc-merged').checked = ghCond ? ghCond.states.includes('merged') : false;
    document.getElementById('pm-form-cc-closed').checked = ghCond ? ghCond.states.includes('closed') : false;
    const jiraCond = cc.find(c => c.type === 'jira-status');
    document.getElementById('pm-form-cc-jira-statuses').value = jiraCond ? jiraCond.statuses.join(', ') : '';
    // Populate continue conditions
    const contConds = pm?.continueConditions || [];
    document.getElementById('pm-form-cont-pr-changes').checked = !!contConds.find(c => c.type === 'github-pr-changes');
    const jiraContCond = contConds.find(c => c.type === 'jira-status');
    document.getElementById('pm-form-cont-jira-statuses').value = jiraContCond ? jiraContCond.statuses.join(', ') : '';
    // Populate context actions checkboxes
    const actionsContainer = document.getElementById('pm-form-actions');
    const PR_ACTIONS = [
      { id: 'approve', label: 'Approve' },
      { id: 'request-changes', label: 'Request Changes' },
      { id: 'merge', label: 'Merge (Squash)' },
      { id: 'merge-commit', label: 'Merge (Merge Commit)' },
      { id: 'admin-merge', label: 'Admin Merge (Override)' },
      { id: 'close-pr', label: 'Close PR' },
    ];
    const allowedActions = pm && pm.actions ? new Set(pm.actions) : null;
    actionsContainer.innerHTML = PR_ACTIONS.map(a => {
      const checked = !allowedActions || allowedActions.has(a.id) ? 'checked' : '';
      return `<label style="font-size:13px;color:var(--fg);cursor:pointer;display:flex;align-items:center;gap:4px">
        <input type="checkbox" data-action="${a.id}" ${checked}> ${a.label}</label>`;
    }).join('');
    // Reset to first tab
    activePmTab = 'source';
    document.querySelectorAll('.pm-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.pmTab === 'source'));
    document.querySelectorAll('.pm-tab-content').forEach(c =>
      c.classList.toggle('active', c.dataset.pmTab === 'source'));
    togglePmSourceFields();
    // Show/hide edit-mode actions
    const isEdit = !!pm;
    document.getElementById('pm-form-export').style.display = isEdit ? '' : 'none';
    document.getElementById('pm-form-rescan').style.display = isEdit ? '' : 'none';
    document.getElementById('pm-form-reset').style.display = isEdit ? '' : 'none';
    document.getElementById('pm-form-delete').style.display = isEdit ? '' : 'none';
    pmDialog.classList.add('visible');
  }

  function closePmDialog() { pmDialog.classList.remove('visible'); editingPmId = null; }

  // ── PM Export Dialog ──────────────────────────────
  const pmExportDialog = document.getElementById('pm-export-dialog');
  let exportingPm = null;
  let exportSkillsList = [];

  document.getElementById('pm-export-cancel').addEventListener('click', closePmExportDialog);
  pmExportDialog.addEventListener('click', (e) => { if (e.target === pmExportDialog) closePmExportDialog(); });

  document.getElementById('pm-export-copy').addEventListener('click', () => {
    const textarea = document.getElementById('pm-export-prompt');
    navigator.clipboard.writeText(textarea.value).then(() => {
      const btn = document.getElementById('pm-export-copy');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.background = 'var(--green)';
      setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1500);
    }).catch(() => {
      // Fallback: select all text
      const textarea2 = document.getElementById('pm-export-prompt');
      textarea2.select();
      document.execCommand('copy');
    });
  });

  function openPmExportDialog(pm) {
    exportingPm = pm;
    document.getElementById('pm-export-title').textContent = 'Export Project Manager — ' + pm.name;
    const promptArea = document.getElementById('pm-export-prompt');
    promptArea.value = 'Loading...';
    pmExportDialog.classList.add('visible');

    // Request skills list
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'pm:skills' }));
    }

    // Request initial export (no skills selected)
    requestPmExport([]);
  }

  function closePmExportDialog() {
    pmExportDialog.classList.remove('visible');
    exportingPm = null;
    exportSkillsList = [];
  }

  function requestPmExport(skillPaths) {
    if (!exportingPm || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'pm:export', id: exportingPm.id, skillPaths }));
  }

  function renderExportSkills(skills) {
    exportSkillsList = skills;
    const container = document.getElementById('pm-export-skills-list');
    if (!container) return;
    if (!skills.length) {
      container.innerHTML = '<span style="color:var(--dim);font-size:12px">No skills found in ~/.claude/skills/</span>';
      return;
    }
    container.innerHTML = '';
    for (const skill of skills) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;user-select:none';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = skill.path;
      cb.style.cssText = 'margin:0';
      cb.addEventListener('change', () => {
        const selected = Array.from(container.querySelectorAll('input:checked')).map(i => i.value);
        requestPmExport(selected);
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(skill.name));
      if (skill.description) {
        label.title = skill.description;
      }
      container.appendChild(label);
    }
  }

  // Handle export WS responses (wired into the main message handler below)
  function handleExportMessage(msg) {
    if (msg.type === 'pm:export:result') {
      const promptArea = document.getElementById('pm-export-prompt');
      if (promptArea) promptArea.value = msg.prompt;
    } else if (msg.type === 'pm:skills') {
      renderExportSkills(msg.skills || []);
    }
  }

  // ── Git files sidebar (compact file list in terminal view) ──
  function renderGitFilesSidebar(data, listId) {
    const list = document.getElementById(listId);
    if (!list) return;
    const isTs = listId === 'ts-git-files-list';
    const sessionNum = isTs ? tasksSessionNum : currentSession;
    const ctx = isTs ? 'ts' : undefined;
    const files = data.changedFiles || [];
    const log = data.log || [];

    if (!files.length && !log.length) {
      list.innerHTML = '<div style="color:var(--dim);padding:8px 10px;font-size:11px">No changes</div>';
      return;
    }

    list.innerHTML = '';

    // 1. Uncommitted changed files
    if (files.length) {
      const section = document.createElement('div');
      section.className = 'git-section';
      let html = '<div class="git-section-title">Changed Files</div><div class="git-section-body">';
      for (const f of files) {
        const statusChar = f.status.charAt(0) || '?';
        html += `<div class="git-file-row" data-file="${esc(f.file)}">
          <span class="git-file-status ${statusChar}">${statusChar}</span>
          <span class="git-file-name" title="${esc(f.file)}">${esc(f.file)}</span>
        </div>`;
      }
      html += '</div>';
      section.innerHTML = html;
      section.querySelectorAll('.git-file-row').forEach(row => {
        row.addEventListener('click', () => {
          if (!sessionNum || !ws || ws.readyState !== 1) return;
          list.querySelectorAll('.git-file-row').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          ws.send(JSON.stringify({ type: 'git:diff', session: sessionNum, file: row.dataset.file }));
        });
      });
      list.appendChild(section);
    }

    // 2. Recent commits
    if (log.length) {
      const section = document.createElement('div');
      section.className = 'git-section';
      let html = '<div class="git-section-title">Recent Commits</div><div class="git-section-body">';
      for (const c of log) {
        html += `<div class="git-log-row" data-hash="${esc(c.hash)}">
          <span class="git-log-hash">${esc(c.short)}</span>
          <span class="git-log-msg">${esc(c.message)}</span>
          <span class="git-log-time">${esc(c.relative)}</span>
        </div>
        <div class="git-log-files" data-for-hash="${esc(c.hash)}" data-sidebar="1"></div>`;
      }
      html += '</div>';
      section.innerHTML = html;
      // Click commit → expand/collapse + request files
      section.querySelectorAll('.git-log-row').forEach(row => {
        row.addEventListener('click', () => {
          const hash = row.dataset.hash;
          const filesEl = section.querySelector(`.git-log-files[data-for-hash="${hash}"]`);
          const wasExpanded = row.classList.contains('expanded');
          section.querySelectorAll('.git-log-row').forEach(r => r.classList.remove('expanded'));
          section.querySelectorAll('.git-log-files').forEach(f => f.classList.remove('visible'));
          if (wasExpanded) return;
          row.classList.add('expanded');
          filesEl.classList.add('visible');
          if (!filesEl.dataset.loaded) {
            filesEl.innerHTML = '<div class="git-log-loading">Loading files...</div>';
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'git:commit', session: sessionNum, hash }));
            }
          }
        });
      });
      list.appendChild(section);
    }
  }

  function showSidebarDiff(file, diff, ctx) {
    const isTs = (ctx === 'ts');
    const paneId = isTs ? 'ts-sidebar-diff-pane' : 'sidebar-diff-pane';
    const pane = document.getElementById(paneId);
    if (!pane) return;
    const fnEl = document.getElementById(isTs ? 'ts-sidebar-diff-filename' : 'sidebar-diff-filename');
    const content = document.getElementById(isTs ? 'ts-sidebar-diff-content' : 'sidebar-diff-content');
    fnEl.textContent = file;
    if (!diff) {
      content.innerHTML = '<span class="diff-ctx">No diff available</span>';
    } else {
      const lines = diff.split('\n');
      content.innerHTML = lines.map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<div class="diff-add">${esc(line)}</div>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<div class="diff-del">${esc(line)}</div>`;
        if (line.startsWith('@@')) return `<div class="diff-hunk">${esc(line)}</div>`;
        return `<div class="diff-ctx">${esc(line)}</div>`;
      }).join('');
    }
    content.scrollTop = 0;
    // Switch to diff pane tab
    switchToDiffPane(ctx);
  }

  function switchToDiffPane(ctx) {
    const isTs = (ctx === 'ts');
    const barId = isTs ? 'ts-pane-tabs' : 'pane-tabs';
    const paneId = isTs ? 'ts-sidebar-diff-pane' : 'sidebar-diff-pane';
    const termId = isTs ? 'tasks-session-terminal' : 'terminal-wrap';
    // Show pane bar even if it was hidden (need at least the diff tab)
    const bar = document.getElementById(barId);
    if (bar) bar.style.display = 'flex';
    // Ensure Diff tab exists in bar
    if (!bar.querySelector('.pane-tab[data-pane-idx="diff"]')) {
      const btn = document.createElement('button');
      btn.className = 'pane-tab';
      btn.dataset.paneIdx = 'diff';
      btn.textContent = 'Diff';
      btn.addEventListener('click', () => switchToDiffPane(ctx));
      bar.appendChild(btn);
    }
    // Activate diff tab, deactivate others
    bar.querySelectorAll('.pane-tab').forEach(t => t.classList.toggle('active', t.dataset.paneIdx === 'diff'));
    // Show diff pane, hide terminal
    document.getElementById(paneId).classList.add('active');
    document.getElementById(termId).style.display = 'none';
  }

  function switchFromDiffPane(ctx) {
    const isTs = (ctx === 'ts');
    const paneId = isTs ? 'ts-sidebar-diff-pane' : 'sidebar-diff-pane';
    const termId = isTs ? 'tasks-session-terminal' : 'terminal-wrap';
    document.getElementById(paneId).classList.remove('active');
    document.getElementById(termId).style.display = '';
  }

  function closeSidebarDiff(target) {
    const ctx = target === 'session' ? undefined : target;
    const isTs = (target === 'ts');
    const paneId = isTs ? 'ts-sidebar-diff-pane' : 'sidebar-diff-pane';
    const termId = isTs ? 'tasks-session-terminal' : 'terminal-wrap';
    // Hide diff, show terminal
    document.getElementById(paneId).classList.remove('active');
    document.getElementById(termId).style.display = '';
    // Remove diff tab from bar
    const barId = isTs ? 'ts-pane-tabs' : 'pane-tabs';
    const diffTab = document.querySelector(`#${barId} .pane-tab[data-pane-idx="diff"]`);
    if (diffTab) diffTab.remove();
    // Restore active state on current pane tab
    const curActive = isTs ? tsActivePane : activePane;
    document.querySelectorAll(`#${barId} .pane-tab`).forEach(t => {
      t.classList.toggle('active', parseInt(t.dataset.paneIdx) === curActive);
    });
    // Clear selection highlight
    const listId = isTs ? 'ts-git-files-list' : 'git-files-list';
    document.querySelectorAll(`#${listId} .git-file-row`).forEach(r => r.classList.remove('selected'));
  }

  function toggleGitFilesSidebar(target) {
    gitFilesSidebarOpen = !gitFilesSidebarOpen;
    localStorage.setItem('gitFilesSidebarOpen', gitFilesSidebarOpen);
    // Mutual exclusion: close plan sidebar when opening git
    if (gitFilesSidebarOpen && planSidebarOpen) {
      closePlanSidebar(target);
    }
    applyGitFilesSidebarState(target);
    // Close diff overlay when hiding sidebar
    if (!gitFilesSidebarOpen) closeSidebarDiff(target);
    // Refit terminal after sidebar toggle
    if (target === 'session') { if (term && fitAddon) requestAnimationFrame(() => fitTerminal()); }
    else { requestAnimationFrame(() => fitTasksTerminal()); }
  }

  function applyGitFilesSidebarState(target) {
    if (target === 'session' || target === 'both') {
      const sb = document.getElementById('git-files-sidebar');
      const btn = document.getElementById('git-files-toggle');
      if (sb) sb.style.display = gitFilesSidebarOpen ? '' : 'none';
      if (btn) btn.classList.toggle('active', gitFilesSidebarOpen);
    }
    if (target === 'ts' || target === 'both') {
      const sb = document.getElementById('ts-git-files-sidebar');
      const btn = document.getElementById('ts-git-files-toggle');
      if (sb) sb.style.display = gitFilesSidebarOpen ? '' : 'none';
      if (btn) btn.classList.toggle('active', gitFilesSidebarOpen);
    }
  }

  // ── Git panel rendering ──────────────────────────
  function renderGitPanel(data, sidebarId) {
    const scroll = document.getElementById(sidebarId || 'git-sidebar');
    if (!scroll) return;
    const sessionForGit = sidebarId === 'td-git-sidebar' ? taskDetailSession : sidebarId === 'ts-git-sidebar' ? tasksSessionNum : currentSession;
    // Preserve state across refreshes
    const prevSelected = scroll.querySelector('.git-file-row.selected');
    const selectedFile = prevSelected ? prevSelected.dataset.file : null;
    const expandedRow = scroll.querySelector('.git-log-row.expanded');
    const expandedHash = expandedRow ? expandedRow.dataset.hash : null;
    const loadedCommits = {};
    scroll.querySelectorAll('.git-log-files[data-loaded="1"]').forEach(el => {
      loadedCommits[el.dataset.forHash] = el.innerHTML;
    });
    scroll.innerHTML = '';

    // Helper: make section titles toggle collapse
    function wireCollapse(section) {
      const title = section.querySelector('.git-section-title');
      if (title) title.addEventListener('click', () => section.classList.toggle('collapsed'));
    }

    // Working directory override indicator
    if (data.workingDir) {
      const wdDiv = document.createElement('div');
      wdDiv.className = 'git-working-dir';
      const short = data.workingDir.replace(/^\/Users\/[^/]+\//, '~/');
      wdDiv.innerHTML = `<span class="git-wd-label">repo</span> <span class="git-wd-path" title="${esc(data.workingDir)}">${esc(short)}</span>`;
      scroll.appendChild(wdDiv);
    }

    // 1. Uncommitted changed files (most important — first)
    const files = data.changedFiles || [];
    if (files.length) {
      const section = document.createElement('div');
      section.className = 'git-section';
      let html = '<div class="git-section-title">Uncommitted Changes</div><div class="git-section-body">';
      // Build stat map from diffStat + stagedStat
      const statMap = {};
      for (const d of (data.diffStat || [])) statMap[d.file] = d;
      for (const d of (data.stagedStat || [])) {
        if (statMap[d.file]) { statMap[d.file].added += d.added; statMap[d.file].deleted += d.deleted; }
        else statMap[d.file] = d;
      }
      for (const f of files) {
        const st = statMap[f.file];
        const statHtml = st ? `<span class="git-file-stat"><span class="add">+${st.added}</span> <span class="del">-${st.deleted}</span></span>` : '';
        const statusChar = f.status.charAt(0) || '?';
        html += `<div class="git-file-row" data-file="${esc(f.file)}">
          <span class="git-file-status ${statusChar}">${statusChar}</span>
          <span class="git-file-name" title="${esc(f.file)}">${esc(f.file)}</span>
          ${statHtml}
        </div>`;
      }
      html += '</div>';
      section.innerHTML = html;
      // Click handlers for uncommitted files — no base
      section.querySelectorAll('.git-file-row').forEach(row => {
        row.addEventListener('click', () => {
          if (!sessionForGit || !ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({ type: 'git:diff', session: sessionForGit, file: row.dataset.file }));
        });
      });
      wireCollapse(section);
      scroll.appendChild(section);
    }

    // 2. Commit log (second)
    const log = data.log || [];
    if (log.length) {
      const section = document.createElement('div');
      section.className = 'git-section';
      let html = '<div class="git-section-title">Recent Commits</div><div class="git-section-body">';
      for (const c of log) {
        html += `<div class="git-log-row" data-hash="${esc(c.hash)}">
          <span class="git-log-hash">${esc(c.short)}</span>
          <span class="git-log-msg">${esc(c.message)}</span>
          <span class="git-log-time">${esc(c.relative)}</span>
        </div>
        <div class="git-log-files" data-for-hash="${esc(c.hash)}"></div>`;
      }
      html += '</div>';
      section.innerHTML = html;
      // Click commit → request files
      section.querySelectorAll('.git-log-row').forEach(row => {
        row.addEventListener('click', () => {
          const hash = row.dataset.hash;
          const filesEl = section.querySelector(`.git-log-files[data-for-hash="${hash}"]`);
          const wasExpanded = row.classList.contains('expanded');
          // Collapse all
          section.querySelectorAll('.git-log-row').forEach(r => r.classList.remove('expanded'));
          section.querySelectorAll('.git-log-files').forEach(f => f.classList.remove('visible'));
          if (wasExpanded) return;
          // Expand this one
          row.classList.add('expanded');
          filesEl.classList.add('visible');
          if (!filesEl.dataset.loaded) {
            filesEl.innerHTML = '<div class="git-log-loading">Loading files...</div>';
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'git:commit', session: sessionForGit, hash }));
            }
          }
        });
      });
      wireCollapse(section);
      scroll.appendChild(section);
    }

    // 3. Branch vs master (least important — last, collapsed by default)
    const bd = data.branchDiff;
    if (bd && bd.commitCount > 0) {
      const totalAdd = bd.files.reduce((s, f) => s + f.added, 0);
      const totalDel = bd.files.reduce((s, f) => s + f.deleted, 0);
      const section = document.createElement('div');
      section.className = 'git-section collapsed';
      let branchFilesHtml = '';
      for (const f of bd.files) {
        branchFilesHtml += `<div class="git-file-row" data-file="${esc(f.file)}" data-base="${esc(bd.base)}">
          <span class="git-file-status M">M</span>
          <span class="git-file-name">${esc(f.file)}</span>
          <span class="git-file-stat"><span class="add">+${f.added}</span> <span class="del">-${f.deleted}</span></span>
        </div>`;
      }
      section.innerHTML = `<div class="git-section-title">Branch vs ${esc(bd.base)} <span style="font-weight:400;text-transform:none;letter-spacing:0">(${bd.commitCount} commits, ${bd.files.length} files)</span></div>
        <div class="git-section-body">
        <div class="git-branch-summary">
          <span><span class="stat purple">${bd.commitCount}</span> commits ahead</span>
          <span><span class="stat green">+${totalAdd}</span> <span class="stat red">-${totalDel}</span></span>
          <span><span class="stat">${bd.files.length}</span> files</span>
        </div>
        ${branchFilesHtml}
        </div>`;
      // Click handlers for branch diff files — pass base
      section.querySelectorAll('.git-file-row').forEach(row => {
        row.addEventListener('click', () => {
          if (!sessionForGit || !ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({ type: 'git:diff', session: sessionForGit, file: row.dataset.file, base: row.dataset.base }));
        });
      });
      wireCollapse(section);
      scroll.appendChild(section);
    }

    // Restore expanded commits and loaded file lists
    for (const [hash, html] of Object.entries(loadedCommits)) {
      const filesEl = scroll.querySelector(`.git-log-files[data-for-hash="${hash}"]`);
      if (filesEl) {
        filesEl.dataset.loaded = '1';
        filesEl.innerHTML = html;
        filesEl.querySelectorAll('.git-file-row').forEach(row => {
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!sessionForGit || !ws || ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: 'git:diff', session: sessionForGit, file: row.dataset.file, commit: row.dataset.commit }));
          });
        });
      }
    }
    if (expandedHash) {
      const row = scroll.querySelector(`.git-log-row[data-hash="${expandedHash}"]`);
      const filesEl = scroll.querySelector(`.git-log-files[data-for-hash="${expandedHash}"]`);
      if (row && filesEl) { row.classList.add('expanded'); filesEl.classList.add('visible'); }
    }
    // Restore selected file highlight
    if (selectedFile) {
      const match = scroll.querySelector(`.git-file-row[data-file="${CSS.escape(selectedFile)}"]`);
      if (match) match.classList.add('selected');
    }

    // Empty state
    if (!files.length && !log.length && !(bd && bd.commitCount > 0)) {
      scroll.innerHTML = '<div class="git-empty">No git data available for this session.</div>';
    }
  }

  function expandCommitRow(hash, files, sidebarId, session) {
    const container = document.getElementById(sidebarId || 'git-sidebar');
    const filesEl = container && container.querySelector(`.git-log-files[data-for-hash="${hash}"]`);
    if (!filesEl) return;
    const sess = session || currentSession;
    filesEl.dataset.loaded = '1';
    if (!files.length) {
      filesEl.innerHTML = '<div class="git-log-loading">No files in this commit</div>';
      return;
    }
    let html = '';
    for (const f of files) {
      html += `<div class="git-file-row" data-file="${esc(f.file)}" data-commit="${esc(hash)}">
        <span class="git-file-status M">M</span>
        <span class="git-file-name" title="${esc(f.file)}">${esc(f.file)}</span>
        <span class="git-file-stat"><span class="add">+${f.added}</span> <span class="del">-${f.deleted}</span></span>
      </div>`;
    }
    filesEl.innerHTML = html;
    filesEl.querySelectorAll('.git-file-row').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!sess || !ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'git:diff', session: sess, file: row.dataset.file, commit: row.dataset.commit }));
      });
    });
  }

  function showDiffViewer(file, diff, prefix) {
    const pfx = prefix || 'git-diff';
    const sidebarId = prefix === 'td-git-diff' ? 'td-git-sidebar' : prefix === 'ts-git-diff' ? 'ts-git-sidebar' : 'git-sidebar';
    document.getElementById(pfx + '-header').style.display = '';
    document.getElementById(pfx + '-filename').textContent = file;
    const content = document.getElementById(pfx + '-content');
    if (!diff) {
      content.innerHTML = '<span class="diff-ctx">No diff available</span>';
    } else {
      const lines = diff.split('\n');
      content.innerHTML = lines.map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<div class="diff-add">${esc(line)}</div>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<div class="diff-del">${esc(line)}</div>`;
        if (line.startsWith('@@')) return `<div class="diff-hunk">${esc(line)}</div>`;
        return `<div class="diff-ctx">${esc(line)}</div>`;
      }).join('');
    }
    // Highlight selected file in sidebar
    document.querySelectorAll(`#${sidebarId} .git-file-row`).forEach(r => r.classList.remove('selected'));
    const match = document.querySelector(`#${sidebarId} .git-file-row[data-file="${CSS.escape(file)}"]`);
    if (match) match.classList.add('selected');
  }

  // ── Ideas panel ──────────────────────────────────
  function renderIdeas(ideas) {
    const list = document.getElementById('ideas-list');
    if (!ideas.length) { list.innerHTML = '<div style="color:var(--dim);text-align:center;padding:40px 0;font-size:14px">No ideas yet. Click + New Idea to submit one.</div>'; return; }
    ideas.sort((a, b) => b.number - a.number);
    list.innerHTML = ideas.map(i => {
      const isOpen = (i.state || '').toUpperCase() === 'OPEN';
      const stateCls = isOpen ? 'open' : 'closed';
      return `<div class="idea-card ${isOpen ? '' : 'closed'}" data-url="${esc(i.url)}">
        <div class="idea-title">#${i.number} ${esc(i.title)}</div>
        <div class="idea-meta"><span class="idea-state ${stateCls}">${isOpen ? 'open' : 'closed'}</span></div>
      </div>`;
    }).join('');
    list.querySelectorAll('.idea-card').forEach(card => {
      card.addEventListener('click', () => window.open(card.dataset.url, '_blank'));
    });
  }

  (function initIdeasDialog() {
    const overlay = document.getElementById('idea-dialog');
    const titleInput = document.getElementById('idea-dialog-title');
    const bodyInput = document.getElementById('idea-dialog-body');
    const saveBtn = document.getElementById('idea-dialog-save');
    const cancelBtn = document.getElementById('idea-dialog-cancel');
    const createBtn = document.getElementById('ideas-create-btn');

    function openDialog() { titleInput.value = ''; bodyInput.value = ''; overlay.classList.add('visible'); titleInput.focus(); }
    function closeDialog() { overlay.classList.remove('visible'); }

    createBtn.addEventListener('click', openDialog);
    cancelBtn.addEventListener('click', closeDialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });

    saveBtn.addEventListener('click', () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'idea:create', title, body: bodyInput.value.trim() }));
      }
      closeDialog();
    });

    // Enter in title field submits
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); } });
  })();

  // ── Update panel ─────────────────────────────────
  (function initUpdatePanel() {
    const pullBtn = document.getElementById('update-pull-btn');
    if (!pullBtn) return;
    pullBtn.addEventListener('click', () => {
      if (!ws || ws.readyState !== 1) return;
      const sel = document.getElementById('update-branch-select');
      const branch = sel ? sel.value : '';
      const logEl = document.getElementById('update-log');
      if (logEl) logEl.textContent = '';
      pullBtn.disabled = true;
      pullBtn.textContent = 'Pulling...';
      pullBtn.style.background = 'var(--green)';
      ws.send(JSON.stringify({ type: 'update:pull', branch }));
    });

    const restartBtn = document.getElementById('update-restart-btn');
    if (restartBtn) {
      restartBtn.addEventListener('click', () => {
        if (!ws || ws.readyState !== 1) return;
        if (!confirm('Restart hive now?')) return;
        restartBtn.disabled = true;
        restartBtn.textContent = 'Restarting...';
        ws.send(JSON.stringify({ type: 'hive:restart' }));
      });
    }
  })();

  // ── Notifications ─────────────────────────────────
  function handleNotify(msg) {
    switch (msg.event) {
      case 'session:idle': showToast(`Session ${msg.session} idle`, msg.name, 'idle'); nativeNotify(`Session ${msg.session} finished`, msg.name); break;
      case 'ci:changed': { const cls = msg.to === 'SUCCESS' ? 'ci-pass' : msg.to === 'FAILURE' ? 'ci-fail' : ''; showToast(`CI ${msg.to}`, `Session ${msg.session} PR#${msg.pr}`, cls); nativeNotify(`CI ${msg.to}`, `Session ${msg.session} PR#${msg.pr}: ${msg.from} -> ${msg.to}`); break; }
    }
  }

  function showToast(title, body, cls) {
    if (cls === 'error') console.error(title, body);
    const el = document.createElement('div'); el.className = `toast ${cls || ''}`;
    el.innerHTML = `<div class="toast-title">${esc(title)}</div><div class="toast-body">${esc(body || '')}</div>`;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); });
    toasts.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, 5000);
  }

  function nativeNotify(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/icon-192.png' });
  }

  function timeAgo(ts) { const diff = Date.now() - ts; if (diff < 60000) return 'just now'; if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`; if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`; return `${Math.round(diff / 86400000)}d ago`; }

  // ── Tooltips ──────────────────────────────────────
  const Tooltip = (() => {
    let el = null;          // the tooltip DOM element
    let showTimer = null;   // delay before showing
    let hideTimer = null;   // delay before hiding
    let longPressTimer = null;
    let currentTarget = null;
    const SHOW_DELAY = 400;
    const HIDE_DELAY = 100;
    const LONG_PRESS_DELAY = 500;
    const isTouchDevice = () => 'ontouchstart' in window;

    function create() {
      if (el) return;
      el = document.createElement('div');
      el.className = 'hive-tooltip';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
    }

    function position(target) {
      const r = target.getBoundingClientRect();
      const pad = 8;
      el.classList.remove('pos-above');

      // Try below first
      let top = r.bottom + pad;
      let left = r.left + r.width / 2 - el.offsetWidth / 2;

      // Flip above if clipped at bottom
      if (top + el.offsetHeight > window.innerHeight - pad) {
        top = r.top - el.offsetHeight - pad;
        el.classList.add('pos-above');
      }

      // Clamp horizontally
      left = Math.max(pad, Math.min(left, window.innerWidth - el.offsetWidth - pad));

      el.style.top = top + 'px';
      el.style.left = left + 'px';
    }

    function show(target) {
      const text = target.getAttribute('data-tooltip');
      if (!text) return;
      create();
      clearTimeout(hideTimer);
      el.innerHTML = text;
      currentTarget = target;

      // Position off-screen first to measure, then reposition
      el.style.top = '-9999px';
      el.style.left = '-9999px';
      el.classList.remove('visible');
      // Force layout so we can measure offsetWidth/Height
      void el.offsetHeight;
      position(target);
      // Trigger animation on next frame
      requestAnimationFrame(() => el.classList.add('visible'));
    }

    function hide() {
      clearTimeout(showTimer);
      clearTimeout(longPressTimer);
      if (!el) return;
      el.classList.remove('visible');
      currentTarget = null;
    }

    function startShow(target) {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      if (currentTarget === target) return;
      showTimer = setTimeout(() => show(target), SHOW_DELAY);
    }

    function startHide() {
      clearTimeout(showTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY);
    }

    function init() {
      // Desktop: hover via event delegation on body
      document.body.addEventListener('mouseenter', (e) => {
        if (isTouchDevice()) return;
        const t = e.target.closest('[data-tooltip]');
        if (t) startShow(t);
      }, true);

      document.body.addEventListener('mouseleave', (e) => {
        if (isTouchDevice()) return;
        const t = e.target.closest('[data-tooltip]');
        if (t) startHide();
      }, true);

      // Mobile: long-press
      document.body.addEventListener('touchstart', (e) => {
        const t = e.target.closest('[data-tooltip]');
        if (!t) return;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => show(t), LONG_PRESS_DELAY);
      }, { passive: true });

      document.body.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
        hide();
      }, { passive: true });

      document.body.addEventListener('touchcancel', () => {
        clearTimeout(longPressTimer);
        hide();
      }, { passive: true });

      // Dismiss on scroll or Escape
      window.addEventListener('scroll', hide, { passive: true, capture: true });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    }

    return { init };
  })();

  Tooltip.init();

  // ── Voice / Meetings panel ──────────────────────────
  let voiceStatus = { active: false };
  let mtgList = [];
  let mtgDetailOpen = false;
  let mtgDetailId = null;
  let mtgDetailData = null;
  let mtgPollTimer = null;
  let mtgElapsedTimer = null;
  let mtgTaskToastTimer = null;
  let mtgActiveTab = 'terminal';
  let mtgMode = 'ask';
  let mtgHistoryIdx = -1;
  let mtgHistoryDraft = '';
  let mtgSpeaking = false;
  var mtgTerm = null;
  var mtgFit = null;
  var mtgLastContent = '';
  var mtgScrolledUp = false;
  var mtgPending = null;
  const mtgAttachedImages = [];

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mtgFormatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  function mtgFormatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000 && d.getDate() === now.getDate()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (diff < 172800000) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function mtgFormatTimeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  }

  // ── Meeting list ───────────────────────────────────

  function initVoicePanel() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'voice:meetings' }));
    }
    if (mtgPollTimer) clearInterval(mtgPollTimer);
    mtgPollTimer = setInterval(() => {
      if (activeTab !== 'voice-panel') { clearInterval(mtgPollTimer); mtgPollTimer = null; return; }
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'voice:meetings' }));
    }, 5000);
  }

  function renderMeetingList(meetings, status) {
    mtgList = meetings || [];
    voiceStatus = status || voiceStatus;
    const container = $('#voice-list');
    if (!container) return;

    // Update sidebar badge
    const badge = $('#voice-badge');
    if (badge) {
      if (voiceStatus.active) { badge.textContent = ''; badge.classList.add('visible'); badge.style.background = 'var(--green)'; badge.style.minWidth = '8px'; badge.style.height = '8px'; }
      else { badge.classList.remove('visible'); badge.style = ''; }
    }

    if (!meetings.length && !voiceStatus.active) {
      container.innerHTML = '<div class="voice-empty">No meetings yet — click "+ New Meeting" to start</div>';
      return;
    }

    container.innerHTML = '';

    // Active meeting card (always first)
    if (voiceStatus.active && voiceStatus.meetingId) {
      const card = document.createElement('div');
      card.className = 'mtg-card mtg-card-live';
      card.dataset.meetingId = voiceStatus.meetingId;
      const elapsed = voiceStatus.joinedAt ? mtgFormatElapsed(Date.now() - voiceStatus.joinedAt) : '';
      card.innerHTML = '<div class="mtg-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg></div>'
        + '<div class="mtg-card-body"><div class="mtg-card-title">' + escapeHtml(voiceStatus.meetingName || 'Meeting') + ' <span class="mtg-card-pill live">LIVE</span></div>'
        + '<div class="mtg-card-meta"><span>' + (voiceStatus.transcriptLength || 0) + ' entries</span><span>' + (voiceStatus.tasksCreated || 0) + ' tasks</span></div></div>'
        + '<div class="mtg-card-time">' + elapsed + '</div>';
      container.appendChild(card);
    }

    // Past meetings
    for (const m of meetings) {
      // Skip if this is the active meeting already shown
      if (voiceStatus.active && voiceStatus.meetingId === m.id) continue;
      const card = document.createElement('div');
      card.className = 'mtg-card';
      card.dataset.meetingId = m.id;
      const duration = m.endedAt && m.startedAt ? mtgFormatElapsed(m.endedAt - m.startedAt) : '';
      const dateStr = mtgFormatDate(m.startedAt);
      card.innerHTML = '<div class="mtg-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg></div>'
        + '<div class="mtg-card-body"><div class="mtg-card-title">' + escapeHtml(m.name || 'Meeting') + '</div>'
        + '<div class="mtg-card-meta"><span>' + (m.transcriptCount || 0) + ' entries</span><span>' + (m.tasksCreated || 0) + ' tasks</span>' + (duration ? '<span>' + duration + '</span>' : '') + '</div></div>'
        + '<div class="mtg-card-time">' + dateStr + '</div>';
      container.appendChild(card);
    }
  }

  // ── Join dialog ────────────────────────────────────

  function openJoinDialog() {
    const overlay = document.getElementById('meeting-join-overlay');
    overlay.classList.add('visible');
    document.getElementById('mtg-join-url').value = '';
    document.getElementById('mtg-join-name').value = '';
    document.getElementById('mtg-join-url').focus();
  }

  function closeJoinDialog() {
    document.getElementById('meeting-join-overlay').classList.remove('visible');
  }

  function confirmJoin() {
    const url = document.getElementById('mtg-join-url').value.trim();
    if (!url) { showToast('Voice', 'Enter a meeting URL', 'error'); return; }
    const name = document.getElementById('mtg-join-name').value.trim() || undefined;
    const reportOnJoin = document.getElementById('mtg-join-standup').checked;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'voice:join', url, name, reportOnJoin }));
    }
    closeJoinDialog();
  }

  document.getElementById('voice-new-btn').addEventListener('click', openJoinDialog);
  document.getElementById('mtg-join-cancel').addEventListener('click', closeJoinDialog);
  document.getElementById('mtg-join-confirm').addEventListener('click', confirmJoin);
  document.getElementById('meeting-join-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeJoinDialog();
  });
  document.getElementById('mtg-join-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmJoin(); }
  });

  // ── Voice session panel (no meeting) ─────────────────

  document.getElementById('voice-session-btn').addEventListener('click', openVoiceSession);

  function openVoiceSession() {
    mtgDetailId = '__session__';
    mtgDetailOpen = true;
    mtgActiveTab = 'terminal';
    document.getElementById('mtg-detail-panel').classList.add('open');
    document.getElementById('mtg-detail-overlay').classList.add('open');

    // Header
    document.getElementById('mtg-detail-title').textContent = 'Voice Session';
    document.getElementById('mtg-detail-url').textContent = 'hive-voice';
    document.getElementById('mtg-detail-elapsed').textContent = '';
    const pill = document.getElementById('mtg-detail-pill');
    pill.textContent = 'Session';
    pill.className = 'voice-status-pill active';

    // Show terminal + input, hide meeting-specific stuff
    document.getElementById('mtg-detail-stats-bar').style.display = 'none';
    document.getElementById('mtg-speak-bar').style.display = 'none';
    document.getElementById('mtg-input-bar').style.display = '';
    document.getElementById('mtg-keys-bar').style.display = '';
    document.getElementById('mtg-tabs-bar').style.display = 'none';
    document.getElementById('mtg-terminal-wrap').style.display = '';
    document.getElementById('mtg-transcript-wrap').style.display = 'none';

    // Ensure session exists, then init terminal
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'voice:ensure-session' }));
    }
    initMtgTerminal();
  }

  // ── Meeting detail panel ───────────────────────────

  function openMeetingDetail(meetingId) {
    mtgDetailId = meetingId;
    mtgDetailOpen = true;
    mtgActiveTab = 'terminal';
    mtgSpeaking = false;
    document.getElementById('mtg-detail-panel').classList.add('open');
    document.getElementById('mtg-detail-overlay').classList.add('open');

    // Reset tabs
    document.querySelectorAll('[data-mtg-tab]').forEach(t => t.classList.toggle('active', t.dataset.mtgTab === 'terminal'));
    document.getElementById('mtg-terminal-wrap').style.display = '';
    document.getElementById('mtg-transcript-wrap').style.display = 'none';

    // Request detail
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'voice:meeting:detail', id: meetingId }));
    }

    // Init terminal for active meetings
    const isActive = voiceStatus.active && voiceStatus.meetingId === meetingId;
    const statsBar = document.getElementById('mtg-detail-stats-bar');
    const speakBar = document.getElementById('mtg-speak-bar');
    const inputBar = document.getElementById('mtg-input-bar');
    const keysBar = document.getElementById('mtg-keys-bar');
    const tabsBar = document.getElementById('mtg-tabs-bar');

    if (isActive) {
      statsBar.style.display = '';
      speakBar.style.display = '';
      inputBar.style.display = '';
      keysBar.style.display = '';
      tabsBar.style.display = '';
      initMtgTerminal();
      startMtgElapsedTimer();
      renderMtgDetailStatus();
    } else {
      // Past meeting — show transcript only, hide terminal/input
      statsBar.style.display = 'none';
      speakBar.style.display = 'none';
      inputBar.style.display = 'none';
      keysBar.style.display = 'none';
      // Switch to transcript tab
      mtgActiveTab = 'transcript';
      document.querySelectorAll('[data-mtg-tab]').forEach(t => t.classList.toggle('active', t.dataset.mtgTab === 'transcript'));
      document.getElementById('mtg-terminal-wrap').style.display = 'none';
      document.getElementById('mtg-transcript-wrap').style.display = '';
      tabsBar.style.display = 'none';
    }
  }

  function closeMeetingDetail() {
    mtgDetailOpen = false;
    mtgDetailId = null;
    mtgDetailData = null;
    document.getElementById('mtg-detail-panel').classList.remove('open');
    document.getElementById('mtg-detail-overlay').classList.remove('open');
    stopMtgElapsedTimer();
    // Unsubscribe from terminal
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal:unsubscribe', session: 'hive-voice' }));
    }
  }

  document.getElementById('mtg-detail-back').addEventListener('click', closeMeetingDetail);
  document.getElementById('mtg-detail-close').addEventListener('click', closeMeetingDetail);
  document.getElementById('mtg-detail-overlay').addEventListener('click', closeMeetingDetail);

  function renderMtgDetail(meeting) {
    if (!meeting) return;
    mtgDetailData = meeting;
    document.getElementById('mtg-detail-title').textContent = meeting.name || 'Meeting';
    document.getElementById('mtg-detail-url').textContent = meeting.url || '';

    if (meeting.active) {
      const pill = document.getElementById('mtg-detail-pill');
      pill.textContent = 'In Meeting';
      pill.className = 'voice-status-pill active';
    } else {
      const pill = document.getElementById('mtg-detail-pill');
      const duration = meeting.endedAt && meeting.startedAt ? mtgFormatElapsed(meeting.endedAt - meeting.startedAt) : '';
      pill.textContent = duration || 'Ended';
      pill.className = 'voice-status-pill';
    }

    // Render transcript
    renderMtgTranscript(meeting.transcript || [], meeting.responses || []);
  }

  function renderMtgDetailStatus() {
    if (!mtgDetailOpen) return;
    const pill = document.getElementById('mtg-detail-pill');
    if (pill && !mtgSpeaking) {
      if (voiceStatus.active) { pill.textContent = 'In Meeting'; pill.className = 'voice-status-pill active'; }
      else { pill.textContent = 'Inactive'; pill.className = 'voice-status-pill'; }
    }
    // Stats
    const st = document.getElementById('mtg-stat-transcript');
    const tt = document.getElementById('mtg-stat-tasks');
    if (st) st.textContent = String(voiceStatus.transcriptLength || 0);
    if (tt) tt.textContent = String(voiceStatus.tasksCreated || 0);
    // Dots
    const dotS = document.getElementById('mtg-dot-session');
    const dotB = document.getElementById('mtg-dot-bridge');
    const dotT = document.getElementById('mtg-dot-transcriber');
    if (dotS) dotS.className = 'voice-dot ' + (voiceStatus.active ? 'on' : '');
    if (dotB) dotB.className = 'voice-dot ' + (voiceStatus.audioBridgeConnected ? 'on' : (voiceStatus.active ? 'off' : ''));
    if (dotT) dotT.className = 'voice-dot ' + ((voiceStatus.transcriptLength || 0) > 0 ? 'on' : (voiceStatus.active ? 'off' : ''));
  }

  function renderMtgTranscript(transcript, responses) {
    const container = document.getElementById('mtg-transcript');
    if (!container) return;
    if (!transcript.length && !responses.length) {
      container.innerHTML = '<div class="voice-empty">No transcript yet</div>';
      return;
    }
    // Merge transcript entries and hive responses by timestamp
    const items = [];
    for (const e of transcript) items.push({ type: 'entry', data: e, ts: e._ts || 0 });
    for (const r of responses) items.push({ type: 'response', data: r, ts: r._ts || 0 });
    items.sort((a, b) => a.ts - b.ts);

    container.innerHTML = '';
    for (const item of items) {
      const el = document.createElement('div');
      if (item.type === 'response') {
        el.className = 'voice-entry voice-hive';
        el.innerHTML = '<span class="voice-entry-time">' + mtgFormatTimeAgo(item.ts) + '</span>'
          + '<span class="voice-entry-body"><span class="voice-speaker">[Hive]</span> <span class="voice-text">' + escapeHtml(item.data.text) + '</span></span>';
      } else {
        const speaker = item.data.speaker != null ? 'Speaker ' + item.data.speaker : 'Unknown';
        el.className = 'voice-entry';
        el.innerHTML = '<span class="voice-entry-time">' + mtgFormatTimeAgo(item.ts) + '</span>'
          + '<span class="voice-entry-body"><span class="voice-speaker">[' + speaker + ']</span> <span class="voice-text">' + escapeHtml(item.data.text) + '</span></span>';
      }
      container.appendChild(el);
    }
    container.scrollTop = container.scrollHeight;

    // Update tab count
    const tabBtn = document.querySelector('[data-mtg-tab="transcript"]');
    if (tabBtn) tabBtn.innerHTML = 'Transcript <span class="voice-tab-count">' + transcript.length + '</span>';
  }

  // ── Meeting detail terminal ────────────────────────

  function initMtgTerminal() {
    const container = document.getElementById('mtg-terminal');
    if (!container) return;
    if (!mtgTerm) {
      mtgTerm = new Terminal({
        theme: currentTheme === 'light' ? XTERM_LIGHT : XTERM_DARK,
        fontSize: 12, fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
        disableStdin: true, scrollback: 5000, convertEol: true, allowProposedApi: true,
      });
      mtgFit = new FitAddon.FitAddon();
      mtgTerm.loadAddon(mtgFit);
      mtgTerm.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => window.open(uri, '_blank')));
      enableTerminalCopy(mtgTerm);
      mtgTerm.open(container);
      mtgTerm.element.addEventListener('wheel', () => {
        setTimeout(() => {
          if (!mtgTerm) return;
          mtgScrolledUp = mtgTerm.buffer.active.viewportY < mtgTerm.buffer.active.baseY;
        }, 50);
      });
    }
    requestAnimationFrame(() => {
      if (mtgFit) mtgFit.fit();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal:subscribe', session: 'hive-voice', pane: 1 }));
        ws.send(JSON.stringify({ type: 'terminal:resize', session: 'hive-voice', cols: mtgTerm.cols, rows: mtgTerm.rows }));
      }
    });
    document.getElementById('mtg-input').focus();
  }

  function writeMtgContent(content) {
    if (!mtgTerm) return;
    mtgTerm.clear();
    mtgTerm.write(content);
    mtgLastContent = content;
  }

  // ── Elapsed timer ──────────────────────────────────

  function startMtgElapsedTimer() {
    if (mtgElapsedTimer) clearInterval(mtgElapsedTimer);
    mtgElapsedTimer = setInterval(() => {
      const el = document.getElementById('mtg-detail-elapsed');
      if (!el || !voiceStatus.joinedAt) return;
      el.textContent = mtgFormatElapsed(Date.now() - voiceStatus.joinedAt);
    }, 1000);
  }

  function stopMtgElapsedTimer() {
    if (mtgElapsedTimer) { clearInterval(mtgElapsedTimer); mtgElapsedTimer = null; }
    const el = document.getElementById('mtg-detail-elapsed');
    if (el) el.textContent = '';
  }

  // ── Send message to Claude in voice session ────────

  function sendMtgMessage() {
    const input = document.getElementById('mtg-input');
    const text = input.value.trim();
    const hasImages = mtgAttachedImages.length > 0;
    if (!text && !hasImages) return;
    if (!ws || ws.readyState !== 1) return;
    let message = text;
    if (hasImages) {
      const paths = mtgAttachedImages.map(i => i.path).join(', ');
      const prefix = '[Attached images: ' + paths + ']';
      message = text ? prefix + '\n\n' + text : prefix + '\n\nLook at the attached screenshot.';
      clearAttachments(mtgAttachedImages, document.getElementById('mtg-attachment-strip'));
    }
    const msgType = mtgMode === 'ask' ? 'ask' : 'tell';
    ws.send(JSON.stringify({ type: msgType, session: 'hive-voice', message }));
    pushMsgHistory('hive-voice', text);
    mtgHistoryIdx = -1;
    mtgHistoryDraft = '';
    input.value = '';
    showToast('Sent', (msgType === 'ask' ? 'Asked' : 'Told') + ' voice session', 'success');
  }

  document.getElementById('mtg-send').addEventListener('click', sendMtgMessage);
  document.getElementById('mtg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMtgMessage(); return; }
    if (e.key === 'Escape') { closeMeetingDetail(); return; }
    // Up/Down arrow history
    const input = e.target;
    const h = msgHistory['hive-voice'] || [];
    if (!h.length) return;
    if (e.key === 'ArrowUp') {
      const beforeCursor = input.value.substring(0, input.selectionStart);
      if (beforeCursor.includes('\n')) return;
      e.preventDefault();
      if (mtgHistoryIdx === -1) mtgHistoryDraft = input.value;
      if (mtgHistoryIdx < h.length - 1) mtgHistoryIdx++;
      input.value = h[h.length - 1 - mtgHistoryIdx];
    } else if (e.key === 'ArrowDown') {
      const afterCursor = input.value.substring(input.selectionEnd);
      if (afterCursor.includes('\n')) return;
      if (mtgHistoryIdx <= -1) return;
      e.preventDefault();
      mtgHistoryIdx--;
      input.value = mtgHistoryIdx === -1 ? mtgHistoryDraft : h[h.length - 1 - mtgHistoryIdx];
    }
  });

  // Mode toggle (Ask/Tell)
  const mtgModeToggle = document.getElementById('mtg-mode-toggle');
  mtgModeToggle.addEventListener('click', () => {
    mtgMode = mtgMode === 'ask' ? 'tell' : 'ask';
    mtgModeToggle.textContent = mtgMode === 'ask' ? 'Ask' : 'Tell';
    mtgModeToggle.classList.toggle('tell', mtgMode === 'tell');
  });

  // Keys bar
  document.querySelectorAll('[data-mtg-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'keys', session: 'hive-voice', keys: [btn.dataset.mtgKey], pane: 1 }));
    });
  });

  // Drag-drop images
  setupDragDrop(document.getElementById('mtg-input'), mtgAttachedImages, document.getElementById('mtg-attachment-strip'));

  // ── Speak / Leave buttons ──────────────────────────

  document.getElementById('mtg-speak-btn').addEventListener('click', () => {
    const input = document.getElementById('mtg-speak-input');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'voice:speak', text }));
    input.value = '';
  });

  document.getElementById('mtg-leave-btn').addEventListener('click', () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'voice:leave' }));
  });

  document.getElementById('mtg-speak-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('mtg-speak-btn').click(); }
  });

  // ── Tab switching (terminal / transcript) ──────────

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-mtg-tab]');
    if (tab) {
      const t = tab.dataset.mtgTab;
      if (!t) return;
      mtgActiveTab = t;
      document.querySelectorAll('[data-mtg-tab]').forEach(b => b.classList.toggle('active', b.dataset.mtgTab === t));
      document.getElementById('mtg-terminal-wrap').style.display = t === 'terminal' ? '' : 'none';
      document.getElementById('mtg-transcript-wrap').style.display = t === 'transcript' ? '' : 'none';
      if (t === 'terminal' && mtgFit) requestAnimationFrame(() => mtgFit.fit());
    }
  });

  // ── Click on meeting card → open detail ────────────

  document.addEventListener('click', (e) => {
    const card = e.target.closest('.mtg-card');
    if (card && card.dataset.meetingId) {
      openMeetingDetail(card.dataset.meetingId);
    }
  });

  // ── WS event handlers ─────────────────────────────

  function updateVoiceStatus(status) {
    voiceStatus = status || { active: false };
    // Re-render list
    renderMeetingList(mtgList, voiceStatus);
    // Update detail panel if open
    if (mtgDetailOpen) renderMtgDetailStatus();
  }

  function updateVoiceJoining(url) {
    const pill = document.getElementById('mtg-detail-pill');
    if (pill) { pill.textContent = 'Joining...'; pill.className = 'voice-status-pill joining'; }
  }

  function updateVoiceSpeaking(isSpeaking) {
    mtgSpeaking = isSpeaking;
    if (!mtgDetailOpen) return;
    const pill = document.getElementById('mtg-detail-pill');
    const dot = document.getElementById('mtg-speaking-indicator');
    const label = document.getElementById('mtg-speaking-label');
    if (isSpeaking) {
      if (pill) { pill.textContent = 'Speaking'; pill.className = 'voice-status-pill speaking'; }
      if (dot) dot.classList.add('active');
      if (label) label.textContent = 'speaking';
    } else {
      if (pill && voiceStatus.active) { pill.textContent = 'In Meeting'; pill.className = 'voice-status-pill active'; }
      if (dot) dot.classList.remove('active');
      if (label) label.textContent = 'listening';
    }
  }

  function showVoiceTaskToast(task) {
    const toast = document.getElementById('mtg-task-toast');
    if (!toast || !mtgDetailOpen) return;
    toast.textContent = 'Task created: ' + (task.title || task.id || 'new task');
    toast.style.display = '';
    if (mtgTaskToastTimer) clearTimeout(mtgTaskToastTimer);
    mtgTaskToastTimer = setTimeout(() => { toast.style.display = 'none'; }, 5000);
  }

  function appendVoiceTranscript(entry) {
    if (!mtgDetailOpen) return;
    const container = document.getElementById('mtg-transcript');
    if (!container) return;
    const empty = container.querySelector('.voice-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    const speaker = entry.speaker != null ? 'Speaker ' + entry.speaker : 'Unknown';
    el.className = 'voice-entry voice-new';
    el.innerHTML = '<span class="voice-entry-time">' + mtgFormatTimeAgo(Date.now()) + '</span>'
      + '<span class="voice-entry-body"><span class="voice-speaker">[' + speaker + ']</span> <span class="voice-text">' + escapeHtml(entry.text) + '</span></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function appendVoiceResponse(text) {
    if (!mtgDetailOpen) return;
    const container = document.getElementById('mtg-transcript');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'voice-entry voice-hive voice-new';
    el.innerHTML = '<span class="voice-entry-time">' + mtgFormatTimeAgo(Date.now()) + '</span>'
      + '<span class="voice-entry-body"><span class="voice-speaker">[Hive]</span> <span class="voice-text">' + escapeHtml(text) + '</span></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function updateVoiceDebug(debug) {
    if (!mtgDetailOpen) return;
    const dotB = document.getElementById('mtg-dot-bridge');
    const dotT = document.getElementById('mtg-dot-transcriber');
    if (dotB) dotB.className = 'voice-dot ' + (debug.audioBridgeConnected ? 'on' : 'off');
    if (dotT) dotT.className = 'voice-dot ' + (debug.transcriberRunning ? 'on' : 'off');
  }

  // ── Unregister any stale service workers ──────────
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
})();
