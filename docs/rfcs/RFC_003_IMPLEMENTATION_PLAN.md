# RFC 003 — Implementation plan

Companion to [RFC 003: Tick cadence](RFC_003_EVENT_DRIVEN_TICKS.md). This is the concrete build plan: exact files, functions, config, and code sketches, phased so the cheap high-confidence work lands first and the event-driven machinery is gated behind a measurement.

**Guiding order (from the RFC):** measure → cheap path (dedup + heartbeat + fail-fast + faster interval) → *only if needed* event-driven triggers. Phases 0–1 are do-regardless; Phase 2 is conditional on Phase 0's data.

---

## Phase 0 — Measurement (decides whether Phase 2 is ever built)

**Goal:** attribute one real end-to-end task's wall-clock to *agent work* / *CI wait* / *tick-wait*, to answer "is the fixed interval actually the bottleneck?"

### 0.1 New: `tools/analyze-cadence.mjs`

Reads `logs/<repo>.jsonl`, reconstructs each task's timeline from the transition events (`dispatch`, `wait` reasons, `merged`, …) and reports per-stage durations.

- Input: `node tools/analyze-cadence.mjs <repo> [taskId]`.
- Group log entries by `taskId`; within a task, compute deltas between successive transition timestamps.
- Classify each gap:
  - `dispatch(dev) → dispatch(reviewer)` = dev work + CI + tick-wait to first review.
  - `wait:no-pr-yet` runs = time PR didn't exist yet (dev still working).
  - first `wait` with CI-pending vs. the `dispatch(reviewer)` = CI-wait + tick-wait.
  - `dispatch(reviewer) → merged` = review + merge latency.
- Output a table per task and an aggregate: **% of wall-clock spent in `wait` states that a faster tick would have shortened.**

This is most useful *after* Phase 1's transition-only log (below) exists, so the timeline is clean. Runs fine on the current noisy log too (just filter to transition types).

**Decision gate:** if tick-wait is a small fraction of task wall-clock, ship Phase 1 and stop. If sub-minute latency demonstrably matters, proceed to Phase 2.

---

## Phase 1 — Cheap path (do regardless)

All in `orchestrator.mjs` + the plist. No new services, no network trigger. Makes a fast cadence *cheap* (fail-fast) and *quiet* (transition-only log), then turns the cadence up.

### 1.1 Heartbeat + transition-only logging

**Problem:** `logDecision` ([orchestrator.mjs:54](../../orchestrator.mjs)) appends + `console.log`s on *every* tick, so a fast cadence buries transitions under `wait`/`idle` heartbeats.

**State additions** (in `state.json`, initialized in `loadState` default):
- `lastTickAt` — ISO timestamp, written every tick.
- `lastQuietSig` — signature of the last suppressed-duplicate decision.
- `quietRepeatCount` — how many identical quiet ticks have been coalesced.

**New helpers:**

```js
function quietSig(entry) {
  return `${entry.type}|${entry.reason ?? ''}|${entry.taskId ?? ''}`;
}

// Dedupe no-op outcomes (wait/idle/skipped/would-*). Logs the first occurrence,
// coalesces repeats into quietRepeatCount instead of a new line.
function logQuiet(state, entry) {
  const sig = quietSig(entry);
  if (state.lastQuietSig === sig) {
    state.quietRepeatCount = (state.quietRepeatCount ?? 0) + 1;
    return;
  }
  // Transitioning to a new quiet state: close out the previous run if it repeated.
  if (state.lastQuietSig && state.quietRepeatCount > 0) {
    logDecision({ type: 'coalesced', of: state.lastQuietSig, repeats: state.quietRepeatCount });
  }
  state.lastQuietSig = sig;
  state.quietRepeatCount = 0;
  logDecision(entry);
}
```

