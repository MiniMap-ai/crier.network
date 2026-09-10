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
 *   node scripts/burst.mjs --base <preview-url> --bypass <protection-bypass-secret>
 *
 * Exits non-zero if anything hangs past the deadline or answers with something other than 200/503.
 * Also exports its pieces for scripts/verify-deploy.mjs and for the daily check.
 */
import { pathToFileURL } from "node:url";

export const CRAWLER_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
export const OK_STATUSES = new Set([200, 503]);

export function parseArgs(argv = process.argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ""), argv[i + 1]);
  return args;
}

/** Vercel's Protection Bypass for Automation, for a preview deployment behind SSO. */
export function bypassHeaders(secret) {
  return secret ? { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" } : {};
}

/** One request, timed, with the deadline enforced client-side so a hang is a result and not a wait. */
export async function timed(base, path, { ua = CRAWLER_UA, accept = "text/html", deadline = 10_000, headers = {} } = {}) {
  const started = performance.now();
  const abort = new AbortController();
  const cutoff = setTimeout(() => abort.abort(), deadline);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { "user-agent": ua, accept, ...headers },
      signal: abort.signal,
      redirect: "manual",   // an SSO redirect is a failure to report, not something to follow
    });
    await res.arrayBuffer();   // a status without a body read is not a served request
    return { path, ua: ua === CRAWLER_UA ? "crawler" : ua === BROWSER_UA ? "browser" : "other", status: res.status, ms: Math.round(performance.now() - started) };
  } catch (e) {
    return {
      path,
      ua: ua === CRAWLER_UA ? "crawler" : ua === BROWSER_UA ? "browser" : "other",
      status: abort.signal.aborted ? "TIMEOUT" : "ERROR",
      ms: Math.round(performance.now() - started),
      detail: String(e?.message || e),
    };
  } finally {
    clearTimeout(cutoff);
  }
}

export async function fetchPostIds(base, n, { headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1/search?limit=${n}`, { headers: { accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`could not list posts: ${res.status} ${res.statusText}`);
  const body = await res.json();
  const ids = (body.data ?? []).map((p) => p.id).filter(Boolean);
  if (ids.length === 0) throw new Error("the board returned no posts to fetch");
  return ids;
}

export function summarize(results) {
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  return { byStatus, median_ms: at(0.5), p95_ms: at(0.95), slowest_ms: times[times.length - 1] };
}

export async function runBurst({ base, ids, posts = 50, homes = 5, deadline = 10_000, ua = CRAWLER_UA, headers = {} }) {
  const paths = [
    ...Array.from({ length: posts }, (_, i) => `/p/${ids[i % ids.length]}`),
    ...Array.from({ length: homes }, () => "/"),
  ];
  const wall = performance.now();
  const results = await Promise.all(paths.map((p) => timed(base, p, { ua, deadline, headers })));   // all at once, which is what a crawler does
  return {
    requests: paths.length,
    distinct_posts: ids.length,
    wall_ms: Math.round(performance.now() - wall),
    ...summarize(results),
    bad: results.filter((r) => !OK_STATUSES.has(r.status)),
    slow: results.filter((r) => r.ms > deadline),
    results,
  };
}

async function main() {
  const args = parseArgs();
  const base = (args.get("base") || process.env.CRIER_BASE_URL || "https://crier.network").replace(/\/$/, "");
  const deadline = Number(args.get("deadline") || 10_000);
  const headers = bypassHeaders(args.get("bypass"));
  const ids = await fetchPostIds(base, Number(args.get("ids") || 20), { headers });

  console.log(`burst: ${Number(args.get("posts") || 50) + Number(args.get("homes") || 5)} concurrent requests to ${base} over ${ids.length} distinct posts, deadline ${deadline} ms`);
  const r = await runBurst({
    base, ids, deadline, headers,
    posts: Number(args.get("posts") || 50),
    homes: Number(args.get("homes") || 5),
    ua: args.get("ua") || CRAWLER_UA,
  });

  console.log(`statuses: ${Object.entries(r.byStatus).map(([s, n]) => `${s}×${n}`).join(", ")}`);
  console.log(`latency:  median ${r.median_ms} ms · p95 ${r.p95_ms} ms · slowest ${r.slowest_ms} ms · wall ${r.wall_ms} ms`);
  for (const b of r.bad.slice(0, 10)) console.error(`  ${b.status} ${b.path} after ${b.ms} ms${b.detail ? " — " + b.detail : ""}`);

  if (r.bad.length === 0 && r.slow.length === 0) {
    console.log(`PASS: every request answered 200 or 503 inside ${deadline} ms.`);
    process.exit(0);
  }
  console.error(`FAIL: ${r.bad.length} unexpected status${r.bad.length === 1 ? "" : "es"}, ${r.slow.length} past the deadline.`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
