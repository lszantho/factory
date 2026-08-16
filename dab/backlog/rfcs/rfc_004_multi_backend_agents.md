# RFC 004: Multi-Backend Agents

## Status

**Proposed — sketch, no code yet.** Unlike the other RFCs in this directory, this one hasn't been through a collaborative design pass; it's a first-draft problem statement and a three-phase shape, not a settled design. Worth a look before building anything here: [RFC 005](rfc_005_sprint_oriented_planning.md) and the docs-as-board multi-language submodule suite it replaced are both examples of the same failure mode — speculative breadth built ahead of any real need — so a genuine multi-backend push should start from a concrete, current pain point (a specific quota outage, a specific task that would benefit from a different model) rather than this sketch's abstract vendor-lock-in framing.

## Context & Motivation
Currently, the factory orchestrator (`orchestrator.mjs`) is tightly coupled to Anthropic's Claude Code CLI. When Claude API quota is exhausted, the entire factory pipeline halts. Furthermore, being locked into a single vendor prevents us from leveraging strengths of other frontier models (like Gemini's speed and large context window).

## Proposed Architecture & Design
We propose abstracting the orchestrator's interactions with the AI agent CLI behind a common interface, allowing us to swap the backend between Anthropic's `claude` and Google's `factory-gemini-agent`.

### Phase 1: Manual Configuration Switch
Introduce a configuration setting `config.agentBackend` that can be set to either `"claude"` or `"gemini"`. The orchestrator will route tasks to the selected backend. Both backends will use the identical worktree layout (`.claude/worktrees/<task>`) and authentication mechanisms (pre-configured API keys).

### Phase 2: Quota-Aware Auto-Fallback
Enhance the orchestrator to catch dispatch failures or specific exit codes (like `429 Too Many Requests` or explicit quota errors) and automatically retry the task using the alternate backend. This ensures continuous operation even during API outages or quota limits.

### Phase 3: Task-Complexity Routing
Introduce role-based model routing. For example:
- **Architect**: Tasks requiring deep reasoning and system design can be routed to `gemini-3.1-pro` or Claude 3.5 Sonnet.
- **Developer/Reviewer**: Implementation and review tasks can be routed to faster, more token-efficient models like `gemini-3.6-flash`.

## Scope of Changes
The current tight coupling in `orchestrator.mjs` is limited to three specific call sites:

1. **Liveness Tracking**: `claudeAgentsJson()` (around line 120) runs `claude agents --json --all`.
2. **Task Dispatching**: `dispatch()` (around line 253) calls `execFileSync(config.paths.claude, args)`.
3. **Session Verification**: Post-dispatch lookup (around line 265) verifies the session was successfully started in the background.

These three integration points will be abstracted into a `BackendAdapter` interface that dynamically resolves the CLI command and arguments based on `config.agentBackend`.

## Alternatives considered

This section is the reason the Status above calls this RFC a sketch: it was written after the fact, and it records the alternatives that *should* have been weighed before proposing an adapter layer, not ones that were.

- **Do nothing; wait out the quota.** The factory is level-triggered and idempotent — a dispatch that fails on quota is retried on a later tick with no lost work. The real cost of an outage is latency, not correctness, and no measurement of that latency exists. This is the null hypothesis the RFC never states, and nothing below is worth building until it is disproved with a specific incident.
- **A single backend, chosen per repo rather than per dispatch.** `configs/<repo>.json` already carries `paths.claude` ([ADR 003](../../../docs/architecture/adr/ADR_003_STANDALONE_TOOL_PER_REPO_CONFIG.md)). Pointing that at a different CLI is a config edit, not an interface. It buys Phase 1's benefit without Phase 1's abstraction, and it fails only where the two CLIs disagree on flags and session semantics — which is exactly the part this RFC has not surveyed.
- **Route by role without abstracting the CLI.** Phase 3's value (cheap models for mechanical work, expensive ones for design) is reachable today by passing a different `--model` to the same CLI. It does not need a second vendor, and conflating the two is what makes this proposal look larger than the problem.

## Risks & open questions

- [ ] **No triggering incident.** Phases 2 and 3 are justified by a quota exhaustion that has not been recorded happening, and by model-strength claims that have not been tested on factory tasks. Naming a real one is the precondition for any of this.
- [ ] **Session semantics may not abstract.** The orchestrator does not merely spawn a CLI: it reads `claude agents --json --all` for liveness and re-reads transcript mtimes to decide whether an agent is alive ([ADR 005](../../../docs/architecture/adr/ADR_005_LIVENESS_FROM_TRANSCRIPT_MTIME.md)). A `BackendAdapter` that resolves a command string does not carry those observations across. Whether a second backend can supply them at all is unknown, and the answer decides whether the interface is three call sites or a rewrite.
- [ ] **The model names in Phase 3 are stale.** They were current when this was drafted and are cited here only as an illustration of role-based routing.
- [ ] **Speculative breadth.** This is the failure mode the Status paragraph names, and the one the docs-as-board multi-language submodule suite already cost. A quota-aware fallback path is exercised only during outages, which is to say it is the code least likely to be correct when it finally runs.
