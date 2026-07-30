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
const viewProcesses       = $('view-processes');
const singleRepoView      = $('single-repo-view');
const portfolioView       = $('portfolio-view');
const portfolioGrid       = $('portfolio-grid');
const processesView       = $('processes-view');
const processesRegion     = $('processes-region');
const processesCount      = $('processes-count');
const pollDot             = $('poll-dot');
const pollLabel           = $('poll-label');
const autopilotBadge      = $('autopilot-badge');
const disconnectedBanner  = $('disconnected-banner');
const sprintRegion        = $('sprint-region');
const verdictRegion       = $('verdict-region');
const tickPanel           = $('tick-panel');
const tickOutput          = $('tick-output');
const gaugesRegion        = $('gauges-region');
const tasksCount          = $('tasks-count');
const tasksRegion         = $('tasks-region');
const timelineRegion      = $('timeline-region');
const btnLoadMore         = $('btn-load-more');
const btnReportIssue      = $('btn-report-issue');
const bugModalBackdrop    = $('bug-modal-backdrop');
const bugModal            = $('bug-modal');
const bugDescription      = $('bug-description');
const btnBugCancel        = $('btn-bug-cancel');
const btnBugSubmit        = $('btn-bug-submit');
const bugError            = $('bug-error');
const bugSuccess          = $('bug-success');

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
    'manual-kill':    '🛑',
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
    'manual-kill':    'var(--type-blocked)',
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

// Answers "which task, out of how many in the sprint" — previously answerable only by opening
// the sprint's WORK_PLAN.md and counting checkboxes by hand while the tracked-task panel below
// names a task with no sense of how far through the sprint it sits.
function renderSprint(status) {
  const sprint = status.activeSprint;
  if (!sprint) {
    sprintRegion.innerHTML = '';
    return;
  }
  const p = sprint.progress;
  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  sprintRegion.innerHTML = `
    <div class="sprint-banner">
      <div class="sprint-title">${escHtml(sprint.title)}</div>
      ${p ? `
        <div class="sprint-progress-track" title="${p.done} of ${p.total} sprint tasks done">
          <div class="sprint-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="sprint-progress-label">${p.done} / ${p.total} tasks</div>
      ` : ''}
    </div>
  `;
}

function renderVerdict(status) {
  const nt      = status.nextTick;
  const marker  = nt.marker; // 'act' | 'wait' | 'blocked'
  // 'awaiting-operator' is a distinct flavor of 'blocked': the factory isn't broken and isn't
  // waiting on GitHub/CI, it's working exactly as designed and needs a human to take one specific
  // step (running a command against production, a decision only the operator can make). Same
  // banner styling/button-disable as any other 'blocked' — that mechanism already existed — but a
  // generic "⚠ Blocked — needs attention" reads as "something's wrong", which understates how
  // routine and expected this state actually is.
  const isAwaitingOperator = marker === 'blocked' && nt.reason === 'awaiting-operator';
  const icon    = isAwaitingOperator ? '🧑' : marker === 'act' ? '▶' : marker === 'blocked' ? '⚠' : '⏸';
  const label   = isAwaitingOperator ? 'Your turn' : marker === 'act' ? 'Act — run next tick now' : marker === 'blocked' ? 'Blocked — needs attention' : 'Wait — nothing to do yet';

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
  // If the orchestrator says it's actionable, we MUST allow the tick, even if a session is running
  // (e.g., WIP limit > 1 allows starting a new task, or a reviewer needs dispatching).
  const btnDisabled = !isActable || tickRunning || autopilotInfo.scheduled || inCooldown;

  let btnText = 'Run next tick';
  if (tickRunning)                                    btnText = 'Running tick...';
  else if (inCooldown)                                btnText = 'Agent starting up...';
  else if (hasSessionRunning && marker !== 'act')     btnText = `${runningTask.lastRole ?? 'Agent'} running in background...`;

  let btnTitle = 'Run node orchestrator.mjs ' + (currentRepo ?? '');
  if (tickRunning)                                    btnTitle = 'A tick is already running';
  else if (autopilotInfo.scheduled)                   btnTitle = `Autopilot is active (launchd runs every ${Math.round((autopilotInfo.intervalSeconds ?? 900) / 60)}m)`;
  else if (inCooldown)                                btnTitle = 'Waiting for agent process to initialize...';
  else if (hasSessionRunning && marker !== 'act')     btnTitle = `An agent session (${runningTask.lastRole ?? 'agent'}) is currently running in background`;
  else if (marker === 'wait')  btnTitle = `Wait: ${nt.description}`;
  else if (marker === 'blocked') btnTitle = `Blocked: ${nt.description}`;

  verdictRegion.innerHTML = `
    <div class="verdict-banner ${escHtml(marker)}${isAwaitingOperator ? ' awaiting-operator' : ''}">
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
    // A stuck session is invisible to sessionRunning (its transcript is silent either way — a
    // paused agent and a wedged one look identical there); `stuck` comes from a live
    // `claude agents --json` check for a session waiting on an interactive prompt it has no TTY
    // to answer (confirmed cause: hitting Claude's own usage limit). See orchestrator.mjs's
    // findStuckSession for the full story.
    const stuckPillHtml = t.stuck
      ? `<span class="pill pill-stuck" title="Stuck: waiting for &quot;${escHtml(t.stuck.waitingFor)}&quot; — this session cannot proceed on its own">🛑 stuck</span>`
      : '';
    const killButtonHtml = t.stuck
      ? `<button class="btn-kill" data-kill-task="${escHtml(taskId)}" title="Terminate the stuck process and audit-log the action">🛑 Kill stuck process</button>`
      : '';
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
            ${stuckPillHtml}
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
        ${killButtonHtml ? `<div class="task-card-footer">${killButtonHtml}</div>` : ''}
      </div>
    `;
  }).join('');

  tasksRegion.querySelectorAll('[data-kill-task]').forEach((btn) => {
    btn.addEventListener('click', () => killStuckSession(btn.getAttribute('data-kill-task'), btn));
  });
}

