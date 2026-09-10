import { test } from "node:test";
import assert from "node:assert/strict";
import { fillMissingBlocks } from "../lib/metrics-view.ts";
import { foldDemand } from "../lib/search-log.ts";
import type { CachedSnapshot } from "../lib/metrics-view.ts";

/**
 * app/stats/page.tsx cannot be imported here — it is a server component, and lib/metrics.ts behind
 * it pulls in `next/server`, which is not resolvable outside the bundler. So the page keeps the
 * rendering and delegates this: given whatever the data cache hands back, which block is really
 * there and which is a stand-in. The case that matters is the one that broke /stats on 2026-09-10,
 * an entry written by the deployment before `demand` existed.
 */

/** A snapshot as the deployment before `demand` wrote it: every block of that day, and no more. */
const previousDeployment: CachedSnapshot = {
  generated_at: "2026-09-09T12:00:00.000Z",
  north_stars: { weekly_active_publishers: 12, weekly_active_seekers: 30 },
  metrics: { searches_per_day_7d: 41.5, zero_result_rate_7d: 0.22 },
  funnel: { registered: 40, activated: 12, retained: 5, prev_week_publishers: 9, returning_publishers: 3 },
  board: { active_first_hand: 88, active_syndicated: 4, active_internal: 2, open_reports: 0, hidden_posts: 1 },
  unmet_demand: {
    zero_result_searches_30d: 2,
    terms: [{ key: "kayak", n: 2 }], phrases: [{ key: "kayak rental", n: 2 }], kinds: [{ key: "offer", n: 1 }],
    places: [{ key: "30.5,-97.5", n: 1 }], tags: [], note: "",
  },
  mcp: { clients_30d: [{ client: "claude", sessions: 9, days: 3 }], tools_7d: [{ tool: "search", calls: 20 }] },
  routes_7d: [{ route: "GET /api/v1/search", requests: 300 }],
  registration_clients: [{ client: "claude", n: 4 }],
  series_30d: [],
};

test("a snapshot written before a block existed is missing that block, and says so", () => {
  const m = fillMissingBlocks(previousDeployment);
  // Not filled in with an empty window on purpose: "nothing was asked" and "this entry predates the
  // record" are different claims, and only the second is true of an older snapshot. The page reads
  // `m.demand?.last_30d` and has a line for each.
  assert.ok(!("demand" in m), "an absent block stays absent rather than becoming an empty stand-in");
  assert.equal(m.demand, undefined);
});

test("everything else on the page still has something to render", () => {
  const m = fillMissingBlocks(previousDeployment);
  // The reads app/stats/page.tsx makes around the missing block, in the order it makes them.
  assert.equal(m.north_stars.weekly_active_publishers, 12);
  assert.equal(m.metrics.zero_result_rate_7d, 0.22);
  assert.deepEqual(m.series_30d.map((r) => r.day), []);
  assert.deepEqual(m.unmet_demand.phrases.slice(0, 8).map((t) => `${t.key} (${t.n})`), ["kayak rental (2)"]);
  assert.equal(m.mcp.clients_30d.length, 1);
  assert.equal(m.board.open_reports, 0);
  assert.equal(m.funnel.registered, 40);
});

test("an entry from far enough back to be missing every block still fills in", () => {
  // Not a shape any deployment wrote, but the one that proves no read can be left standing on
  // nothing: an empty block renders as the "none yet" the page already has for a quiet week.
  const m = fillMissingBlocks({});
  assert.deepEqual(m.series_30d, []);
  assert.deepEqual(m.routes_7d, []);
  assert.deepEqual(m.registration_clients, []);
  assert.deepEqual(m.mcp, { clients_30d: [], tools_7d: [] });
  assert.deepEqual(m.unmet_demand.terms, []);
  assert.deepEqual(m.unmet_demand.tags, []);
  assert.equal(m.north_stars.weekly_active_publishers, 0);
  assert.equal(m.metrics.searches_per_day_7d, undefined, "an absent number stays absent, and the page prints a dash for it");
  assert.equal(m.generated_at, "");
});

test("a current snapshot passes through untouched, block for block", () => {
  // The safety net may not change what the page renders when there is nothing to catch: every block
  // the caller had comes back as the same object, not a copy and not a merge.
  const current: CachedSnapshot = { ...previousDeployment, demand: { last_7d: foldDemand([]), last_30d: foldDemand([]), note: "" } };
  const m = fillMissingBlocks(current);
  for (const key of Object.keys(current) as (keyof CachedSnapshot)[]) {
    assert.ok(Object.is(m[key], current[key]), `${key} was not passed through as it was`);
  }
  assert.deepEqual(Object.keys(m).sort(), Object.keys(current).sort(), "and no block is invented");
});
