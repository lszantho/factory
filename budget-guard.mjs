import { execFile } from 'node:child_process';

/** Drops dispatch timestamps outside the rolling window, mutating state.dispatchTimestamps in place. */
export function pruneDispatchTimestamps(state, windowMs) {
  const now = Date.now();
  state.dispatchTimestamps = (state.dispatchTimestamps ?? []).filter((ts) => now - ts < windowMs);
}

/** Read-only check: how many dispatches are already in the current window vs. the configured cap. */
export function budgetStatus(state, config) {
  const windowMs = (config.budget?.windowMinutes ?? 300) * 60 * 1000;
  pruneDispatchTimestamps(state, windowMs);
  const cap = config.budget?.maxDispatchesPerWindow ?? 8;
  const count = state.dispatchTimestamps.length;
  return { count, cap, allowed: count < cap };
}

/** Call only when an actual (non-dry-run) dispatch is about to happen. */
export function recordDispatch(state) {
  state.dispatchTimestamps = state.dispatchTimestamps ?? [];
  state.dispatchTimestamps.push(Date.now());
}

/** Fire-and-forget macOS notification. Never throws — a failed notification shouldn't crash the tick. */
export function notify(title, message) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  try {
    execFile('/usr/bin/osascript', ['-e', script], () => {});
  } catch {
    // best-effort only
  }
}
