/**
 * factory/ui/app.js — Dashboard controller.
 * Vanilla JS, no framework, no build step.
 * Polls GET /api/status every 12s and renders all regions from the JSON payload.
 */

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 12_000;
const LOG_PAGE_SIZE    = 30;

// ── State ─────────────────────────────────────────────────────────────────────
let currentRepo      = null;
let pollTimer        = null;
let logLimit         = LOG_PAGE_SIZE;
let lastStatus       = null;   // last successful status payload
let tickRunning      = false;
let lastTickCompletedAt = 0;   // timestamp of last tick completion, for post-dispatch cooldown
let autopilotInfo    = { scheduled: false, intervalSeconds: null, nextRunEta: null };
let viewMode         = localStorage.getItem('factory.viewMode') || 'single';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const repoSelect          = $('repo-select');
const viewSingle          = $('view-single');
const viewPortfolio       = $('view-portfolio');
const singleRepoView      = $('single-repo-view');
const portfolioView       = $('portfolio-view');
const portfolioGrid       = $('portfolio-grid');
const pollDot             = $('poll-dot');
const pollLabel           = $('poll-label');
const autopilotBadge      = $('autopilot-badge');
const disconnectedBanner  = $('disconnected-banner');
const verdictRegion       = $('verdict-region');
const tickPanel           = $('tick-panel');
const tickOutput          = $('tick-output');
const gaugesRegion        = $('gauges-region');
const tasksCount          = $('tasks-count');
const tasksRegion         = $('tasks-region');
const timelineRegion      = $('timeline-region');
const btnLoadMore         = $('btn-load-more');

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60)   return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)    return `${diffH}h ago`;
  return `${Math.round(diffH / 24)}d ago`;
}

function formatDuration(input) {
  if (!input) return '—';
  let ms = 0;
  if (typeof input === 'number') {
    ms = input;
  } else if (typeof input === 'string') {
    const time = new Date(input).getTime();
    if (isNaN(time)) return '—';
    ms = Date.now() - time;
  } else if (input instanceof Date) {
    ms = Date.now() - input.getTime();
  }

  if (isNaN(ms) || ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);

  if (hours > 0) {
    return min > 0 ? `${hours}h ${min}m` : `${hours}h`;
  }
  if (totalMin > 0) {
    return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  }
  return `${totalSec}s`;
}

function shortTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function ciClass(ci) {
  const map = { green: 'ci-green', RED: 'ci-red', pending: 'ci-pending', 'no-ci': 'ci-no-ci' };
  return map[ci] ?? 'ci-no-ci';
}

function ciEmoji(ci) {
  return { green: '✓', RED: '✗', pending: '…', 'no-ci': '—' }[ci] ?? '—';
}

function typeIcon(type) {
  const map = {
    dispatch:         '🚀',
    merged:           '✅',
    'reconciled-merged': '↩',
    'would-merge':    '🔶',
    wait:             '⏸',
    blocked:          '⚠',
    idle:             '💤',
    'skipped-dispatch': '⏭',
    error:            '🔴',
  };
  return map[type] ?? '•';
}

