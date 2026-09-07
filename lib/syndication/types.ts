import type { Kind } from "../posts";

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

export type AdapterContext = { now: Date; horizonEnd: Date; signal: AbortSignal };
export type Adapter = (source: SourceRow, ctx: AdapterContext) => Promise<Item[]>;

export const UA = "Crier-Syndication/1.0 (+https://crier.network/llms.txt; hello@crier.network)";

export async function fetchText(url: string, ctx: AdapterContext, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*", ...headers }, signal: ctx.signal, redirect: "follow" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

export async function fetchJson<T>(url: string, ctx: AdapterContext, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctx.signal, redirect: "follow" });
  if (!res.ok) throw new Error(`${url.replace(/apikey=[^&]+/, "apikey=…")} -> HTTP ${res.status}`);
  return (await res.json()) as T;
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
