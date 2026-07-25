# RFC 003: Tick cadence — is faster polling good enough?

## Status

**Proposed — Phase 1 shipped, Phase 2 (event-driven Stop-hook) deferred.** The question this RFC answers is *sequencing*: before building any event-driven trigger machinery (hooks, webhooks, a coalescing server endpoint), establish whether simply **running the existing tick more often** — e.g. every minute instead of every 15 — is good enough, and what it actually costs. Faster polling is a one-line plist change with no new moving parts; the event-driven designs are only worth their complexity if this cheap option is shown to be inadequate. So this RFC leads with the cost analysis of frequent polling and treats event-driven triggering as one option the study may or may not reach for. **Phase 1 landed** (`f7a3dce`, `eec52d1`): quiet-tick log dedup + coalescing, a `state.lastTickAt` heartbeat, a fail-fast pre-check (`canFastSkip`) that skips a tick when every in-flight task is pre-PR and its session transcript is actively being written, `tools/analyze-cadence.mjs`, and the factory's first-ever tests. Phase 1.4 (actually bumping launchd's `StartInterval`) and Phase 2 remain deliberately deferred.

## Motivation

A tick is a single-shot reconcile: `sync → decide → one action → exit` ([orchestrator.mjs](../../orchestrator.mjs), [ADR 001](../architecture/adr/ADR_001_DETERMINISTIC_ORCHESTRATOR.md)). One task's lifecycle is a *chain*:

```
dispatch dev → dev opens PR → CI green → dispatch reviewer → review submitted → merge
```

Each tick advances the chain by one step, and today **every step waits for the next launchd fire** (`StartInterval: 900` = 15 min). A task needing minutes of real agent work can accrue ~5 × up-to-15-min of dead waiting. The cadence, not the work, is the rate limiter.

The obvious fix is *look more often*. The obvious worry is *what does looking more often cost — API rate limits, log spam, wasted work?* This RFC's job is to answer that worry with numbers, and only then decide whether the cheap fix suffices or the expensive (event-driven) one is justified.

## The central question

> **Is "waiting for the next tick" actually the dominant latency, and if we just tick every minute, does anything break or degrade?**

Three cost axes to settle, each a section below:

1. **API rate limits** — does 1 tick/min (or faster) risk throttling on GitHub / git / the `claude` CLI?
2. **Log noise** — frequent ticks bloat the audit trail with no-op heartbeats; how do we keep the log a log of *transitions*, not *polls*?
3. **Wasted work** — while an agent is mid-flight there is provably nothing to do; can a tick **fail fast** (bail before the expensive `gh`/`git`/`claude` calls) instead of doing the full reconcile every minute?

Only if faster polling is shown to be either insufficient (latency floor still too high) or wasteful in a way fail-fast can't fix do the event-driven options (§ Options 4–5) earn their keep.

## What one tick actually does

Grounded in the current code, here is every external call a single tick makes, with the classification that the rate-limit analysis needs. Steady state, `maxConcurrentTasks: 1`.

| Phase | Call | Cost class | When |
| --- | --- | --- | --- |
| `main` | `gh auth status` | **GitHub API** (token validation) | every tick |
| `main` | `git fetch origin` | git protocol (not REST) | every tick |
| `main` | `git merge --ff-only @{u}` | local | every tick |
| `decide` | `dab check --json` | local node subprocess (file IO) | every tick |
| `decide` in-flight loop | `findPrForBranch` → `gh pr list --state all` | **GitHub API** (GraphQL) | per tracked task w/ branch |
| `decide` in-flight loop | `latestRejectionTag` → `gh pr view --json reviews` | **GitHub API** (GraphQL) | only when changes-requested & unfixed |
| `decide` in-flight loop | `hasRunningSession` → `claude agents --json --all` | local subprocess (`claude` CLI) + `fs.stat` | only in the *no-PR-yet* path |
| `decide` | `dab status` | local node subprocess | when nothing in-flight acted |
| `decide` | `dab next` | local node subprocess | when nothing in-flight acted |
| `main` (merge action) | `gh pr merge --squash` | **GitHub API** (write) | only on a merge tick |

