const fleet = require('../../core/fleet');
const relay = require('../../core/relay');
const tmux = require('../../core/tmux');

// ── Formatting helpers ───────────────────────────────

function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const HTML = { parse_mode: 'HTML' };

/**
 * Convert Claude's markdown response to rich Telegram HTML.
 * Uses all available Telegram formatting: bold, italic, code,
 * underline, blockquote, and emoji for visual hierarchy.
 */
function mdToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let inCodeBlock = false;
  let inBlockquote = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    // Code block fences
    if (trimmed.startsWith('```')) {
      if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
      if (inCodeBlock) {
        out.push('</pre>');
        inCodeBlock = false;
      } else {
        out.push('<pre>');
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(esc(line));
      continue;
    }

    // Escape HTML
    line = esc(line);
    const escapedTrimmed = line.trim();

    // Horizontal rules (--- or ***)
    if (/^[-*_]{3,}$/.test(trimmed)) {
      if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
      out.push('───────────────────');
      continue;
    }

    // H1: # heading → ▎HEADING (bold + line)
    const h1 = line.match(/^#{1}\s+(.+)$/);
    if (h1) {
      if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
      out.push(`\n<b>▎${h1[1].toUpperCase()}</b>`);
      continue;
    }

    // H2: ## heading → bold with marker
    const h2 = line.match(/^#{2}\s+(.+)$/);
    if (h2) {
      if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
      out.push(`\n<b>◆ ${h2[1]}</b>`);
      continue;
    }

    // H3: ### heading → bold italic
    const h3 = line.match(/^#{3,}\s+(.+)$/);
    if (h3) {
      if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
      out.push(`<b><i>${h3[1]}</i></b>`);
      continue;
    }

    // Detect standalone section headers (short lines, Title Case or ALL CAPS, no punctuation at end)
    if (escapedTrimmed.length > 0 && escapedTrimmed.length < 40 &&
        !escapedTrimmed.endsWith('.') && !escapedTrimmed.endsWith(':') &&
        !escapedTrimmed.startsWith('•') && !escapedTrimmed.startsWith('-') &&
        /^[A-Z]/.test(escapedTrimmed) &&
        i > 0 && (!lines[i-1] || !lines[i-1].trim())) {
      // Check next line exists and is content (not empty)
      const nextLine = lines[i+1];
      if (nextLine && nextLine.trim() && !nextLine.trim().startsWith('#')) {
        if (inBlockquote) { out.push('</blockquote>'); inBlockquote = false; }
        out.push(`\n<b>◆ ${escapedTrimmed}</b>`);
        continue;
      }
    }

    // Blockquote lines (> text)
    const bq = line.match(/^&gt;\s*(.*)$/);
    if (bq) {
      if (!inBlockquote) { out.push('<blockquote>'); inBlockquote = true; }
      out.push(applyInlineFormatting(bq[1]));
      continue;
    } else if (inBlockquote && trimmed === '') {
      out.push('</blockquote>');
      inBlockquote = false;
      out.push('');
      continue;
    }

    // Numbered list: 1. item
    const numList = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (numList) {
      const indent = numList[1];
      const content = numList[2];
      const idx = line.match(/^(\s*)(\d+)\./);
      out.push(`${indent}<b>${idx[2]}.</b> ${applyInlineFormatting(content)}`);
      continue;
    }

    // Bullet points: - item or * item
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) {
      const depth = Math.floor(bullet[1].length / 2);
      const indent = '  '.repeat(depth);
      const marker = depth === 0 ? '•' : '◦';
      out.push(`${indent}${marker} ${applyInlineFormatting(bullet[2])}`);
      continue;
    }

    // Regular line — apply inline formatting
    out.push(applyInlineFormatting(line));
  }

  if (inCodeBlock) out.push('</pre>');
  if (inBlockquote) out.push('</blockquote>');

  // Clean up excessive blank lines
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Apply inline markdown formatting to a single line.
 */
function applyInlineFormatting(line) {
  // Bold: **text** or __text__
  line = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  line = line.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (not inside words)
  line = line.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  line = line.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Inline code: `code`
  line = line.replace(/`([^`]+?)`/g, '<code>$1</code>');

  return line;
}

function stateTag(state) {
  switch (state) {
    case 'idle':    return '[IDLE]';
    case 'working': return '[WORK]';
    case 'off':     return '[ OFF]';
    default:        return '[  ? ]';
  }
}

function ciTag(result) {
  switch (result) {
    case 'SUCCESS':  return 'CI:PASS';
    case 'FAILURE':  return 'CI:FAIL';
    case 'RUNNING':  return 'CI:RUN ';
    case 'UNSTABLE': return 'CI:WARN';
    case 'ABORTED':  return 'CI:STOP';
    default:         return '';
  }
}

function reviewTag(review) {
  switch (review) {
    case 'APPROVED':         return 'APPROVED';
    case 'CHANGES_REQUESTED': return 'CHANGES';
    case 'REVIEW_REQUIRED':  return 'REVIEW?';
    default:                 return '';
  }
}

function shortBranch(branch) {
  if (!branch) return 'master';
  const short = branch.replace(/^[^/]+\//, '');
  return short.length > 30 ? short.substring(0, 27) + '...' : short;
}

function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

function formatGitStatus(git) {
  if (git.staged + git.modified + git.untracked === 0) return 'clean';
  const parts = [];
  if (git.staged) parts.push(`${git.staged}S`);
  if (git.modified) parts.push(`${git.modified}M`);
  if (git.untracked) parts.push(`${git.untracked}U`);
  return parts.join(' ');
}

// ── Resolve session from user input ────────────────────

function resolve(config, send, query) {
  const name = fleet.findSession(config, query);
  if (!name) {
    send(`<pre>? No session matching "${esc(query)}"</pre>`, HTML);
    return null;
  }
  return name;
}

// ── Commands ───────────────────────────────────────────

async function status(config, send) {
  const sessions = fleet.getFleetStatus(config);
  if (sessions.length === 0) {
    send('<pre>No fleet sessions found.</pre>', HTML);
    return;
  }

  const lines = ['HIVE FLEET STATUS', '═'.repeat(42)];

  for (const s of sessions) {
    const num = rpad(s.num, 2);
    const state = stateTag(s.state);
    const branch = pad(esc(shortBranch(s.branch)), 30);
    lines.push(`${num} ${state} ${branch}`);

    if (s.pr) {
      const ci = s.pr.ciResult ? ` ${ciTag(s.pr.ciResult)}` : '';
      const rv = s.pr.review ? ` ${reviewTag(s.pr.review)}` : '';
      lines.push(`         PR#${pad(s.pr.prNum, 6)} +${rpad(s.pr.prAdds, 4)} -${rpad(s.pr.prDels, 4)}${ci}${rv}`);
    }
  }

  lines.push('═'.repeat(42));
  const idle = sessions.filter(s => s.state === 'idle').length;
  const work = sessions.filter(s => s.state === 'working').length;
  const off = sessions.filter(s => s.state === 'off').length;
  lines.push(`${idle} idle  ${work} working  ${off} off`);

  send(`<pre>${lines.join('\n')}</pre>`, HTML);
}