**Wiring in `main()`:**
- Convert `wait`, `idle`, `skipped-dispatch`, `would-merge`, `would-dispatch` log calls to `logQuiet(state, …)`.
- Keep `dispatch`, `merged`, `reconciled-merged`, `blocked`, `error` on `logDecision` (always visible) — and reset the quiet run when one fires: set `state.lastQuietSig = null` right after (so a later identical quiet logs fresh, and any pending coalesced-count is flushed by the next `logQuiet`). Simplest: call a tiny `flushQuiet(state)` before real logs.
- **Guarantee the heartbeat on every exit path.** Several early returns (`!ghAuthOk`, `syncTargetRepo` fail) don't `saveState` today. Refactor `main()` body into `try { … } finally { state.lastTickAt = new Date().toISOString(); saveState(state); }` and drop the scattered `saveState` calls. Idempotent and guarantees `lastTickAt` + coalesced counts always persist.

**Liveness read:** `--status` / the UI can show `lastTickAt` so "is the loop alive / when did it last run" needs no log line. (Small addition to `renderStatusJson`.)

### 1.2 Fail-fast pre-check (skip the expensive path while an agent works)

**Problem:** while a developer session is actively working and hasn't opened a PR, the tick's `gh auth status` + `git fetch` + `dab check` + `gh pr list` are guaranteed to find nothing new — pure waste at a fast cadence.

**Record the session cwd at dispatch** (needed to stat the transcript without spawning `claude`):
- `dispatch()` already resolves `spawned` from `claude agents --json`; return its cwd:
  `return { dispatched: true, sessionId: spawned?.sessionId, cwd: spawned?.cwd, pid: spawned?.pid };`
- In `main()`'s dispatch path, store it: `task.sessionCwd = result.cwd;`

**Config:** add `activeSessionSeconds` (default **90**) to `configs/<repo>.json`. Distinct from `staleSessionMinutes` (30) — see the RFC's two-thresholds table; this one must be *short*.

**New helpers:**

```js
// Direct transcript stat — no `claude agents --json` subprocess, no network.
function sessionActivelyWriting(task, seconds) {
  if (!task.sessionCwd || !task.sessionId) return false;
  try {
    const { mtimeMs } = fs.statSync(sessionTranscriptPath(task.sessionCwd, task.sessionId));
    return Date.now() - mtimeMs < seconds * 1000;
  } catch {
    return false; // transcript missing/unreadable → not provably active → run the full tick
  }
}

// True only when nothing could have changed since last tick AND we can't start new work:
// at the WIP cap, and every in-flight task is pre-PR with an actively-writing session.
function canFastSkip(config, state) {
  const inFlight = Object.keys(state.tasks).filter((id) => state.tasks[id].branch);
  const wip = config.maxConcurrentTasks ?? 1;
  if (inFlight.length < wip) return false; // room to start new work → must run decide()
  const T = config.activeSessionSeconds ?? 90;
  return inFlight.length > 0 && inFlight.every((id) => {
    const t = state.tasks[id];
    return !t.prNumber && sessionActivelyWriting(t, T);
  });
}
```

**Wiring:** at the very top of `main()`, after `loadState`, before `ghAuthOk`:

```js
if (canFastSkip(config, state)) {
  logQuiet(state, { type: 'wait', reason: 'session-active-no-pr' });
  return; // finally-block persists heartbeat
}
```

**Correctness notes (mirror in a code comment):**
- Relies on `task.prNumber`, which `inFlightAction` sets once a PR is first seen ([orchestrator.mjs:322](../../orchestrator.mjs)). Pre-PR it's unset → eligible to skip; once a PR exists it's set forever → never skip (CI/review are GitHub-side, must poll).
- Self-correcting: when the dev finishes and the transcript goes quiet for `T` seconds, `sessionActivelyWriting` flips false → next tick runs fully → finds the PR within ~`T` of completion.
- Only ever fast-skips **at the WIP cap**; under the cap it always runs `decide()` so new work can start. Safe for `maxConcurrentTasks > 1`.
- First tick after dispatch (transcript not yet created) → `false` → full tick; harmless.

### 1.3 (Optional) Cheaper idle ticks — lazy `gh auth status`

