#!/usr/bin/env node
// One tick of the factory: deterministic router, no LLM call of its own.
// Usage: node orchestrator.mjs <repoConfigName>
// Reads configs/<repoConfigName>.json for paths/thresholds, tracks per-repo
// runtime state in state/<repoConfigName>.json and an audit trail in
// logs/<repoConfigName>.jsonl. See the target repo's .agents/AGENTS.md §6
// (Autonomous Factory Mode) for the rules dispatched sessions operate under.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { budgetStatus, recordDispatch, notify } from './budget-guard.mjs';

const FACTORY_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoConfigName = process.argv[2];
if (!repoConfigName || repoConfigName.startsWith('-')) {
  console.error('Usage: node orchestrator.mjs <repoConfigName> [--status] [--watch[=seconds]]');
  process.exit(1);
}
const CLI_FLAGS = process.argv.slice(3);
const WATCH_FLAG = CLI_FLAGS.find((f) => f.startsWith('--watch'));
const WATCH_SECONDS = WATCH_FLAG ? Number(WATCH_FLAG.split('=')[1]) || 30 : null;
// --status (and --watch, which is just a repeating --status) is a read-only monitor: it observes
// the same reality a real tick would and reports what a tick WOULD do, without doing it or
// touching state. This is the answer to "how do I know when to run it?" without staring at GitHub.
const STATUS_ONLY = CLI_FLAGS.includes('--status') || WATCH_FLAG != null;
// --json (only meaningful alongside --status) emits structured JSON instead of human text.
// Used by the local UI server; ignored during --watch (interactive terminal only).
const JSON_FLAG = CLI_FLAGS.includes('--json');

const CONFIG_PATH = path.join(FACTORY_DIR, 'configs', `${repoConfigName}.json`);
const STATE_PATH = path.join(FACTORY_DIR, 'state', `${repoConfigName}.json`);
const DECISIONS_PATH = path.join(FACTORY_DIR, 'logs', `${repoConfigName}.jsonl`);

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { tasks: {}, dispatchTimestamps: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function logDecision(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), repo: repoConfigName, ...entry });
  fs.mkdirSync(path.dirname(DECISIONS_PATH), { recursive: true });
  fs.appendFileSync(DECISIONS_PATH, line + '\n', 'utf-8');
  console.log(line);
}

function runDab(config, args) {
  return execFileSync(config.paths.node, [config.paths.dabEntry, ...args], {
    cwd: config.repoDir,
    encoding: 'utf-8',
    timeout: 30_000
  }).trim();
}

function runGh(config, args) {
  return execFileSync(config.paths.gh, args, {
    cwd: config.repoDir,
    encoding: 'utf-8',
    timeout: 30_000
  }).trim();
}