async function idle(config, send) {
  const sessions = fleet.getFleetStatus(config).filter(s => s.state === 'idle');
  if (sessions.length === 0) {
    send('<pre>No idle sessions.</pre>', HTML);
    return;
  }

  const lines = ['IDLE SESSIONS', '─'.repeat(42)];
  for (const s of sessions) {
    const num = rpad(s.num, 2);
    const branch = esc(shortBranch(s.branch));
    const git = formatGitStatus(s.git);
    lines.push(`${num}  ${pad(branch, 28)} ${git}`);
  }

  send(`<pre>${lines.join('\n')}</pre>`, HTML);
}

async function working(config, send) {
  const sessions = fleet.getFleetStatus(config).filter(s => s.state === 'working');
  if (sessions.length === 0) {
    send('<pre>No sessions currently working.</pre>', HTML);
    return;
  }

  const lines = ['WORKING SESSIONS', '─'.repeat(42)];
  for (const s of sessions) {
    const num = rpad(s.num, 2);
    const branch = esc(shortBranch(s.branch));
    lines.push(`${num}  ${branch}`);
    if (s.pr) {
      const ci = s.pr.ciResult ? `  ${ciTag(s.pr.ciResult)}` : '';
      lines.push(`    PR#${s.pr.prNum} +${s.pr.prAdds} -${s.pr.prDels}${ci}`);
    }
  }

  send(`<pre>${lines.join('\n')}</pre>`, HTML);
}

async function session(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const s = fleet.getSession(config, name);
  const lines = [
    `SESSION ${s.num}`,
    '═'.repeat(42),
    `State:   ${stateTag(s.state)}`,
    `Branch:  ${esc(s.branch || 'master')}`,
  ];

  if (s.ticket) lines.push(`Ticket:  ${s.ticket}`);
  lines.push(`Git:     ${formatGitStatus(s.git)}`);

  if (s.pr) {
    lines.push('');
    lines.push(`PR #${s.pr.prNum}  +${s.pr.prAdds} -${s.pr.prDels}  (${s.pr.prFiles} files)`);
    if (s.pr.review) lines.push(`Review:  ${reviewTag(s.pr.review)}`);
    if (s.pr.ciBuild) lines.push(`CI:      ${ciTag(s.pr.ciResult)}  Jenkins #${s.pr.ciBuild}`);
  } else {
    lines.push(`PR:      none`);
  }

  send(`<pre>${lines.join('\n')}</pre>`, HTML);
}