Net **GitHub API calls per tick**:

- **Idle** (no tracked task): **1** — just `gh auth status`.
- **In-flight, no PR yet**: **2** — `auth status` + `pr list` (plus one `claude agents --json` subprocess).
- **In-flight, PR open**: **2**, occasionally **3** (+ rejection tag).
- **Merge tick**: the above **+1 write**.

Plus exactly **1 git fetch** per tick. The `dab` calls and the `--ff-only` merge are local and don't count against any network budget.

## Cost analysis

### 1. API rate limits

**GitHub (primary).** An authenticated token gets **5,000 requests/hour** (REST) / **5,000 points/hour** (GraphQL); `gh pr list`/`pr view` are GraphQL (~1 point each).

| Cadence | Ticks/hr | GitHub API/hr (2–3 calls each) | % of 5,000 |
| --- | --- | --- | --- |
| 15 min (today) | 4 | ~8–12 | ~0.2% |
| **1 min** | **60** | **~120–180** | **~3%** |
| 10 s | 360 | ~720–1,080 | ~14–22% |

Even at one tick every 10 seconds we're well under budget. **Rate limit is not the constraint** for any cadence we'd plausibly want.

**GitHub secondary/abuse limits** — the ones that bite bursty automation — are ~2,000 GraphQL points/min and ≤100 concurrent requests. A tick issues ≤3 sequential calls, once a minute: **~3 points/min, 1 concurrent.** Three orders of magnitude clear. Writes (`gh pr merge`) fall under the content-creation secondary limit (~500/hr); merges happen a handful of times a day. Fine.

**Reviewer identity is separate and unaffected.** `ls-reviewer`'s token ([ADR 004](docs/architecture/adr/ADR_004_DISTINCT_REVIEWER_IDENTITY.md)) has its *own* 5,000/hr budget and is only used by the reviewer *agent's* `gh` calls — never by the tick itself. Tick cadence doesn't touch it.

**git fetch.** 60 small fetches/hour is nothing; GitHub imposes no per-hour git limit that normal polling approaches.

**`claude agents --json`.** Not network — a local `claude` CLI subprocess (~0.5–1 s, some memory). Called at most once per tick, and *only* in the no-PR-yet path. It's the heaviest *local* cost of a fast cadence, and it's exactly what the fail-fast in §3 removes.

**Conclusion:** the honest finding is that **frequent polling does not stress any rate limit.** The real costs of a fast cadence are the two below — log noise and wasted local work — both fixable without touching cadence at all.

### 2. Log noise

`logDecision` appends one JSONL line **and** `console.log`s on **every** tick, whatever the outcome ([orchestrator.mjs](../../orchestrator.mjs)). At 15-min cadence that's ~96 lines/day; at 1/min it's **~1,440/day**, the overwhelming majority `wait`/`idle` heartbeats that bury the handful of real transitions. The audit trail degrades from a state *timeline* into a poll *log*.

Fixes, primary first:

- **Log transitions, not polls (primary).** Track the previous decision's `(action, reason, taskId)`; if the new decision is the same class, don't append a new audit line. Optionally carry a `repeatCount` / `lastSeen` so "waited 37 times since 12:00" is one coalesced record, not 37 lines. Result: the JSONL reads as `dispatch → wait-for-ci → dispatch-reviewer → merge` — what you actually audit. `dispatch`/`merge`/`blocked`/`error` always log unconditionally.
- **Separate liveness from audit (secondary).** Write `state.lastTickAt` (+ last decision) into `state.json` each tick so "is the loop alive / when did it last run" is answerable without any log line; `--status` already recomputes the live verdict on demand. The audit log is then free to be transition-only.
- **Rotate/cap** the JSONL (keep last N lines) — orthogonal housekeeping, worth doing once cadence rises.

This is the change that makes a fast cadence *pleasant* rather than noisy, and it composes with fail-fast below: a fail-fast tick is a no-op and should touch only the heartbeat, never the audit log.

### 3. Fail-fast: skip the expensive path when nothing can have changed

