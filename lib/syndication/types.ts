import type { Kind } from "../posts";
import { clipText } from "./feeds.ts";
import { FetchFailure } from "./walk.ts";

/** The adapters a new source may name; lib/syndication/adapters.ts has one for each. */
export const ADAPTER_NAMES = ["ticketmaster", "ical", "rss", "localist"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export type SourceRow = {
  id: string;
  name: string;
  /**
   * An `AdapterName`, or a removed adapter's name on a disabled row kept as provenance for what it
   * relayed. `adapterFor` in lib/syndication/adapters.ts tells the two apart.
   */
  adapter: string;
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
  /**
   * Other identities this item's row may be stored under, for an item standing for several
   * upstream records (lib/syndication/aliases.ts). The runner finds a row by uid or any alias and
   * keeps the stored uid. Set by the Ticketmaster adapter, and by the iCalendar adapter on an item
   * with a link, whose alias is its raw UID.
   */
  aliases?: string[];
  /**
   * The identity the instances of one repeating event share when their links do not show it, set
   * by the iCalendar adapter under `fold_repeats` (`seriesKey` in lib/syndication/adapters.ts). The
   * fold groups on it instead of the link, and the folded item is stored under it.
   */
  series?: string;
  /**
   * Content flags (lib/flags.ts) the adapter found in upstream text that the item's own text no
   * longer shows, such as an instruction tag removed with the description's HTML. The runner adds
   * them to the flags the post computes from its title and body.
   */
  flags?: string[];
};

/** The relay policy's ceiling on writes per source per run, whatever the row says. */
export const MAX_PER_RUN_CAP = 100;

/** The relay policy's ceiling on how far ahead a source may relay, in days. */
export const HORIZON_DAYS_CAP = 30;

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

/** The most a fetched response body may hold, in bytes as served (after any decompression): 8 MiB. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The body as UTF-8 text, as `Response.text()` reads it, read in chunks and refused once it passes
 * `max` bytes: a run fails on an oversized feed rather than holding it in memory or relaying a
 * truncated one. A declared `Content-Length` over `max` is refused before reading. Either way the
 * body is cancelled, which releases the connection. `progress.bytes` counts what was read, for a
 * caller whose read is aborted part way.
 */
export async function readCapped(res: Response, max = MAX_BODY_BYTES, progress: { bytes: number } = { bytes: 0 }): Promise<string> {
  const over = () => new Error(`response body is over the ${max}-byte cap; not read further`);
  if (Number(res.headers.get("content-length")) > max) { await res.body?.cancel().catch(() => {}); throw over(); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    progress.bytes += value.byteLength;
    if (progress.bytes > max) { await reader.cancel().catch(() => {}); throw over(); }
    text += decoder.decode(value, { stream: true });
  }
}

/** GET with the run's signal. Every failure, an abort and an oversized body included, is a FetchFailure naming the URL, elapsed ms and status. */
async function get<T>(url: string, ctx: AdapterContext, headers: Record<string, string>, read: (body: string) => T): Promise<T> {
  const t0 = Date.now();
  let status: number | undefined;
  const progress = { bytes: 0 };
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctx.signal, redirect: "follow" });
    status = res.status;
    if (!res.ok) throw new FetchFailure({ url, status, ms: Date.now() - t0 });
    return read(await readCapped(res, MAX_BODY_BYTES, progress));
  } catch (e) {
    throw FetchFailure.from(e, { url, status, ms: Date.now() - t0, bytes: progress.bytes });
  }
}

export function fetchText(url: string, ctx: AdapterContext, headers: Record<string, string> = {}): Promise<string> {
  return get(url, ctx, { Accept: "*/*", ...headers }, (body) => body);
}

export function fetchJson<T>(url: string, ctx: AdapterContext, headers: Record<string, string> = {}): Promise<T> {
  return get(url, ctx, { Accept: "application/json", ...headers }, (body) => JSON.parse(body) as T);
}

/** Strip HTML, decode common entities, collapse whitespace, truncate on a word boundary. */
export function plainText(s: string | null | undefined, max = 600): string {
  if (!s) return "";
  // No tag ends past the last ">", and the tag pattern is quadratic on a run of "<" with none after it.
  const tagsEnd = s.lastIndexOf(">") + 1;
  let t = s.slice(0, tagsEnd).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ") + s.slice(tagsEnd);
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
  return clipText(t, max);
}

export function inHorizon(startsAt: string | undefined, ctx: AdapterContext): boolean {
  if (!startsAt) return true;
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return false;
  return t <= ctx.horizonEnd.getTime() && t >= ctx.now.getTime() - 6 * 3600e3;
}
