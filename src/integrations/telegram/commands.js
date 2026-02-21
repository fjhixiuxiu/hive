const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const tmux = require('../../core/tmux');

// ── Formatting helpers ─────────────────────────────────

function stateIcon(state) {
  switch (state) {
    case 'idle': return '🟢';
    case 'working': return '🟡';
    case 'off': return '⚫';
    default: return '⚪';
  }
}

function ciIcon(result) {
  switch (result) {
    case 'SUCCESS': return '✅';
    case 'FAILURE': return '❌';
    case 'RUNNING': return '🔄';
    case 'UNSTABLE': return '⚠️';
    case 'ABORTED': return '⏹';
    default: return '';
  }
}

function reviewIcon(review) {
  switch (review) {
    case 'APPROVED': return '✅';
    case 'CHANGES_REQUESTED': return '🔴';
    case 'REVIEW_REQUIRED': return '👀';
    default: return '';
  }
}

function shortBranch(branch) {
  if (!branch) return 'master';
  // "nukulb/DEV-43966-fix-paystub" → "DEV-43966-fix-paystub"
  const short = branch.replace(/^[^/]+\//, '');
  return short.length > 35 ? short.substring(0, 32) + '...' : short;
}

function formatSessionLine(s) {
  const icon = stateIcon(s.state);
  const num = String(s.num).padStart(2);
  const branch = shortBranch(s.branch);

  let extras = '';
  if (s.pr) {
    extras += ` PR#${s.pr.prNum}`;
    if (s.pr.ciResult) extras += ciIcon(s.pr.ciResult);
    if (s.pr.review) extras += reviewIcon(s.pr.review);
  }

  return `${icon} \`${num}\` ${branch}${extras}`;
}

function formatGitStatus(git) {
  if (git.staged + git.modified + git.untracked === 0) return 'clean';
  const parts = [];
  if (git.staged) parts.push(`${git.staged} staged`);
  if (git.modified) parts.push(`${git.modified} modified`);
  if (git.untracked) parts.push(`${git.untracked} untracked`);
  return parts.join(', ');
}

// ── Resolve session from user input ────────────────────

function resolve(config, send, query) {
  const name = fleet.findSession(config, query);
  if (!name) {
    send(`❓ No session matching "${query}"`);
    return null;
  }
  return name;
}

// ── Commands ───────────────────────────────────────────

async function status(config, send) {
  const sessions = fleet.getFleetStatus(config);
  if (sessions.length === 0) {
    send('No fleet sessions found.');
    return;
  }

  // Group consecutive off sessions
  const lines = [];
  let offRun = [];

  for (const s of sessions) {
    if (s.state === 'off' && !s.pr) {
      offRun.push(s.num);
    } else {
      if (offRun.length > 0) {
        lines.push(flushOff(offRun));
        offRun = [];
      }
      lines.push(formatSessionLine(s));
    }
  }
  if (offRun.length > 0) lines.push(flushOff(offRun));

  send(lines.join('\n'));
}

function flushOff(nums) {
  if (nums.length === 1) return `⚫ \`${String(nums[0]).padStart(2)}\` —`;
  // Collapse consecutive: [13,14,15,16] → "13-16"
  const first = nums[0], last = nums[nums.length - 1];
  if (last - first === nums.length - 1) {
    return `⚫ \`${first}-${last}\` —`;
  }
  return `⚫ \`${nums.join(',')}\` —`;
}

async function idle(config, send) {
  const sessions = fleet.getFleetStatus(config).filter(s => s.state === 'idle');
  if (sessions.length === 0) {
    send('No idle sessions.');
    return;
  }
  send(sessions.map(formatSessionLine).join('\n'));
}

async function working(config, send) {
  const sessions = fleet.getFleetStatus(config).filter(s => s.state === 'working');
  if (sessions.length === 0) {
    send('No sessions currently working.');
    return;
  }
  send(sessions.map(formatSessionLine).join('\n'));
}

async function session(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const s = fleet.getSession(config, name);
  const lines = [
    `*Session ${s.num}* — ${s.name}`,
    `${stateIcon(s.state)} Claude: *${s.state}*`,
    `Branch: \`${s.branch || 'master'}\``,
  ];

  if (s.ticket) lines.push(`JIRA: \`${s.ticket}\``);
  lines.push(`Git: ${formatGitStatus(s.git)}`);

  if (s.pr) {
    let prLine = `PR: #${s.pr.prNum}  +${s.pr.prAdds} -${s.pr.prDels} (${s.pr.prFiles} files)`;
    if (s.pr.review) prLine += ` ${reviewIcon(s.pr.review)} ${s.pr.review}`;
    lines.push(prLine);

    if (s.pr.ciBuild) {
      lines.push(`CI: Jenkins #${s.pr.ciBuild} — ${s.pr.ciResult} ${ciIcon(s.pr.ciResult)}`);
    }
  } else {
    lines.push('PR: none');
  }

  send(lines.join('\n'));
}

async function peek(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const content = fleet.peekSession(config, name);
  if (!content) {
    send('(empty pane)');
    return;
  }

  // Telegram has a 4096 char limit
  const truncated = content.length > 3900
    ? content.substring(content.length - 3900)
    : content;

  send(`\`\`\`\n${truncated}\n\`\`\``);
}

async function ask(config, send, query, message) {
  const name = resolve(config, send, query);
  if (!name) return;

  send(`⏳ Sent to session ${fleet.sessionNum(name)}, waiting...`);

  const result = await relay.ask(config, name, message, (progress) => {
    send(`⏳ ${progress}`);
  });

  if (result.success) {
    const duration = Math.round(result.duration / 1000);
    const response = result.response.length > 3800
      ? result.response.substring(0, 3800) + '\n\n_(truncated — /peek for full)_'
      : result.response;
    send(`✅ *Session ${fleet.sessionNum(name)}* replied (${duration}s):\n\n${response}`);
  } else {
    send(`❌ ${result.error}`);
  }
}

async function tell(config, send, query, message) {
  const name = resolve(config, send, query);
  if (!name) return;

  const result = relay.tell(config, name, message);
  if (result.success) {
    send(`📨 Sent to session ${fleet.sessionNum(name)}`);
  } else {
    send(`❌ ${result.error}`);
  }
}

async function restart(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const paneTarget = `${name}:.${config.sessions.claudePane}`;
  tmux.sendKeys(paneTarget, '/exit', true);
  send(`♻️ Restarting Claude in session ${fleet.sessionNum(name)}...`);

  setTimeout(() => {
    tmux.sendKeys(paneTarget, 'claude --resume', true);
  }, 3000);
}

async function kill(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const ok = tmux.killSession(name);
  if (ok) {
    send(`💀 Session ${fleet.sessionNum(name)} killed.`);
  } else {
    send(`❌ Failed to kill session.`);
  }
}

async function prs(config, send) {
  const sessions = fleet.getFleetStatus(config).filter(s => s.pr);
  if (sessions.length === 0) {
    send('No open PRs across the fleet.');
    return;
  }

  const lines = sessions.map(s => {
    const ci = s.pr.ciResult ? ` ${ciIcon(s.pr.ciResult)}${s.pr.ciResult}` : '';
    const review = s.pr.review ? ` ${reviewIcon(s.pr.review)}` : '';
    return `\`${String(s.num).padStart(2)}\` PR#${s.pr.prNum} +${s.pr.prAdds}-${s.pr.prDels}${ci}${review} — ${shortBranch(s.branch)}`;
  });

  send(lines.join('\n'));
}

module.exports = { status, idle, working, session, peek, ask, tell, restart, kill, prs };