`gh auth status` is the one GitHub API call on *every* tick, including idle ones (O5). Make it lazy: cache success in `state.lastAuthOkAt` and re-verify only every N minutes (config `authRecheckMinutes`, default 30) or on a real `gh` auth failure. Drops idle-tick API cost to ~0. Low priority; include if idle polling proves noisy.

### 1.4 Turn up the cadence (plist)

`~/Library/LaunchAgents/com.lucian.leanmacrofeed-factory.plist`: change `StartInterval` `900` → **`60`** (or `120`), then `launchctl unload -w … && launchctl load -w …`. launchd single-instances the job (no overlapping ticks), and 1.2 makes mid-flight ticks nearly free.

### Phase 1 verification
- Dispatch one real task; confirm the JSONL shows a clean `dispatch → (coalesced wait) → dispatch-reviewer → merged` timeline, not a wall of `wait`s.
- Confirm mid-flight ticks log `wait:session-active-no-pr` once (coalesced) and make **no** `gh`/`git` calls (watch with `--status` and/or a `gh api` rate-limit before/after check).
- Confirm the PR is picked up within ~`activeSessionSeconds` of the dev session going quiet.
- Confirm no double-dispatch and `budget-guard` still bounds spend (O7 — cap hits sooner in wall-clock, same total).

---

## Phase 2 — Event-driven triggers (only if Phase 0 says sub-minute latency matters)

Adds a push signal for the window fail-fast can't help: an agent finishing → fire the *next* tick in seconds. Touches `orchestrator.mjs` (env), `server.mjs` (coalescing endpoint), the target repo's Claude settings (Stop hook), and launchd.

### 2.1 Pass `FACTORY_REPO` to dispatched agents

`dispatch()` env → add `FACTORY_REPO: repoConfigName` alongside `FACTORY_DISPATCH: '1'` so one hook serves any repo:

```js
env: { ...process.env, FACTORY_DISPATCH: '1', FACTORY_REPO: repoConfigName, ...reviewerGhEnv(config, role) }
```

### 2.2 Coalescing trigger endpoint (`server.mjs`)

Replace the single `tickInProgress` boolean ([server.mjs:21](../../server.mjs)) with **per-repo** run/rerun tracking so a hit during a running tick queues *exactly one* follow-up (a dropped trigger = a dropped transition):

```js
const running = new Set();   // repos with a tick in flight
const rerun   = new Set();   // repos that got a trigger while running
const DEBOUNCE_MS = 1500;

function runTick(repo) {
  if (running.has(repo)) { rerun.add(repo); return; }
  running.add(repo);
  const child = spawn(config.paths.node, [orchestratorPath, repo], { cwd: FACTORY_DIR, env: { ...process.env } });
  child.on('close', () => {
    running.delete(repo);
    if (rerun.delete(repo)) setTimeout(() => runTick(repo), DEBOUNCE_MS);
  });
}
```

- New route `POST /api/trigger/:repo` → validate repo, respond `202` immediately (fire-and-forget), then `setTimeout(() => runTick(repo), DEBOUNCE_MS)` (debounce absorbs bursts).
- Route the existing `POST /api/tick` (UI, SSE) and launchd through the **same** `running`/`rerun` lock so hook + button + timer never clobber `state.json`. (Keep the SSE stream for the UI; just gate entry on the lock.)
- Per-repo, not global (O7): two repos' ticks may run concurrently, but never two of the same repo.

### 2.3 Stop hook (target repo)

In `LeanMacroFeed/.claude/settings.json` (gated on `FACTORY_DISPATCH`, so inert for interactive sessions):

```jsonc
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "[ \"$FACTORY_DISPATCH\" = \"1\" ] && curl -s -m 2 -X POST http://127.0.0.1:3141/api/trigger/$FACTORY_REPO >/dev/null 2>&1; true"
      }]
    }]
  }
}
```

- Alternative if we don't want it in the repo's committed settings: dispatch with `--settings <factory-hooks.json>` pointing at a factory-owned file. Decide during build.
- **Blocking prerequisite (O1):** confirm `Stop` actually fires for `--bg`/headless sessions before relying on it. Quick test: dispatch a trivial agent, watch for the curl hit in the server log. If it doesn't fire, fall back to a transcript-idle watcher or `gh pr checks --watch` (2.5b).

