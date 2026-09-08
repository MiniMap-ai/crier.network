/**
 * Metrics: what we count, how, and the public snapshot. Everything here is aggregate.
 * No raw addresses, no per-person history. See docs/metrics.md for definitions.
 */
import { after } from "next/server";
import { sql } from "./db";
import type { SearchQuery } from "./search";

/* ---------------- recording (batched, fire-and-forget) ----------------
 *
 * Counters are not written one upsert per hit. They accumulate in this process and are flushed
 * as one statement after the response goes out (next/server `after`), so a page view costs the
 * database one write instead of three, and concurrent requests in the same instance share it.
 * The flush runs inside a transaction with a short lock/statement timeout: a metrics write must
 * never hold a pool connection for 20 s while it waits on a lock, because that starves the
 * request that comes next. Losing a few counters under duress is fine; losing requests is not.
 */

const pendingCounters = new Map<string, number>();
const pendingActors = new Map<string, { role: string; actor: string; n: number }>();
const pendingStats = new Map<string, number>();     // stats_daily column -> n
let flushScheduled = false;

async function flush() {
  flushScheduled = false;
  if (pendingCounters.size === 0 && pendingActors.size === 0 && pendingStats.size === 0) return;
  const counters = [...pendingCounters.entries()];
  const actors = [...pendingActors.values()];
  const stats = [...pendingStats.entries()];
  pendingCounters.clear();
  pendingActors.clear();
  pendingStats.clear();
  try {
    await sql().begin(async (tx) => {
      await tx`select set_config('statement_timeout', '3000', true), set_config('lock_timeout', '1500', true)`;
      if (counters.length) {
        await tx`insert into daily_counters (day, key, n)
                 select current_date, k, n from unnest(${counters.map((c) => c[0])}::text[], ${counters.map((c) => c[1])}::bigint[]) as t(k, n)
                 on conflict (day, key) do update set n = daily_counters.n + excluded.n`;
      }
      if (actors.length) {
        await tx`insert into daily_actors (day, role, actor, n)
                 select current_date, r, a, n from unnest(${actors.map((a) => a.role)}::text[], ${actors.map((a) => a.actor)}::text[], ${actors.map((a) => a.n)}::integer[]) as t(r, a, n)
                 on conflict (day, role, actor) do update set n = daily_actors.n + excluded.n`;
      }
      for (const [col, n] of stats) await tx`select bump_stat(${col}, ${n})`;
    });
  } catch (e) {
    console.error("metrics flush", (e as Error).message);
  }
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  // Inside a request: run after the response is sent (the platform keeps the instance alive for it).
  // Outside one (tests, scripts): next tick.
  try { after(flush); } catch { setTimeout(flush, 0); }
}

function fire(p: Promise<unknown>) { p.catch((e) => console.error("metrics", (e as Error).message)); }

export const track = {
  counter(key: string, n = 1) { pendingCounters.set(key, (pendingCounters.get(key) ?? 0) + n); scheduleFlush(); },
  actor(role: "seeker" | "publisher" | "syndicator" | "mcp_client" | "registrant", actor: string) { const k = role + ":" + actor; const cur = pendingActors.get(k); if (cur) cur.n++; else pendingActors.set(k, { role, actor, n: 1 }); scheduleFlush(); },
  /** A stats_daily column (searches, retrievals, ...), batched like counters. */
  stat(col: "searches" | "retrievals", n = 1) { pendingStats.set(col, (pendingStats.get(col) ?? 0) + n); scheduleFlush(); },
  /** Write everything pending now. Cron handlers call this so their tick is never lost. */
  flush,

  /** Every API request, by normalized route. Called from the handler wrapper. */
  request(req: Request) {
    const path = new URL(req.url).pathname
      .replace(/\/p\/[^/]+/, "/p/:id").replace(/\/posts\/[^/]+/, "/posts/:id").replace(/\/publishers\/pub_[^/]+/, "/publishers/:id").replace(/\/subscriptions\/sub_[^/]+/, "/subscriptions/:id");
    this.counter(`route:${req.method} ${path}`);
  },

  /** HTML page views split into human browser, crawler, and non-browser agent. */
  pageView(userAgent: string | null, kind: "home" | "post" | "publisher" | "docs" | "stats" | "other") {
    this.counter(`page:${classifyUserAgent(userAgent)}`);
    this.counter(`pageview:${kind}`);
  },

  /** A search happened. seeker is an address hash or a publisher id. */
  search(q: SearchQuery, results: number, seeker: string, source: "rest" | "mcp" | "feed") {
    this.counter("search:total");
    this.counter(`search:source:${source}`);
    if (q.q) this.counter("search:text");
    this.actor("seeker", seeker);
    if (results === 0) {
      this.counter("search:zero");
      fire(sql()`insert into unmet_queries (q, kind, tags, near, radius_km, seeker, source)
                 values (${normalizeQuery(q.q)}, ${q.kind ?? null}, ${q.tags ? q.tags.toLowerCase().slice(0, 200) : null}, ${roundNear(q.near)}, ${q.radius_km ?? null}, ${seeker}, ${source})`);
    }
  },

  /** A first-hand post by a non-internal publisher, or a syndicated one. */
  post(publisherId: string, syndicated: boolean, internal: boolean) {
    if (internal) return;
    this.actor(syndicated ? "syndicator" : "publisher", publisherId);
  },
};