function typeColor(type) {
  const map = {
    dispatch:         'var(--type-dispatch)',
    merged:           'var(--type-merged)',
    'reconciled-merged': 'var(--type-reconcile)',
    'would-merge':    'var(--type-would-merge)',
    wait:             'var(--type-wait)',
    blocked:          'var(--type-blocked)',
    idle:             'var(--type-idle)',
    'skipped-dispatch': 'var(--type-wait)',
    error:            'var(--type-blocked)',
  };
  return map[type] ?? 'var(--text-muted)';
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderVerdict(status) {
  const nt      = status.nextTick;
  const marker  = nt.marker; // 'act' | 'wait' | 'blocked'
  const icon    = marker === 'act' ? '▶' : marker === 'blocked' ? '⚠' : '⏸';
  const label   = marker === 'act' ? 'Act — run next tick now' : marker === 'blocked' ? 'Blocked — needs attention' : 'Wait — nothing to do yet';

  // Button is enabled ONLY when the orchestrator verdict is actionable ('act') and no agent/tick is active.
  // Post-tick cooldown: after a tick dispatches an agent, sessionRunning may take a few seconds to
  // become true (the agent process needs to start and write its transcript). During that window the
  // status API returns sessionRunning:false + marker:'act', which would incorrectly re-enable the
  // button. A 15-second cooldown after any tick prevents this.
  const POST_TICK_COOLDOWN_MS = 15_000;
  const runningTask = Object.values(status.tasks).find((t) => t.sessionRunning);
  const hasSessionRunning = !!runningTask;
  const inCooldown = lastTickCompletedAt && (Date.now() - lastTickCompletedAt < POST_TICK_COOLDOWN_MS);
  const isActable = marker === 'act';
  const btnDisabled = !isActable || tickRunning || autopilotInfo.scheduled || hasSessionRunning || inCooldown;

  let btnText = 'Run next tick';
  if (tickRunning)             btnText = 'Running tick...';
  else if (hasSessionRunning)  btnText = `${runningTask.lastRole ?? 'Agent'} running in background...`;
  else if (inCooldown)         btnText = 'Agent starting up...';

  let btnTitle = 'Run node orchestrator.mjs ' + (currentRepo ?? '');
  if (tickRunning)             btnTitle = 'A tick is already running';
  else if (autopilotInfo.scheduled) btnTitle = `Autopilot is active (launchd runs every ${Math.round((autopilotInfo.intervalSeconds ?? 900) / 60)}m)`;
  else if (hasSessionRunning)  btnTitle = `An agent session (${runningTask.lastRole ?? 'agent'}) is currently running in background`;
  else if (inCooldown)         btnTitle = 'Waiting for agent process to initialize...';
  else if (marker === 'wait')  btnTitle = `Wait: ${nt.description}`;
  else if (marker === 'blocked') btnTitle = `Blocked: ${nt.description}`;

  verdictRegion.innerHTML = `
    <div class="verdict-banner ${escHtml(marker)}">
      <div class="verdict-icon">${icon}</div>
      <div class="verdict-text">
        <div class="verdict-label">${escHtml(label)}</div>
        <div class="verdict-description">${escHtml(nt.description)}</div>
      </div>
      <button id="btn-tick" class="btn-tick${tickRunning || hasSessionRunning ? ' running' : ''}" ${btnDisabled ? 'disabled' : ''} title="${escHtml(btnTitle)}">
        <span class="btn-tick-spinner"></span>
        <span class="btn-tick-icon">${tickRunning || hasSessionRunning ? '' : '▶'}</span>
        ${escHtml(btnText)}
      </button>
    </div>
  `;

  if (!btnDisabled) {
    document.getElementById('btn-tick').addEventListener('click', runTick);
  }
}

function renderGauges(status) {
  const b = status.budget;
  const budgetPct  = b.cap > 0 ? (b.count / b.cap) * 100 : 0;
  const budgetBar  = budgetPct > 80 ? 'red' : budgetPct > 55 ? 'amber' : '';
  const budgetVal  = budgetPct > 80 ? 'red' : budgetPct > 55 ? 'amber' : 'green';

  const inFlight   = Object.values(status.tasks).filter(t => t.branch).length;
  const wipCap     = status.config.maxConcurrentTasks;
  const wipPct     = wipCap > 0 ? (inFlight / wipCap) * 100 : 0;

  const headShort  = status.repoHead ? status.repoHead.slice(0, 8) : '—';
  const headFull   = escHtml(status.repoHead ?? '');

  gaugesRegion.innerHTML = `
    <div class="gauges">
      <div class="gauge-card">
        <div class="gauge-label">Budget</div>
        <div class="gauge-value ${budgetVal}">${b.count} / ${b.cap}</div>
        <div class="gauge-bar-track"><div class="gauge-bar-fill ${budgetBar}" style="width:${Math.min(budgetPct,100)}%"></div></div>
      </div>
      <div class="gauge-card">
        <div class="gauge-label">WIP</div>
        <div class="gauge-value ${wipPct >= 100 ? 'amber' : 'neutral'}">${inFlight} / ${wipCap}</div>
        <div class="gauge-bar-track"><div class="gauge-bar-fill ${wipPct >= 100 ? 'amber' : ''}" style="width:${Math.min(wipPct,100)}%"></div></div>
      </div>
      <div class="gauge-card">
        <div class="gauge-label">autoMerge</div>
        <div class="gauge-value ${status.config.autoMerge ? 'green' : 'neutral'}">${status.config.autoMerge ? 'ON' : 'OFF'}</div>
      </div>
      <div class="gauge-card">
        <div class="gauge-label">gh auth</div>
        <div class="gauge-value ${status.ghAuth ? 'green' : 'red'}">${status.ghAuth ? 'OK' : 'FAIL'}</div>
      </div>
      <div class="gauge-card">
        <div class="gauge-label">HEAD</div>
        <div class="gauge-value neutral" title="${headFull}">${escHtml(headShort)}${status.repoSync?.ok === false ? ' ⚠' : ''}</div>
      </div>
    </div>
  `;
}

function renderTasks(status) {
  const taskIds = Object.keys(status.tasks).sort();
  tasksCount.textContent = taskIds.length;

  if (taskIds.length === 0) {
    tasksRegion.innerHTML = '<div class="tasks-empty">No tasks currently in flight.</div>';
    return;
  }

  tasksRegion.innerHTML = taskIds.map((taskId) => {
    const t       = status.tasks[taskId];
    const role    = t.lastRole ?? '?';
    const roleClass = `pill-role-${role}`;
    const sessionClass = t.sessionRunning ? 'pill-session-running' : 'pill-session-idle';
    const sessionLabel = t.sessionRunning ? 'session running' : 'session idle';
    const pr = t.pr;
    const prHref = pr
      ? `https://github.com/${status.repo === 'leanmacrofeed' ? 'lszantho/lean-macro-feed' : currentRepo}/pull/${pr.number}`
      : null;

    const prHtml = pr ? `
      <div class="task-meta-item">
        <div class="task-meta-label">Pull Request</div>
        <div class="task-meta-value"><a href="${escHtml(prHref)}" target="_blank" rel="noopener">PR #${pr.number}</a> <span style="color:var(--text-muted)">${escHtml(pr.state)}</span></div>
      </div>
      <div class="task-meta-item">
        <div class="task-meta-label">CI</div>
        <div class="task-meta-value ${ciClass(pr.ci)}">${ciEmoji(pr.ci)} ${escHtml(pr.ci)}</div>
      </div>
      <div class="task-meta-item">
        <div class="task-meta-label">Review</div>
        <div class="task-meta-value">${escHtml(pr.reviewDecision || '—')}</div>
      </div>
    ` : `
      <div class="task-meta-item">
        <div class="task-meta-label">Pull Request</div>
        <div class="task-meta-value" style="color:var(--text-muted)">not yet opened</div>
      </div>
    `;

    return `
      <div class="task-card">
        <div class="task-card-header">
          <div class="task-id">${escHtml(taskId)}</div>
          <div class="task-pills">
            <span class="pill ${roleClass}">${escHtml(role)}</span>
            <span class="pill ${sessionClass}">${sessionLabel}</span>
          </div>
        </div>
        <div class="task-card-body">
          ${prHtml}
          <div class="task-meta-item">
            <div class="task-meta-label">Active Time</div>
            <div class="task-meta-value highlight">⏱ ${t.lastDispatchedAt ? formatDuration(t.lastDispatchedAt) : '—'}</div>
          </div>
          <div class="task-meta-item">
            <div class="task-meta-label">Branch</div>
            <div class="task-meta-value" title="${escHtml(t.branch)}">${escHtml(t.branch?.replace('worktree-', '') ?? '—')}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function enrichTimelineDurations(entries) {
  // Process entries chronologically (oldest to newest)
  const chronological = [...entries].reverse();
  const taskState = {}; // taskId -> { firstStart: timestamp, lastDispatch: { role, timestamp } }

  for (const e of chronological) {
    if (!e.taskId || !e.timestamp) continue;
    const tTime = new Date(e.timestamp).getTime();
    if (isNaN(tTime)) continue;

    const state = taskState[e.taskId] || { firstStart: null, lastDispatch: null };

    if (e.type === 'dispatch') {
      if (state.lastDispatch) {
        e.stepDurationMs = tTime - state.lastDispatch.timestamp;
        e.prevRole = state.lastDispatch.role;
      }
      if (!state.firstStart) {
        state.firstStart = tTime;
      }
      state.lastDispatch = { role: e.role, timestamp: tTime };
    } else if (e.type === 'merged' || e.type === 'reconciled-merged') {
      if (state.lastDispatch) {
        e.stepDurationMs = tTime - state.lastDispatch.timestamp;
        e.prevRole = state.lastDispatch.role;
      }
      if (state.firstStart) {
        e.totalTaskDurationMs = tTime - state.firstStart;
      }
    }
    taskState[e.taskId] = state;
  }
}

function renderTimeline(entries) {
  if (entries.length === 0) {
    timelineRegion.innerHTML = '<div class="timeline-empty">No decisions logged yet.</div>';
    return;
  }

  enrichTimelineDurations(entries);

  timelineRegion.innerHTML = entries.map((e) => {
    let durationBadge = '';
    if (e.stepDurationMs && e.stepDurationMs > 0) {
      const prevRoleLabel = e.prevRole ? `${e.prevRole} ` : '';
      durationBadge += `<span class="timeline-duration-badge" title="Duration of preceding ${prevRoleLabel}step">⏱ ${formatDuration(e.stepDurationMs)}</span>`;
    }
    if (e.totalTaskDurationMs && e.totalTaskDurationMs > 0) {
      durationBadge += `<span class="timeline-duration-badge total" title="Total elapsed task duration from start to merge">⌛ Total: ${formatDuration(e.totalTaskDurationMs)}</span>`;
    }

    const desc = buildTimelineDesc(e);
    return `
      <div class="timeline-entry">
        <div class="timeline-time">${shortTime(e.timestamp)}</div>
        <div class="timeline-icon">${typeIcon(e.type)}</div>
        <div class="timeline-body">
          <div class="timeline-desc" style="color:${typeColor(e.type)}">
            ${desc}
            ${durationBadge}
          </div>
          ${e.taskId ? `<div class="timeline-task">${escHtml(e.taskId)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function buildTimelineDesc(e) {
  switch (e.type) {
    case 'dispatch':
      return `Dispatch <span class="highlight">${escHtml(e.role)}</span> — ${escHtml(e.reason ?? '')}`;
    case 'skipped-dispatch':
      return `Skip dispatch (${escHtml(e.dispatchSkipReason ?? e.reason ?? '')})`;
    case 'merged':
      return `Merged PR #${e.prNumber}`;
    case 'would-merge':
      return `Ready to merge PR #${e.prNumber} — waiting for autoMerge`;
    case 'reconciled-merged':
      return `Reconciled PR #${e.prNumber} merged out-of-band`;
    case 'wait':
      return `Wait — ${escHtml(e.reason ?? '')}`;
    case 'blocked':
      return `Blocked — ${escHtml(e.reason ?? '')}`;
    case 'idle':
      return e.reason === 'autopilot-checkpoint-reached'
        ? `Idle — checkpoint reached (${escHtml(e.detail ?? '')})`
        : 'Idle — nothing queued';
    case 'error':
      return `Error — ${escHtml(e.message ?? e.reason ?? '')}`;
    default:
      return escHtml(e.type);
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function fetchStatus() {
  if (!currentRepo) return;
  pollDot.classList.add('active');
  try {
    const [statusRes, logRes, autopilotRes] = await Promise.all([
      fetch(`/api/status/${currentRepo}`),
      fetch(`/api/log/${currentRepo}?limit=${logLimit}`),
      fetch(`/api/autopilot/${currentRepo}`),
    ]);

    if (!statusRes.ok) throw new Error(`Status ${statusRes.status}`);
    const status  = await statusRes.json();
    const logData = logRes.ok ? await logRes.json() : { entries: [] };
    if (autopilotRes.ok) {
      autopilotInfo = await autopilotRes.json();
    }

    lastStatus = status;
    disconnectedBanner.classList.remove('visible');
    pollLabel.textContent = `updated ${relativeTime(status.timestamp)}`;

    // Show/hide autopilot badge in header
    if (autopilotInfo.scheduled) {
      autopilotBadge.classList.remove('hidden');
      const mins = Math.round((autopilotInfo.intervalSeconds ?? 900) / 60);
      const nextStr = autopilotInfo.nextRunEta ? relativeTime(autopilotInfo.nextRunEta) : '?';
      autopilotBadge.title = `launchd schedule active — runs every ${mins}m (next ~${nextStr})`;
    } else {
      autopilotBadge.classList.add('hidden');
    }

    renderVerdict(status);
    renderGauges(status);
    renderTasks(status);
    renderTimeline(logData.entries);

  } catch (err) {
    console.error('Poll failed:', err);
    disconnectedBanner.classList.add('visible');
    pollLabel.textContent = 'disconnected';
    if (lastStatus) {
      // Keep showing stale data but dim it
      renderVerdict(lastStatus);
      renderGauges(lastStatus);
      renderTasks(lastStatus);
    }
  } finally {
    setTimeout(() => pollDot.classList.remove('active'), 400);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const pollFn = () => (viewMode === 'portfolio' ? fetchPortfolio() : fetchStatus());
  pollFn();
  pollTimer = setInterval(pollFn, POLL_INTERVAL_MS);
}

// ── Repo selection ────────────────────────────────────────────────────────────

async function loadRepos() {
  try {
    const res   = await fetch('/api/repos');
    const data  = await res.json();
    const repos = data.repos ?? [];

    const saved = localStorage.getItem('factory.selectedRepo');
    const defaultRepo = repos.includes(saved) ? saved : (repos[0] ?? null);

    repoSelect.innerHTML = repos.map((r) =>
      `<option value="${escHtml(r)}" ${r === defaultRepo ? 'selected' : ''}>${escHtml(r)}</option>`
    ).join('');

    if (defaultRepo) {
      currentRepo = defaultRepo;
      startPolling();
    }
  } catch (err) {
    console.error('Failed to load repos:', err);
    disconnectedBanner.classList.add('visible');
    pollLabel.textContent = 'server unreachable';
  }
}

repoSelect.addEventListener('change', () => {
  currentRepo = repoSelect.value;
  localStorage.setItem('factory.selectedRepo', currentRepo);
  logLimit = LOG_PAGE_SIZE;
  // Reset regions to skeleton while loading
  verdictRegion.innerHTML = '<div class="skeleton skeleton-verdict"></div>';
  gaugesRegion.innerHTML  = '<div class="gauges">' + Array(5).fill('<div class="skeleton skeleton-gauge"></div>').join('') + '</div>';
  tasksRegion.innerHTML   = '<div class="skeleton skeleton-task"></div>';
  timelineRegion.innerHTML = '<div class="skeleton skeleton-timeline"></div>';
  startPolling();
});

// ── Load more timeline ────────────────────────────────────────────────────────

btnLoadMore.addEventListener('click', async () => {
  logLimit += LOG_PAGE_SIZE;
  try {
    const res  = await fetch(`/api/log/${currentRepo}?limit=${logLimit}`);
    const data = await res.json();
    renderTimeline(data.entries);
  } catch (err) {
    console.error('Load more failed:', err);
  }
});

// ── Tick button ───────────────────────────────────────────────────────────────

async function runTick() {
  if (tickRunning || !currentRepo) return;
  tickRunning = true;

  // Re-render button in running state
  const btn = document.getElementById('btn-tick');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('running');
    btn.innerHTML = `<span class="btn-tick-spinner"></span> Running tick...`;
  }

  // Open output panel
  tickPanel.classList.add('open');
  tickOutput.innerHTML = '';

  const addLine = (text, cssClass = '') => {
    const line = document.createElement('div');
    line.className = `tick-line ${cssClass}`.trim();
    line.textContent = text;
    tickOutput.appendChild(line);
    tickOutput.scrollTop = tickOutput.scrollHeight;
  };

  try {
    const res = await fetch(`/api/tick/${currentRepo}`, { method: 'POST' });
    if (res.status === 409) {
      addLine('[tick already in progress — try again in a moment]', 'meta');
      tickRunning = false;
      if (lastStatus) renderVerdict(lastStatus);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE lines: "data: <content>\n\n"
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        for (const raw of part.split('\n')) {
          if (!raw.startsWith('data: ')) continue;
          const text = raw.slice(6);
          let cls = '';
          if (text.includes('"type":"dispatch"') || text.includes('"type": "dispatch"')) cls = 'dispatch';
          else if (text.includes('"type":"merged"') || text.includes('"type": "merged"')) cls = 'merged';
          else if (text.includes('"type":"blocked"') || text.includes('"type": "blocked"')) cls = 'blocked';
          else if (text.startsWith('[stderr]')) cls = 'stderr';
          else if (text.startsWith('[done')) cls = 'done';
          else if (text.startsWith('[')) cls = 'meta';
          addLine(text, cls);
        }
      }
    }
  } catch (err) {
    addLine(`[error: ${err.message}]`, 'blocked');
  } finally {
    // Keep tickRunning=true until fetchStatus completes, so the polling timer
    // can't sneak in a renderVerdict() that re-enables the button prematurely.
    lastTickCompletedAt = Date.now();
    await fetchStatus();
    tickRunning = false;
    // One final re-render now that tickRunning is false — fetchStatus already
    // called renderVerdict while tickRunning was true (button stayed disabled).
    // This re-render picks up the fresh status with tickRunning=false but will
    // still respect the post-tick cooldown via lastTickCompletedAt.
    if (lastStatus) renderVerdict(lastStatus);
  }
}

// ── Portfolio View ────────────────────────────────────────────────────────────

async function fetchPortfolio() {
  pollDot.classList.add('active');
  try {
    const res = await fetch('/api/portfolio');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    disconnectedBanner.classList.remove('visible');
    pollLabel.textContent = `updated ${shortTime(new Date().toISOString())}`;
    renderPortfolio(data.portfolio ?? []);
  } catch (err) {
    console.error('Portfolio poll failed:', err);
    disconnectedBanner.classList.add('visible');
    pollLabel.textContent = 'disconnected';
  } finally {
    setTimeout(() => pollDot.classList.remove('active'), 400);
  }
}

function renderPortfolio(cards) {
  if (cards.length === 0) {
    portfolioGrid.innerHTML = '<div class="tasks-empty">No active repositories found.</div>';
    return;
  }

  portfolioGrid.innerHTML = cards.map((c) => {
    const epicTitle = c.activeEpic ? escHtml(c.activeEpic.title) : 'No active epic';
    const nowTask = c.now ? `
      <div>
        <div class="portfolio-section-label">▶ now</div>
        <div class="portfolio-now-box">
          <span class="portfolio-now-task">${escHtml(c.now.id)}</span>
          <span class="pill pill-role-${escHtml(c.now.role)}">${escHtml(c.now.role)}</span>
        </div>
      </div>
    ` : '<div class="portfolio-now-box" style="color:var(--text-muted)">No active task</div>';

    const nextTasks = c.next.length > 0 ? `
      <div>
        <div class="portfolio-section-label">next (highest priority top)</div>
        <div class="portfolio-next-list">
          ${c.next.map(t => `<div class="portfolio-next-item">${escHtml(t.id)}</div>`).join('')}
        </div>
      </div>
    ` : '';

    return `
      <div class="portfolio-card">
        <div class="portfolio-card-header">
          <div class="portfolio-repo-name">${escHtml(c.repo)}</div>
          <div class="portfolio-epic-badge">${epicTitle}</div>
        </div>
        <div class="portfolio-progress-bar">
          <div class="portfolio-progress-track">
            <div class="portfolio-progress-fill" style="width:100%"></div>
          </div>
          <span>${c.progress.remaining} remaining</span>
        </div>
        ${nowTask}
        ${nextTasks}
      </div>
    `;
  }).join('');
}

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('factory.viewMode', mode);
  if (mode === 'portfolio') {
    viewSingle.classList.remove('active');
    viewPortfolio.classList.add('active');
    singleRepoView.classList.add('hidden');
    portfolioView.classList.remove('hidden');
    repoSelect.classList.add('hidden');
    fetchPortfolio();
  } else {
    viewPortfolio.classList.remove('active');
    viewSingle.classList.add('active');
    portfolioView.classList.add('hidden');
    singleRepoView.classList.remove('hidden');
    repoSelect.classList.remove('hidden');
    fetchStatus();
  }
}

viewSingle.addEventListener('click', () => setViewMode('single'));
viewPortfolio.addEventListener('click', () => setViewMode('portfolio'));

// ── Boot ──────────────────────────────────────────────────────────────────────

loadRepos();
if (viewMode === 'portfolio') {
  setViewMode('portfolio');
}

