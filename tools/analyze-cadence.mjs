#!/usr/bin/env node
// Phase 0 of RFC 003 (dab/backlog/rfcs/rfc_003_event_driven_ticks.md): attribute a task's wall-clock
// to agent-active time vs. wait-on-something time, purely by reading the orchestrator's own
// decision log. Read-only — never touches state.json, never dispatches anything.
// Usage: node tools/analyze-cadence.mjs <repoConfigName> [taskId]
//
// Caveat: this can't distinguish "genuinely waiting on GitHub (CI/review)" from "the change
// already happened but the next tick hasn't run yet to notice it" — both show up as a 'wait'
// entry. So "tick-wait %" below is an UPPER BOUND on what a faster/event-driven cadence could
// shave off a task's wall-clock, not a precise measurement of tick-scheduling latency alone.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FACTORY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [, , repo, filterTaskId] = process.argv;
if (!repo) {
  console.error('Usage: node tools/analyze-cadence.mjs <repoConfigName> [taskId]');
  process.exit(1);
}

const logPath = path.join(FACTORY_DIR, 'logs', `${repo}.jsonl`);
if (!fs.existsSync(logPath)) {
  console.error(`No log found at ${logPath}`);
  process.exit(1);
}
const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 'coalesced' summary lines (see logQuiet/flushQuiet in orchestrator.mjs) don't carry taskId
// directly — recover it from the sig they summarize (quietSig format: type|reason|taskId|prNumber|message).
function taskIdOf(entry) {
  if (entry.taskId) return entry.taskId;
  if (entry.type === 'coalesced' && entry.of) return entry.of.split('|')[2] || null;
  return null;
}

// Each line "occupies" the wall-clock from its own timestamp to the next line's timestamp —
// true whether the line is a real transition or the first occurrence of a coalesced quiet state.
// A 'coalesced' summary line's own timestamp is essentially the moment the state changed away,
// so it doesn't introduce a distinct interval of its own; it just confirms the repeat count.
const events = lines.map((e, i) => ({
  ...e,
  taskId: taskIdOf(e),
  durationMs: i + 1 < lines.length ? new Date(lines[i + 1].timestamp).getTime() - new Date(e.timestamp).getTime() : null,
}));

const WAIT_TYPES = new Set(['wait', 'would-merge', 'blocked', 'coalesced']);
const ACTIVE_TYPES = new Set(['dispatch', 'skipped-dispatch', 'would-dispatch']);
const TERMINAL_TYPES = new Set(['merged', 'reconciled-merged']);

function summarize(taskId) {
  // Include this task's own lines, plus global lines with no taskId (idle/blocked/gh-not-authenticated/
  // budget-exceeded) that stall every task's progress, not just this one.
  const relevant = events.filter((e) => e.taskId === taskId || (!e.taskId && WAIT_TYPES.has(e.type)));
  if (relevant.length === 0) {
    console.log(`No log entries found for taskId "${taskId}".`);
    return;
  }

  let activeMs = 0, waitMs = 0, otherMs = 0;
  const rows = [];
  for (const e of relevant) {
    const dur = e.durationMs ?? 0;
    let bucket = 'other';
    if (ACTIVE_TYPES.has(e.type)) { bucket = 'agent-active'; activeMs += dur; }
    else if (WAIT_TYPES.has(e.type)) { bucket = 'tick-wait'; waitMs += dur; }
    else if (TERMINAL_TYPES.has(e.type)) { bucket = 'terminal'; }
    else { otherMs += dur; }
    rows.push({
      ts: e.timestamp,
      type: e.type,
      reason: e.reason ?? e.of ?? '',
      durationMin: (dur / 60000).toFixed(1),
      bucket,
    });
  }

  console.log(`\n=== Task "${taskId}" ===`);
  console.table(rows);

  const totalMs = activeMs + waitMs + otherMs;
  const pct = (ms) => (totalMs > 0 ? ((ms / totalMs) * 100).toFixed(0) : '0');
  console.log(`Total tracked span: ${(totalMs / 60000).toFixed(1)} min`);
  console.log(`  agent-active (dispatched / session presumed running): ${(activeMs / 60000).toFixed(1)} min (${pct(activeMs)}%)`);
  console.log(`  tick-wait (upper bound — CI/review wait AND/OR next-tick latency): ${(waitMs / 60000).toFixed(1)} min (${pct(waitMs)}%)`);
  console.log(`  other/unclassified: ${(otherMs / 60000).toFixed(1)} min (${pct(otherMs)}%)`);
}

if (filterTaskId) {
  summarize(filterTaskId);
} else {
  const taskIds = [...new Set(events.map((e) => e.taskId).filter(Boolean))];
  if (taskIds.length === 0) {
    console.log(`No task-scoped entries in ${repo}'s log yet.`);
  } else {
    console.log(`Tasks found in ${repo}'s log: ${taskIds.join(', ')}`);
    for (const id of taskIds) summarize(id);
  }
}
