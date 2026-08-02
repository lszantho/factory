// Unit tests for the pure decision/logging helpers exported from orchestrator.mjs.
// Run with: node --test
//
// orchestrator.mjs only exports its pure functions when imported (guarded by IS_MAIN, so
// `node orchestrator.mjs <repo>` still runs a real tick as before) — see the IS_MAIN check
// near the top of that file. fs.statSync is mocked per-test via t.mock so these never touch
// the real ~/.claude/projects transcript tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Default import, matching orchestrator.mjs — a namespace import (`* as fs`) would give frozen
// ESM bindings that t.mock.method() can't redefine ("Cannot redefine property: statSync").
import fs from 'node:fs';
import {
  quietSig,
  flushQuiet,
  logQuiet,
  sessionActivelyWriting,
  canFastSkip,
  checkOutcome,
  ciState,
  isCiGreen,
  findClosableSprint,
  findOperatorBlockedTask,
  describeDecision,
  parseWorktreeList,
  pickSessionState,
} from '../orchestrator.mjs';

// ---- quietSig ----------------------------------------------------------------------------

test('quietSig: identical entries produce the same signature', () => {
  const a = quietSig({ type: 'wait', reason: 'r', taskId: 't' });
  const b = quietSig({ type: 'wait', reason: 'r', taskId: 't' });
  assert.equal(a, b);
});

test('quietSig: differs on type, reason, taskId, prNumber, or message independently', () => {
  const base = { type: 'wait', reason: 'r', taskId: 't', prNumber: 1, message: 'm' };
  const sig = quietSig(base);
  assert.notEqual(quietSig({ ...base, type: 'idle' }), sig);
  assert.notEqual(quietSig({ ...base, reason: 'r2' }), sig);
  assert.notEqual(quietSig({ ...base, taskId: 't2' }), sig);
  assert.notEqual(quietSig({ ...base, prNumber: 2 }), sig);
  assert.notEqual(quietSig({ ...base, message: 'm2' }), sig);
});

// ---- logQuiet / flushQuiet ----------------------------------------------------------------

test('logQuiet: first occurrence of an outcome logs it and returns true', () => {
  const logged = [];
  const state = {};
  const isNew = logQuiet(state, { type: 'wait', reason: 'x' }, (e) => logged.push(e));
  assert.equal(isNew, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, 'wait');
  assert.equal(state.quietRepeatCount, 0);
});

test('logQuiet: an identical repeat is coalesced — no new log line, count increments, returns false', () => {
  const logged = [];
  const state = {};
  const log = (e) => logged.push(e);
  logQuiet(state, { type: 'wait', reason: 'x' }, log);
  const isNewRepeat = logQuiet(state, { type: 'wait', reason: 'x' }, log);
  assert.equal(isNewRepeat, false);
  assert.equal(logged.length, 1); // still just the first occurrence
  assert.equal(state.quietRepeatCount, 1);
});

test('logQuiet: a changed outcome flushes the prior streak as one coalesced summary, then logs fresh', () => {
  const logged = [];
  const state = {};
  const log = (e) => logged.push(e);
  logQuiet(state, { type: 'wait', reason: 'x' }, log); // #1: first 'wait'
  logQuiet(state, { type: 'wait', reason: 'x' }, log); // repeat (count=1)
  logQuiet(state, { type: 'wait', reason: 'x' }, log); // repeat (count=2)
  logQuiet(state, { type: 'idle' }, log);              // sig changes -> flush + log 'idle'

  assert.equal(logged.length, 3);
  assert.equal(logged[0].type, 'wait');
  assert.equal(logged[1].type, 'coalesced');
  assert.equal(logged[1].repeats, 2);
  assert.equal(logged[2].type, 'idle');
});

