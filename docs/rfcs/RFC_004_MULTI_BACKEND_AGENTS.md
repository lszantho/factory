# RFC 004: Multi-Backend Agents

## Problem
Currently, the factory orchestrator (`orchestrator.mjs`) is tightly coupled to Anthropic's Claude Code CLI. When Claude API quota is exhausted, the entire factory pipeline halts. Furthermore, being locked into a single vendor prevents us from leveraging strengths of other frontier models (like Gemini's speed and large context window).

## Proposal
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