### 2.4 Server as a managed service + launchd re-role

The hook needs the server up. Add a `KeepAlive` plist for `server.mjs`. Then:
- Factory plist `ProgramArguments` → `curl -s -X POST http://127.0.0.1:3141/api/trigger/leanmacrofeed` instead of invoking node directly (all triggers share the lock).
- Lengthen its `StartInterval` back to a **safety-net / CI-poll cadence** (e.g. 120–180 s): with Stop-hooks handling local transitions, launchd only needs to catch the remote CI-green gate and recover missed events.
- **Fallback story (O3-server):** if the server is down, the hook curl fails silently. `KeepAlive` should keep it up; decide whether the launchd curl should fall back to a direct `node orchestrator.mjs` on connection-refused (belt-and-suspenders) or rely on `KeepAlive`.

### 2.5 CI-green gate

The one transition no local Stop hook sees. Pick during build:
- **(a) Preferred:** the lengthened launchd interval (2.4) *is* the CI poll — cheapest, no code.
- **(b)** developer runs `gh pr checks <n> --watch` before finishing, so its Stop fires only once CI settles (fold remote → local); costs agent wall-clock, guard against a stuck CI hanging past `staleSessionMinutes`.
- **(c)** GitHub webhooks via a tunnel — deferred; likely over-engineering.

### Phase 2 verification
- One full autonomous cycle: verify a task advances stage-to-stage in **seconds** (agent Stop → tick), no `state.json` clobber under concurrent triggers, coalescing collapses bursts, and `budget-guard` still bounds spend at event pace (O7).

---

## File-by-file summary

| File | Phase | Change |
| --- | --- | --- |
| `tools/analyze-cadence.mjs` | 0 | **new** — attribute task wall-clock from the log |
| `orchestrator.mjs` | 1 | `quietSig`/`logQuiet`/`flushQuiet`; `try/finally` heartbeat; `sessionActivelyWriting`/`canFastSkip` + top-of-`main` guard; `dispatch()` returns `cwd`, stored as `task.sessionCwd`; (opt) lazy `gh auth status` |
| `configs/leanmacrofeed.json` | 1 | `activeSessionSeconds: 90` (+ opt `authRecheckMinutes`) |
| `…/com.lucian.leanmacrofeed-factory.plist` | 1 | `StartInterval` 900 → 60/120 |
| `orchestrator.mjs` | 2 | `FACTORY_REPO` in dispatch env |
| `server.mjs` | 2 | per-repo `running`/`rerun` coalescing; `POST /api/trigger/:repo`; route `/api/tick` + launchd through the lock |
| `LeanMacroFeed/.claude/settings.json` | 2 | `Stop` hook gated on `FACTORY_DISPATCH` |
| `com.lucian.leanmacrofeed-server.plist` | 2 | **new** — `KeepAlive` server; factory plist re-pointed to curl + longer interval |

## Open questions carried from the RFC (resolve as they come up)
- **O1** confirm `Stop` fires in `--bg` (blocks 2.3) · **O2** value of `activeSessionSeconds` · **O3** transcript-cwd == `spawned.cwd` for `--worktree` · **O4** any persona opens a PR mid-session (would break the pre-PR fail-fast assumption) · **O5** lazy auth · **O6** heartbeat location/read · **O7** budget at speed · **O8** launchd on battery/sleep.

## Commit sequencing (factory repo — no AI-authorship trailer)
1. Phase 1.1 log dedup + heartbeat (+ `try/finally`).
2. Phase 1.2 fail-fast (+ `dispatch` cwd, config field).
3. Phase 0 analyzer (can land alongside 1.1 since it reads the clean log).
4. Phase 1.4 plist cadence bump — *after* 1.1/1.2 are verified.
5. Phase 2 as a separate series, gated on the Phase 0 measurement.