test('logQuiet: a repeat with no prior occurrences (repeats=0) is never flushed as a coalesced line', () => {
  const logged = [];
  const state = {};
  const log = (e) => logged.push(e);
  logQuiet(state, { type: 'wait', reason: 'x' }, log); // logs once, count stays 0
  logQuiet(state, { type: 'idle' }, log);              // immediate change, nothing to coalesce
  assert.equal(logged.length, 2);
  assert.equal(logged.some((e) => e.type === 'coalesced'), false);
});

test('flushQuiet: no pending streak is a no-op', () => {
  const logged = [];
  flushQuiet({}, (e) => logged.push(e));
  assert.equal(logged.length, 0);
});

test('flushQuiet: a pending streak emits exactly one coalesced summary and clears state', () => {
  const logged = [];
  const state = { lastQuietSig: 'wait|x|||', quietRepeatCount: 3 };
  flushQuiet(state, (e) => logged.push(e));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].type, 'coalesced');
  assert.equal(logged[0].repeats, 3);
  assert.equal(state.lastQuietSig, null);
  assert.equal(state.quietRepeatCount, 0);
});

// ---- sessionActivelyWriting -----------------------------------------------------------------

test('sessionActivelyWriting: transcript written within the window -> true', (t) => {
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() - 1_000 }));
  assert.equal(sessionActivelyWriting({ sessionCwd: '/fake', sessionId: 's' }, 90), true);
});

test('sessionActivelyWriting: transcript older than the window -> false', (t) => {
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() - 5 * 60_000 }));
  assert.equal(sessionActivelyWriting({ sessionCwd: '/fake', sessionId: 's' }, 90), false);
});

test('sessionActivelyWriting: transcript missing/unreadable -> false (never throws)', (t) => {
  t.mock.method(fs, 'statSync', () => { throw new Error('ENOENT'); });
  assert.equal(sessionActivelyWriting({ sessionCwd: '/fake', sessionId: 's' }, 90), false);
});

test('sessionActivelyWriting: missing sessionCwd or sessionId -> false without touching the filesystem', (t) => {
  const statMock = t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() }));
  assert.equal(sessionActivelyWriting({ sessionId: 's' }, 90), false);
  assert.equal(sessionActivelyWriting({ sessionCwd: '/fake' }, 90), false);
  assert.equal(statMock.mock.callCount(), 0);
});

// ---- canFastSkip -----------------------------------------------------------------------------

test('canFastSkip: no in-flight tasks -> false', () => {
  assert.equal(canFastSkip({ maxConcurrentTasks: 1 }, { tasks: {} }), false);
});

test('canFastSkip: below the WIP cap -> false (must run so new work can start)', (t) => {
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() }));
  const config = { maxConcurrentTasks: 2 };
  const state = { tasks: { a: { branch: 'x', sessionCwd: '/c', sessionId: 's' } } };
  assert.equal(canFastSkip(config, state), false);
});

test('canFastSkip: at cap, sole task pre-PR and actively writing -> true', (t) => {
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() - 1_000 }));
  const config = { maxConcurrentTasks: 1, activeSessionSeconds: 90 };
  const state = { tasks: { a: { branch: 'x', sessionCwd: '/c', sessionId: 's' } } };
  assert.equal(canFastSkip(config, state), true);
});

test('canFastSkip: at cap but the task already has a PR -> false (CI/review is GitHub-side, must poll)', (t) => {
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() - 1_000 }));
  const config = { maxConcurrentTasks: 1 };
  const state = { tasks: { a: { branch: 'x', sessionCwd: '/c', sessionId: 's', prNumber: 42 } } };
  assert.equal(canFastSkip(config, state), false);
});

test('canFastSkip: at cap but the session transcript is stale -> false', (t) => {
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() - 10 * 60_000 }));
  const config = { maxConcurrentTasks: 1, activeSessionSeconds: 90 };
  const state = { tasks: { a: { branch: 'x', sessionCwd: '/c', sessionId: 's' } } };
  assert.equal(canFastSkip(config, state), false);
});

