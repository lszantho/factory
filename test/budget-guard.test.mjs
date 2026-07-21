// Unit tests for budget-guard.mjs's dispatch-rate cap.
// Run with: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneDispatchTimestamps, budgetStatus, recordDispatch } from '../budget-guard.mjs';

test('pruneDispatchTimestamps: drops timestamps outside the window, keeps ones inside it', () => {
  const now = Date.now();
  const state = { dispatchTimestamps: [now - 10_000, now - 1_000] };
  pruneDispatchTimestamps(state, 5_000);
  assert.deepEqual(state.dispatchTimestamps, [now - 1_000]);
});

test('pruneDispatchTimestamps: handles a state with no dispatchTimestamps yet', () => {
  const state = {};
  pruneDispatchTimestamps(state, 5_000);
  assert.deepEqual(state.dispatchTimestamps, []);
});

test('budgetStatus: allowed while strictly under the cap', () => {
  const state = { dispatchTimestamps: [] };
  const config = { budget: { maxDispatchesPerWindow: 2, windowMinutes: 5 } };
  const status = budgetStatus(state, config);
  assert.equal(status.allowed, true);
  assert.equal(status.count, 0);
  assert.equal(status.cap, 2);
});

test('budgetStatus: blocked once the count reaches the cap', () => {
  const now = Date.now();
  const state = { dispatchTimestamps: [now, now, now] };
  const config = { budget: { maxDispatchesPerWindow: 3, windowMinutes: 5 } };
  const status = budgetStatus(state, config);
  assert.equal(status.allowed, false); // count(3) < cap(3) is false -> blocked at the boundary
  assert.equal(status.count, 3);
});

test('budgetStatus: defaults to cap 8 / 300min window when config.budget is absent', () => {
  const status = budgetStatus({}, {});
  assert.equal(status.cap, 8);
  assert.equal(status.allowed, true);
});

test('recordDispatch: appends a timestamp to a fresh state', () => {
  const state = {};
  recordDispatch(state);
  assert.equal(state.dispatchTimestamps.length, 1);
  assert.equal(typeof state.dispatchTimestamps[0], 'number');
});

test('recordDispatch + budgetStatus: cap trips after exactly maxDispatchesPerWindow dispatches', () => {
  const state = {};
  const config = { budget: { maxDispatchesPerWindow: 2, windowMinutes: 5 } };
  assert.equal(budgetStatus(state, config).allowed, true);
  recordDispatch(state);
  assert.equal(budgetStatus(state, config).allowed, true);
  recordDispatch(state);
  assert.equal(budgetStatus(state, config).allowed, false);
});
