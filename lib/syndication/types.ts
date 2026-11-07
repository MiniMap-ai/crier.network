import type { Kind } from "../posts";
import { FetchFailure } from "./walk.ts";

export type SourceRow = {
  id: string;
  name: string;
  adapter: "ticketmaster" | "ical" | "rss" | "localist" | "nws";
  config: Record<string, unknown>;
  homepage: string | null;
  license: string;
  default_kind: Exclude<Kind, "thread">;
  tags: string[];
  enabled: boolean;
  run_every_minutes: number;
  max_per_run: number;
  horizon_days: number;
  added_by: string;
  notes: string | null;
  created_at: Date;
  last_run_at: Date | null;
  last_status: string | null;
  last_error: string | null;
  last_counts: Record<string, number> | null;
};

/** One relayable thing from a source. Everything optional except uid, title, body. */
export type Item = {
  uid: string;
  title: string;
  body: string;
  url?: string;
  kind?: Exclude<Kind, "thread">;
  starts_at?: string;
  ends_at?: string;
  timezone?: string;
  location?: { name?: string; lat?: number; lng?: number };
  tags?: string[];
  expires_at?: string;
  cancelled?: boolean;
  metadata?: Record<string, unknown>;
};

/** The relay policy's ceiling on writes per source per run, whatever the row says. */
export const MAX_PER_RUN_CAP = 100;

/** How many posts one run of this source may create or update: the row's value, capped by policy. */
export function runLimit(source: Pick<SourceRow, "max_per_run">): number {
  return Math.max(0, Math.min(source.max_per_run, MAX_PER_RUN_CAP));
}

/**
 * `signal` aborts any fetch still running when the run's fetch budget is spent; `fetchUntil` is
 * that same moment in epoch ms, for an adapter that pages and should not start a page it cannot
 * finish. Absent, the adapter has no deadline but the signal.
 */
export type AdapterContext = { now: Date; horizonEnd: Date; signal: AbortSignal; fetchUntil?: number };

/**
 * What an adapter read. `note` says why a walk ended before the feed did, for `source_runs.error`.
 * `coveredBefore` is set when the feed was not read to its end: items starting before it were all
 * in the pages read, and the runner judges only those as missing.
 */
export type Fetched = { items: Item[]; note?: string; coveredBefore?: string };
export type Adapter = (source: SourceRow, ctx: AdapterContext) => Promise<Item[] | Fetched>;

/** Either return shape as Fetched. */
export function asFetched(r: Item[] | Fetched): Fetched {
  return Array.isArray(r) ? { items: r } : r;
}

export const UA = "Crier-Syndication/1.0 (+https://crier.network/llms.txt; hello@crier.network)";

/** GET with the run's signal. Every failure, an abort included, is a FetchFailure naming the URL, elapsed ms and status. */
async function get<T>(url: string, ctx: AdapterContext, headers: Record<string, string>, read: (res: Response) => Promise<T>): Promise<T> {
  const t0 = Date.now();
  let status: number | undefined;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctx.signal, redirect: "follow" });
    status = res.status;
    if (!res.ok) throw new FetchFailure({ url, status, ms: Date.now() - t0 });
    return await read(res);
  } catch (e) {
    throw FetchFailure.from(e, { url, status, ms: Date.now() - t0 });
  }
}

export function fetchText(url: string, ctx: AdapterContext, headers: Record<string, string> = {}): Promise<string> {
  return get(url, ctx, { Accept: "*/*", ...headers }, (res) => res.text());
}

export function fetchJson<T>(url: string, ctx: AdapterContext, headers: Record<string, string> = {}): Promise<T> {
  return get(url, ctx, { Accept: "application/json", ...headers }, async (res) => (await res.json()) as T);
}

/** Strip HTML, decode common entities, collapse whitespace, truncate on a word boundary. */
export function plainText(s: string | null | undefined, max = 600): string {
  if (!s) return "";
  let t = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ");
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  t = t.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return t;
}

export function inHorizon(startsAt: string | undefined, ctx: AdapterContext): boolean {
  if (!startsAt) return true;
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return false;
  return t <= ctx.horizonEnd.getTime() && t >= ctx.now.getTime() - 6 * 3600e3;
}
