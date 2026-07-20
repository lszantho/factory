# ADR 004: A distinct GitHub identity for the reviewer, sourced inline

## Status

Approved

## Context

The reviewer role is the merge gate: it must produce a real, recorded GitHub **approval** (a formal `APPROVED` review state), because the pipeline treats "approved + green CI" as the signal a PR is mergeable. A written verdict in a comment is not enough — it needs to be an actual review.

Two hard constraints collide here:

1. **GitHub unconditionally blocks an account from approving its own PR** — via API, CLI, or web UI alike (the web UI just silently disables the option, which makes it easy to *think* you approved when you only merged). Every factory role otherwise shares the operator's single `gh` identity. So the account that authored the PR (developer, as the operator) is the same account trying to approve it — and GitHub refuses. Result: the reviewer could analyse a PR perfectly and never be able to record its approval.

2. **A `--bg` dispatch does not reliably run in a freshly-spawned process.** Claude Code keeps a warm pool of `--bg-spare` processes and can *claim* one to service a dispatch. A claimed warm-pool process inherited its environment when it was pre-forked, long before this dispatch — so environment variables set at dispatch time do not propagate into the process actually doing the work.

The first attempt handled (1) by creating a separate account and having the orchestrator inject that account's token as a `GH_TOKEN` **environment variable** at dispatch time (`reviewerGhEnv()`). Constraint (2) silently defeated it: the reviewer session ran in a warm-pool process that never saw the injected env, so it authenticated as the PR author and GitHub refused the self-approval. This was observed directly — the reviewer produced a correct "Approve" verdict but reported it could not record it.

## Decision

**Use a genuinely separate GitHub account for the reviewer, and have the reviewer source that account's token inline, per `gh` command, rather than relying on dispatch-time environment injection.**

- A separate GitHub account (`ls-reviewer`) is a collaborator (push permission) on the target repo, with a classic PAT (`repo` scope) stored at a path outside any repo (`~/.config/factory/leanmacrofeed-reviewer-token`, `chmod 600`, never committed).
- The reviewer persona (`reviewer.md` in the target repo) instructs the reviewer to **check `gh auth status` first** and, because ambient env cannot be trusted to carry the token, to source it explicitly and scoped to the single command:

  ```
  GH_TOKEN=$(cat <token-path>) gh pr review <PR> --approve --body "..."
  ```

- The orchestrator still injects the token as env for reviewer dispatches (harmless when it works), but correctness no longer depends on it: the reviewer self-corrects by sourcing the token itself.

## Consequences

- **Real approvals are now possible and were verified end-to-end** — `ls-reviewer` submitted a genuine `APPROVED` review with no manual assistance, which is the signal the merge step depends on.
- **A second identity and secret to manage.** The reviewer account, its collaborator access, and its token file are operational dependencies. The token lives outside all repos and is never committed; a missing/invalid token is treated by the reviewer as a blocking infrastructure error, not something to work around by editing the PR or falling back to a self-approval.
- **The persona owns the auth mechanic, not the engine.** Because the fix is in `reviewer.md`, it travels with the target repo and is robust to the warm-pool behaviour regardless of how the orchestrator dispatches. This is consistent with [ADR 003](ADR_003_STANDALONE_TOOL_PER_REPO_CONFIG.md).
- **A general caution recorded:** dispatch-time environment is *not* a reliable channel to a `--bg` session, because of warm-pool process reuse. Anything a dispatched session needs must be sourced by the session itself (from a file/command), not handed to it via env at spawn time.
