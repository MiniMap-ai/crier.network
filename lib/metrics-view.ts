/**
 * The metrics snapshot as a page must actually treat it: a value this deployment did not write.
 *
 * lib/cache.ts is careful that everything it caches is JSON-safe, because the data cache round-trips
 * entries through JSON. This module is the other half of that round trip. JSON preserves the keys the
 * writer had, not the ones the reader expects, and the writer of the entry a page is handed is
 * whichever deployment last refreshed it — `unstable_cache` keeps serving the entry it already has
 * whenever a revalidation throws, so "the previous deployment's snapshot" is not a moment during a
 * deploy, it lasts as long as the refresh keeps failing. On 2026-09-10 that was a snapshot written
 * before the `demand` block existed, read by a page that did `m.demand.last_30d`: every render threw
 * and /stats was a 500 until the migration the new snapshot needed was applied.
 *
 * So the type here says the true thing — every block is optional — and `fillMissingBlocks` puts an
 * empty one in place of each block the page walks, which the page already renders as "none yet".
 * A block left out of EMPTY_BLOCKS stays optional in the returned type, and that is the point: the
 * next block added to the snapshot is one TypeScript makes the page decide about rather than one it
 * lets the page assume. `demand` is left out on purpose; app/stats/page.tsx says why.
 */
import type { metricsSnapshot } from "./metrics";

/** The snapshot as this deployment writes it. */
export type Snapshot = Awaited<ReturnType<typeof metricsSnapshot>>;

/**
 * A value once it has been through the cache's JSON round trip. The only thing this changes is the
 * row lists postgres.js hands back: JSON keeps an array's elements and drops the properties
 * postgres.js hangs off it (count, columns, command), so what a page reads is a plain array and the
 * empty stand-in for one is a plain [].
 */
type AsJson<T> = T extends readonly (infer E)[] ? AsJson<E>[] : T extends object ? { [K in keyof T]: AsJson<T[K]> } : T;

/** Every block as a page reads it, all of them together. */
type Blocks = { [K in keyof Snapshot]: AsJson<Snapshot[K]> };

/** The snapshot as a cache entry may really hold it: any block can predate the code reading it. */
export type CachedSnapshot = { [K in keyof Blocks]?: Blocks[K] };

/**
 * An empty value for every block /stats reads its way into. The scalar blocks are zeroes rather than
 * absences because they have been in the snapshot since the page was written and an older entry
 * always has them; they are listed anyway so that filling in is one line instead of a condition per
 * read, and so that renaming one of them out from under the page is a compile error here rather than
 * a 500 there.
 */
const EMPTY_BLOCKS: Pick<Blocks, "generated_at" | "north_stars" | "metrics" | "funnel" | "board" | "unmet_demand" | "mcp" | "routes_7d" | "registration_clients" | "series_30d"> = {
  generated_at: "",
  north_stars: { weekly_active_publishers: 0, weekly_active_seekers: 0 },
  metrics: {},
  funnel: { registered: 0, activated: 0, retained: 0, prev_week_publishers: 0, returning_publishers: 0 },
  board: { active_first_hand: 0, active_syndicated: 0, active_internal: 0, open_reports: 0, hidden_posts: 0 },
  unmet_demand: { zero_result_searches_30d: 0, terms: [], phrases: [], kinds: [], places: [], tags: [], note: "" },
  mcp: { clients_30d: [], tools_7d: [] },
  routes_7d: [],
  registration_clients: [],
  series_30d: [],
};

/**
 * Fill in the blocks a cached snapshot does not have. Blocks it does have are passed through as they
 * are, so a current snapshot renders exactly as it did before this existed.
 */
export function fillMissingBlocks(snapshot: CachedSnapshot) {
  return { ...EMPTY_BLOCKS, ...snapshot };
}