function ghAuthOk(config) {
  try {
    runGh(config, ['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

// The orchestrator reads `dab` from the target repo's local `main` checkout, but merges land on
// `origin` (via `gh pr merge`, a remote call that never touches the local working tree). Git does
// not auto-pull, so the local checkout falls behind origin after every merge and `dab` reports a
// pre-merge board until it's synced. Fast-forward it to origin before observing, so every decision
// is made against current reality. This is only safe because the orchestrator *never writes* to
// this checkout — task completion flows through the developer's PR, not a post-merge mutation here
// (see ADR 008) — so the checkout can only ever be behind origin, never divergent, and a clean
// `--ff-only` always succeeds.
function syncTargetRepo(config) {
  try {
    // Fetch, then fast-forward to exactly the current branch's upstream (origin/main) — NOT
    // `git pull --ff-only`, which merges whatever FETCH_HEAD lists as "for-merge". Under concurrent
    // git activity during an autopilot run that FETCH_HEAD was seen with multiple for-merge heads
    // (and origin/main momentarily missing), making `pull --ff-only` fail with "Cannot fast-forward
    // to multiple branches". Merging `@{u}` explicitly targets one ref, so it's immune to that:
    // the fetch rebuilds origin/main if it was corrupted, and the merge can only ever ff to it.
    execFileSync('git', ['-C', config.repoDir, 'fetch', '--quiet', 'origin'], { encoding: 'utf-8', timeout: 60_000 });
    execFileSync('git', ['-C', config.repoDir, 'merge', '--ff-only', '--quiet', '@{u}'], { encoding: 'utf-8', timeout: 60_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.stderr || err?.message || err).trim().split('\n').slice(-3).join(' ') };
  }
}

function repoHead(config) {
  try {
    return execFileSync('git', ['-C', config.repoDir, 'log', '-1', '--format=%h %s'], { encoding: 'utf-8', timeout: 15_000 }).trim();
  } catch {
    return '(unknown)';
  }
}

function claudeAgentsJson(config) {
  try {
    return JSON.parse(execFileSync(config.paths.claude, ['agents', '--json', '--all'], { encoding: 'utf-8', timeout: 15_000 }));
  } catch {
    return [];
  }
}

// Every background session appends to a live transcript at
// ~/.claude/projects/<cwd, non-alphanumerics turned into "-">/<sessionId>.jsonl as it works —
// a far more reliable liveness signal than the pid `claude agents --json` reports. A pid-only
// check ("does this process exist") is wrong because macOS recycles pids and one was observed
// reused by an unrelated `claude --bg-spare` warm-pool process within minutes of the original
// session dying. The fix for *that* (confirming the live process's command line still mentions
// the session id) is wrong in the other direction: a `--bg-spare` process, once claimed and put
// to work on a real session, keeps its original "--bg-spare ...claim.sock" argv forever — so
// that check reports a session as "not running" while `claude logs <id>` shows it actively
// streaming tool calls. Transcript mtime has neither failure mode: it's silent exactly when the
// session is silent.
function sessionTranscriptPath(cwd, sessionId) {
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
}

function sessionRecentlyActive(cwd, sessionId, withinMinutes) {
  try {
    const { mtimeMs } = fs.statSync(sessionTranscriptPath(cwd, sessionId));
    return Date.now() - mtimeMs < withinMinutes * 60 * 1000;
  } catch {
    return false;
  }
}

function hasRunningSession(config, sessionName) {
  return claudeAgentsJson(config).some(
    (s) =>
      s.name === sessionName &&
      s.kind === 'background' &&
      s.cwd &&
      s.sessionId &&
      sessionRecentlyActive(s.cwd, s.sessionId, config.staleSessionMinutes ?? 30)
  );
}

function findPrForBranch(config, branch) {
  // `--state all`, not just `open`: a PR can close via GitHub's web UI, `gh pr merge`/`close` run
  // directly (bypassing this orchestrator entirely), or auto-merge — any channel. GitHub keeps
  // the PR record (and its head branch name) forever regardless of which of those happened or
  // whether the branch itself still exists, so this is the durable source of truth for "did this
  // land," not a commit-SHA check: every merge here is a squash merge, which fabricates a new
  // commit on main rather than replaying the branch's own commits, so a branch-tip-in-main-history
  // check would misreport every legitimately-merged PR as unmerged.
  const raw = runGh(config, [
    'pr', 'list', '--repo', config.repo, '--head', branch, '--state', 'all',
    '--json', 'number,state,reviewDecision,statusCheckRollup,mergeable,mergedAt,headRefOid'
  ]);
  const prs = JSON.parse(raw || '[]');
  // A branch name can be reused across retries, so more than one PR may share it — the most
  // recent (highest PR number) is the one that matters.
  return [...prs].sort((a, b) => b.number - a.number)[0] ?? null;
}

const CI_BAD_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

function isCiGreen(pr) {
  const rollup = pr.statusCheckRollup ?? [];
  if (rollup.length === 0) return false;
  // SKIPPED is common and benign here (deploy jobs that only run on pushes to main, not PRs) —
  // only a genuinely bad conclusion should count as red, not "not literally SUCCESS".
  return rollup.every((c) => !CI_BAD_CONCLUSIONS.has((c.conclusion ?? c.state ?? '').toUpperCase()));
}

function latestRejectionTag(config, prNumber) {
  const raw = runGh(config, ['pr', 'view', String(prNumber), '--repo', config.repo, '--json', 'reviews']);
  const reviews = JSON.parse(raw).reviews ?? [];
  const lastRejection = [...reviews].reverse().find((r) => r.state === 'CHANGES_REQUESTED');
  if (!lastRejection) return 'quality';
  return lastRejection.body?.includes('[architectural]') ? 'architectural' : 'quality';
}

// GitHub blocks an account from approving its own PR — every role otherwise shares Lucian's
// own gh identity, so the reviewer needs a distinct account's token to ever submit a real
// review. Only the reviewer dispatch gets this; architect/developer are untouched.
function reviewerGhEnv(config, role) {
  if (role !== 'reviewer' || !config.reviewerGhTokenPath) {
    return {};
  }
  try {
    const token = fs.readFileSync(config.reviewerGhTokenPath, 'utf-8').trim();
    return token ? { GH_TOKEN: token } : {};
  } catch {
    return {};
  }
}

function dispatch(config, state, { role, sessionName, prompt, worktree, fromPr }) {
  if (hasRunningSession(config, sessionName)) {
    return { dispatched: false, reason: 'session-already-running' };
  }

  // --bg is incompatible with --print/--output-format (the CLI rejects that combo outright) —
  // the prompt goes in as a plain positional, and the session's id is recovered afterward via
  // `claude agents --json`, matched by the --name we gave it.
  // permission-mode must be bypassPermissions, not acceptEdits, for real unattended operation:
  // acceptEdits still prompts for Bash commands (git/dab/gh/pnpm), which a --bg session can
  // never answer, leaving it permanently "blocked".
  const args = ['--agent', role, '--permission-mode', 'bypassPermissions', '--bg', '-n', sessionName];
  // Since prompts are off, the only tool-level guardrail is this denylist plus the target repo's
  // AGENTS.md §6 instructions. `--disallowedTools` blocks the operations no role should ever run
  // (merging, force-pushing, branch deletion, hard reset) as an enforced backstop to the personas'
  // "never merge / never force-push / never touch main" rules. Config-driven so it's tunable and
  // visible. NB: explicit denies are intended to take precedence over the permission mode; if a
  // session is ever observed running a denied command under bypassPermissions, promote this to a
  // PreToolUse hook (unconditionally enforced) — see docs/architecture/EXECUTION_AND_PERMISSIONS.md.
  if (config.disallowedTools?.length) {
    args.push('--disallowedTools', config.disallowedTools.join(','));
  }
  if (fromPr) {
    args.push('--from-pr', String(fromPr));
  } else if (worktree) {
    args.push('--worktree', worktree);
  }
  args.push(prompt);

  if (config.dryRun) {
    return { dispatched: false, reason: 'dry-run', wouldRunArgs: args };
  }

  recordDispatch(state);
  execFileSync(config.paths.claude, args, {
    cwd: config.repoDir,
    encoding: 'utf-8',
    timeout: 60_000,
    env: { ...process.env, FACTORY_DISPATCH: '1', ...reviewerGhEnv(config, role) }
  });
  // `claude agents --json --all` never prunes finished sessions, so a taskId/role combo that's
  // been dispatched before (retry, address-feedback, mediate-rejection, ...) reuses the same
  // deterministic sessionName and now has multiple entries in the list sharing it. Taking the
  // first match is wrong — it can silently resolve to a long-finished session instead of the one
  // just spawned (observed directly: a stale morning session's id got logged instead of the new
  // one). The one we just started is the most recent by startedAt.
  const spawned = claudeAgentsJson(config)
    .filter((s) => s.name === sessionName)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  return { dispatched: true, sessionId: spawned?.sessionId, pid: spawned?.pid };
}

function findClosableEpic(statusPayload) {
  const activeEpicIds = statusPayload.activeEpics.map((e) => e.id).sort();
  for (const epicId of activeEpicIds) {
    const hasOpenTask = statusPayload.activeTasks.some((t) => t.epic === epicId);
    if (!hasOpenTask) {
      return statusPayload.activeEpics.find((e) => e.id === epicId);
    }
  }
  return null;
}

/**
 * Handles a task that already has a branch tracked in state (regardless of which role
 * started it — developer's implementation branches and architect's dab/** branches both
 * flow through here), so an architect-authored PR is never orphaned from the state machine.
 */
function inFlightAction(config, taskId, task, titleHint) {
  const pr = findPrForBranch(config, task.branch);

  if (pr?.state === 'MERGED') {
    return { action: 'reconcile-merged', taskId, prNumber: pr.number };
  }
  if (pr?.state === 'CLOSED') {
    // Closed without merging — nothing shipped, so this isn't "done" like MERGED, but it also
    // isn't safe to silently retry (might duplicate already-abandoned work) or leave circling
    // through no-PR retry logic (findPrForBranch would keep finding this same closed PR forever,
    // never falling into the !pr branch). Surface it; a human decides reopen vs. redo vs. drop.
    return { action: 'blocked', reason: 'pr-closed-without-merge', taskId, prNumber: pr.number };
  }

  if (!pr) {
    const sessionName = `factory-${task.lastRole ?? 'developer'}-${taskId}`;
    const stale = task.lastDispatchedAt && Date.now() - task.lastDispatchedAt > (config.staleSessionMinutes ?? 30) * 60 * 1000;
    if (hasRunningSession(config, sessionName)) {
      return { action: 'wait', reason: 'session-running', taskId };
    }
    if (stale) {
      return {
        action: 'dispatch',
        role: task.lastRole ?? 'developer',
        taskId,
        sessionName,
        worktree: task.worktreeName,
        reason: 'retry-no-pr',
        prompt: `Resume the task "${titleHint ?? taskId}" on branch ${task.branch} — no PR was found after the previous dispatch and the session is no longer running. Finish the work and open a PR.`,
        onDispatched: () => { task.lastDispatchedAt = Date.now(); }
      };
    }
    return { action: 'wait', reason: 'no-pr-yet-not-stale', taskId };
  }

  task.prNumber = pr.number;

  // The review loop keys off the reviewed commit SHA (`headRefOid`). This is what lets the
  // orchestrator tell "a fix was pushed, re-review it" apart from "rejected again," and count
  // rejections per review-round rather than per tick. `task.reviewedSha` = the commit the reviewer
  // last looked at; `task.lastRejectionSha` = the commit we last counted a rejection for.
  const head = pr.headRefOid;
  const shortHead = head ? head.slice(0, 7) : 'nohead';

  if (pr.reviewDecision === 'APPROVED' && isCiGreen(pr)) {
    return { action: 'merge', taskId, prNumber: pr.number };
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    // Head advanced past what the reviewer saw → a fix was pushed since the rejection. Get a fresh
    // review; don't count a new rejection. (Without this the PR would sit at CHANGES_REQUESTED
    // forever — GitHub doesn't clear it on push without branch protection — and never re-review.)
    if (head !== task.reviewedSha) {
      return {
        action: 'dispatch',
        role: 'reviewer',
        taskId,
        sessionName: `factory-reviewer-${taskId}-${shortHead}`,
        reason: 're-review',
        prompt: `PR #${pr.number} for task "${titleHint ?? taskId}" was updated after a changes-requested review. Re-review the current state per your role instructions via \`gh pr diff ${pr.number}\` / \`gh pr view ${pr.number}\`.`,
        onDispatched: () => { task.reviewedSha = head; }
      };
    }
    // The rejected commit is still the head — it needs a fix. Count this as a rejection round only
    // if we haven't already counted (and dispatched a fixer for) this exact SHA, so repeated ticks
    // while the fixer works don't inflate the count and prematurely escalate. Escalate to the
    // architect after 2 genuine rounds or on an [architectural] tag; otherwise the developer.
    const alreadyCounted = task.lastRejectionSha === head;
    const rounds = (task.rejectionCount ?? 0) + (alreadyCounted ? 0 : 1);
    const tag = latestRejectionTag(config, pr.number);
    const toArchitect = rounds >= 2 || tag === 'architectural';
    return {
      action: 'dispatch',
      role: toArchitect ? 'architect' : 'developer',
      taskId,
      // SHA-suffixed so a just-finished session of the previous round (whose transcript is still
      // <staleMinutes old) can't false-positive hasRunningSession and skip this dispatch.
      sessionName: `factory-${toArchitect ? 'architect-mediate' : 'developer'}-${taskId}-${shortHead}`,
      fromPr: pr.number,
      reason: toArchitect ? 'mediate-rejection' : 'address-feedback',
      prompt: toArchitect
        ? `PR #${pr.number} for task "${titleHint ?? taskId}" has been rejected ${rounds} time(s) by the reviewer, tagged "${tag}". Read the PR discussion and mediate per your role instructions: fix the spec, split the task, or clarify the approach.`
        : `Address the reviewer's feedback on PR #${pr.number} for task "${titleHint ?? taskId}". Push your changes to the same branch.`,
      onDispatched: () => { task.rejectionCount = rounds; task.lastRejectionSha = head; }
    };
  }

  if (!pr.reviewDecision && isCiGreen(pr)) {
    return {
      action: 'dispatch',
      role: 'reviewer',
      taskId,
      sessionName: `factory-reviewer-${taskId}-${shortHead}`,
      // No --from-pr here: it resumes a session already associated with the PR, but the
      // reviewer's first look at any given PR has no such session to resume — it was observed
      // falling back to an interactive picker (per --help: "...or open interactive picker"),
      // which hangs forever with no TTY attached in --bg mode. A plain dispatch in the main
      // checkout reviewing via `gh pr diff`/`gh pr view` (per reviewer.md) avoids that entirely.
      reason: 'ready-for-review',
      prompt: `Review PR #${pr.number} for task "${titleHint ?? taskId}" per your role instructions. Use \`gh pr diff ${pr.number}\` and \`gh pr view ${pr.number}\` to inspect it remotely — no local checkout needed.`,
      onDispatched: () => { task.reviewedSha = head; }
    };
  }

  return { action: 'wait', reason: 'ci-pending-or-no-review-yet', taskId };
}

function decide(config, state) {
  const check = JSON.parse(runDab(config, ['check', '--json']));
  if (check.length > 0) {
    return { action: 'blocked', reason: 'dab-check-issues', detail: check };
  }

  // Finish in-flight tracked work (any role) before starting anything new.
  for (const taskId of Object.keys(state.tasks).sort()) {
    const task = state.tasks[taskId];
    if (!task.branch) continue;
    const result = inFlightAction(config, taskId, task, taskId);
    if (result.action !== 'wait') {
      return result;
    }
  }

  const statusPayload = JSON.parse(runDab(config, ['status']));
  // `dab next` only fills in `id` when the epic todo's numbered filename (e.g. 01_foo.md)
  // matches its frontmatter id (foo) exactly — it usually doesn't in this repo's convention.
  // `dab status`'s activeTasks reliably maps spec path -> real frontmatter id, so fall back to it.
  const specToId = new Map(statusPayload.activeTasks.map((t) => [t.spec, t.id]));

  // Autopilot checkpoint: if `stopAfterTask` is configured and that task is no longer active on the
  // board (i.e. it's been completed/merged), the requested subset is done — pause instead of
  // starting anything new. The in-flight loop above still finishes whatever's running, and the
  // checkpoint task itself completes normally (it stays "active" until merged, so we only stop once
  // it's done). Set to null/absent to run the whole board. NB: a `stopAfterTask` that doesn't match
  // a real task id is never "active", so it would pause immediately — validate the id when setting it.
  if (config.stopAfterTask && !statusPayload.activeTasks.some((t) => t.id === config.stopAfterTask)) {
    return { action: 'idle', reason: 'autopilot-checkpoint-reached', detail: `completed through "${config.stopAfterTask}"` };
  }

  // WIP cap: only START new work while under the concurrent-in-flight limit. "In flight" = tracked
  // in state.json with a branch (its worktree/PR lifecycle is underway). Default 1 = single-track,
  // i.e. today's behaviour. The in-flight loop above always runs first, so already-started work
  // keeps advancing regardless of this cap — the cap only gates *starting* something new. Raising it
  // is the WIP half of parallelism; the fan-out to *different* ready tasks also needs dab to exclude
  // in-flight tasks / return a ready-list, which it can't yet — see docs/rfcs/RFC_001.
  const inFlightIds = Object.keys(state.tasks).filter((id) => state.tasks[id].branch);
  const wipLimit = config.maxConcurrentTasks ?? 1;
  if (inFlightIds.length >= wipLimit) {
    return { action: 'wait', reason: 'wip-limit-reached', detail: `${inFlightIds.length}/${wipLimit} in flight` };
  }

  const closableEpic = findClosableEpic(statusPayload);
  // Skip if this epic's close is already in flight (its close PR is tracked) — the in-flight loop is
  // already driving it; re-dispatching would duplicate it. Fall through to any other ready work.
  if (closableEpic && !state.tasks[`epic-close-${closableEpic.id}`]?.branch) {
    const taskId = `epic-close-${closableEpic.id}`;
    const task = state.tasks[taskId] ?? { branch: null, rejectionCount: 0 };
    state.tasks[taskId] = task;
    return {
      action: 'dispatch',
      role: 'architect',
      taskId,
      sessionName: `factory-architect-${taskId}`,
      worktree: taskId,
      reason: 'epic-closing',
      prompt: `The epic "${closableEpic.id}" (${closableEpic.title}) has no remaining open tasks. Review it end-to-end per your role instructions and, if it genuinely delivered what its overview.md proposed, run \`dab epic close ${closableEpic.id}\` and open a PR for the archive move. Spec: ${closableEpic.spec}`,
      onDispatched: () => { task.branch = `worktree-${taskId}`; task.worktreeName = taskId; task.lastRole = 'architect'; task.kind = 'board-change'; task.lastDispatchedAt = Date.now(); }
    };
  }

  const next = JSON.parse(runDab(config, ['next']));
  if (!next) {
    return { action: 'idle' };
  }

  if (next.source === 'backlog') {
    const taskId = next.id ?? next.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    // Dedup: if dab next handed back a task already in flight, don't re-dispatch it. (With today's
    // dab next this is also why raising the WIP cap won't fan out to a *different* task yet — it
    // keeps returning the same still-"active"-on-main task. RFC_001 covers the dab-side fix.)
    if (state.tasks[taskId]?.branch) {
      return { action: 'wait', reason: 'next-task-already-in-flight', taskId };
    }
    const task = state.tasks[taskId] ?? { branch: null, rejectionCount: 0 };
    state.tasks[taskId] = task;
    return {
      action: 'dispatch',
      role: 'architect',
      taskId,
      sessionName: `factory-architect-${taskId}`,
      worktree: taskId,
      reason: 'needs-design-assessment',
      prompt: `Assess the backlog item "${next.title}" (spec: ${next.spec ?? 'none yet'}). Decide whether it's simple enough to graduate straight to dab/todos/, or whether it needs an RFC + epic first per your role instructions. Open a PR for whatever dab/ changes you make.`,
      onDispatched: () => { task.branch = `worktree-${taskId}`; task.worktreeName = taskId; task.lastRole = 'architect'; task.kind = 'board-change'; task.lastDispatchedAt = Date.now(); }
    };
  }

  // source === 'epic': a concrete task with a spec under todos/, not yet started
  const taskId = next.id ?? specToId.get(next.spec) ?? path.basename(next.spec, '.md');
  // Dedup (also the ADR-008 latent-bug fix): never re-dispatch a task already in flight.
  if (state.tasks[taskId]?.branch) {
    return { action: 'wait', reason: 'next-task-already-in-flight', taskId };
  }
  const task = state.tasks[taskId] ?? { branch: null, rejectionCount: 0 };
  state.tasks[taskId] = task;

  return {
    action: 'dispatch',
    role: 'developer',
    taskId,
    sessionName: `factory-developer-${taskId}`,
    worktree: taskId,
    reason: 'new-task',
    prompt: `Implement the task "${next.title}" (id: ${taskId}). Spec: ${next.spec}. Follow your role instructions end-to-end: implement, test, validate, commit, push, and open a PR.`,
    onDispatched: () => { task.branch = `worktree-${taskId}`; task.worktreeName = taskId; task.lastRole = 'developer'; task.kind = 'dab-task'; task.lastDispatchedAt = Date.now(); }
  };
}

// ---- Read-only status monitor (--status / --watch) ------------------------------------------
// A tick that acts vs. a tick that does nothing look identical until you run it. These helpers
// let you ask "would running a tick make progress right now?" without side effects, by observing
// reality exactly as `decide()` does and describing the answer.

const ACTIONABLE_ACTIONS = new Set(['dispatch', 'merge', 'reconcile-merged']);

function ciLabel(pr) {
  const rollup = pr?.statusCheckRollup ?? [];
  if (rollup.length === 0) return 'no-ci';
  if (isCiGreen(pr)) return 'green';
  const bad = rollup.some((c) => CI_BAD_CONCLUSIONS.has((c.conclusion ?? c.state ?? '').toUpperCase()));
  return bad ? 'RED' : 'pending';
}

function describeDecision(d) {
  switch (d.action) {
    case 'dispatch': return `dispatch ${d.role} for "${d.taskId}" (${d.reason})`;
    case 'merge': return `merge PR #${d.prNumber} for "${d.taskId}" — autoMerge`;
    case 'reconcile-merged': return `reconcile "${d.taskId}" — PR #${d.prNumber} was merged outside the orchestrator`;
    case 'wait': return `wait — ${d.reason}${d.taskId ? ` ("${d.taskId}")` : ''}`;
    case 'blocked': return `blocked — ${d.reason}`;
    case 'idle': return d.reason === 'autopilot-checkpoint-reached'
      ? `idle — autopilot checkpoint reached (${d.detail})`
      : 'idle — no tracked work, and nothing queued on the board';
    default: return d.action;
  }
}

function renderStatus(config) {
  const state = loadState();
  const out = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  out.push(`Factory status — ${repoConfigName}    ${now}`);

  const authOk = ghAuthOk(config);
  // Same fast-forward a tick does, so the monitor reports against current reality rather than a
  // stale local board. Read-only in intent: --ff-only can only receive what origin already has.
  const sync = authOk ? syncTargetRepo(config) : { ok: false, error: 'gh not authenticated' };
  const budget = budgetStatus(state, config);
  out.push(`gh auth: ${authOk ? 'ok' : 'NOT AUTHENTICATED'}    budget: ${budget.count}/${budget.cap} in ${config.budget?.windowMinutes ?? 300}m    autoMerge: ${config.autoMerge ? 'on' : 'off'}`);
  out.push(`repo: ${repoHead(config)}${sync.ok ? '' : `   ⚠ NOT SYNCED to origin (${sync.error}) — showing local state`}`);
  out.push('');

  const taskIds = Object.keys(state.tasks).sort();
  out.push(`Tracked tasks (${taskIds.length}):`);
  if (taskIds.length === 0) {
    out.push('  (none in flight)');
  }
  for (const taskId of taskIds) {
    const task = state.tasks[taskId];
    if (!task.branch) { out.push(`  ${taskId} — no branch yet`); continue; }
    const sessionName = `factory-${task.lastRole ?? 'developer'}-${taskId}`;
    const running = hasRunningSession(config, sessionName);
    const pr = findPrForBranch(config, task.branch);
    const prStr = pr ? `PR #${pr.number} ${pr.state}  CI:${ciLabel(pr)}  review:${pr.reviewDecision || '—'}` : 'no PR yet';
    out.push(`  ${taskId}`);
    out.push(`      role=${task.lastRole ?? '?'}  session=${running ? 'running' : 'idle/done'}  ${prStr}`);
  }
  out.push('');

  // Mirror main()'s guard order exactly, on a clone so decide()'s bookkeeping never persists.
  let decision;
  if (!authOk) decision = { action: 'blocked', reason: 'gh-not-authenticated' };
  else if (!sync.ok) decision = { action: 'blocked', reason: `repo-sync-failed: ${sync.error}` };
  else if (!budget.allowed) decision = { action: 'blocked', reason: 'budget-exceeded' };
  else {
    try { decision = decide(config, structuredClone(state)); }
    catch (err) { decision = { action: 'blocked', reason: `decide-threw: ${err?.message ?? err}` }; }
  }

  const marker = ACTIONABLE_ACTIONS.has(decision.action) ? '▶ ACT — a tick will make progress'
    : decision.action === 'blocked' ? '⚠ BLOCKED — needs you'
    : '⏸ WAIT — nothing to do yet';
  out.push(`Next tick would: ${marker}`);
  out.push(`  ${describeDecision(decision)}`);
  if (ACTIONABLE_ACTIONS.has(decision.action)) {
    out.push('');
    out.push(`  → run:  node orchestrator.mjs ${repoConfigName}`);
  }
  return out.join('\n');
}

/**
 * Structured-JSON equivalent of renderStatus() — same observations, machine-readable output.
 * Consumed by the local UI server via `node orchestrator.mjs <repo> --status --json`.
 * The decision logic lives only in decide(); this function is a thin reader, never a second brain.
 */
function renderStatusJson(config) {
  const state = loadState();
  const authOk = ghAuthOk(config);
  const sync = authOk ? syncTargetRepo(config) : { ok: false, error: 'gh not authenticated' };
  const budget = budgetStatus(state, config);

  const tasks = {};
  for (const taskId of Object.keys(state.tasks).sort()) {
    const task = state.tasks[taskId];
    const sessionName = `factory-${task.lastRole ?? 'developer'}-${taskId}`;
    const running = task.branch ? hasRunningSession(config, sessionName) : false;
    const pr = task.branch ? findPrForBranch(config, task.branch) : null;
    tasks[taskId] = {
      branch: task.branch ?? null,
      lastRole: task.lastRole ?? null,
      kind: task.kind ?? null,
      sessionRunning: running,
      sessionId: task.sessionId ?? null,
      lastDispatchedAt: task.lastDispatchedAt ? new Date(task.lastDispatchedAt).toISOString() : null,
      pr: pr ? {
        number: pr.number,
        state: pr.state,
        ci: ciLabel(pr),
        reviewDecision: pr.reviewDecision ?? null,
        mergedAt: pr.mergedAt ?? null,
      } : null,
    };
  }

  let decision;
  if (!authOk) decision = { action: 'blocked', reason: 'gh-not-authenticated' };
  else if (!sync.ok) decision = { action: 'blocked', reason: `repo-sync-failed: ${sync.error}` };
  else if (!budget.allowed) decision = { action: 'blocked', reason: 'budget-exceeded' };
  else {
    try { decision = decide(config, structuredClone(state)); }
    catch (err) { decision = { action: 'blocked', reason: `decide-threw: ${err?.message ?? err}` }; }
  }

  return {
    repo: repoConfigName,
    timestamp: new Date().toISOString(),
    ghAuth: authOk,
    repoSync: { ok: sync.ok, error: sync.ok ? undefined : sync.error },
    repoHead: repoHead(config),
    config: {
      autoMerge: config.autoMerge ?? false,
      maxConcurrentTasks: config.maxConcurrentTasks ?? 1,
      stopAfterTask: config.stopAfterTask ?? null,
      budget: config.budget ?? null,
    },
    budget: { count: budget.count, cap: budget.cap, allowed: budget.allowed },
    tasks,
    nextTick: {
      action: decision.action,
      reason: decision.reason ?? null,
      taskId: decision.taskId ?? null,
      prNumber: decision.prNumber ?? null,
      role: decision.role ?? null,
      actionable: ACTIONABLE_ACTIONS.has(decision.action),
      marker: ACTIONABLE_ACTIONS.has(decision.action) ? 'act'
        : decision.action === 'blocked' ? 'blocked'
        : 'wait',
      description: describeDecision(decision),
    },
  };
}

function statusMain() {
  const config = loadConfig();
  if (WATCH_SECONDS) {
    const tick = () => {
      process.stdout.write('\x1Bc'); // clear screen
      console.log(renderStatus(config));
      console.log(`\n(watching — refreshing every ${WATCH_SECONDS}s · Ctrl-C to stop)`);
      setTimeout(tick, WATCH_SECONDS * 1000);
    };
    tick();
  } else if (JSON_FLAG) {
    // Machine-readable output for the local UI server.
    console.log(JSON.stringify(renderStatusJson(config)));
  } else {
    console.log(renderStatus(config));
  }
}

function main() {
  const config = loadConfig();
  const state = loadState();
  const decisionId = randomUUID();

  if (!ghAuthOk(config)) {
    logDecision({ decisionId, type: 'blocked', reason: 'gh-not-authenticated' });
    return;
  }

  // Observe current reality, not a pre-merge snapshot. If the checkout can't be fast-forwarded to
  // origin, decisions about what work to start next (findClosableEpic, dab next) would run against
  // stale files — the exact cause of a spurious "re-close an already-closed epic" dispatch — so
  // stop rather than act on a stale board.
  const sync = syncTargetRepo(config);
  if (!sync.ok) {
    logDecision({ decisionId, type: 'blocked', reason: 'repo-sync-failed', detail: sync.error });
    notify('Factory blocked', `${repoConfigName}: couldn't fast-forward ${config.repoDir} to origin — ${sync.error}`);
    return;
  }

  const budget = budgetStatus(state, config);
  if (!budget.allowed) {
    logDecision({ decisionId, type: 'blocked', reason: 'budget-exceeded', count: budget.count, cap: budget.cap });
    notify('Factory paused', `Dispatch cap reached (${budget.count}/${budget.cap} in window) — resuming once the window rolls over.`);
    saveState(state);
    return;
  }

  let decision;
  try {
    decision = decide(config, state);
  } catch (err) {
    logDecision({ decisionId, type: 'error', reason: 'decide-threw', message: String(err?.message ?? err) });
    saveState(state);
    return;
  }

  if (decision.action === 'blocked') {
    logDecision({ decisionId, type: 'blocked', reason: decision.reason, detail: decision.detail, taskId: decision.taskId, prNumber: decision.prNumber });
    const message = decision.reason === 'pr-closed-without-merge'
      ? `${repoConfigName}: PR #${decision.prNumber} for "${decision.taskId}" was closed without merging — needs a human call (reopen, redo, or drop the task).`
      : `dab check found issues in ${repoConfigName} — see factory/logs/${repoConfigName}.jsonl`;
    notify('Factory blocked', message);
    saveState(state);
    return;
  }

  if (decision.action === 'idle') {
    logDecision({ decisionId, type: 'idle', reason: decision.reason, detail: decision.detail });
    saveState(state);
    return;
  }

  if (decision.action === 'wait') {
    logDecision({ decisionId, type: 'wait', reason: decision.reason, taskId: decision.taskId });
    saveState(state);
    return;
  }

  if (decision.action === 'merge') {
    if (!config.autoMerge) {
      logDecision({ decisionId, type: 'would-merge', taskId: decision.taskId, prNumber: decision.prNumber });
      notify('Factory: ready to merge', `${repoConfigName} PR #${decision.prNumber} approved + CI green — autoMerge is off, merge manually.`);
      saveState(state);
      return;
    }
    runGh(config, ['pr', 'merge', String(decision.prNumber), '--squash', '--delete-branch', '--repo', config.repo]);
    // No `dab complete` here. Task completion is part of the developer's PR — the WORK_PLAN box is
    // checked / the task archived inside the worktree and reviewed, so it lands on main atomically
    // with the merge (ADR 008). The orchestrator only reads and fast-forwards this checkout, never
    // writes to it; the next tick's sync reflects the completion.
    delete state.tasks[decision.taskId];
    logDecision({ decisionId, type: 'merged', taskId: decision.taskId, prNumber: decision.prNumber });
    notify('Factory: merged', `${repoConfigName}: ${decision.taskId} merged and archived.`);
    saveState(state);
    return;
  }

  if (decision.action === 'reconcile-merged') {
    // The PR landed through a channel other than this orchestrator's own 'merge' action above —
    // a human running `gh pr merge` or clicking Merge on GitHub directly, most likely. Catch
    // state up to match reality (same cleanup the 'merge' branch does, minus the merge itself,
    // which already happened) instead of treating "no open PR" as "still needs work" and
    // redispatching over already-finished work.
    // Completion rode in with the merged PR (ADR 008) — nothing to mark done here. Just catch
    // state up to the reality that this PR already merged (through whatever channel).
    delete state.tasks[decision.taskId];
    logDecision({ decisionId, type: 'reconciled-merged', taskId: decision.taskId, prNumber: decision.prNumber });
    saveState(state);
    return;
  }

  // action === 'dispatch'
  const result = dispatch(config, state, decision);
  if (!result.dispatched) {
    logDecision({
      decisionId,
      type: config.dryRun ? 'would-dispatch' : 'skipped-dispatch',
      role: decision.role,
      taskId: decision.taskId,
      reason: decision.reason,
      dispatchSkipReason: result.reason,
      wouldRunArgs: result.wouldRunArgs
    });
    saveState(state);
    return;
  }

  decision.onDispatched?.();
  const task = state.tasks[decision.taskId];
  if (task) {
    task.lastRole = decision.role;
    task.lastDispatchedAt = Date.now();
    task.sessionId = result.sessionId;
    task.lastDecisionId = decisionId;
  }
  logDecision({ decisionId, type: 'dispatch', role: decision.role, taskId: decision.taskId, reason: decision.reason, sessionId: result.sessionId });
  if (decision.role === 'architect') {
    notify('Factory: architect dispatched', `${repoConfigName}: ${decision.reason} — ${decision.taskId}`);
  }
  saveState(state);
}

if (STATUS_ONLY) statusMain();
else main();