// ── Kill stuck session ───────────────────────────────────────────────────────

async function killStuckSession(taskId, btn) {
  if (!currentRepo) return;
  const confirmed = confirm(
    `Kill the stuck process for "${taskId}"?\n\n` +
    `This session is waiting on an interactive prompt it can't answer (usually Claude's own ` +
    `usage limit) and cannot make progress on its own. Terminating it is logged to the audit ` +
    `timeline. A later tick will retry the task fresh.`
  );
  if (!confirmed) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Killing...';
  }

  try {
    const res = await fetch(`/api/kill/${currentRepo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) {
      throw new Error(result.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    alert(`Failed to kill session: ${err.message}`);
  } finally {
    // Refresh immediately rather than waiting for the next poll — the task card should stop
    // showing "stuck" (or, on failure, at least reflect current reality) right away.
    await fetchStatus();
  }
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
    case 'manual-kill': {
      const outcome = e.killed?.length ? `killed pid${e.killed.length > 1 ? 's' : ''} ${e.killed.join(', ')}` : 'nothing to kill (already gone)';
      const via = e.source === 'ui' ? ' via dashboard' : '';
      return `Killed stuck session${via} — ${escHtml(outcome)}`;
    }
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

    renderSprint(status);
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
  const pollFn = () =>
    viewMode === 'portfolio' ? fetchPortfolio() :
    viewMode === 'processes' ? fetchAgents() :
    fetchStatus();
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
    const sprintTitle = c.activeSprint ? escHtml(c.activeSprint.title) : 'No active sprint';
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

    // c.progress is null when there's no active sprint, or its WORK_PLAN.md couldn't be read —
    // both are "nothing to show a fraction for", not "0/0 done".
    const progressBar = c.progress ? `
      <div class="portfolio-progress-bar">
        <div class="portfolio-progress-track">
          <div class="portfolio-progress-fill" style="width:${c.progress.total > 0 ? Math.round((c.progress.done / c.progress.total) * 100) : 0}%"></div>
        </div>
        <span>${c.progress.done}/${c.progress.total} done</span>
      </div>
    ` : '';

    return `
      <div class="portfolio-card">
        <div class="portfolio-card-header">
          <div class="portfolio-repo-name">${escHtml(c.repo)}</div>
          <div class="portfolio-sprint-badge">${sprintTitle}</div>
        </div>
        ${progressBar}
        ${nowTask}
        ${nextTasks}
      </div>
    `;
  }).join('');
}

// ── Processes View ────────────────────────────────────────────────────────────
// Live from `claude agents --json`, filtered server-side (orchestrator.mjs's listAgentProcesses)
// to this repo's own factory-dispatched sessions — the underlying command is global to every
// Claude Code session on the machine, so that filtering is what keeps this view meaningful rather
// than a list of unrelated work a click could accidentally kill.

async function fetchAgents() {
  if (!currentRepo) return;
  pollDot.classList.add('active');
  try {
    const res = await fetch(`/api/agents/${currentRepo}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    disconnectedBanner.classList.remove('visible');
    pollLabel.textContent = `updated ${shortTime(new Date().toISOString())}`;
    renderProcesses(data.agents ?? []);
  } catch (err) {
    console.error('Agents poll failed:', err);
    disconnectedBanner.classList.add('visible');
    pollLabel.textContent = 'disconnected';
  } finally {
    setTimeout(() => pollDot.classList.remove('active'), 400);
  }
}

