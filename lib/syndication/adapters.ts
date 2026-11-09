import { RECURRENCE_CAP } from "./collapse.ts";
import { icalDate, icalText, parseFeed, parseICal } from "./feeds.ts";
import { ticketmasterItem } from "./ticketmaster.ts";
import { fetchJson, fetchText, inHorizon, plainText, runLimit } from "./types.ts";
import { walkNote, walkPages } from "./walk.ts";
// Split out: node's type stripping erases `import type` but cannot spot types inside a mixed list.
import type { Adapter, AdapterContext, Item, SourceRow } from "./types.ts";

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** A point only when both halves are there: half a coordinate pair is not a location. */
const point = (lat: unknown, lng: unknown): { lat: number; lng: number } | undefined => {
  const y = num(lat), x = num(lng);
  return y !== undefined && x !== undefined ? { lat: y, lng: x } : undefined;
};

/* ---------------- Ticketmaster Discovery API ----------------
   config: { lat, lng, radius_km, city (label), segment? ("Music" | "Sports" | "Arts & Theatre" | ...) }
   Terms require attribution and a link back; every post says "Source: Ticketmaster" and links the event.
   Each record maps to one item in ./ticketmaster.ts. */
export const ticketmaster: Adapter = async (source, ctx) => {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) throw new Error("TICKETMASTER_API_KEY is not set");
  const c = source.config;
  const lat = num(c.lat), lng = num(c.lng);
  if (lat === undefined || lng === undefined) throw new Error("config.lat and config.lng are required");
  const radius = Math.min(150, num(c.radius_km) ?? 40);
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const items: Item[] = [];
  const pageSize = 200;
  const maxPages = Math.ceil(runLimit(source) / pageSize);
  for (let page = 0; page < maxPages && page * pageSize < 1000; page++) {
    const params = new URLSearchParams({
      apikey: key, latlong: `${lat},${lng}`, radius: String(Math.round(radius)), unit: "km",
      startDateTime: fmt(ctx.now), endDateTime: fmt(ctx.horizonEnd), size: String(pageSize), page: String(page), sort: "date,asc", locale: "*",
    });
    if (typeof c.segment === "string") params.set("classificationName", c.segment);
    type TM = { _embedded?: { events?: Record<string, unknown>[] }; page?: { totalPages?: number } };
    const data = await fetchJson<TM>(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, ctx);
    const events = data._embedded?.events ?? [];
    for (const e of events) {
      const item = ticketmasterItem(e, source);
      if (item) items.push(item);
    }
    if (events.length < pageSize || (data.page?.totalPages ?? 0) <= page + 1) break;
  }
  return items.filter((i) => inHorizon(i.starts_at, ctx));
};

/* ---------------- iCalendar ----------------
   config: { url, timezone? (default zone for floating times), location_name?, lat?, lng? } */
