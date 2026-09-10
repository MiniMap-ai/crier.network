#!/usr/bin/env node
/**
 * Post-deploy check for the 504-wedge fix: everything that has to be confirmed over HTTP, in one
 * run, ending in a block you can paste back.
 *
 * It does three things:
 *   1. The burst — 50 concurrent /p/<id> over 20 distinct posts plus 5 × /, all with a crawler
 *      user agent. Every response must be 200 or 503 inside the deadline. This is the regression.
 *   2. The pages, one at a time: /, /p/<id>, /stats, /publishers/<id>, and the JSON surfaces.
 *   3. Two classified page views — one browser user agent, one crawler — so `page:human` and
 *      `page:crawler` in daily_counters have something to move on. It cannot read those counters
 *      back itself (/api/v1/metrics is cached for a minute, so a before/after inside one run would
 *      compare a snapshot with itself); read them from the database against the baseline instead.
 *
 *   node scripts/verify-deploy.mjs --base https://crier.network
 *   node scripts/verify-deploy.mjs --base <preview-url> --bypass <protection-bypass-secret>
 *
 * Exits 0 only if the burst passes and every single fetch answers 200.
 */
import { BROWSER_UA, CRAWLER_UA, OK_STATUSES, bypassHeaders, fetchPostIds, parseArgs, runBurst, timed } from "./burst.mjs";

const args = parseArgs();
const BASE = (args.get("base") || process.env.CRIER_BASE_URL || "https://crier.network").replace(/\/$/, "");
const DEADLINE = Number(args.get("deadline") || 10_000);
const headers = bypassHeaders(args.get("bypass"));
const started = new Date().toISOString();

const ids = await fetchPostIds(BASE, Number(args.get("ids") || 20), { headers });

// 1. The burst.
console.log(`[1/3] burst: 55 concurrent requests to ${BASE} over ${ids.length} distinct posts, deadline ${DEADLINE} ms`);
const burst = await runBurst({ base: BASE, ids, deadline: DEADLINE, headers });
console.log(`      statuses ${Object.entries(burst.byStatus).map(([s, n]) => `${s}×${n}`).join(", ")} · median ${burst.median_ms} ms · p95 ${burst.p95_ms} ms · slowest ${burst.slowest_ms} ms · wall ${burst.wall_ms} ms`);
for (const b of burst.bad.slice(0, 10)) console.error(`      ${b.status} ${b.path} after ${b.ms} ms${b.detail ? " — " + b.detail : ""}`);

// 2. The pages and JSON surfaces, one at a time, so a single slow route is visible on its own.
const publisher = await (async () => {
  const res = await fetch(`${BASE}/api/v1/posts/${ids[0]}`, { headers: { accept: "application/json", ...headers } });
  const body = await res.json().catch(() => ({}));
  return body?.data?.publisher?.id ?? null;
})();

const singles = [
  { path: "/", ua: BROWSER_UA },
  { path: "/", ua: CRAWLER_UA },
  { path: `/p/${ids[0]}`, ua: BROWSER_UA },     // a browser view also exercises the view bump
  { path: `/p/${ids[0]}`, ua: CRAWLER_UA },
  { path: "/stats", ua: BROWSER_UA },
  ...(publisher ? [{ path: `/publishers/${publisher}`, ua: BROWSER_UA }] : []),
  { path: "/api/v1/board", ua: BROWSER_UA, accept: "application/json" },
  { path: `/api/v1/posts/${ids[0]}`, ua: BROWSER_UA, accept: "application/json" },
  { path: "/api/v1/search?limit=5", ua: BROWSER_UA, accept: "application/json" },
  { path: "/feed.xml", ua: CRAWLER_UA, accept: "application/rss+xml" },
];

console.log(`[2/3] pages and JSON, one at a time`);
const results = [];
for (const s of singles) {
  const r = await timed(BASE, s.path, { ua: s.ua, accept: s.accept ?? "text/html", deadline: DEADLINE, headers });
  results.push(r);
  console.log(`      ${String(r.status).padEnd(7)} ${String(r.ms).padStart(6)} ms  ${r.ua.padEnd(7)} ${r.path}${r.detail ? "  — " + r.detail : ""}`);
}

// 3. Let the counters land: they are batched in-process and written after the response.
console.log(`[3/3] waiting 8 s for the metrics flush to land`);
await new Promise((r) => setTimeout(r, 8000));

const badSingles = results.filter((r) => r.status !== 200);
const pass = burst.bad.length === 0 && burst.slow.length === 0 && badSingles.length === 0;

console.log(`\n${pass ? "PASS" : "FAIL"}: burst ${burst.bad.length === 0 && burst.slow.length === 0 ? "clean" : "had failures"}, ${results.length - badSingles.length}/${results.length} single fetches answered 200.`);
console.log("\n----- paste everything below back -----");
console.log(JSON.stringify({
  base: BASE,
  started,
  finished: new Date().toISOString(),
  deadline_ms: DEADLINE,
  pass,
  burst: {
    requests: burst.requests,
    distinct_posts: burst.distinct_posts,
    statuses: burst.byStatus,
    median_ms: burst.median_ms,
    p95_ms: burst.p95_ms,
    slowest_ms: burst.slowest_ms,
    wall_ms: burst.wall_ms,
    failures: burst.bad.map(({ path, status, ms, detail }) => ({ path, status, ms, detail })),
    past_deadline: burst.slow.length,
  },
  singles: results.map(({ path, ua, status, ms, detail }) => ({ path, ua, status, ms, detail })),
  post_ids_used: ids,
}, null, 2));
console.log("----- end -----");

process.exit(pass ? 0 : 1);
