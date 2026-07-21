# Execution, permissions & security

The factory autonomously spins up AI agent sessions that write code, push branches, review PRs, and (under autopilot) merge to `main`. Several **independent** restriction layers govern that — and they're easy to conflate. This document maps them precisely: what can trigger a run, what permissions a run needs to dispatch agents, what those agents run as, and the known gaps.

---

## 1. Who can trigger a tick — and why "I couldn't run it, you had to"

A "tick" is `node orchestrator.mjs <repo>`. It can decide to dispatch a `claude --bg` agent. **Who** launches that command determines whether it's allowed, and the restrictions differ by launcher:

| Launcher | Can run a tick? | Why |
| --- | --- | --- |
| **The assistant (Claude Code, in-session)** | ❌ **No** | The session's **auto-mode classifier** blocks the assistant from launching a command that spins up `bypassPermissions` background agents. This is a **guardrail on the assistant**, not a system permission — there is nothing to "grant." The assistant *can* run read-only things (`--status`, `git`/`gh` reads), edit files, and even `launchctl load` — but not pull the trigger on dispatch itself. It's also blocked from `gh pr review --approve`. |
| **You, in your terminal** | ✅ Yes | No classifier. `node orchestrator.mjs leanmacrofeed` just works, subject to the permission stack in §2. |
| **launchd (the scheduled loop / autopilot)** | ✅ Yes | Runs *as you*, on a timer, no classifier. **This is the mechanism autopilot uses** — it's why unattended operation goes through launchd, not the assistant. |
| **The UI "Run next tick" button** | ⚠️ Read works, dispatch failed | The button's server spawns the tick as a subprocess. Reads are fine; the agent-dispatch didn't work — see §6. |

**The key mental correction:** "the assistant can't run it" is **not** a missing permission on the orchestrator or a misconfiguration you need to fix. It's a deliberate limit on the *assistant*. You (or launchd) running the exact same command has no such limit.

---

## 2. The permission stack a tick needs to dispatch agents

When *you* or *launchd* run a tick and it decides to dispatch, these must all be true. This is the actual "what do I need to grant" list:

| # | Requirement | What it is / how to satisfy it |
| --- | --- | --- |
| **a** | **Claude Code authenticated + usage available** | Each `claude --bg` session consumes your Claude subscription. You must be logged in (`claude` CLI authed), and have usage left — a usage-limit exhaustion pauses dispatches (this is why the overnight run was scheduled after the reset). |
| **b** | **`bypassPermissions` mode permitted** | The orchestrator dispatches with `--permission-mode bypassPermissions` (see [ADR 007](adr/ADR_007_BYPASS_PERMISSIONS_FOR_DISPATCH.md)) because a `--bg` session has no TTY to answer prompts. Your Claude Code must allow this mode. If your environment/org disables `bypassPermissions`, dispatch fails. |
| **c** | **`--bg` background sessions enabled** | The Claude Code background daemon (and its `--bg-spare` warm pool) must be operational — this is what actually hosts the dispatched agent. |
| **d** | **GitHub access** | Your `gh` authenticated with `repo` scope for PR reads, creation context, and **merges** (done as your identity). Plus the **separate `ls-reviewer` token** (`repo` scope, a collaborator on the repo) at `~/.config/factory/<repo>-reviewer-token`, injected only for reviewer dispatches — because GitHub blocks self-approval ([ADR 004](adr/ADR_004_DISTINCT_REVIEWER_IDENTITY.md)). |
| **e** | **OS / filesystem** | Read/write to the target repo + its worktrees; write to `~/Library/LaunchAgents/` for the scheduled loop; `caffeinate` (or "prevent sleep") so a laptop doesn't sleep and freeze the loop. |

None of these is exotic — for a solo machine already set up for Claude Code + `gh`, the only factory-specific additions are **(b)** allowing `bypassPermissions`, and **(d)** the extra `ls-reviewer` token.

---

## 3. What the dispatched agents actually run as — and the safety-net gap

The exact dispatch is:

```
claude --agent <role> --permission-mode bypassPermissions --bg -n <sessionName> [--from-pr N | --worktree W] "<prompt>"
   env: { ...parent env, FACTORY_DISPATCH=1, [GH_TOKEN=<reviewer token> for reviewer] }
```

`bypassPermissions` means **the agent runs every tool without prompting** — file edits, and crucially **arbitrary `Bash`** (git/gh/pnpm/rm/curl/…). There is no interactive gate; a `--bg` session couldn't answer one anyway.

**Tool denylist (`--disallowedTools`) — fixed 2026-07-21.** The orchestrator now passes a config-driven `--disallowedTools` (`configs/<repo>.json` → `disallowedTools`) that blocks the operations **no role should ever run**, as an enforced backstop to the personas' "never merge / never force-push / never touch `main`" instructions:

```
Bash(gh pr merge*)   Bash(git push --force*)   Bash(git push -f*)
Bash(git push --force-with-lease*)   Bash(git reset --hard*)   Bash(git branch -D*)
```

Two honest limits on how strong this is:
- **Prefix globs, not airtight.** Patterns like `Bash(gh pr merge*)` match a command *prefix*; a differently-phrased invocation could evade one. It's defense-in-depth, not a sandbox. Tune the list per repo.
- **Precedence under `bypassPermissions` is assumed, not confirmed here.** Explicit denies are *designed* to win over the permission mode, but that hasn't been empirically verified in this setup. **If you need airtight enforcement** (e.g. before trusting wider/unattended autopilot), promote this to a **PreToolUse hook** in the target repo's `.claude/settings.json` — a hook blocks the tool call unconditionally, regardless of permission mode.

