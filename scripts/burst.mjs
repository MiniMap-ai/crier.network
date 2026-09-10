#!/usr/bin/env node
/**
 * Burst check: the shape of traffic that wedged the site on 2026-09-10.
 *
 * Fires a crawl-sized burst of concurrent page requests — many distinct /p/<id> pages plus the
 * homepage — and asserts the one property that failed that day: every request answers, quickly.
 * A 503 is a pass. A hang is not, and neither is a 5xx that is not a 503, because the whole point of
 * the timeout wrapper and the maxDuration exports is that a bad minute costs seconds, not minutes.
 *
 *   node scripts/burst.mjs                                   # against production
 *   node scripts/burst.mjs --base http://localhost:3000
 *   node scripts/burst.mjs --base <preview-url> --posts 50 --ids 20 --deadline 10000
 *
 * Exits non-zero if anything hangs past the deadline or answers with something other than 200/503.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);

const BASE = (args.get("base") || process.env.CRIER_BASE_URL || "https://crier.network").replace(/\/$/, "");
const IDS = Number(args.get("ids") || 20);
const POSTS = Number(args.get("posts") || 50);
const HOMES = Number(args.get("homes") || 5);
const DEADLINE = Number(args.get("deadline") || 10_000);
const CRAWLER_UA = args.get("ua") || "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const OK_STATUSES = new Set([200, 503]);

async function postIds(n) {
  const res = await fetch(`${BASE}/api/v1/search?limit=${n}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`could not list posts: ${res.status} ${res.statusText}`);
  const body = await res.json();
  const ids = (body.data ?? []).map((p) => p.id).filter(Boolean);
  if (ids.length === 0) throw new Error("the board returned no posts to fetch");
  return ids;
}

async function timed(path) {
  const started = performance.now();
  const abort = new AbortController();
  const cutoff = setTimeout(() => abort.abort(), DEADLINE);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "user-agent": CRAWLER_UA, accept: "text/html" },
      signal: abort.signal,
      redirect: "manual",
    });
    await res.arrayBuffer();   // a status without a body read is not a served request
    return { path, status: res.status, ms: Math.round(performance.now() - started) };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    return { path, status: abort.signal.aborted ? "TIMEOUT" : "ERROR", ms, detail: String(e.message || e) };
  } finally {
    clearTimeout(cutoff);
  }
}

const ids = await postIds(IDS);
const paths = [
  ...Array.from({ length: POSTS }, (_, i) => `/p/${ids[i % ids.length]}`),
  ...Array.from({ length: HOMES }, () => "/"),
];

console.log(`burst: ${paths.length} concurrent requests to ${BASE} over ${ids.length} distinct posts, deadline ${DEADLINE} ms`);
const wall = performance.now();
const results = await Promise.all(paths.map(timed));   // all at once, which is what a crawler does
const elapsed = Math.round(performance.now() - wall);

const byStatus = new Map();
for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];

console.log(`statuses: ${[...byStatus.entries()].map(([s, n]) => `${s}×${n}`).join(", ")}`);
console.log(`latency:  median ${at(0.5)} ms · p95 ${at(0.95)} ms · slowest ${times[times.length - 1]} ms · wall ${elapsed} ms`);

const bad = results.filter((r) => !OK_STATUSES.has(r.status));
const slow = results.filter((r) => r.ms > DEADLINE);
for (const r of bad.slice(0, 10)) console.error(`  ${r.status} ${r.path} after ${r.ms} ms${r.detail ? " — " + r.detail : ""}`);

if (bad.length === 0 && slow.length === 0) {
  console.log(`PASS: every request answered 200 or 503 inside ${DEADLINE} ms.`);
  process.exit(0);
}
console.error(`FAIL: ${bad.length} unexpected status${bad.length === 1 ? "" : "es"}, ${slow.length} past the deadline.`);
process.exit(1);