The user's proposal: *if a session is in progress, bail before calling `gh`/`claude`.* This is sound, with one sharp caveat about *how you decide the session is "in progress."*

**Why it's correct (in this flow).** A tick's expensive calls exist to detect two kinds of change since the last tick: **(a)** a local agent finished or pushed, and **(b)** GitHub-side CI/review moved. For an in-flight task with **no PR yet**, (b) is *impossible* — no PR ⇒ no CI ⇒ no review. And in this factory the developer opens the PR at the very *end* of its session (prompt: implement → test → push → **then** open PR). So while a developer session is genuinely active, `gh pr list` is *guaranteed* to return "no PR" — every one of those calls is pure waste. Fail-fast: while the session is actively working and has no PR, skip `gh` (and skip re-deriving anything).

**The caveat — do not reuse the 30-minute liveness window.** The existing liveness signal (`sessionRecentlyActive`, a 30-min transcript-mtime window, [ADR 005](docs/architecture/adr/ADR_005_LIVENESS_FROM_TRANSCRIPT_MTIME.md)) is deliberately *lagging*: it calls a session alive for 30 min after its last transcript write, so a briefly-paused agent isn't re-dispatched over. If fail-fast used that same window, it would skip the `gh` check for up to **30 minutes after the agent actually finished and opened the PR** — a latency *regression* worse than the 15-min poll it replaces. The two needs are opposite:

| Threshold | Purpose | Wants to be |
| --- | --- | --- |
| long (~30 min, existing) | don't **re-dispatch** over a paused agent | conservative / lagging |
| short (~60–120 s, **new**) | safe to **skip** the expensive check | tight / eager |

So fail-fast needs its **own short threshold**: transcript touched within ~T seconds (T ≈ 60–120) ⇒ agent is actively writing ⇒ skip `gh`. Older than T ⇒ agent *might* be done ⇒ do the full reconcile and go look. This bounds wasted `gh` calls to the agent's active-work span **and** bounds post-completion latency to ~T (seconds, not minutes).

**Cheapest form — skip `claude` too.** We already store `task.sessionId`. If we also record the session's **cwd** at dispatch time, the "is it active" check collapses to a single `fs.statSync` on the transcript path — **no `claude agents --json` subprocess at all**. A mid-flight tick then costs *zero* API calls and *zero* subprocesses: stat the transcript, see it's <T s old, bump the heartbeat, exit. That is the ideal fast-cadence tick — nearly free, so ticking every minute (or every 10 s) during a long agent run is genuinely cheap.

**Its limit (and where events come back in).** Fail-fast only helps the **no-PR-yet** window. Once a PR exists, CI/review changes are GitHub-side with no local proxy, so the tick *must* call `gh` to see them — there's no way to fail-fast that window by polling. That is precisely the window the event-driven options target (Options 4–5). Fail-fast and events are **complementary**: fail-fast removes waste *during agent work*; events remove latency *during GitHub waits*.

## Options considered (the study)

1. **Shorten `StartInterval` (the baseline under analysis).** One-line plist change, no new parts. Drops worst-case per-step latency from 15 min → the interval. §1 shows the API cost is negligible; §2 and §3 remove the noise/waste. **Strongest first move.** Combine with #2 and #3.
2. **Log transitions, not polls (§2).** Makes a fast cadence non-noisy; independently worth doing. Low risk.
3. **Fail-fast short-circuit (§3).** Makes a fast cadence cheap by skipping the expensive path while an agent works. Needs the *short* threshold and (ideally) the recorded-cwd optimization. Medium, self-contained.
4. **Event-driven trigger on agent completion (`Stop` hook).** A `Stop` hook in the target repo's `.claude/settings.json`, gated on `FACTORY_DISPATCH=1`, pokes a coalescing `POST /api/trigger/:repo` in [server.mjs](../../server.mjs) so an agent finishing fires the *next* tick in seconds rather than at the next interval. Removes latency in the window fail-fast can't (agent→next-stage). Cost: confirm `Stop` fires in `--bg` (**O1**); a new coalescing endpoint (per-repo lock; a *dropped* trigger = a dropped transition, so it must coalesce, not 409); route launchd through the same lock. **Only worth building if faster polling's latency floor proves too high.** Deferred pending the measurement below.
5. **Handle the remote CI-green gate.** The one transition neither faster polling-with-fail-fast nor a `Stop` hook catches locally. Options: (a) keep a short poll purely for the brief "PR open, CI pending" state — cheapest; (b) have the developer run `gh pr checks --watch` so its `Stop` fires only once CI settles — folds the remote event into a local one, at the cost of agent wall-clock; (c) GitHub webhooks via a tunnel — most infrastructure, likely over-engineering for a single-user local factory. Lean (a).

