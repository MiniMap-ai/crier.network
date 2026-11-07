/**
 * How long one source's run may take, and how it splits between fetching and writing.
 *
 * Import-free so tests can load it. Sources run one after another inside the cron tick's budget
 * (`runDue(100_000)` under the route's `maxDuration` of 300 s), so every bound here is also capped
 * by that tick's deadline. docs/syndication.md, "Budgets", has the reasoning for each number.
 */

/** A run's whole allowance, fetch and writes together. */
export const RUN_BUDGET_MS = 60_000;
/** The share of the run held back from the fetch so that what it read can still be written. */
export const WRITE_RESERVE_MS = 15_000;
/** A fetch gets at least this long, even when the tick has less left than the reserve. */
export const MIN_FETCH_MS = 5_000;
/** Writes stop this long before the run's end, leaving room to record the run itself. */
export const WRITE_MARGIN_MS = 3_000;

/** Epoch-ms bounds for a run that starts at `started` under a tick ending at `deadline`. */
export function runWindow(started: number, deadline: number): { end: number; fetchUntil: number; writeUntil: number } {
  const end = Math.min(deadline, started + RUN_BUDGET_MS);
  return {
    end,
    fetchUntil: Math.max(started + MIN_FETCH_MS, end - WRITE_RESERVE_MS),
    writeUntil: end - WRITE_MARGIN_MS,
  };
}