function renderProcesses(agents) {
  processesCount.textContent = agents.length;

  if (agents.length === 0) {
    processesRegion.innerHTML = '<div class="tasks-empty">No factory processes currently running for this repo.</div>';
    return;
  }

  processesRegion.innerHTML = `
    <table class="processes-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Started</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${agents.map((a) => {
          const stuckClass = a.stuck ? ' stuck' : '';
          const statusHtml = a.stuck
            ? `<span class="pill pill-stuck" title="Stuck: waiting for &quot;${escHtml(a.stuck.waitingFor)}&quot; — this session cannot proceed on its own">🛑 stuck (${escHtml(a.stuck.waitingFor)})</span>`
            : `<span class="pill pill-session-running">${escHtml(a.status ?? '—')}</span>`;
          const killHtml = a.stuck
            ? `<button class="btn-kill" data-kill-agent-session="${escHtml(a.sessionId)}" title="Terminate the stuck process and audit-log the action">🛑 Kill</button>`
            : '';
          return `
            <tr class="processes-row${stuckClass}">
              <td class="processes-name" title="${escHtml(a.sessionId)}${a.pid ? ' · pid ' + a.pid : ''}">${escHtml(a.name)}</td>
              <td class="processes-time" title="${escHtml(a.startedAt ?? '')}">${relativeTime(a.startedAt)}</td>
              <td>${statusHtml}</td>
              <td class="processes-actions">${killHtml}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  processesRegion.querySelectorAll('[data-kill-agent-session]').forEach((btn) => {
    btn.addEventListener('click', () => killAgentSession(btn.getAttribute('data-kill-agent-session'), btn));
  });
}

async function killAgentSession(sessionId, btn) {
  if (!currentRepo) return;
  const confirmed = confirm(
    `Kill this stuck process?\n\n` +
    `Session ${sessionId} is waiting on an interactive prompt it can't answer (usually Claude's ` +
    `own usage limit) and cannot make progress on its own. Terminating it is logged to the audit ` +
    `timeline in Repo View.`
  );
  if (!confirmed) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Killing...';
  }

  try {
    const res = await fetch(`/api/kill/${currentRepo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) {
      throw new Error(result.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    alert(`Failed to kill session: ${err.message}`);
  } finally {
    await fetchAgents();
  }
}

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('factory.viewMode', mode);

  viewSingle.classList.toggle('active', mode === 'single');
  viewPortfolio.classList.toggle('active', mode === 'portfolio');
  viewProcesses.classList.toggle('active', mode === 'processes');

  singleRepoView.classList.toggle('hidden', mode !== 'single');
  portfolioView.classList.toggle('hidden', mode !== 'portfolio');
  processesView.classList.toggle('hidden', mode !== 'processes');

  // The repo selector is meaningless in portfolio view (it spans every configured repo at once)
  // but still applies to processes view (it's scoped to one repo, same as single view).
  repoSelect.classList.toggle('hidden', mode === 'portfolio');

  if (mode === 'portfolio')       fetchPortfolio();
  else if (mode === 'processes')  fetchAgents();
  else                             fetchStatus();
}

viewSingle.addEventListener('click', () => setViewMode('single'));
viewPortfolio.addEventListener('click', () => setViewMode('portfolio'));
viewProcesses.addEventListener('click', () => setViewMode('processes'));

// ── Bug Report Modal ────────────────────────────────────────────────────────────

function showBugModal() {
  bugModal.classList.remove('hidden');
  bugModalBackdrop.classList.remove('hidden');
  bugDescription.value = '';
  bugError.classList.add('hidden');
  bugSuccess.classList.add('hidden');
  btnBugSubmit.disabled = false;
  btnBugSubmit.textContent = 'Submit Report';
  bugDescription.focus();
}

function hideBugModal() {
  bugModal.classList.add('hidden');
  bugModalBackdrop.classList.add('hidden');
}

btnReportIssue.addEventListener('click', showBugModal);
btnBugCancel.addEventListener('click', hideBugModal);
bugModalBackdrop.addEventListener('click', hideBugModal);

btnBugSubmit.addEventListener('click', async () => {
  if (!currentRepo) {
    bugError.textContent = 'No repository selected.';
    bugError.classList.remove('hidden');
    return;
  }
  
  const desc = bugDescription.value.trim();
  if (!desc) {
    bugError.textContent = 'Please provide a description.';
    bugError.classList.remove('hidden');
    return;
  }

  bugError.classList.add('hidden');
  btnBugSubmit.disabled = true;
  btnBugSubmit.textContent = 'Collecting data...';

  try {
    const res = await fetch(`/api/bugreport/${currentRepo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: desc,
        uiState: lastStatus
      })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');

    bugSuccess.textContent = `Report saved: ${data.filename}`;
    bugSuccess.classList.remove('hidden');
    bugDescription.value = '';
    btnBugSubmit.textContent = 'Submitted';
    
    setTimeout(() => {
      hideBugModal();
    }, 2000);
  } catch (err) {
    bugError.textContent = err.message;
    bugError.classList.remove('hidden');
    btnBugSubmit.disabled = false;
    btnBugSubmit.textContent = 'Submit Report';
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

loadRepos();
if (viewMode === 'portfolio') {
  setViewMode('portfolio');
}