export const ical: Adapter = async (source, ctx) => {
  const url = str(source.config.url);
  if (!url) throw new Error("config.url is required");
  const text = await fetchText(url, ctx);
  const zone = str(source.config.timezone) || /X-WR-TIMEZONE:([^\r\n]+)/.exec(text)?.[1]?.trim();
  const items: Item[] = [];
  for (const ev of parseICal(text)) {
    const uid = ev.UID?.[0]?.value?.trim(); if (!uid) continue;
    if (ev.RRULE) continue;   // recurring series are not expanded; single instances only
    const st = icalDate(ev.DTSTART?.[0], zone); if (!st) continue;
    const en = icalDate(ev.DTEND?.[0], zone);
    if (ev.STATUS?.[0]?.value?.toUpperCase() === "CANCELLED") { items.push({ uid, title: "cancelled", body: "cancelled", cancelled: true }); continue; }
    const summary = icalText(ev.SUMMARY?.[0]?.value).trim(); if (!summary) continue;
    const desc = plainText(icalText(ev.DESCRIPTION?.[0]?.value), 500);
    const loc = icalText(ev.LOCATION?.[0]?.value).trim();
    const geo = ev.GEO?.[0]?.value?.split(";").map(Number);
    const link = ev.URL?.[0]?.value?.trim();
    items.push({
      uid,
      title: summary.slice(0, 200),
      body: [desc, loc ? `Where: ${loc}` : "", link ? `Details: ${link}` : "", `Source: ${source.name}${source.homepage ? " (" + source.homepage + ")" : ""}, relayed by Crier.`].filter(Boolean).join("\n"),
      url: link || undefined,
      kind: source.default_kind,
      starts_at: st.iso,
      ends_at: en?.iso,
      timezone: zone || undefined,
      location: { name: loc || str(source.config.location_name) || undefined, lat: geo && geo.length === 2 && Number.isFinite(geo[0]) ? geo[0] : num(source.config.lat), lng: geo && geo.length === 2 && Number.isFinite(geo[1]) ? geo[1] : num(source.config.lng) },
      tags: [...source.tags, ...(ev.CATEGORIES?.flatMap((c) => c.value.split(",")) ?? [])].map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40),
      metadata: { source: "ical", all_day: st.allDay },
    });
  }
  return items.filter((i) => i.cancelled || inHorizon(i.starts_at, ctx));
};

/* ---------------- RSS / Atom ----------------
   config: { url, ttl_days? (default 14), location_name?, lat?, lng? }. Items are notices, not timed events. */
export const rss: Adapter = async (source, ctx) => {
  const url = str(source.config.url);
  if (!url) throw new Error("config.url is required");
  const xml = await fetchText(url, ctx);
  const feed = parseFeed(xml);
  const ttlDays = num(source.config.ttl_days) ?? 14;
  const items: Item[] = [];
  for (const it of feed.items) {
    if (!it.id || !it.title) continue;
    const published = it.published ? new Date(it.published) : undefined;
    if (published && !Number.isNaN(published.getTime()) && published.getTime() < ctx.now.getTime() - ttlDays * 86400e3) continue;
    items.push({
      uid: it.id,
      title: plainText(it.title, 200),
      body: [plainText(it.summary, 600), it.link ? `Read more: ${it.link}` : "", `Source: ${source.name}${source.homepage ? " (" + source.homepage + ")" : ""}, relayed by Crier.`].filter(Boolean).join("\n"),
      url: it.link,
      kind: source.default_kind,
      location: { name: str(source.config.location_name) || undefined, lat: num(source.config.lat), lng: num(source.config.lng) },
      tags: [...source.tags, ...it.categories].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40).slice(0, 20),
      expires_at: new Date((published && !Number.isNaN(published.getTime()) ? published.getTime() : ctx.now.getTime()) + ttlDays * 86400e3).toISOString(),
      metadata: { source: "rss", feed_title: feed.title.slice(0, 120), published: it.published },
    });
  }
  return items;
};

/* ---------------- Localist (campus/community calendars) ----------------
   config: { base (e.g. https://events.stanford.edu), location_name?, lat?, lng? } */

/** Localist's way of saying it has no venue. Exact match, not a pattern: "Lincoln Park Campus (Room TBD)" is real. */
const LOCALIST_NO_PLACE = new Set(["sign in to download the location", "tbd"]);

/** True, but not a place. */
const LOCALIST_ONLINE = "online event";

/** Rows per `/api/2/events` page; 100 is the most Localist serves. */
export const LOCALIST_PAGE_SIZE = 100;

/**
 * Rows read per run: five pages. A fetch bound, not a write bound: `max_per_run` caps the posts a
 * run creates or updates, and the rows read past it are what keep the posts already relayed alive.
 */
export const LOCALIST_MAX_ROWS = 500;

/** The first candidate that names a place, or "" if none does. */
function localistPlace(...candidates: unknown[]): string {
  for (const c of candidates) {
    const t = str(c).trim();
    if (t && !LOCALIST_NO_PLACE.has(t.toLowerCase())) return t;
  }
  return "";
}

