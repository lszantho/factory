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
