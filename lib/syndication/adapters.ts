import { createHash } from "node:crypto";
import { RECURRENCE_CAP } from "./collapse.ts";
import { contentFlags, stripHiddenUnicode } from "../flags.ts";
import { cancelledTitle, clipText, decodeEntities, descriptionText, dropControls, eventUrl, eventUrlTemplateProblem, httpLink, icalDate, icalList, icalText, parseFeed, parseICal, placeText, placeWithoutContacts, withoutCancelMarker } from "./feeds.ts";
import type { VEvent } from "./feeds.ts";
import { ticketmasterItems } from "./ticketmaster.ts";
import { ADAPTER_NAMES, fetchJson, fetchText, inHorizon, plainText, runLimit } from "./types.ts";
import { walkNote, walkPages } from "./walk.ts";
// Split out: node's type stripping erases `import type` but cannot spot types inside a mixed list.
import type { Adapter, AdapterContext, AdapterName, Item } from "./types.ts";

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
   Records map to items, one per show, in ./ticketmaster.ts. */
export const ticketmaster: Adapter = async (source, ctx) => {
  const key = process.env.TICKETMASTER_API_KEY;
  if (!key) throw new Error("TICKETMASTER_API_KEY is not set");
  const c = source.config;
  const lat = num(c.lat), lng = num(c.lng);
  if (lat === undefined || lng === undefined) throw new Error("config.lat and config.lng are required");
  const radius = Math.min(150, num(c.radius_km) ?? 40);
  const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const records: Record<string, unknown>[] = [];
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
    records.push(...events);
    if (events.length < pageSize || (data.page?.totalPages ?? 0) <= page + 1) break;
  }
  return ticketmasterItems(records, source).filter((i) => inHorizon(i.starts_at, ctx));
};

/* ---------------- iCalendar ----------------
   config: { url, timezone? (default zone for floating times), location_name?, lat?, lng?, event_url_template?, fold_repeats?, omit_description? } */

/**
 * The event's page: the first of its `URL`, Trumba's `X-TRUMBA-LINK` and the source's
 * `event_url_template` filled with the UID that `httpLink` accepts, else none.
 */
export function icalLink(ev: VEvent, uid: string, template: string | undefined): string | undefined {
  return httpLink(ev.URL?.[0]?.value) ?? httpLink(ev["X-TRUMBA-LINK"]?.[0]?.value) ?? (template ? httpLink(eventUrl(template, uid)) : undefined);
}

/**
 * The key `fold_repeats` folds instances on: the title, trimmed and lower-cased, and the place's
 * letters and digits alone, lower-cased, so "100 Dexter Ave N." and "100 Dexter Ave. N" are one
 * place. Hashed so the key is short and fit to store as a uid. Pass the title without its cancel
 * marker, so a cancelled instance keys with its series. Undefined without a place, since one title
 * at no named place proves nothing.
 */
export function seriesKey(title: string, place: string): string | undefined {
  const where = place.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!where) return undefined;
  return `series:${createHash("sha256").update(`${title.trim().toLowerCase()}\n${where}`).digest("hex").slice(0, 32)}`;
}