async function peek(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const content = fleet.peekSession(config, name);
  if (!content) {
    send('<i>(empty pane)</i>', HTML);
    return;
  }

  const num = fleet.sessionNum(name);

  // Convert markdown to formatted HTML
  const formatted = mdToHtml(content);

  // Telegram has a 4096 char limit
  const header = `<b>Session ${num}</b>\n\n`;
  const maxContent = 4096 - header.length - 10;
  const truncated = formatted.length > maxContent
    ? formatted.substring(formatted.length - maxContent)
    : formatted;

  send(`${header}${truncated}`, HTML);
}

async function ask(config, send, edit, query, message) {
  const name = resolve(config, send, query);
  if (!name) return;

  const num = fleet.sessionNum(name);

  const sentMsg = await send(`⏳ <b>Session ${num}</b> — thinking...`, HTML);
  const msgId = sentMsg && sentMsg.message_id;

  const result = await relay.ask(config, name, message, {
    onProgress: () => {},
    onStream: (content, isFinal) => {
      if (!msgId) return;
      const formatted = mdToHtml(content);
      const truncated = formatted.length > 3800
        ? formatted.substring(formatted.length - 3800)
        : formatted;
      edit(msgId, `⏳ <b>Session ${num}</b> — working...\n\n${truncated}`, HTML);
    },
  });

  if (result.success) {
    const duration = Math.round(result.duration / 1000);
    const formatted = mdToHtml(result.response);
    const truncated = formatted.length > 3800
      ? formatted.substring(0, 3800) + '\n\n<i>... truncated — /peek for full</i>'
      : formatted;
    const text = `✅ <b>Session ${num}</b> (${duration}s)\n\n${truncated}`;
    if (msgId) {
      edit(msgId, text, HTML);
    } else {
      send(text, HTML);
    }
  } else {
    const text = `❌ <b>Session ${num}</b>: ${esc(result.error)}`;
    if (msgId) {
      edit(msgId, text, HTML);
    } else {
      send(text, HTML);
    }
  }
}

async function tell(config, send, query, message) {
  const name = resolve(config, send, query);
  if (!name) return;

  const result = await relay.tell(config, name, message);
  if (result.success) {
    send(`📨 Sent to session ${fleet.sessionNum(name)}`, HTML);
  } else {
    send(`❌ ${esc(result.error)}`, HTML);
  }
}

async function restart(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const paneTarget = `${name}:.${config.sessions.claudePane}`;
  tmux.sendKeys(paneTarget, '', false);
  tmux.exec(`tmux send-keys -t "${paneTarget}" Escape`);
  setTimeout(() => {
    tmux.sendKeys(paneTarget, '/exit', true);
    send(`♻️ Restarting Claude in session ${fleet.sessionNum(name)}...`, HTML);
    setTimeout(() => {
      tmux.sendKeys(paneTarget, 'claude --resume', true);
    }, 3000);
  }, 500);
}

async function kill(config, send, query) {
  const name = resolve(config, send, query);
  if (!name) return;

  const ok = tmux.killSession(name);
  if (ok) {
    send(`💀 Session ${fleet.sessionNum(name)} killed.`, HTML);
  } else {
    send(`❌ Failed to kill session.`, HTML);
  }
}

async function prs(config, send) {
  const sessions = fleet.getFleetStatus(config).filter(s => s.pr);
  if (sessions.length === 0) {
    send('<pre>No open PRs.</pre>', HTML);
    return;
  }

  const lines = ['OPEN PRs', '═'.repeat(42)];
  for (const s of sessions) {
    const num = rpad(s.num, 2);
    const pr = pad(`PR#${s.pr.prNum}`, 10);
    const diff = `+${rpad(s.pr.prAdds, 4)} -${rpad(s.pr.prDels, 4)}`;
    const ci = s.pr.ciResult ? ` ${ciTag(s.pr.ciResult)}` : '';
    const rv = s.pr.review ? ` ${reviewTag(s.pr.review)}` : '';
    lines.push(`${num}  ${pr} ${diff}${ci}${rv}`);
    lines.push(`    ${esc(shortBranch(s.branch))}`);
  }

  send(`<pre>${lines.join('\n')}</pre>`, HTML);
}

module.exports = { status, idle, working, session, peek, ask, tell, restart, kill, prs };