(Before this fix, `--disallowedTools` was documented as the safety net but never actually passed — so the only constraint was `AGENTS.md` §6 prose, with no tool-level enforcement at all.)

---

## 4. Autopilot checklist (unattended)

For the loop to run itself end-to-end, all of these hold simultaneously:

- launchd job **loaded** (`launchctl load -w ~/Library/LaunchAgents/com.lucian.<repo>-factory.plist`), `StartInterval` set, `RunAtLoad` as desired.
- `autoMerge: true` in the config (else it parks at `would-merge` for you) — **and** the `bypassPermissions` + gh + reviewer-token stack from §2.
- **Machine stays awake** — `caffeinate` running **and lid open + on power** (a closed lid sleeps the Mac regardless of caffeinate).
- **Usage available** the whole time.
- Safety limiters that stay on: the **dispatch budget** (`budget.maxDispatchesPerWindow`), the **WIP cap** (`maxConcurrentTasks`), and any **`stopAfterTask` checkpoint**.
- To stop: `launchctl unload -w …plist` (+ `pkill caffeinate`).

---

## 5. Don't conflate the layers

Three different restriction systems, three different scopes:

1. **The auto-mode classifier** restricts **the assistant** (in-session Claude Code). Scope: what the assistant may trigger. Irrelevant to you/launchd/UI.
2. **`bypassPermissions`** governs **the dispatched agents** — it *removes* their prompts. Scope: what a running agent may do without asking.
3. **`gh` / reviewer-token / branch rules** govern **GitHub actions**. Scope: what lands on `main` and who can approve.

"The assistant is blocked" (layer 1) says nothing about whether the orchestrator has permission (layers 2–3). They're orthogonal.

**Blast-radius mitigations that *are* in place** (so §3's gap isn't unbounded): agents work on a **per-task worktree/branch**, never `main` directly; every change reaches `main` only via a **reviewed PR**; the **reviewer role + CI** gate merges; the **budget cap** bounds dispatch volume; and — during Phase 2 — **you review each PR** with `autoMerge` off. The target repo is also **not live**, so a bad merge is reversible.

---

## 6. Why the UI "Run next tick" button didn't work (analysis + how to fix)

**Symptom:** clicking "Run next tick" repeatedly produced **zero** decision-log entries and dispatched **no** agent — while the dashboard's *read* endpoints (`/api/repos`, `/api/status`, `/api/log`) work perfectly.

**What that rules in/out:** the server is up and its read path is fine. The failure is specific to `POST /api/tick`, which does `spawn(node, [orchestrator.mjs, repo], { env: { ...process.env } })` and streams output over SSE. A completed tick *always* writes to `logs/<repo>.jsonl` (every path — dispatch/wait/blocked/idle — calls `logDecision`). **No log entry at all** means the tick **crashed before any decision was logged**, or never spawned.

**Leading hypotheses** (not yet confirmed — the SSE output that would show the error was only in the browser and wasn't captured):

1. **The nested `claude --bg` dispatch fails/hangs in the server-spawned context.** The tick's decision was `dispatch developer` → `execFileSync(claude, ['--bg', …], { timeout: 60_000 })`. `node` and `claude` are invoked by **absolute path** (from `config.paths`), so it's *not* a `PATH` problem. More likely the **environment inherited from the UI server differs from your terminal** — e.g. the server was started from *inside* a Claude Code session (so its env carries `CLAUDE_*`/session vars), and a nested `claude --bg` launched under that env refuses or misbehaves. If `claude --bg` throws or hangs to the 60s timeout, the `execFileSync` throw is **uncaught** in `dispatch()` (only `decide()` is try/caught), so the tick dies **before** `logDecision('dispatch')` — exactly the "no log" symptom.
2. **A stuck `tickInProgress` flag** — if a first click's child never fired `close`/`error`, later clicks all `409`'d without spawning. Less likely (the handler resets on close), but possible.
3. **The frontend didn't actually POST** (or hit the wrong path), so nothing reached the server. Distinguishable via browser devtools' network tab.

**How to diagnose (do this next):**
- Click once with the **browser devtools Network + Console** open: confirm the `POST /api/tick/leanmacrofeed` fires and read the SSE stream — it will show `[stderr] …` / `[error: …]` / `[done — exit code N]`.
- Make failures durable: patch `handleTick` in `server.mjs` to also write the spawned tick's `stdout`+`stderr` to `logs/ui-tick.log` (right now that output is browser-only and lost). Then the next failed click is diagnosable from a file.
- Compare `env | grep -i claude` between your working terminal and the shell that launched `npm run serve`.

**Likely fixes, once confirmed:**
- Start the UI server from a **clean login shell** (a normal terminal, not inside a Claude Code session), so nested `claude --bg` gets an uncontaminated environment; or
- Have the tick endpoint spawn with a **sanitized env** (strip `CLAUDE_*`/session vars) matching a plain terminal; and
- Regardless, **capture tick output to a file** so this class of failure is never silent again.

**Meanwhile,** the proven trigger paths are your **terminal** (`node orchestrator.mjs leanmacrofeed`) and **launchd** (the autopilot loop) — both run in a clean context and dispatch agents reliably. Use those to drive real ticks until the button's context issue is fixed; keep using the dashboard for its (working) live view.