/**
 * The venue an event names in any of the fields Localist puts one in: `location_name`, then
 * `location`, then `address`, then the geocoded street and city. A room is not a venue and is not
 * read here.
 */
export function localistVenue(e: Record<string, unknown>): string {
  const geo = (e.geo ?? {}) as Record<string, unknown>;
  const street = localistPlace(geo.street);
  return localistPlace(e.location_name, e.location, e.address) || (street ? [street, localistPlace(geo.city)].filter(Boolean).join(", ") : "");
}

/** One instance of a Localist event, as the repeat check sees it. An absent field matches anything. */
export type LocalistInstance = { id: string; title: string; start: string; venue: string; room?: string; end?: string; experience?: string };

const normText = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/** Same venue, or one of them names none, or one name begins the other: "Regis Hall" and "Regis Hall MPR". */
function sameVenue(a: string, b: string): boolean {
  const x = normText(a), y = normText(b);
  if (!x || !y || x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(short) && /^[\s,(-]/.test(long.slice(short.length));
}

/**
 * Whether two instances with one title and one start can be one event. A venue left empty or gated
 * matches any, so the end, the room and the in-person or online mode must not disagree either: two
 * sections in different rooms, or one online and one in person, are two events.
 */
function sameEvent(a: LocalistInstance, b: LocalistInstance): boolean {
  const ends = (x?: string, y?: string) => !x || !y || Date.parse(x) === Date.parse(y);
  const modes = (x?: string, y?: string) => !x || !y || x === y;
  return sameVenue(a.venue, b.venue) && sameVenue(a.room ?? "", b.room ?? "") && ends(a.end, b.end) && modes(a.experience, b.experience);
}

/** Localist ids are decimal strings; shorter is smaller. */
const byId = (a: { id: string }, b: { id: string }) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Drop instances that repeat another event's instance: the same title at the same instant, with
 * nothing in `sameEvent` disagreeing, published as a second event under its own id and URL. The
 * oldest event (the lowest id) is kept, so the choice does not move between runs. Two venues that
 * are both named and differ ("Lake Shore Campus", "Water Tower Campus") are two sessions and both
 * stay, as does anything at a different start: a series stays one row per occurrence. Order is
 * preserved.
 */
export function dropLocalistRepeats<T extends LocalistInstance>(xs: T[]): T[] {
  const kept = new Map<string, T[]>();
  const out = new Set<T>();
  for (const x of [...xs].sort(byId)) {
    const at = Date.parse(x.start);
    const key = `${normText(x.title)}\u0000${Number.isNaN(at) ? x.start : at}`;
    const group = kept.get(key) ?? [];
    if (group.some((k) => k.id === x.id || sameEvent(k, x))) continue;
    group.push(x);
    kept.set(key, group);
    out.add(x);
  }
  return xs.filter((x) => out.has(x));
}

export const localist: Adapter = async (source, ctx) => {
  const base = str(source.config.base).replace(/\/$/, "");
  if (!base) throw new Error("config.base is required");
  type L = { events?: { event: Record<string, unknown> }[]; page?: { total?: number } };
  const urlOf = (page: number) => `${base}/api/2/events?days=${source.horizon_days}&pp=${LOCALIST_PAGE_SIZE}&page=${page}`;
  const walk = await walkPages({
    pageSize: LOCALIST_PAGE_SIZE,
    limit: LOCALIST_MAX_ROWS,
    until: ctx.fetchUntil ?? Infinity,
    urlOf,
    fetchPage: async (page) => {
      const data = await fetchJson<L>(urlOf(page), ctx);
      return { rows: (data.events ?? []).map((x) => x.event), totalPages: num(data.page?.total) };
    },
  });

  type Instance = LocalistInstance & { e: Record<string, unknown>; inst: Record<string, unknown> };
  const instances: Instance[] = [];
  for (const e of walk.rows) {
    const id = String(e.id ?? ""); if (!id) continue;
    const venue = localistVenue(e);
    const room = localistPlace(e.room_number);
    const experience = str(e.experience) || undefined;
    // Five was a brake on how many rows one event could become; the fold is the brake now, so take
    // enough instances to fill the recurrence list it builds (the representative plus the rest).
    for (const x of ((e.event_instances ?? []) as { event_instance: Record<string, unknown> }[]).slice(0, RECURRENCE_CAP + 1)) {
      const inst = x.event_instance;
      const start = str(inst.start); if (!start) continue;
      instances.push({ id, title: plainText(str(e.title), 200), start, venue, room, end: str(inst.end) || undefined, experience, e, inst });
    }
  }

  const items: Item[] = [];
  for (const { id, title, start, venue: place, room, e, inst } of dropLocalistRepeats(instances)) {
    const geo = (e.geo ?? {}) as Record<string, unknown>;
    // Read the name too: DePaul marks online events "inperson".
    const online = str(e.experience) === "virtual" || place.toLowerCase() === LOCALIST_ONLINE;
    // An online event is not at the campus, so it gets neither of the source's fallbacks.
    const named = place || (online ? "" : str(source.config.location_name).trim());
    const where = [named, room].filter(Boolean).join(", ");
    // Upstream has coordinates for about a quarter of events; config.lat/lng covers the rest, as in ical and rss.
    const at = point(geo.latitude, geo.longitude) ?? (online ? undefined : point(source.config.lat, source.config.lng));
    items.push({
      uid: `${id}:${start}`,
      title,
      body: [plainText(str(e.description_text) || str(e.description), 500), where ? `Where: ${where}` : "", `Details: ${str(e.localist_url)}`, `Source: ${source.name}, relayed by Crier.`].filter(Boolean).join("\n"),
      url: str(e.localist_url) || undefined,
      kind: "event",
      starts_at: start,
      ends_at: str(inst.end) || undefined,
      location: { name: named || undefined, lat: at?.lat, lng: at?.lng },
      tags: [...source.tags, ...Object.values((e.filters ?? {}) as Record<string, { name: string }[]>).flat().map((f) => f?.name ?? "")].map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40).slice(0, 20),
      metadata: { source: "localist", all_day: !!inst.all_day, free: e.free },
    });
  }

  return {
    items: items.filter((i) => inHorizon(i.starts_at, ctx)),
    note: walkNote(walk),
    coveredBefore: walk.stop === "end" ? undefined : localistCoveredBefore(walk.rows),
  };
};

/** The epoch: a walk that can vouch for nothing spares every post from the missing-item sweep. */
const COVERS_NOTHING = new Date(0).toISOString();

/**
 * Where a walk that stopped early stops vouching for the feed: the last parseable start among the
 * rows read. Localist serves one row per instance in start order, so every event starting before
 * that was in the pages read. The order is checked, not assumed: rows out of order, or none with a
 * start, vouch for nothing.
 */
export function localistCoveredBefore(rows: Record<string, unknown>[]): string {
  let last = -Infinity;
  for (const row of rows) {
    const inst = ((row.event_instances ?? []) as { event_instance: Record<string, unknown> }[])[0]?.event_instance;
    const at = Date.parse(str(inst?.start));
    if (Number.isNaN(at)) continue;
    if (at < last) return COVERS_NOTHING;
    last = at;
  }
  return Number.isFinite(last) ? new Date(last).toISOString() : COVERS_NOTHING;
}

/* ---------------- NWS active alerts (public domain) ----------------
   config: { area: "TX" (state or marine zone), min_severity?: "Severe" | "Moderate" | "Extreme" } */
const SEVERITY_RANK: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

function centroid(geometry: Record<string, unknown> | null | undefined): { lat: number; lng: number } | undefined {
  if (!geometry) return undefined;
  const coords = geometry.coordinates as unknown;
  const ring = geometry.type === "Polygon" ? (coords as number[][][])[0] : geometry.type === "MultiPolygon" ? (coords as number[][][][])[0]?.[0] : undefined;
  if (!ring || ring.length === 0) return undefined;
  const n = ring.length;
  const lng = ring.reduce((a, p) => a + p[0], 0) / n, lat = ring.reduce((a, p) => a + p[1], 0) / n;
  return { lat, lng };
}

const zoneCentroidCache = new Map<string, { lat: number; lng: number } | null>();

/**
 * When an NWS post stops being shown. CAP `expires` is the *product's* refresh deadline — the office
 * reissues a multi-day watch every few hours, so `expires` lands the same day while `ends` is days
 * out — and a post that expires on it leaves the board while the hazard it describes is in effect:
 * 46% of active alerts on 2026-09-29, a Coastal Flood Warning three days early on 10-26 (CRI-50).
 * The post's expiry is "stop showing this", which for a hazard is the later of the two, plus an hour
 * so it does not vanish the minute the hazard does. An alert with no `ends` (a Special Weather
 * Statement) keeps the refresh deadline as its only bound. The rows written before this were
 * floored the same way by migrations/0010_nws_expiry_floor.sql.
 *
 * Only a floor. Whether an alert whose `expires` outlives its `ends` should stay up that long is a
 * separate question, and this does not answer it.
 */
export const NWS_END_GRACE_MS = 3600e3;
export function nwsExpiry(capExpires: string, ends: string): string | undefined {
  const e = Date.parse(capExpires), d = Date.parse(ends);
  const t = Math.max(Number.isNaN(e) ? -Infinity : e, Number.isNaN(d) ? -Infinity : d + NWS_END_GRACE_MS);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/**
 * The zone an alert's times are in, from the abbreviation NWS puts in every headline ("issued
 * November 2 at 3:13AM MST until ... by NWS Denver CO"). The CAP timestamps carry an offset, which
 * says nothing about the name; the headline says MST, and the page renders the post's times in its
 * `timezone` when it has one — which, for NWS, it never did. MST alone is ambiguous: Arizona keeps
 * it all year, so an Arizona office means America/Phoenix.
 */
const NWS_ZONES: Record<string, string> = {
  EST: "America/New_York", EDT: "America/New_York",
  CST: "America/Chicago", CDT: "America/Chicago",
  MST: "America/Denver", MDT: "America/Denver",
  PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
  AKST: "America/Anchorage", AKDT: "America/Anchorage",
  HST: "Pacific/Honolulu",
  AST: "America/Puerto_Rico",
  CHST: "Pacific/Guam",
  SST: "Pacific/Pago_Pago",
};
export function nwsTimezone(headline: string, senderName: string): string | undefined {
  const m = /\b\d{1,2}:\d{2}\s?[AP]M\s+([A-Za-z]{2,5})\b/.exec(headline);
  const abbr = m?.[1].toUpperCase();
  if (!abbr) return undefined;
  if (abbr === "MST" && /\bAZ$/.test(senderName.trim())) return "America/Phoenix";
  return NWS_ZONES[abbr];
}

/**
 * The places one CAP segment covers, from its `areaDesc`: the zone names, each once, in upstream
 * order. NWS splits one alert into a segment per group of zones and serves each as its own feature
 * under the same headline, so this is what tells sibling segments apart. A zone listed twice
 * ("Greater Lake Tahoe Area; Greater Lake Tahoe Area") is named once. Empty when upstream names none.
 */
export function nwsArea(areaDesc: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of plainText(areaDesc, 2000).split(";")) {
    const part = raw.trim();
    if (!part || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    parts.push(part);
  }
  return parts.join("; ");
}

/** Zone-based alerts carry no geometry; resolve the first affected zone's centroid (cached per process, capped per run). */
async function zoneCentroid(zoneUrls: string[], ctx: AdapterContext, budget: { left: number }): Promise<{ lat: number; lng: number } | undefined> {
  for (const url of zoneUrls.slice(0, 3)) {
    if (zoneCentroidCache.has(url)) { const c = zoneCentroidCache.get(url); if (c) return c; continue; }
    if (budget.left <= 0) return undefined;
    budget.left--;
    try {
      const z = await fetchJson<{ geometry: Record<string, unknown> | null }>(url, ctx, { Accept: "application/geo+json" });
      const c = centroid(z.geometry) ?? null;
      zoneCentroidCache.set(url, c);
      if (c) return c;
    } catch { zoneCentroidCache.set(url, null); }
  }
  return undefined;
}

export const nws: Adapter = async (source, ctx) => {
  const area = str(source.config.area);
  if (!area) throw new Error("config.area is required (e.g. TX)");
  const minSev = SEVERITY_RANK[str(source.config.min_severity, "Severe")] ?? 3;
  type F = { features: { properties: Record<string, unknown>; geometry: Record<string, unknown> | null }[] };
  const data = await fetchJson<F>(`https://api.weather.gov/alerts/active?area=${encodeURIComponent(area)}&status=actual&message_type=alert,update`, ctx, { Accept: "application/geo+json" });
  const items: Item[] = [];
  const zoneBudget = { left: 15 };
  for (const f of data.features ?? []) {
    const p = f.properties;
    if ((SEVERITY_RANK[str(p.severity)] ?? 0) < minSev) continue;
    const id = str(p.id); if (!id) continue;
    const c = centroid(f.geometry) ?? (await zoneCentroid((p.affectedZones as string[] | undefined) ?? [], ctx, zoneBudget));
    const expires = nwsExpiry(str(p.expires), str(p.ends));
    const where = nwsArea(str(p.areaDesc));
    const headline = str(p.headline);
    items.push({
      uid: id,
      title: plainText(headline && where ? `${headline} — ${where}` : headline || `${str(p.event)}: ${where}`, 200),
      body: [
        `${str(p.event)} · ${str(p.severity)} · ${str(p.urgency)}. Areas: ${plainText(where, 200)}.`,
        plainText(str(p.description), 700),
        str(p.instruction) ? `Instruction: ${plainText(str(p.instruction), 300)}` : "",
        `Issued by ${str(p.senderName)}. Source: National Weather Service (public domain), relayed by Crier.`,
      ].filter(Boolean).join("\n"),
      url: `https://alerts.weather.gov/search?id=${encodeURIComponent(id)}`,
      kind: "announcement",
      starts_at: str(p.onset) || str(p.effective) || undefined,
      ends_at: str(p.ends) || undefined,
      timezone: nwsTimezone(str(p.headline), str(p.senderName)),
      expires_at: expires,
      location: { name: plainText(where, 120) || undefined, lat: c?.lat, lng: c?.lng },
      tags: [...source.tags, "weather", "alert", str(p.event).toLowerCase().replace(/[^a-z0-9]+/g, "-")].filter((t) => t.length >= 2 && t.length <= 40),
      metadata: { source: "nws", severity: p.severity, urgency: p.urgency, certainty: p.certainty, event: p.event },
    });
  }
  return items;
};

export const ADAPTERS: Record<SourceRow["adapter"], Adapter> = { ticketmaster, ical, rss, localist, nws };

export function describeAdapter(a: SourceRow["adapter"]): string {
  return {
    ticketmaster: "Ticketmaster Discovery API: concerts, sports, theatre near a point. Needs TICKETMASTER_API_KEY. config: {lat, lng, radius_km, city, segment?}",
    ical: "Any public iCalendar feed (LibCal, Google Calendar public ICS, venue calendars). config: {url, timezone?, location_name?, lat?, lng?}",
    rss: "Any RSS or Atom feed of notices. Items are announcements with a TTL. config: {url, ttl_days?, location_name?, lat?, lng?}",
    localist: "Localist-powered calendars (most university event sites). Placeholder venues (\"Sign in to download the location\", \"TBD\") are dropped. config: {base, location_name?, lat?, lng?} — the name and point to fall back on for the events upstream gives no coordinates for; not applied to online events.",
    nws: "National Weather Service active alerts for a state, public domain. config: {area, min_severity?}",
  }[a];
}

export type { AdapterContext };