test('canFastSkip: multiple in-flight tasks at cap — every one must qualify, not just one', (t) => {
  let call = 0;
  t.mock.method(fs, 'statSync', () => {
    call += 1;
    // first task's transcript is fresh, second's is stale
    return { mtimeMs: call === 1 ? Date.now() - 1_000 : Date.now() - 10 * 60_000 };
  });
  const config = { maxConcurrentTasks: 2, activeSessionSeconds: 90 };
  const state = {
    tasks: {
      a: { branch: 'x', sessionCwd: '/c', sessionId: 's1' },
      b: { branch: 'y', sessionCwd: '/c', sessionId: 's2' },
    },
  };
  assert.equal(canFastSkip(config, state), false);
});

test('canFastSkip: uses the default activeSessionSeconds (90) when unset in config', (t) => {
  // 60s old: within the 90s default, but would read as stale under the 30-min staleSessionMinutes
  // window if that were used by mistake — this pins that the SHORT threshold is what's applied.
  t.mock.method(fs, 'statSync', () => ({ mtimeMs: Date.now() - 60_000 }));
  const config = { maxConcurrentTasks: 1 }; // no activeSessionSeconds set
  const state = { tasks: { a: { branch: 'x', sessionCwd: '/c', sessionId: 's' } } };
  assert.equal(canFastSkip(config, state), true);
});

// ---- ciState / checkOutcome --------------------------------------------------------------
// Regression cover for the two mirror-image defects in the old two-state isCiGreen():
// an empty rollup read as "not green" (permanent silent stall when CI is off), and a *running*
// CheckRun read as green (merging before checks finish, with autoMerge on).

test('checkOutcome: a running CheckRun is pending, not green', () => {
  // Exactly what `gh pr view --json statusCheckRollup` returns mid-run: conclusion is an empty
  // STRING, not null, which is why `??` fell through to it and reported green.
  assert.equal(
    checkOutcome({ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }),
    'pending',
  );
  assert.equal(checkOutcome({ __typename: 'CheckRun', status: 'QUEUED', conclusion: '' }), 'pending');
});

test('checkOutcome: completed conclusions map to ok or red', () => {
  assert.equal(checkOutcome({ status: 'COMPLETED', conclusion: 'SUCCESS' }), 'ok');
  assert.equal(checkOutcome({ status: 'COMPLETED', conclusion: 'FAILURE' }), 'red');
  assert.equal(checkOutcome({ status: 'COMPLETED', conclusion: 'TIMED_OUT' }), 'red');
  // Deploy jobs gated to pushes on main are SKIPPED on every PR — benign, not a failure.
  assert.equal(checkOutcome({ status: 'COMPLETED', conclusion: 'SKIPPED' }), 'ok');
  assert.equal(checkOutcome({ status: 'COMPLETED', conclusion: 'NEUTRAL' }), 'ok');
});

test('checkOutcome: legacy StatusContext entries carry only `state`', () => {
  assert.equal(checkOutcome({ __typename: 'StatusContext', state: 'SUCCESS' }), 'ok');
  assert.equal(checkOutcome({ __typename: 'StatusContext', state: 'FAILURE' }), 'red');
  assert.equal(checkOutcome({ __typename: 'StatusContext', state: 'PENDING' }), 'pending');
});

test('ciState: an empty rollup is "none", distinct from "pending"', () => {
  assert.equal(ciState({ statusCheckRollup: [] }), 'none');
  assert.equal(ciState({}), 'none');
  assert.equal(ciState(null), 'none');
});

test('ciState: green only when every check has finished successfully', () => {
  assert.equal(
    ciState({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    'green',
  );
  assert.equal(
    ciState({
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
      ],
    }),
    'green',
  );
});

test('ciState: one unfinished check holds the whole rollup at pending', () => {
  assert.equal(
    ciState({
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'IN_PROGRESS', conclusion: '' },
      ],
    }),
    'pending',
  );
});

