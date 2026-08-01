#!/usr/bin/env node
// One tick of the factory: deterministic router, no LLM call of its own.
// Usage: node orchestrator.mjs <repoConfigName>
// Reads configs/<repoConfigName>.json for paths/thresholds, tracks per-repo
// runtime state in state/<repoConfigName>.json and an audit trail in
// logs/<repoConfigName>.jsonl. See the target repo's .agents/AGENTS.md §6
// (Autonomous Factory Mode) for the rules dispatched sessions operate under.

// Default import, not `* as fs`: the ESM namespace form gives frozen bindings that
// t.mock.method() can't redefine, which blocks test/orchestrator.test.mjs from mocking
// fs.statSync for sessionActivelyWriting/canFastSkip. The default export is the same
// underlying mutable object, so this changes nothing at runtime.
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { budgetStatus, recordDispatch, notify } from './budget-guard.mjs';

const FACTORY_DIR = path.dirname(fileURLToPath(import.meta.url));
// True only when this file is the process entry point (`node orchestrator.mjs ...`), not when
// it's `import`ed (e.g. by test/orchestrator.test.mjs to exercise the exported pure functions).
// Keeps a test import side-effect-free: no CLI-arg validation, no process.exit, no tick/dispatch.
const IS_MAIN = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
const repoConfigName = process.argv[2];
if (IS_MAIN && (!repoConfigName || repoConfigName.startsWith('-'))) {
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
// --kill-session=<taskId> terminates a stuck session's process(es) and audit-logs the action —
// the manual-recovery runbook for the usage-limit-dialog hang, made self-service via the UI's
// kill button (server.mjs shells out to this) instead of a human hand-matching pids. Does not
// touch state.tasks or attempt to redispatch: recovery from here on is the existing
// stale-session retry path on a subsequent ordinary tick, same as any other session that died
// without opening a PR.
const KILL_SESSION_FLAG = CLI_FLAGS.find((f) => f.startsWith('--kill-session='));
const KILL_SESSION_TASK_ID = KILL_SESSION_FLAG ? KILL_SESSION_FLAG.split('=').slice(1).join('=') : null;
// --kill-agent=<sessionId> is the direct-by-session counterpart, for the processes view: it kills
// any agents-tracked session by id with no requirement that a factory task track it (the case for
// an already-orphaned process whose dispatching task completed some other way).
const KILL_AGENT_FLAG = CLI_FLAGS.find((f) => f.startsWith('--kill-agent='));
const KILL_AGENT_SESSION_ID = KILL_AGENT_FLAG ? KILL_AGENT_FLAG.split('=').slice(1).join('=') : null;
// --source=<ui|cli> is audit metadata only — who initiated the kill. Defaults to 'cli' (a human
// running the command directly); server.mjs passes --source=ui for the dashboard's kill button.
const SOURCE_FLAG = CLI_FLAGS.find((f) => f.startsWith('--source='));
const KILL_SOURCE = SOURCE_FLAG ? SOURCE_FLAG.split('=')[1] : 'cli';
// --agents (with --json) lists this repo's own factory-dispatched processes, live from `claude
// agents --json` — the processes view's data source. Read-only, same spirit as --status.
const AGENTS_FLAG = CLI_FLAGS.includes('--agents');

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

// A fast tick cadence (RFC 003) means the same no-op outcome (waiting on a session, waiting on
// CI, budget-exceeded, ...) can repeat every tick for a long time. Logging each repeat as its own
// line turns the audit trail into a poll log instead of a timeline of real transitions. quietSig
// identifies "is this the same outcome as last tick"; logQuiet only writes a line the first time a
// given outcome is seen, and folds repeats into a count flushed (as a single 'coalesced' line) the
// moment the outcome actually changes. Returns true iff this call produced a *new* line — callers
// use that to also gate a notify() so notifications don't repeat every tick either.
export function quietSig(entry) {
  return [entry.type, entry.reason ?? '', entry.taskId ?? '', entry.prNumber ?? '', entry.message ?? ''].join('|');
}

// `log` is injectable (defaults to the real logDecision) so tests can assert on what would have
// been written without touching logs/<repo>.jsonl.
export function flushQuiet(state, log = logDecision) {
  if (state.lastQuietSig && state.quietRepeatCount > 0) {
    log({ type: 'coalesced', of: state.lastQuietSig, repeats: state.quietRepeatCount });
  }
  state.lastQuietSig = null;
  state.quietRepeatCount = 0;
}

export function logQuiet(state, entry, log = logDecision) {
  const sig = quietSig(entry);
  if (state.lastQuietSig === sig) {
    state.quietRepeatCount = (state.quietRepeatCount ?? 0) + 1;
    return false;
  }
  flushQuiet(state, log);
  state.lastQuietSig = sig;
  state.quietRepeatCount = 0;
  log(entry);
  return true;
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

// Picks the worktree checked out on `branch` from `git worktree list --porcelain` output, which
// emits one blank-line-separated block per worktree: `worktree <path>`, `HEAD <sha>`, then
// `branch refs/heads/<name>` — the last line absent when the worktree is detached.
//
// Matching on the branch is deliberate, rather than rebuilding the path from the task id: the
// directory name is a convention (interactive sessions append a hash suffix, factory dispatches do
// not), while the branch is a fact already recorded in state.json and trusted by findPrForBranch.
// Same reconcile-from-reality principle as ADR 002.
export function parseWorktreeList(raw, branch) {
  if (!raw || !branch) return null;
  for (const block of raw.split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const head = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && head === branch) return path;
  }
  return null;
}

function findWorktreeForBranch(config, branch) {
  try {
    const raw = execFileSync('git', ['-C', config.repoDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf-8', timeout: 15_000 });
    return parseWorktreeList(raw, branch);
  } catch {
    return null;
  }
}

/**
 * Removes the worktree and local branch a merged task leaves behind.
 *
 * `gh pr merge --delete-branch` deletes the head branch on the *remote* only, and nothing ever
 * removed the local side — so before this, every dispatched task leaked one worktree and one local
 * branch permanently (14 worktrees / 27 branches had accumulated on LeanMacroFeed by 2026-08-01).
 * Permitted by ADR 008's 2026-08-01 amendment, which scopes that ADR's read-only invariant to
 * *content*: this writes no tracked file, creates no commit, and cannot make the checkout diverge,
 * so `--ff-only` stays unconditionally safe.
 *
 * Callers must have established the PR is MERGED. Never runs on a CLOSED PR — that work was
 * deliberately not merged and the local branch may be its only copy.
 *
 * Never throws, and never forces. Housekeeping must not turn an already-successful merge into a
 * stuck tick, and a worktree with uncommitted work is left alone for a human to look at.
 */
function cleanupMergedWorktree(config, branch) {
  if (!branch) return { ok: false, reason: 'no-branch' };
  const result = { branch, worktreeRemoved: false, branchDeleted: false };
  try {
    const worktreePath = findWorktreeForBranch(config, branch);
    if (worktreePath) {
      const dirty = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 15_000 }).trim();
      if (dirty) {
        // `git worktree remove` would refuse this anyway; catching it here turns an opaque git
        // error into a log line naming the branch, and leaves the uncommitted work in place.
        return { ...result, ok: false, reason: 'worktree-dirty', worktreePath };
      }
      execFileSync('git', ['-C', config.repoDir, 'worktree', 'remove', worktreePath], { encoding: 'utf-8', timeout: 30_000 });
      result.worktreeRemoved = true;
      result.worktreePath = worktreePath;
    }
    // `-D`, not `-d`: every merge here is a squash merge, so the branch's own commits never appear
    // in main's history and `-d`'s merged-check rejects a branch that demonstrably landed. Same
    // reasoning findPrForBranch documents for not using a commit-SHA check.
    execFileSync('git', ['-C', config.repoDir, 'branch', '-D', branch], { encoding: 'utf-8', timeout: 15_000 });
    result.branchDeleted = true;
    execFileSync('git', ['-C', config.repoDir, 'worktree', 'prune'], { encoding: 'utf-8', timeout: 15_000 });
    return { ...result, ok: true };
  } catch (err) {
    return { ...result, ok: false, reason: String(err?.stderr || err?.message || err).trim().split('\n').slice(-2).join(' ') };
  }
}

function claudeAgentsJson(config) {
  try {
    return JSON.parse(execFileSync(config.paths.claude, ['agents', '--json', '--all'], { encoding: 'utf-8', timeout: 15_000 }));
  } catch {
    return [];
  }
}

// A session stuck on an interactive prompt it has no TTY to answer (confirmed cause: hitting
// Claude's own usage limit and dropping into `/rate-limit-options`, see factory's operational
// gotchas doc) is invisible to the transcript-mtime liveness check above by design — the
// transcript IS silent, same as a session that's just thinking. `claude agents --json` is the one
// source that distinguishes them: a still-tracked live session reports `status`/`waitingFor`
// (e.g. "dialog open"); a session with no live process left reports neither. Call sites pass in
// the already-fetched agents list rather than each spawning their own `claude agents` subprocess.
function findStuckSession(agents, sessionId) {
  const entry = agents.find((s) => s.sessionId === sessionId);
  if (!entry || !entry.waitingFor) return null;
  return { pid: entry.pid ?? null, status: entry.status ?? null, waitingFor: entry.waitingFor, name: entry.name ?? null };
}

// The pid `claude agents --json` reports is the inner `--bg-spare` worker; the process actually
// holding the pty/session (and blocking on the stuck dialog) is its parent, a `--bg-pty-host`
// wrapper — confirmed by inspecting a live stuck session's process tree. Killing only the child
// leaves the pty-host orphaned, still holding its socket. Returns both pids (ppid may be null if
// the process already exited between the `agents --json` snapshot and this call).
function resolveKillTargets(pid) {
  if (!pid) return [];
  let ppid = null;
  try {
    ppid = Number(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8' }).trim()) || null;
  } catch {
    // Process already gone by the time we looked — nothing to resolve, pid alone is still tried.
  }
  return ppid ? [pid, ppid] : [pid];
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

// Fail-fast pre-check (RFC 003): while a developer session is genuinely still working and hasn't
// opened a PR yet, gh/dab calls are guaranteed to find nothing new (no PR -> no CI -> no review) —
// every one of them is pure waste at a fast tick cadence. This uses its own SHORT threshold
// (config.activeSessionSeconds, default 90s), never config.staleSessionMinutes (30 min): that
// threshold is deliberately lagging so a briefly-paused agent isn't re-dispatched over, and reusing
// it here would delay noticing a just-opened PR by up to 30 minutes — a latency regression worse
// than the tick interval it replaces. This checks the transcript mtime directly (no `claude
// agents --json` subprocess), so a mid-flight skip costs nothing at all.
export function sessionActivelyWriting(task, activeSeconds) {
  if (!task.sessionCwd || !task.sessionId) return false;
  try {
    const { mtimeMs } = fs.statSync(sessionTranscriptPath(task.sessionCwd, task.sessionId));
    return Date.now() - mtimeMs < activeSeconds * 1000;
  } catch {
    return false; // transcript missing/unreadable -> not provably active -> run the full tick
  }
}

// True only when nothing could possibly have changed since the last tick: every in-flight task is
// pre-PR and its session is still actively writing, AND we're at the WIP cap so there's no new work
// to start either (below the cap, decide() must still run so a new task can be dispatched). Once
// any in-flight task has a PR, CI/review state is GitHub-side with no local proxy for it — this can
// never fast-skip that task, only the pre-PR window.
export function canFastSkip(config, state) {
  const inFlight = Object.keys(state.tasks).filter((id) => state.tasks[id].branch);
  const wipLimit = config.maxConcurrentTasks ?? 1;
  if (inFlight.length === 0 || inFlight.length < wipLimit) return false;
  const activeSeconds = config.activeSessionSeconds ?? 90;
  return inFlight.every((id) => {
    const task = state.tasks[id];
    return !task.prNumber && sessionActivelyWriting(task, activeSeconds);
  });
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

// A check that hasn't finished reports its state in one of these, depending on the rollup entry
// type. `''` belongs here because a *running* CheckRun serialises as `conclusion: ""` — an empty
// string, not null — which is the single most important case in this file to get right.
const CI_PENDING_STATES = new Set(['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

/**
 * One rollup entry -> 'ok' | 'pending' | 'red'.
 *
 * Two entry shapes come back from `gh pr view --json statusCheckRollup`: a **CheckRun** (GitHub
 * Actions) carries `status` + `conclusion`; a **StatusContext** (legacy commit status) carries
 * only `state`. A CheckRun still running has `status: "IN_PROGRESS"` and `conclusion: ""`.
 *
 * That empty string is why this used to read `c.conclusion ?? c.state ?? ''`: `??` only falls
 * through on null/undefined, so `""` was returned as-is, `""` is not a bad conclusion, and a check
 * that was still running was reported **green**. With `autoMerge` on that meant a PR could be
 * merged before its checks finished — CI gated nothing at all once a single entry existed.
 */
export function checkOutcome(entry) {
  const status = (entry.status ?? '').toUpperCase();
  // CheckRun: anything short of COMPLETED is pending, whatever `conclusion` currently says.
  if (status && status !== 'COMPLETED') return 'pending';
  // `||` not `??` — an empty-string conclusion must fall through to `state` rather than be taken
  // as a final answer.
  const outcome = (entry.conclusion || entry.state || '').toUpperCase();
  if (CI_PENDING_STATES.has(outcome)) return 'pending';
  if (CI_BAD_CONCLUSIONS.has(outcome)) return 'red';
  // SKIPPED and NEUTRAL are common and benign (deploy jobs that only run on pushes to main, not
  // PRs) — only a genuinely bad conclusion counts as red, not "not literally SUCCESS".
  return 'ok';
}

/**
 * The rollup as a whole -> 'none' | 'red' | 'pending' | 'green'.
 *
 * `'none'` is deliberately distinct from `'pending'`. An empty rollup means either "checks have
 * not attached yet" (a race, moments after a PR opens) or "no CI is configured / the workflow is
 * disabled" (permanent). Both must block a merge, but only the second is something a human needs
 * told about — collapsing them into a bare `false` made a disabled workflow look exactly like
 * normal waiting, and the factory sat in `wait` with no distinguishing symptom.
 */
export function ciState(pr) {
  const rollup = pr?.statusCheckRollup ?? [];
  if (rollup.length === 0) return 'none';
  const outcomes = rollup.map(checkOutcome);
  if (outcomes.includes('red')) return 'red';
  if (outcomes.includes('pending')) return 'pending';
  return 'green';
}

export function isCiGreen(pr) {
  return ciState(pr) === 'green';
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
  const args = [];
  // `--disallowedTools` is a VARIADIC option (`<tools...>`): it greedily consumes every following
  // argument until the next flag. So it MUST come first, terminated by `--agent` — otherwise, for a
  // dispatch with no `--worktree`/`--from-pr` between it and the trailing prompt (i.e. every reviewer
  // dispatch), the variadic swallows the prompt as bogus tool names and the session blocks at
  // startup, never seeing its prompt (diagnosed after a re-review reviewer hung with no transcript
  // while developers with `--worktree` — a flag that stopped the variadic — ran fine). Patterns are
  // passed as separate argv elements (not comma-joined) so ones containing spaces stay intact.
  // These denies are the only tool-level guardrail alongside AGENTS.md §6 (no merge / no force-push /
  // no touching main); promote to a PreToolUse hook if airtight enforcement is needed — see
  // docs/architecture/EXECUTION_AND_PERMISSIONS.md.
  if (config.disallowedTools?.length) {
    args.push('--disallowedTools', ...config.disallowedTools);
  }
  // --bg is incompatible with --print/--output-format; the prompt is the trailing positional and the
  // session id is recovered afterward via `claude agents --json`, matched by the --name we gave it.
  args.push('--agent', role, '--permission-mode', 'bypassPermissions', '--bg', '-n', sessionName);
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
  // cwd is recorded on the task so a later tick's fail-fast check (canFastSkip) can stat the
  // session's transcript directly, with no `claude agents --json` subprocess needed.
  return { dispatched: true, sessionId: spawned?.sessionId, cwd: spawned?.cwd, pid: spawned?.pid };
}

// "5 of 12" for the active sprint's WORK_PLAN.md — checked vs. total top-level checklist items.
// Mirrors server.mjs's readSprintProgress (used today only by the portfolio view) so both surfaces
// agree; kept as its own small read here rather than routed through dab, since it's a plain
// regex over a file this process already knows the path to; the sprint id it needs comes from
// dab status's existing activeSprints, so it costs no extra dab call as well.
function readSprintProgress(config, sprintId) {
  try {
    const workPlanPath = path.join(config.repoDir, config.boardDir ?? 'dab', 'sprints', sprintId, 'WORK_PLAN.md');
    const content = fs.readFileSync(workPlanPath, 'utf-8');
    const total = (content.match(/^- \[[ xX]\]/gm) ?? []).length;
    const done = (content.match(/^- \[[xX]\]/gm) ?? []).length;
    return { done, total };
  } catch {
    return null;
  }
}

/** The first task in a currently-active sprint whose status is blocked-operator, or null.
 *  `dab next` already refuses to hand one of these out as workable, so its absence from `next`'s
 *  result only tells you nothing is dispatchable — not *why*. This answers the why, so `decide()`
 *  can report "waiting on you" instead of a bare "idle" that looks identical to genuinely having
 *  nothing left. */
export function findOperatorBlockedTask(statusPayload) {
  const activeSprintIds = new Set(statusPayload.activeSprints.map((e) => e.id));
  return (statusPayload.blockedTasks ?? []).find((t) => t.sprint && activeSprintIds.has(t.sprint)) ?? null;
}

export function findClosableSprint(statusPayload) {
  // A sprint is closable only when NONE of dab status's three task buckets still claim it —
  // not just activeTasks. This used to check activeTasks alone, which had two live bugs:
  // a task someone had actually claimed (inProgressTasks) was invisible to this check, and so
  // was a task stuck on the operator (blockedTasks, added alongside this fix). Both meant a
  // sprint could be reported closable while real or human-only work was still open on it —
  // the second one is exactly what motivated adding blockedTasks in the first place: an
  // orchestrator dispatching a sprint-close architect onto a sprint whose last item was "run
  // this against production" is the same wasted-cycle mistake as dispatching a developer onto
  // it, just one step later in the sprint's lifecycle.
  const openBuckets = [statusPayload.activeTasks, statusPayload.inProgressTasks, statusPayload.blockedTasks ?? []];
  const activeSprintIds = statusPayload.activeSprints.map((e) => e.id).sort();
  for (const sprintId of activeSprintIds) {
    const hasOpenTask = openBuckets.some((bucket) => bucket.some((t) => t.sprint === sprintId));
    if (!hasOpenTask) {
      return statusPayload.activeSprints.find((e) => e.id === sprintId);
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
      const sessionName = `factory-reviewer-${taskId}-${shortHead}`;
      if (hasRunningSession(config, sessionName)) {
        return { action: 'wait', reason: 'session-running', taskId };
      }
      return {
        action: 'dispatch',
        role: 'reviewer',
        taskId,
        sessionName,
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
    const role = toArchitect ? 'architect' : 'developer';
    const sessionName = `factory-${toArchitect ? 'architect-mediate' : 'developer'}-${taskId}-${shortHead}`;
    if (hasRunningSession(config, sessionName)) {
      return { action: 'wait', reason: 'session-running', taskId };
    }
    return {
      action: 'dispatch',
      role,
      taskId,
      // SHA-suffixed so a just-finished session of the previous round (whose transcript is still
      // <staleMinutes old) can't false-positive hasRunningSession and skip this dispatch.
      sessionName,
      // --worktree, NOT --from-pr. `--from-pr` resumes a session associated with the PR, but once
      // several sessions touch a PR (original dev + reviewer + prior feedback rounds) it can't pick
      // one and falls back to an interactive picker that hangs forever in --bg (no TTY) — observed
      // live: five back-to-back address-feedback dispatches all stuck "blocked" with no transcript,
      // never pushing, so the head never advanced and the re-review never fired. Dispatching into
      // the task's existing worktree is deterministic; the fixer reads the feedback via `gh pr view`.
      worktree: task.worktreeName,
      reason: toArchitect ? 'mediate-rejection' : 'address-feedback',
      prompt: toArchitect
        ? `PR #${pr.number} for task "${titleHint ?? taskId}" has been rejected ${rounds} time(s) by the reviewer, tagged "${tag}". Read the discussion with \`gh pr view ${pr.number}\` / \`gh pr diff ${pr.number}\` and mediate per your role instructions: fix the spec, split the task, or clarify the approach.`
        : `Address the reviewer's feedback on PR #${pr.number} for task "${titleHint ?? taskId}". Read it with \`gh pr view ${pr.number} --comments\`, make the changes in this worktree, and push to the same branch (do NOT open a new PR).`,
      onDispatched: () => { task.rejectionCount = rounds; task.lastRejectionSha = head; }
    };
  }

  if (!pr.reviewDecision && isCiGreen(pr)) {
    const sessionName = `factory-reviewer-${taskId}-${shortHead}`;
    if (hasRunningSession(config, sessionName)) {
      return { action: 'wait', reason: 'session-running', taskId };
    }
    return {
      action: 'dispatch',
      role: 'reviewer',
      taskId,
      sessionName,
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

  // Say *which* of the several "not ready yet" conditions this is. The old single reason,
  // 'ci-pending-or-no-review-yet', covered a transient wait and a permanently-stuck repo equally
  // well, so a disabled CI workflow was indistinguishable from patience.
  return { action: 'wait', reason: ciWaitReason(pr), taskId };
}

/** Why an open PR isn't moving, specific enough to act on without opening GitHub. */
function ciWaitReason(pr) {
  switch (ciState(pr)) {
    case 'none':
      return 'ci-not-reporting: no checks attached to this PR — is the workflow enabled, and does it trigger on pull_request?';
    case 'red':
      return 'ci-red';
    case 'pending':
      return 'ci-pending';
    default:
      return pr.reviewDecision === 'CHANGES_REQUESTED' ? 'awaiting-fix-push' : 'awaiting-review';
  }
}

export function decide(config, state) {
  const check = JSON.parse(runDab(config, ['check', '--json']));
  if (check.length > 0) {
    return { action: 'blocked', reason: 'dab-check-issues', detail: check };
  }

  // Finish in-flight tracked work (any role) before starting anything new.
  // Keep the first in-flight wait: if nothing downstream turns out to be actionable either, that
  // reason is the one worth reporting. Falling through to a generic 'wip-limit-reached' hid the
  // real blocker — an operator saw "at capacity" when the truth was "PR #230's checks never
  // attached", which are very different problems with very different fixes.
  let firstInFlightWait = null;
  for (const taskId of Object.keys(state.tasks).sort()) {
    const task = state.tasks[taskId];
    if (!task.branch) continue;
    const result = inFlightAction(config, taskId, task, taskId);
    if (result.action !== 'wait') {
      return result;
    }
    firstInFlightWait ??= result;
  }

  const statusPayload = JSON.parse(runDab(config, ['status']));
  // `dab next` only fills in `id` when the sprint todo's numbered filename (e.g. 01_foo.md)
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
    // At capacity *because* of the in-flight task above — so report why that one isn't moving,
    // not the capacity symptom it causes. Without this the operator-facing answer to "why is the
    // factory stuck?" is "it's busy", which is true and useless.
    if (firstInFlightWait) return firstInFlightWait;
    return { action: 'wait', reason: 'wip-limit-reached', detail: `${inFlightIds.length}/${wipLimit} in flight` };
  }

  const closableSprint = findClosableSprint(statusPayload);
  // Skip if this sprint's close is already in flight (its close PR is tracked) — the in-flight loop is
  // already driving it; re-dispatching would duplicate it. Fall through to any other ready work.
  if (closableSprint && !state.tasks[`sprint-close-${closableSprint.id}`]?.branch) {
    const taskId = `sprint-close-${closableSprint.id}`;
    const task = state.tasks[taskId] ?? { branch: null, rejectionCount: 0 };
    state.tasks[taskId] = task;
    return {
      action: 'dispatch',
      role: 'architect',
      taskId,
      sessionName: `factory-architect-${taskId}`,
      worktree: taskId,
      reason: 'sprint-closing',
      prompt: `The sprint "${closableSprint.id}" (${closableSprint.title}) has no remaining open tasks. Review it end-to-end per your role instructions and, if it genuinely delivered what its overview.md proposed, run \`dab sprint close ${closableSprint.id}\` and open a PR for the archive move. Spec: ${closableSprint.spec}`,
      onDispatched: () => { task.branch = `worktree-${taskId}`; task.worktreeName = taskId; task.lastRole = 'architect'; task.kind = 'board-change'; task.lastDispatchedAt = Date.now(); }
    };
  }

  // RFC 005: planning is collaborative human work that produces a ready sprint; the factory only
  // consumes one. A bare backlog item — no active sprint claims it yet — isn't the factory's to
  // assess or graduate anymore, so it's exactly as actionable as no next item at all: idle —
  // unless the *reason* nothing else is resolvable is a task stuck on the operator, in which case
  // idle is the wrong word for it: "nothing to do" and "waiting on you" call for different
  // responses from a human skimming the board, and only one of them is actually true here.
  const next = JSON.parse(runDab(config, ['next']));
  if (!next || next.source === 'backlog') {
    const blockedInActiveSprint = findOperatorBlockedTask(statusPayload);
    if (blockedInActiveSprint) {
      return {
        action: 'blocked',
        reason: 'awaiting-operator',
        taskId: blockedInActiveSprint.id,
        detail: blockedInActiveSprint.blockedReason ?? `${blockedInActiveSprint.title} needs operator action — see its task spec`,
      };
    }
    return { action: 'idle' };
  }

  // source === 'sprint': a concrete task with a spec under todos/, not yet started
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
  // Previously this asked isCiGreen() first, which returned true for a still-running check — so
  // 'pending' was unreachable and `--status` printed `CI:green` while Validate was in progress.
  return { none: 'no-ci', red: 'RED', pending: 'pending', green: 'green' }[ciState(pr)];
}

export function describeDecision(d) {
  switch (d.action) {
    case 'dispatch': return `dispatch ${d.role} for "${d.taskId}" (${d.reason})`;
    case 'merge': return `merge PR #${d.prNumber} for "${d.taskId}" — autoMerge`;
    case 'reconcile-merged': return `reconcile "${d.taskId}" — PR #${d.prNumber} was merged outside the orchestrator`;
    case 'wait': return `wait — ${d.reason}${d.taskId ? ` ("${d.taskId}")` : ''}`;
    // `detail` already carries useful text on several blocked reasons (dab-check-issues' issue
    // list, repo-sync-failed's git error, this one's operator instructions) but nothing before
    // this rendered it — the banner said only "blocked — <reason>", and the actual "why" lived
    // in the JSON's .detail field where no human-facing surface showed it. Only append it when
    // it's a plain string: an array/object detail (dab-check-issues) stays as compact as before
    // rather than dumping a raw JSON blob into a one-line banner.
    case 'blocked': return `blocked — ${d.reason}${d.taskId ? ` ("${d.taskId}")` : ''}${typeof d.detail === 'string' ? `: ${d.detail}` : ''}`;
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
  out.push(`last tick: ${state.lastTickAt ?? '(never)'}`);
  out.push(`repo: ${repoHead(config)}${sync.ok ? '' : `   ⚠ NOT SYNCED to origin (${sync.error}) — showing local state`}`);
  // "Which task, out of how many in the sprint" was previously answerable only by opening the
  // sprint's WORK_PLAN.md and counting by hand — the tracked-task list below names a task with
  // no sense of how far through the sprint it sits.
  try {
    const activeSprint = JSON.parse(runDab(config, ['status'])).activeSprints[0];
    if (activeSprint) {
      const progress = readSprintProgress(config, activeSprint.id);
      out.push(`sprint: ${activeSprint.title}${progress ? `  (${progress.done}/${progress.total} tasks done)` : ''}`);
    }
  } catch { /* best-effort — a status line is not worth failing --status over */ }
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
    const running = inFlightAction(config, taskId, task, taskId).reason === 'session-running';
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

  // Fetched once and reused across every task below (each of which already shells out to `gh`
  // separately for its own PR lookup) rather than one `claude agents` subprocess per task.
  const agents = claudeAgentsJson(config);

  let activeSprint = null;
  try {
    const sprint = JSON.parse(runDab(config, ['status'])).activeSprints[0];
    if (sprint) {
      activeSprint = { id: sprint.id, title: sprint.title, progress: readSprintProgress(config, sprint.id) };
    }
  } catch { /* best-effort — the UI already handles activeSprint: null */ }

  const tasks = {};
  for (const taskId of Object.keys(state.tasks).sort()) {
    const task = state.tasks[taskId];
    const running = task.branch ? inFlightAction(config, taskId, task, taskId).reason === 'session-running' : false;
    const pr = task.branch ? findPrForBranch(config, task.branch) : null;
    const stuck = task.sessionId ? findStuckSession(agents, task.sessionId) : null;
    tasks[taskId] = {
      branch: task.branch ?? null,
      lastRole: task.lastRole ?? null,
      kind: task.kind ?? null,
      sessionRunning: running,
      sessionId: task.sessionId ?? null,
      lastDispatchedAt: task.lastDispatchedAt ? new Date(task.lastDispatchedAt).toISOString() : null,
      stuck: stuck ? { pid: stuck.pid, waitingFor: stuck.waitingFor } : null,
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
    lastTickAt: state.lastTickAt ?? null,
    ghAuth: authOk,
    repoSync: { ok: sync.ok, error: sync.ok ? undefined : sync.error },
    repoHead: repoHead(config),
    activeSprint,
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

// Manual recovery for a session stuck on an interactive dialog it has no TTY to answer (see
// findStuckSession's comment). Prints a single JSON result line to stdout — server.mjs parses
// this directly rather than re-implementing any of the lookup/kill logic, keeping the
// orchestrator the one place this behavior is defined.
// Shared by both kill entry points below. Only ever terminates a session `claude agents --json`
// itself reports as waiting on a prompt — never a bare "kill whatever this sessionId points at" —
// so a request against a legitimately busy session (confirmed to happen: the daemon can silently
// resume a killed session's *logical* id onto a fresh pid) is a safe no-op, not a foot-gun.
// taskId is optional (present when called via the tracked-task path, null for an untracked
// process killed directly from the processes view) — audit-log correlation only, never a lookup key.
function killSessionCore(config, sessionId, source, taskId = null) {
  const decisionId = randomUUID();
  const agents = claudeAgentsJson(config);
  const stuck = findStuckSession(agents, sessionId);
  const targets = resolveKillTargets(stuck?.pid);

  const killed = [];
  const errors = [];
  for (const pid of targets) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch (err) {
      // ESRCH ("no such process") means it was already gone — not a failure of this action,
      // the end state (dead) is exactly what was wanted.
      if (err.code !== 'ESRCH') errors.push({ pid, error: err.message });
    }
  }

  logDecision({
    decisionId,
    type: 'manual-kill',
    taskId,
    sessionId,
    source: source ?? 'cli',
    waitingFor: stuck?.waitingFor ?? null,
    pids: targets,
    killed,
    errors: errors.length ? errors : undefined,
  });

  const result = { ok: errors.length === 0, taskId, sessionId, pids: targets, killed, errors };
  console.log(JSON.stringify(result));
  if (errors.length > 0) process.exitCode = 1;
}

function killSessionMain(taskId, source) {
  const config = loadConfig();
  const state = loadState();
  const task = state.tasks[taskId];

  if (!task) {
    console.log(JSON.stringify({ ok: false, taskId, error: 'no such tracked task' }));
    process.exitCode = 1;
    return;
  }
  if (!task.sessionId) {
    console.log(JSON.stringify({ ok: false, taskId, error: 'task has no recorded session' }));
    process.exitCode = 1;
    return;
  }

  killSessionCore(config, task.sessionId, source, taskId);
}

// Direct-by-session counterpart for the processes view: kills any agents-tracked session by its
// sessionId, with no requirement that a factory task track it — exactly the case for an orphaned
// process (its dispatching task already completed some other way, e.g. a prior manual retry) that
// the per-task path above can't reach at all, since there's no task left to look it up through.
function killAgentMain(sessionId, source) {
  const config = loadConfig();
  killSessionCore(config, sessionId, source, null);
}

function agentsMain() {
  const config = loadConfig();
  console.log(JSON.stringify({ agents: listAgentProcesses(config) }));
}

// Repo-scoped read for the processes view: `claude agents --json` is global to the whole machine
// (every Claude Code session, this very one included) — filtering to this factory's own dispatch
// naming convention (`factory-<role>-...`) plus a cwd under this repo's checkout is what keeps the
// view from becoming a list of unrelated work a click could accidentally kill.
//
// Liveness signal: NOT `pid` — confirmed by inspecting real entries, a session from five days ago
// with no live process left still carries its last-known pid in the daemon's historical record,
// so pid presence alone doesn't mean "currently running." `status` is the reliable signal: a
// genuinely tracked-live session reports "waiting" (stuck on a prompt) or "busy" (working); a
// cleanly-finished session still gets a status, "idle"; a pure historical record with no live
// process left has no status field at all. Filtering to status present and not "idle" is what
// keeps this to sessions actually worth showing in a *processes* view.
function listAgentProcesses(config) {
  const agents = claudeAgentsJson(config);
  return agents
    .filter((s) =>
      s.kind === 'background' &&
      typeof s.name === 'string' && s.name.startsWith('factory-') &&
      typeof s.cwd === 'string' && s.cwd.startsWith(config.repoDir) &&
      s.status != null && s.status !== 'idle'
    )
    .map((s) => ({
      name: s.name,
      sessionId: s.sessionId,
      pid: s.pid ?? null,
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      status: s.status ?? null,
      state: s.state ?? null,
      stuck: s.waitingFor ? { waitingFor: s.waitingFor } : null,
    }))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

function main() {
  const config = loadConfig();
  const state = loadState();
  const decisionId = randomUUID();

  // Every path below (however it returns) must persist the heartbeat + any pending coalesced-quiet
  // count exactly once. A try/finally makes this true by construction instead of relying on a
  // saveState(state) call placed before every return — a fast tick cadence made a missed one on any
  // one path much more visible (it used to just mean a slightly stale --status between polls).
  try {
    // Fail-fast (RFC 003): nothing below this point can matter if every in-flight task is pre-PR
    // and its session is still actively writing, and there's no room to start new work anyway. Skip
    // gh-auth/sync/dab entirely rather than spend a full reconcile confirming what's already known.
    if (canFastSkip(config, state)) {
      logQuiet(state, { decisionId, type: 'wait', reason: 'session-active-no-pr' });
      return;
    }

    if (!ghAuthOk(config)) {
      logQuiet(state, { decisionId, type: 'blocked', reason: 'gh-not-authenticated' });
      return;
    }

    // Observe current reality, not a pre-merge snapshot. If the checkout can't be fast-forwarded to
    // origin, decisions about what work to start next (findClosableSprint, dab next) would run against
    // stale files — the exact cause of a spurious "re-close an already-closed sprint" dispatch — so
    // stop rather than act on a stale board.
    const sync = syncTargetRepo(config);
    if (!sync.ok) {
      if (logQuiet(state, { decisionId, type: 'blocked', reason: 'repo-sync-failed', detail: sync.error })) {
        notify('Factory blocked', `${repoConfigName}: couldn't fast-forward ${config.repoDir} to origin — ${sync.error}`);
      }
      return;
    }

    const budget = budgetStatus(state, config);
    if (!budget.allowed) {
      if (logQuiet(state, { decisionId, type: 'blocked', reason: 'budget-exceeded', count: budget.count, cap: budget.cap })) {
        notify('Factory paused', `Dispatch cap reached (${budget.count}/${budget.cap} in window) — resuming once the window rolls over.`);
      }
      return;
    }

    let decision;
    try {
      decision = decide(config, state);
    } catch (err) {
      logQuiet(state, { decisionId, type: 'error', reason: 'decide-threw', message: String(err?.message ?? err) });
      return;
    }

    if (decision.action === 'blocked') {
      const isNew = logQuiet(state, { decisionId, type: 'blocked', reason: decision.reason, detail: decision.detail, taskId: decision.taskId, prNumber: decision.prNumber });
      if (isNew) {
        const message = decision.reason === 'pr-closed-without-merge'
          ? `${repoConfigName}: PR #${decision.prNumber} for "${decision.taskId}" was closed without merging — needs a human call (reopen, redo, or drop the task).`
          // Deliberately its own notification title/tone below (see the `notify()` call), not
          // folded into the generic "Factory blocked" case here: the other two reasons reaching
          // this branch mean something is wrong (a closed PR, a failing dab check); this one
          // means the factory is working exactly as designed and waiting on a normal, expected
          // step only a human can take. Same urgency to see it, different urgency to fix it.
          : decision.reason === 'awaiting-operator'
            ? `${repoConfigName}: "${decision.taskId}" needs you — ${decision.detail}`
            : `dab check found issues in ${repoConfigName} — see factory/logs/${repoConfigName}.jsonl`;
        notify(decision.reason === 'awaiting-operator' ? 'Factory: your turn' : 'Factory blocked', message);
      }
      return;
    }

    if (decision.action === 'idle') {
      logQuiet(state, { decisionId, type: 'idle', reason: decision.reason, detail: decision.detail });
      return;
    }

    if (decision.action === 'wait') {
      logQuiet(state, { decisionId, type: 'wait', reason: decision.reason, taskId: decision.taskId });
      return;
    }

    if (decision.action === 'merge') {
      if (!config.autoMerge) {
        if (logQuiet(state, { decisionId, type: 'would-merge', taskId: decision.taskId, prNumber: decision.prNumber })) {
          notify('Factory: ready to merge', `${repoConfigName} PR #${decision.prNumber} approved + CI green — autoMerge is off, merge manually.`);
        }
        return;
      }
      runGh(config, ['pr', 'merge', String(decision.prNumber), '--squash', '--delete-branch', '--repo', config.repo]);
      // No `dab complete` here. Task completion is part of the developer's PR — the WORK_PLAN box is
      // checked / the task archived inside the worktree and reviewed, so it lands on main atomically
      // with the merge (ADR 008). The orchestrator only reads and fast-forwards this checkout, never
      // writes to it; the next tick's sync reflects the completion.
      // Read the branch before dropping the state entry — it is the only record of which worktree
      // this task owns, and `--delete-branch` above removed only the remote side.
      const mergedBranch = state.tasks[decision.taskId]?.branch;
      delete state.tasks[decision.taskId];
      flushQuiet(state);
      const cleanup = cleanupMergedWorktree(config, mergedBranch);
      logDecision({ decisionId, type: 'merged', taskId: decision.taskId, prNumber: decision.prNumber, cleanup });
      notify('Factory: merged', `${repoConfigName}: ${decision.taskId} merged and archived.`);
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
      // This is the larger of the two worktree leaks: a PR merged in GitHub's UI or by a human
      // `gh pr merge` never reaches the 'merge' action above, so its worktree was never seen again.
      const reconciledBranch = state.tasks[decision.taskId]?.branch;
      delete state.tasks[decision.taskId];
      flushQuiet(state);
      const reconcileCleanup = cleanupMergedWorktree(config, reconciledBranch);
      logDecision({ decisionId, type: 'reconciled-merged', taskId: decision.taskId, prNumber: decision.prNumber, cleanup: reconcileCleanup });
      return;
    }

    // action === 'dispatch'
    const result = dispatch(config, state, decision);
    if (!result.dispatched) {
      logQuiet(state, {
        decisionId,
        type: config.dryRun ? 'would-dispatch' : 'skipped-dispatch',
        role: decision.role,
        taskId: decision.taskId,
        reason: decision.reason,
        dispatchSkipReason: result.reason,
        wouldRunArgs: result.wouldRunArgs
      });
      return;
    }

    decision.onDispatched?.();
    const task = state.tasks[decision.taskId];
    if (task) {
      task.lastRole = decision.role;
      task.lastDispatchedAt = Date.now();
      task.sessionId = result.sessionId;
      task.sessionCwd = result.cwd;
      task.lastDecisionId = decisionId;
    }
    flushQuiet(state);
    logDecision({ decisionId, type: 'dispatch', role: decision.role, taskId: decision.taskId, reason: decision.reason, sessionId: result.sessionId });
    if (decision.role === 'architect') {
      notify('Factory: architect dispatched', `${repoConfigName}: ${decision.reason} — ${decision.taskId}`);
    }
  } finally {
    state.lastTickAt = new Date().toISOString();
    saveState(state);
  }
}

if (IS_MAIN) {
  if (KILL_SESSION_TASK_ID) killSessionMain(KILL_SESSION_TASK_ID, KILL_SOURCE);
  else if (KILL_AGENT_SESSION_ID) killAgentMain(KILL_AGENT_SESSION_ID, KILL_SOURCE);
  else if (AGENTS_FLAG) agentsMain();
  else if (STATUS_ONLY) statusMain();
  else main();
}
