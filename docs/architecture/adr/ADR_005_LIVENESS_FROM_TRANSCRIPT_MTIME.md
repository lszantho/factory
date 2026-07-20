# ADR 005: Detect a running session by transcript mtime, not PID

## Status

Approved

## Context

Every tick, before dispatching or retrying a role, the orchestrator must answer: *is the session it previously started still actually working?* Get this wrong in one direction and it redispatches over a session that's still busy (duplicate work, wasted budget); wrong in the other and it waits forever on a session that has died.

The obvious source is `claude agents --json`, which reports a `pid` per session. It turns out to be unreliable in **both** directions:

- **False "alive": recycled pids.** macOS reuses pids. A pid reported for a session whose process already exited can, minutes later, belong to an unrelated `claude --bg-spare` warm-pool process — so a bare "does this pid exist" check reports a long-dead session as running.
- **False "dead": warm-pool argv.** The fix for the above — checking that the live process's own command line still references the session id — fails the *other* way. A `--bg-spare` process, once claimed and put to work on a real session, keeps its original `--bg-spare …claim.sock` argv forever. So the command-line check reports a genuinely active session as *not running* — observed directly, with `claude logs <id>` showing live tool-call streaming while the pid/argv check said dead.

Both failures come from treating a *reported or indirect* signal (the pid, the argv) as ground truth for "is it working," instead of observing the work itself.

## Decision

**Determine liveness from the mtime of the session's live transcript, not from any pid.**

Every background session appends to a JSONL transcript as it works, at:

```
~/.claude/projects/<cwd, with every non-alphanumeric char replaced by "-">/<sessionId>.jsonl
```

`hasRunningSession` resolves that path and treats the session as running if the file was modified within `staleSessionMinutes`. The transcript is written to exactly when the session produces output, so its mtime is silent precisely when the session is silent — which is the actual question being asked.

For a one-off manual check, `claude logs <session-id>` prints a background session's recent output directly; `claude agents --json`'s `status`/`state` fields (`busy`/`idle`, `working`/`done`) are also a more honest signal than the pid.

## Consequences

- **Liveness now reflects the work itself**, not a process-table artifact — immune to both pid recycling and warm-pool argv staleness.
- **It reuses the existing `staleSessionMinutes` threshold** as the "recently produced output" window — no new config knob, and it lines up with the same staleness notion the retry logic already uses.
- **A dependency on an internal path layout.** The transcript location and the cwd-escaping scheme (`[^a-zA-Z0-9]` → `-`) are Claude Code internals, not a public contract; a future change to either would need this updated. Verified correct against live sessions in practice, including the warm-pool case that broke the pid approach.
- **Same root cause as [ADR 002](ADR_002_RECONCILE_STATE_FROM_REALITY.md).** This is the liveness instance of the same principle: prefer a direct observation of reality (the transcript being written) over a reported proxy (the pid).