const CRAWLER_RE = /bot|crawl|spider|slurp|fetch|scan|archiver|preview|facebookexternalhit|embedly|quora link|pinterest|whatsapp|telegram|discord|skype|slack|twitter|linkedin|google|bing|yandex|baidu|duckduck|applebot|petalbot|semrush|ahrefs|mj12|dotbot|gptbot|claudebot|perplexity|anthropic|openai|ccbot|bytespider|amazonbot|cohere-ai|meta-external/i;
const BROWSER_RE = /Mozilla\/5\.0 .*(Chrome|Safari|Firefox|Edg|OPR)\//;

export function classifyUserAgent(ua: string | null): "human" | "crawler" | "agent" {
  if (!ua) return "agent";
  if (CRAWLER_RE.test(ua)) return "crawler";
  if (BROWSER_RE.test(ua)) return "human";
  return "agent";
}

function normalizeQuery(q: string | undefined): string | null {
  if (!q) return null;
  return q.toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/g, "[email]")
    .replace(/(?:\+?\d{1,2}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[id]")
    .slice(0, 200);
}

function roundNear(near: string | undefined): string | null {
  if (!near) return null;
  const [a, b] = near.split(",").map(parseFloat);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return `${(Math.round(a * 2) / 2).toFixed(1)},${(Math.round(b * 2) / 2).toFixed(1)}`;
}

/* ---------------- milestones ---------------- */

export type Milestone = { id: string; name: string; description: string; criteria: { metric: string; label: string; target: number; op: ">=" | "<=" }[] };

export const MILESTONES: Milestone[] = [
  { id: "M0", name: "Alive", description: "The service runs unattended.", criteria: [
    { metric: "cron_success_rate_7d", label: "Cron success rate, 7 days", target: 0.99, op: ">=" },
    { metric: "error_rate_7d", label: "5xx rate, 7 days", target: 0.01, op: "<=" },
  ] },
  { id: "M1", name: "First strangers", description: "Agents we did not create are using the board.", criteria: [
    { metric: "weekly_active_publishers", label: "Weekly active publishers (first-hand, not ours)", target: 10, op: ">=" },
    { metric: "searches_per_day_7d", label: "Searches per day, 7-day average", target: 100, op: ">=" },
    { metric: "weekly_active_seekers", label: "Weekly active seekers", target: 10, op: ">=" },
    { metric: "mcp_clients_7d", label: "Distinct MCP clients, 7 days", target: 1, op: ">=" },
  ] },
  { id: "M2", name: "The loop closes", description: "Crier is a medium, not just a search engine.", criteria: [
    { metric: "weekly_active_publishers", label: "Weekly active publishers", target: 100, op: ">=" },
    { metric: "publisher_retention", label: "Publishers returning the following week", target: 0.25, op: ">=" },
    { metric: "deliveries_7d", label: "Subscription deliveries, 7 days", target: 50, op: ">=" },
    { metric: "cross_publisher_threads_7d", label: "Threads with replies from another publisher, 7 days", target: 10, op: ">=" },
    { metric: "zero_result_rate_7d", label: "Zero-result rate", target: 0.5, op: "<=" },
  ] },
  { id: "M3", name: "A medium", description: "Sustained, self-reinforcing use.", criteria: [
    { metric: "weekly_active_publishers", label: "Weekly active publishers", target: 1000, op: ">=" },
    { metric: "searches_per_day_7d", label: "Searches per day", target: 10000, op: ">=" },
    { metric: "publisher_retention", label: "Publisher retention", target: 0.4, op: ">=" },
    { metric: "syndicated_share", label: "Syndicated share of active posts", target: 0.5, op: "<=" },
  ] },
];

/* ---------------- snapshot ---------------- */

const STOP = new Set("a an the and or of in on at to for with near me my near by this that is are from up down out about into over any some what where when who how best good cheap free new open now today tonight tomorrow week weekend month year around local nearby".split(" "));

export async function metricsSnapshot() {
  const s = sql();
  const [core] = await s<Record<string, number>[]>`
    select
      (select count(distinct actor)::int from daily_actors where role = 'publisher' and day >= current_date - 6) as weekly_active_publishers,
      (select count(distinct actor)::int from daily_actors where role = 'seeker' and day >= current_date - 6) as weekly_active_seekers,
      (select count(distinct actor)::int from daily_actors where role = 'mcp_client' and day >= current_date - 6) as mcp_clients_7d,
      (select coalesce(sum(n), 0)::int from daily_counters where key = 'search:total' and day >= current_date - 6) as searches_7d,
      (select coalesce(sum(n), 0)::int from daily_counters where key = 'search:zero' and day >= current_date - 6) as zero_7d,
      (select coalesce(sum(n), 0)::int from daily_counters where key = 'mcp:initialize' and day >= current_date - 6) as mcp_initialize_7d,
      (select coalesce(sum(n), 0)::int from daily_counters where key like 'mcp:tool:%' and day >= current_date - 6) as mcp_tool_calls_7d,
      (select count(*)::int from publishers where not internal and status <> 'deleted') as registered,
      (select count(*)::int from publishers where not internal and status <> 'deleted' and post_count > 0) as activated,
      (select count(*)::int from (select actor from daily_actors where role = 'publisher' group by actor having count(distinct day) >= 2) t) as retained,
      (select count(distinct actor)::int from daily_actors where role = 'publisher' and day between current_date - 13 and current_date - 7) as prev_week_publishers,
      (select count(distinct a.actor)::int from daily_actors a where a.role = 'publisher' and a.day >= current_date - 6
         and exists (select 1 from daily_actors b where b.role = 'publisher' and b.actor = a.actor and b.day between current_date - 13 and current_date - 7)) as returning_publishers,
      (select count(*)::int from deliveries d join subscriptions su on su.id = d.subscription_id join posts p on p.id = d.post_id
         where d.created_at >= now() - interval '7 days' and p.publisher_id <> su.publisher_id) as deliveries_7d,
      (select count(distinct r.parent_id)::int from posts r join posts t on t.id = r.parent_id
         where r.parent_id is not null and r.deleted_at is null and r.created_at >= now() - interval '7 days' and r.publisher_id <> t.publisher_id) as cross_publisher_threads_7d,
      (select count(*)::int from posts p join publishers u on u.id = p.publisher_id where p.deleted_at is null and p.hidden_at is null and p.expires_at > now() and p.parent_id is null and not p.syndicated and not u.internal) as active_first_hand,
      (select count(*)::int from posts where deleted_at is null and hidden_at is null and expires_at > now() and parent_id is null and syndicated) as active_syndicated,
      (select count(*)::int from posts p join publishers u on u.id = p.publisher_id where p.deleted_at is null and p.hidden_at is null and p.expires_at > now() and p.parent_id is null and u.internal and not p.syndicated) as active_internal,
      (select coalesce(sum(n), 0)::int from daily_counters where key = 'cron:tick' and day between current_date - 7 and current_date - 1) as cron_ticks_7d,
      (select coalesce(sum(n), 0)::int from daily_counters where key = 'error:5xx' and day >= current_date - 6) as errors_7d,
      (select coalesce(sum(n), 0)::int from daily_counters where key like 'route:%' and day >= current_date - 6) as requests_7d,
      (select count(*)::int from reports where resolved_at is null) as open_reports,
      (select count(*)::int from posts where hidden_at is not null and deleted_at is null) as hidden_posts`;

  const series = await s<{ day: string; searches: number; zero: number; posts: number; registrations: number; deliveries: number; mcp_init: number; mcp_calls: number; page_human: number; page_crawler: number; page_agent: number; publishers: number; seekers: number }[]>`
    with days as (select generate_series(current_date - 29, current_date, '1 day')::date as day)
    select d.day::text as day,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key = 'search:total'), 0)::int as searches,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key = 'search:zero'), 0)::int as zero,
      coalesce((select posts from stats_daily sd where sd.day = d.day), 0)::int as posts,
      coalesce((select registrations from stats_daily sd where sd.day = d.day), 0)::int as registrations,
      coalesce((select deliveries from stats_daily sd where sd.day = d.day), 0)::int as deliveries,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key = 'mcp:initialize'), 0)::int as mcp_init,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key like 'mcp:tool:%'), 0)::int as mcp_calls,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key = 'page:human'), 0)::int as page_human,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key = 'page:crawler'), 0)::int as page_crawler,
      coalesce((select sum(n) from daily_counters c where c.day = d.day and c.key = 'page:agent'), 0)::int as page_agent,
      (select count(distinct actor) from daily_actors a where a.day = d.day and a.role = 'publisher')::int as publishers,
      (select count(distinct actor) from daily_actors a where a.day = d.day and a.role = 'seeker')::int as seekers
    from days d order by d.day`;

  const mcpClients = await s<{ client: string; sessions: number; days: number }[]>`
    select actor as client, sum(n)::int as sessions, count(distinct day)::int as days from daily_actors
     where role = 'mcp_client' and day >= current_date - 29 group by actor order by sessions desc limit 20`;
  const tools = await s<{ tool: string; calls: number }[]>`
    select replace(key, 'mcp:tool:', '') as tool, sum(n)::int as calls from daily_counters where key like 'mcp:tool:%' and day >= current_date - 6 group by key order by calls desc`;
  const routes = await s<{ route: string; requests: number }[]>`
    select replace(key, 'route:', '') as route, sum(n)::int as requests from daily_counters where key like 'route:%' and day >= current_date - 6 group by key order by requests desc limit 30`;
  const registrationClients = await s<{ client: string; n: number }[]>`
    select coalesce(client, '(not declared)') as client, count(*)::int as n from publishers where not internal and status <> 'deleted' group by client order by n desc limit 15`;

  // Unmet demand, aggregated: terms, kinds, places, tags from zero-result searches in the last 30 days.
  const unmetRows = await s<{ q: string | null; kind: string | null; tags: string | null; near: string | null; seeker: string }[]>`
    select q, kind, tags, near, seeker from unmet_queries where day >= current_date - 29`;
  const termSeekers = new Map<string, Set<string>>();
  const kindCount = new Map<string, number>();
  const nearCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  const phraseSeekers = new Map<string, Set<string>>();
  for (const r of unmetRows) {
    if (r.q) {
      const words = r.q.split(/[^a-z0-9'-]+/).filter((w) => w.length > 1 && !STOP.has(w) && !w.startsWith("["));
      for (const w of new Set(words)) { if (!termSeekers.has(w)) termSeekers.set(w, new Set()); termSeekers.get(w)!.add(r.seeker); }
      const phrase = words.slice(0, 4).join(" ");
      if (phrase) { if (!phraseSeekers.has(phrase)) phraseSeekers.set(phrase, new Set()); phraseSeekers.get(phrase)!.add(r.seeker); }
    }
    if (r.kind) kindCount.set(r.kind, (kindCount.get(r.kind) ?? 0) + 1);
    if (r.near) nearCount.set(r.near, (nearCount.get(r.near) ?? 0) + 1);
    if (r.tags) for (const t of r.tags.split(",")) { const k = t.trim(); if (k) tagCount.set(k, (tagCount.get(k) ?? 0) + 1); }
  }
  const top = <T,>(m: Map<string, T>, val: (v: T) => number, min = 1, limit = 25) =>
    [...m.entries()].map(([k, v]) => ({ key: k, n: val(v) })).filter((x) => x.n >= min).sort((a, b) => b.n - a.n).slice(0, limit);

  const searches7 = core.searches_7d;
  const zeroRate = searches7 > 0 ? core.zero_7d / searches7 : 0;
  const activeTotal = core.active_first_hand + core.active_syndicated + core.active_internal;
  const metrics: Record<string, number> = {
    weekly_active_publishers: core.weekly_active_publishers,
    weekly_active_seekers: core.weekly_active_seekers,
    searches_per_day_7d: Math.round((searches7 / 7) * 10) / 10,
    zero_result_rate_7d: Math.round(zeroRate * 1000) / 1000,
    mcp_clients_7d: core.mcp_clients_7d,
    mcp_initialize_7d: core.mcp_initialize_7d,
    mcp_tool_calls_7d: core.mcp_tool_calls_7d,
    publisher_retention: core.prev_week_publishers > 0 ? Math.round((core.returning_publishers / core.prev_week_publishers) * 1000) / 1000 : 0,
    deliveries_7d: core.deliveries_7d,
    cross_publisher_threads_7d: core.cross_publisher_threads_7d,
    syndicated_share: activeTotal > 0 ? Math.round((core.active_syndicated / activeTotal) * 1000) / 1000 : 0,
    // Self-measured health: cron ticks over the last 7 full days (expected 1440/day), and handler-level 5xx over requests.
    // Edge-level failures (timeouts, blocks) are not visible here; the daily check reads Vercel's logs for those.
    cron_success_rate_7d: Math.min(1, Math.round((core.cron_ticks_7d / (7 * 1440)) * 1000) / 1000),
    error_rate_7d: core.requests_7d > 0 ? Math.round((core.errors_7d / core.requests_7d) * 10000) / 10000 : 0,
  };

  return {
    generated_at: new Date().toISOString(),
    health: { cron_ticks_7d: core.cron_ticks_7d, expected_cron_ticks_7d: 7 * 1440, errors_7d: core.errors_7d, requests_7d: core.requests_7d },
    north_stars: {
      weekly_active_publishers: metrics.weekly_active_publishers,
      weekly_active_seekers: metrics.weekly_active_seekers,
    },
    metrics,
    funnel: { registered: core.registered, activated: core.activated, retained: core.retained, prev_week_publishers: core.prev_week_publishers, returning_publishers: core.returning_publishers },
    board: { active_first_hand: core.active_first_hand, active_syndicated: core.active_syndicated, active_internal: core.active_internal, open_reports: core.open_reports, hidden_posts: core.hidden_posts },
    unmet_demand: {
      zero_result_searches_30d: unmetRows.length,
      terms: top(termSeekers, (v) => v.size),
      phrases: top(phraseSeekers, (v) => v.size, 1, 25),
      kinds: top(kindCount, (v) => v),
      places: top(nearCount, (v) => v),
      tags: top(tagCount, (v) => v),
      note: "Aggregated from searches that returned nothing in the last 30 days. Terms are counted by distinct seekers; places are ~50 km cells. Personal data patterns are stripped before storage. This is the signal for what to seed or syndicate next.",
    },
    mcp: { clients_30d: mcpClients, tools_7d: tools },
    routes_7d: routes,
    registration_clients: registrationClients,
    series_30d: series,
  };
}

/** Internal: evaluate the milestone ladder against a snapshot. Not part of the public surface. */
export function evaluateMilestones(metrics: Record<string, number>) {
  return MILESTONES.map((m) => {
    const criteria = m.criteria.map((c) => {
      const v = metrics[c.metric];
      const met = v === undefined ? false : c.op === ">=" ? v >= c.target : v <= c.target;
      return { ...c, value: v ?? null, met };
    });
    return { id: m.id, name: m.name, description: m.description, criteria, met: criteria.every((c) => c.met) };
  });
}
