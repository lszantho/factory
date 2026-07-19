#!/usr/bin/env node
// One tick of the factory: deterministic router, no LLM call of its own.
// Usage: node orchestrator.mjs <repoConfigName>
// Reads configs/<repoConfigName>.json for paths/thresholds, tracks per-repo
// runtime state in state/<repoConfigName>.json and an audit trail in
// logs/<repoConfigName>.jsonl. See the target repo's .agents/AGENTS.md §6
// (Autonomous Factory Mode) for the rules dispatched sessions operate under.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { budgetStatus, recordDispatch, notify } from './budget-guard.mjs';

const FACTORY_DIR = path.dirname(fileURLToPath(import.meta.url));
const repoConfigName = process.argv[2];
if (!repoConfigName) {
  console.error('Usage: node orchestrator.mjs <repoConfigName>  (expects configs/<repoConfigName>.json to exist)');
  process.exit(1);
}

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

function claudeAgentsJson(config) {
  try {
    return JSON.parse(execFileSync(config.paths.claude, ['agents', '--json', '--all'], { encoding: 'utf-8', timeout: 15_000 }));
  } catch {
    return [];
  }
}

function isPidThisSession(pid, sessionId) {
  // A bare "does this pid exist" check isn't enough — macOS recycles pids, and one was observed
  // reused by an unrelated `claude --bg-spare` warm-pool process minutes after the original
  // session died, which would make a pid-only check report a long-dead session as running.
  // Confirming the live process's own command line still references this exact session id
  // rules out a coincidental pid reuse.
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
    return cmd.includes(sessionId);
  } catch {
    return false;
  }
}

function hasRunningSession(config, sessionName) {
  // `claude agents --json`'s own bookkeeping can be stale — it has been observed reporting a
  // pid for a session whose process had already exited. Don't trust the JSON's pid field alone.
  return claudeAgentsJson(config).some(
    (s) => s.name === sessionName && s.kind === 'background' && s.pid && isPidThisSession(s.pid, s.sessionId)
  );
}

function findPrForBranch(config, branch) {
  const raw = runGh(config, [
    'pr', 'list', '--repo', config.repo, '--head', branch, '--state', 'open',
    '--json', 'number,state,reviewDecision,statusCheckRollup,mergeable'
  ]);
  const prs = JSON.parse(raw || '[]');
  return prs[0] ?? null;
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

function dispatch(config, state, { role, sessionName, prompt, worktree, fromPr }) {
  if (hasRunningSession(config, sessionName)) {
    return { dispatched: false, reason: 'session-already-running' };
  }

  // --bg is incompatible with --print/--output-format (the CLI rejects that combo outright) —
  // the prompt goes in as a plain positional, and the session's id is recovered afterward via
  // `claude agents --json`, matched by the --name we gave it.
  // permission-mode must be bypassPermissions, not acceptEdits, for real unattended operation:
  // acceptEdits still prompts for Bash commands (git/dab/gh/pnpm), which a --bg session can
  // never answer, leaving it permanently "blocked". The target repo's AGENTS.md §6 restrictions
  // on destructive ops (via --disallowedTools below) are the actual safety net, not an
  // interactive approval step.
  const args = ['--agent', role, '--permission-mode', 'bypassPermissions', '--bg', '-n', sessionName];
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
    env: { ...process.env, FACTORY_DISPATCH: '1' }
  });
  const spawned = claudeAgentsJson(config).find((s) => s.name === sessionName);
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

  if (pr.reviewDecision === 'APPROVED' && isCiGreen(pr)) {
    return { action: 'merge', taskId, prNumber: pr.number };
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    task.rejectionCount = (task.rejectionCount ?? 0) + 1;
    const tag = latestRejectionTag(config, pr.number);
    if (task.rejectionCount >= 2 || tag === 'architectural') {
      return {
        action: 'dispatch',
        role: 'architect',
        taskId,
        sessionName: `factory-architect-mediate-${taskId}`,
        fromPr: pr.number,
        reason: 'mediate-rejection',
        prompt: `PR #${pr.number} for task "${titleHint ?? taskId}" has been rejected ${task.rejectionCount} time(s) by the reviewer, tagged "${tag}". Read the PR discussion and mediate per your role instructions: fix the spec, split the task, or clarify the approach.`
      };
    }
    return {
      action: 'dispatch',
      role: 'developer',
      taskId,
      sessionName: `factory-developer-${taskId}`,
      fromPr: pr.number,
      reason: 'address-feedback',
      prompt: `Address the reviewer's feedback on PR #${pr.number} for task "${titleHint ?? taskId}". Push your changes to the same branch.`
    };
  }

  if (!pr.reviewDecision && isCiGreen(pr)) {
    return {
      action: 'dispatch',
      role: 'reviewer',
      taskId,
      sessionName: `factory-reviewer-${taskId}`,
      // No --from-pr here: it resumes a session already associated with the PR, but the
      // reviewer's first look at any given PR has no such session to resume — it was observed
      // falling back to an interactive picker (per --help: "...or open interactive picker"),
      // which hangs forever with no TTY attached in --bg mode. A plain dispatch in the main
      // checkout reviewing via `gh pr diff`/`gh pr view` (per reviewer.md) avoids that entirely.
      reason: 'ready-for-review',
      prompt: `Review PR #${pr.number} for task "${titleHint ?? taskId}" per your role instructions. Use \`gh pr diff ${pr.number}\` and \`gh pr view ${pr.number}\` to inspect it remotely — no local checkout needed.`
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

  const closableEpic = findClosableEpic(statusPayload);
  if (closableEpic) {
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

function main() {
  const config = loadConfig();
  const state = loadState();
  const decisionId = randomUUID();

  if (!ghAuthOk(config)) {
    logDecision({ decisionId, type: 'blocked', reason: 'gh-not-authenticated' });
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
    logDecision({ decisionId, type: 'blocked', reason: decision.reason, detail: decision.detail });
    notify('Factory blocked', `dab check found issues in ${repoConfigName} — see factory/logs/${repoConfigName}.jsonl`);
    saveState(state);
    return;
  }

  if (decision.action === 'idle') {
    logDecision({ decisionId, type: 'idle' });
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
    runGh(config, ['pr', 'merge', String(decision.prNumber), '--squash', '--repo', config.repo]);
    // Only real dab todo/epic-todo tasks get `dab complete`; RFC/backlog-graduation/epic-close
    // PRs ("board-change") already applied their dab/** change inside the dispatched session —
    // there's nothing left to mark done, `dab complete` would just fail to find a matching task.
    if (state.tasks[decision.taskId]?.kind === 'dab-task') {
      runDab(config, ['complete', decision.taskId]);
    }
    delete state.tasks[decision.taskId];
    logDecision({ decisionId, type: 'merged', taskId: decision.taskId, prNumber: decision.prNumber });
    notify('Factory: merged', `${repoConfigName}: ${decision.taskId} merged and archived.`);
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

main();