## Recommendation

**Measure, then take the cheap path first.** Instrument one real end-to-end task and attribute its wall-clock to *agent work* / *CI* / *tick-wait*. Then:

- If tick-wait is a **small** fraction → shorten `StartInterval` (Option 1) + log dedup (2) + fail-fast (3), and stop. No event machinery.
- If tick-wait is **large even at 1-min cadence** (i.e. sub-minute latency genuinely matters) → add the `Stop` hook (Option 4) on top, and pick a CI-gate strategy (Option 5).

The event-driven design is the optimization of last resort, reached only if the data says polling — even fast, cheap, fail-fast polling — leaves real latency on the table.

## Open questions

- **O1 — Does `Stop` fire for `--bg`/headless sessions?** Blocks Option 4 entirely. Confirm empirically before building any hook.
- **O2 — Fail-fast threshold `T`.** What short window (60 s? 120 s?) reliably means "still actively working" without prematurely calling a thinking-paused agent done? Pick against real transcript-write cadence.
- **O3 — Record session cwd in state** to enable the `claude`-free transcript stat (§3). Confirm the `--worktree` cwd is what appears in the transcript path, and store it at dispatch time.
- **O4 — Is a PR ever opened mid-session** (before the developer finishes)? The fail-fast correctness argument assumes the PR is opened at the end. If any role opens a draft PR early, the no-PR-yet fail-fast must key off "no PR *recorded in state* yet" and re-check once one appears. Audit the personas.
- **O5 — `gh auth status` every tick.** It's the one unconditional API call on *every* tick, including idle ones. Can it be lazy (only re-check on a real `gh` auth failure) or cached for N minutes, to make idle ticks cost *zero* API calls?
- **O6 — Heartbeat vs. audit split.** Where does `lastTickAt` live (state.json? a `.heartbeat` file?) and does `--status` / the UI read it for liveness so the audit log can go transition-only?
- **O7 — Budget interaction at speed.** Faster ticks reach the same dispatches sooner, so `budget-guard`'s 8/300-min cap ([ADR 006](docs/architecture/adr/ADR_006_HUMAN_MERGE_GATE_AND_BUDGET.md)) is hit earlier in wall-clock (same total spend, earlier pause). Confirm that's understood/desired, not a surprise.
- **O8 — launchd on a sleeping/battery Mac.** A 1-min timer means a catch-up fire on wake and steady wake-ups; confirm that's acceptable on laptop power, or gate cadence on AC.

## Rollout (once measured)

1. **Instrument and measure** one real task: agent / CI / tick-wait breakdown. This decides everything below.
2. Land **log dedup** (Option 2) + a **heartbeat** (O6) — makes any faster cadence safe to read. Low risk, do regardless.
3. Land **fail-fast** (Option 3) with the short threshold (O2) and, if cheap, the recorded-cwd stat (O3).
4. **Shorten `StartInterval`** to the measured sweet spot (start ~60–120 s). Watch one full autonomous cycle for cost, noise, and any double-dispatch.
5. **Only if** step 1 showed sub-minute latency matters: confirm O1, then add the `Stop` hook (Option 4) + a CI-gate strategy (Option 5), routing all triggers through one coalescing per-repo lock. Same "earn the gate" posture as [ADR 006](docs/architecture/adr/ADR_006_HUMAN_MERGE_GATE_AND_BUDGET.md).