export const ical: Adapter = async (source, ctx) => {
  const url = str(source.config.url);
  if (!url) throw new Error("config.url is required");
  // Rows the daily brief inserts directly never meet the admin route's schema, so check here too.
  const template = source.config.event_url_template;
  const problem = template === undefined ? undefined : eventUrlTemplateProblem(template);
  if (problem) throw new Error(`config.event_url_template ${problem}`);
  const repeats = source.config.fold_repeats;
  if (repeats !== undefined && typeof repeats !== "boolean") throw new Error("config.fold_repeats must be true or false");
  const omit = source.config.omit_description;
  if (omit !== undefined && typeof omit !== "boolean") throw new Error("config.omit_description must be true or false");
  const text = await fetchText(url, ctx);
  const zone = str(source.config.timezone) || /X-WR-TIMEZONE:([^\r\n]+)/.exec(text)?.[1]?.trim();
  const items: Item[] = [];
  for (const ev of parseICal(text)) {
    const uid = ev.UID?.[0]?.value?.trim(); if (!uid) continue;
    if (ev.RRULE) continue;   // recurring series are not expanded; single instances only
    const st = icalDate(ev.DTSTART?.[0], zone); if (!st) continue;
    const en = icalDate(ev.DTEND?.[0], zone);
    const link = icalLink(ev, uid, template as string | undefined);
    // A linked item's row is keyed on the link; the uid alias also finds a row stored before the feed
    // gave one. A cancelled item carries both, or it cannot reach the row it should retire.
    const aliases = link ? [uid] : undefined;
    const summary = dropControls(decodeEntities(icalText(ev.SUMMARY?.[0]?.value))).trim();
    const rawPlace = dropControls(placeText(icalText(ev.LOCATION?.[0]?.value)));
    // Cleaned without hidden Unicode, which could split an address; a place nothing is removed from
    // keeps it, so the Where line shows it to the post's flags.
    const plainPlace = stripHiddenUnicode(rawPlace);
    const cleanedPlace = placeWithoutContacts(plainPlace);
    const loc = cleanedPlace === plainPlace ? rawPlace : cleanedPlace;
    const series = repeats ? seriesKey(withoutCancelMarker(summary).slice(0, 200), plainPlace) : undefined;
    if (ev.STATUS?.[0]?.value?.toUpperCase() === "CANCELLED" || (summary && cancelledTitle(summary))) {
      items.push({ uid, title: "cancelled", body: "cancelled", url: link, aliases, ...(series ? { series } : {}), cancelled: true });
      continue;
    }
    if (!summary) continue;
    const html = omit ? "" : icalText(ev.DESCRIPTION?.[0]?.value);
    const desc = clipText(descriptionText(html, (t) => stripHiddenUnicode(dropControls(t))), 500);
    const geo = ev.GEO?.[0]?.value?.split(";").map(Number);
    // The description's own text no longer shows an instruction tag or a hidden character it came with.
    const flags = contentFlags(summary, dropControls(decodeEntities(html))).filter((f) => f === "possible_instruction" || f === "hidden_unicode");
    if (loc !== rawPlace && plainPlace !== rawPlace && !flags.includes("hidden_unicode")) flags.push("hidden_unicode");
    items.push({
      uid,
      title: summary.slice(0, 200),
      // The Where line keeps any hidden Unicode so the post's flags see it; the write strips it from the body.
      body: [desc, loc ? `Where: ${loc}` : "", link ? `Details: ${link}` : "", `Source: ${source.name}${source.homepage ? " (" + source.homepage + ")" : ""}, relayed by Crier.`].filter(Boolean).join("\n"),
      url: link,
      aliases,
      ...(series ? { series } : {}),
      ...(flags.length ? { flags } : {}),
      kind: source.default_kind,
      starts_at: st.iso,
      ends_at: en?.iso,
      timezone: zone || undefined,
      location: { name: stripHiddenUnicode(loc) || str(source.config.location_name) || undefined, lat: geo && geo.length === 2 && Number.isFinite(geo[0]) ? geo[0] : num(source.config.lat), lng: geo && geo.length === 2 && Number.isFinite(geo[1]) ? geo[1] : num(source.config.lng) },
      tags: [...source.tags, ...(ev.CATEGORIES?.flatMap((c) => icalList(c.value).map(decodeEntities)) ?? [])].map((t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")).filter((t) => t.length >= 2 && t.length <= 40),
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

export const ADAPTERS: Record<AdapterName, Adapter> = { ticketmaster, ical, rss, localist };

/**
 * The adapter a source row names, or undefined when there is none: a disabled row kept as
 * provenance can name a removed one. The runner fails such a source's run before fetching, and
 * the admin route refuses to enable or run it.
 */
export function adapterFor(name: string): Adapter | undefined {
  return (ADAPTER_NAMES as readonly string[]).includes(name) ? ADAPTERS[name as AdapterName] : undefined;
}

export function describeAdapter(a: AdapterName): string {
  return {
    ticketmaster: "Ticketmaster Discovery API: concerts, sports, theatre near a point. Needs TICKETMASTER_API_KEY. config: {lat, lng, radius_km, city, segment?}",
    ical: "Any public iCalendar feed (LibCal, Google Calendar public ICS, Trumba, Communico, venue calendars). Each event links to the first of its URL, Trumba's X-TRUMBA-LINK and event_url_template (an https URL containing {uid}, filled with the event's UID) that is an http(s) URL with no username or password. Contact fields, email addresses and phone numbers are removed from descriptions; a title that opens or closes with CANCELLED or POSTPONED retires the event. Contact details are also removed from the place. fold_repeats: true relays the instances of one title at one place as one post, for feeds that give each instance its own UID and link. omit_description: true relays no description text, for feeds whose descriptions are staff notes. config: {url, timezone?, location_name?, lat?, lng?, event_url_template?, fold_repeats?, omit_description?}",
    rss: "Any RSS or Atom feed of notices. Items are announcements with a TTL. config: {url, ttl_days?, location_name?, lat?, lng?}",
    localist: "Localist-powered calendars (most university event sites). Placeholder venues (\"Sign in to download the location\", \"TBD\") are dropped. config: {base, location_name?, lat?, lng?} — the name and point to fall back on for the events upstream gives no coordinates for; not applied to online events.",
  }[a];
}

export type { AdapterContext };