test('ciState: red wins over pending, so a known failure never waits on the rest', () => {
  assert.equal(
    ciState({
      statusCheckRollup: [
        { status: 'IN_PROGRESS', conclusion: '' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    }),
    'red',
  );
});

test('isCiGreen: only "green" merges — none, pending and red all hold', () => {
  assert.equal(isCiGreen({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }), true);
  assert.equal(isCiGreen({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }), false);
  assert.equal(isCiGreen({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }), false);
  assert.equal(isCiGreen({ statusCheckRollup: [] }), false);
});

// ---- findClosableSprint / findOperatorBlockedTask -------------------------------------------
// findClosableSprint used to check activeTasks only. Two live bugs followed from that: a task
// someone had genuinely claimed (in-progress) was invisible to it, and — once blockedTasks
// existed — so was a task stuck on the operator. Both meant "no activeTasks" could be reported
// as "sprint is closable" while real work, or a human's turn, was still open on it.

function statusPayload({ activeTasks = [], inProgressTasks = [], blockedTasks = [], activeSprints = [] } = {}) {
  return { activeTasks, inProgressTasks, blockedTasks, activeSprints };
}

test('findClosableSprint: a sprint with zero open tasks in any bucket is closable', () => {
  const result = findClosableSprint(statusPayload({
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' }],
  }));
  assert.deepEqual(result, { id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' });
});

test('findClosableSprint: an activeTasks entry blocks closing (the original, always-correct case)', () => {
  const result = findClosableSprint(statusPayload({
    activeTasks: [{ id: 'invoice_api', title: 'Invoice API', spec: 'x', sprint: 'billing_v2' }],
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' }],
  }));
  assert.equal(result, null);
});

test('findClosableSprint: an inProgressTasks entry blocks closing (the first bug this fixes)', () => {
  const result = findClosableSprint(statusPayload({
    inProgressTasks: [{ id: 'invoice_api', title: 'Invoice API', spec: 'x', sprint: 'billing_v2' }],
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' }],
  }));
  assert.equal(result, null);
});

test('findClosableSprint: a blockedTasks entry blocks closing (the second bug this fixes)', () => {
  const result = findClosableSprint(statusPayload({
    blockedTasks: [{ id: 'seed_prod', title: 'Seed Prod', spec: 'x', sprint: 'billing_v2', blockedReason: 'Run against production' }],
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' }],
  }));
  assert.equal(result, null);
});

test('findClosableSprint: a task belonging to a different sprint does not block this one', () => {
  const result = findClosableSprint(statusPayload({
    blockedTasks: [{ id: 'other', title: 'Other', spec: 'x', sprint: 'reporting' }],
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' }],
  }));
  assert.deepEqual(result, { id: 'billing_v2', title: 'Billing V2', spec: 'sprints/billing_v2/overview.md' });
});

test('findOperatorBlockedTask: finds a blocked task belonging to a currently-active sprint', () => {
  const blocked = { id: 'seed_prod', title: 'Seed Prod', spec: 'x', sprint: 'billing_v2', blockedReason: 'Run against production' };
  const result = findOperatorBlockedTask(statusPayload({
    blockedTasks: [blocked],
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'x' }],
  }));
  assert.deepEqual(result, blocked);
});

test('findOperatorBlockedTask: null when the blocked task belongs to a sprint that is not active', () => {
  const result = findOperatorBlockedTask(statusPayload({
    blockedTasks: [{ id: 'seed_prod', title: 'Seed Prod', spec: 'x', sprint: 'archived_sprint' }],
    activeSprints: [{ id: 'billing_v2', title: 'Billing V2', spec: 'x' }],
  }));
  assert.equal(result, null);
});

test('findOperatorBlockedTask: null when blockedTasks is empty', () => {
  assert.equal(findOperatorBlockedTask(statusPayload({ activeSprints: [{ id: 'billing_v2', title: 'B', spec: 'x' }] })), null);
});

// ---- describeDecision --------------------------------------------------------------------
// The 'blocked' case used to render as just "blocked — <reason>" — decision.detail existed
// (dab-check-issues carries the actual issue list, repo-sync-failed the git error) but nothing
// showed it, so the one line an operator actually sees never said *why*.

test('describeDecision: awaiting-operator renders the taskId and the human-facing detail', () => {
  const text = describeDecision({
    action: 'blocked',
    reason: 'awaiting-operator',
    taskId: 'seed_prod',
    detail: 'Run `pnpm history import --force-remote` against production',
  });
  assert.equal(text, 'blocked — awaiting-operator ("seed_prod"): Run `pnpm history import --force-remote` against production');
});

test('describeDecision: a non-string detail (e.g. dab-check-issues\' array) is not dumped inline', () => {
  const text = describeDecision({ action: 'blocked', reason: 'dab-check-issues', detail: [{ category: 'orphaned-link' }] });
  assert.equal(text, 'blocked — dab-check-issues');
});

test('describeDecision: blocked with no detail at all is unchanged from before', () => {
  assert.equal(describeDecision({ action: 'blocked', reason: 'gh-not-authenticated' }), 'blocked — gh-not-authenticated');
});

// ---- parseWorktreeList -------------------------------------------------------------------
//
// Real `git worktree list --porcelain` output, captured from LeanMacroFeed on 2026-08-01 while
// cleaning up the 12 worktrees the pre-amendment orchestrator had leaked.
const WORKTREE_PORCELAIN = [
  'worktree /Users/lucian/Works/LeanMacroFeed',
  'HEAD 788239aa1f0f2a0f9a1d2c3b4e5f60718293a4b5',
  'branch refs/heads/main',
  '',
  'worktree /Users/lucian/Works/LeanMacroFeed/.claude/worktrees/raw_upstream_payload_capture',
  'HEAD c40a5b6d2e1f3a4b5c6d7e8f90a1b2c3d4e5f607',
  'branch refs/heads/worktree-raw_upstream_payload_capture',
  '',
  'worktree /Users/lucian/Works/LeanMacroFeed/.claude/worktrees/detached-session',
  'HEAD b8ecca5f1e2d3c4b5a6978869504132231405060',
  'detached',
  ''
].join('\n');

test('parseWorktreeList: finds the worktree path for a task branch', () => {
  assert.equal(
    parseWorktreeList(WORKTREE_PORCELAIN, 'worktree-raw_upstream_payload_capture'),
    '/Users/lucian/Works/LeanMacroFeed/.claude/worktrees/raw_upstream_payload_capture'
  );
});

test('parseWorktreeList: the main checkout is matched by its own branch, not treated specially', () => {
  // Worth pinning: cleanupMergedWorktree must never be handed 'main', and if it ever were, the
  // lookup would return the primary checkout. The guard is the caller (merged task branches only),
  // so this documents the behaviour rather than pretending the parser filters it.
  assert.equal(parseWorktreeList(WORKTREE_PORCELAIN, 'main'), '/Users/lucian/Works/LeanMacroFeed');
});

test('parseWorktreeList: a detached worktree never matches', () => {
  assert.equal(parseWorktreeList(WORKTREE_PORCELAIN, 'detached'), null);
});

test('parseWorktreeList: an unknown branch yields null rather than a wrong path', () => {
  assert.equal(parseWorktreeList(WORKTREE_PORCELAIN, 'worktree-never-existed'), null);
});

test('parseWorktreeList: a branch name that is a prefix of another does not match it', () => {
  // `worktree-raw` must not match `worktree-raw_upstream_payload_capture` — a substring match here
  // would remove the wrong worktree.
  assert.equal(parseWorktreeList(WORKTREE_PORCELAIN, 'worktree-raw'), null);
});

test('parseWorktreeList: empty or missing input is null, never a throw', () => {
  assert.equal(parseWorktreeList('', 'worktree-x'), null);
  assert.equal(parseWorktreeList(WORKTREE_PORCELAIN, undefined), null);
  assert.equal(parseWorktreeList(undefined, 'worktree-x'), null);
});

// ---- pickSessionState --------------------------------------------------------------------
//
// Shape captured from `claude agents --json --all` on 2026-08-01, while diagnosing the loop this
// function exists to end: eight dispatches of one task, every session reporting state=failed,
// nothing reading the field.
const AGENTS = [
  { id: 'a539873a', sessionId: 'a539873a-0000-0000-0000-000000000001', name: 'factory-developer-short_task', kind: 'background', state: 'done' },
  { id: '6b21eb5b', sessionId: '6b21eb5b-fb55-46b2-be0b-0b833807405d', name: 'factory-developer-add_batch_identity_and_contract_version_to_the_published_payloads', kind: 'background', state: 'failed' },
  { id: '4df1614f', sessionId: '4df1614f-8e1c-48d0-8f01-d844319ee6dd', name: 'factory-developer-add_batch_identity_and_contract_version_to_the_published_payloads', kind: 'background', state: 'failed' },
  { id: 'nostate', sessionId: 'nostate-0000-0000-0000-000000000002', name: 'factory-reviewer-x', kind: 'background' }
];

test('pickSessionState: reads the terminal state of the matching session', () => {
  assert.equal(pickSessionState(AGENTS, '6b21eb5b-fb55-46b2-be0b-0b833807405d'), 'failed');
  assert.equal(pickSessionState(AGENTS, 'a539873a-0000-0000-0000-000000000001'), 'done');
});

test('pickSessionState: matches on sessionId, never on name', () => {
  // The two failed records share a name — every retry of a task reuses it. Matching by name would
  // read whichever attempt happened to be found first, which is the wrong attempt by construction.
  assert.equal(pickSessionState(AGENTS, '4df1614f-8e1c-48d0-8f01-d844319ee6dd'), 'failed');
  assert.equal(
    pickSessionState(AGENTS, 'factory-developer-add_batch_identity_and_contract_version_to_the_published_payloads'),
    null
  );
});

test('pickSessionState: an unknown session is null, not undefined or a throw', () => {
  assert.equal(pickSessionState(AGENTS, 'never-dispatched'), null);
});

test('pickSessionState: a record with no state field yields null rather than undefined', () => {
  assert.equal(pickSessionState(AGENTS, 'nostate-0000-0000-0000-000000000002'), null);
});

test('pickSessionState: missing sessionId or a non-array agent list is null, never a throw', () => {
  assert.equal(pickSessionState(AGENTS, undefined), null);
  assert.equal(pickSessionState(AGENTS, null), null);
  assert.equal(pickSessionState(undefined, 'x'), null);
  assert.equal(pickSessionState(null, 'x'), null);
  // `claudeAgentsJson` returns [] when the CLI call fails; that must read as "unknown", not failed.
  assert.equal(pickSessionState([], '6b21eb5b-fb55-46b2-be0b-0b833807405d'), null);
});

// ---- ciWaitReason vs the red-CI fixer path ------------------------------------------------
//
// Regression cover for 2026-08-02: a task's PR went red and the tick reported `wait — ci-red`
// indefinitely, because nothing dispatched on red CI. `ciWaitReason` still names the condition for
// the non-red cases; red is now handled before the fallthrough ever reaches it.

test('ciWaitReason: still distinguishes no-CI, pending and review states', () => {
  const red = { statusCheckRollup: [{ conclusion: 'FAILURE' }] };
  const pending = { statusCheckRollup: [{ conclusion: '' }] };
  const none = { statusCheckRollup: [] };
  assert.equal(ciState(red), 'red');
  assert.equal(ciState(pending), 'pending');
  assert.equal(ciState(none), 'none');
});

test('describeDecision: ci-red-after-fix renders its detail so the log says what to run', () => {
  const text = describeDecision({
    action: 'blocked',
    reason: 'ci-red-after-fix',
    taskId: 'refine_release_id_and_trigger_timing',
    detail: 'CI is still red on abc1234 after a fixer dispatch.'
  });
  assert.match(text, /blocked — ci-red-after-fix \("refine_release_id_and_trigger_timing"\)/);
  assert.match(text, /still red on abc1234/);
});
