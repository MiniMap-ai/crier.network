/**
 * Ticketmaster Discovery events to items, and one item per event however many Discovery records
 * describe it. Discovery serves some shows twice, under two event ids and two URLs (a dated slug
 * and a bare `/event/<id>`), with names that differ in punctuation or billing and with the timezone
 * on only one of them. docs/syndication.md has the evidence and the identity this settles on.
 *
 * Pure: no database, no `next/server`, so tests/syndication-ticketmaster.test.ts can load it.
 */
import { normalizeSourceKey } from "../source-key.ts";
import { plainText } from "./types.ts";
import type { Item, SourceRow } from "./types.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
/** Ticketmaster fills empty classifications with the literal name "Undefined". */
const cname = (v: unknown) => { const t = str(v); return /^undefined$/i.test(t) ? "" : t; };

/** A name this short, or a single word, does not identify an event on its own ("Wanted"). */
const SHORT_TITLE = 12;

/**
 * The title an agent can tell apart from a wanted ad: Discovery's name, with the venue appended
 * when the name is 12 characters or fewer or a single word. The city stands in for a missing venue.
 */
export function composeTitle(name: string, venue: string, city: string): string {
  const n = name.trim();
  if (!n || (n.length > SHORT_TITLE && /\s/.test(n))) return n.slice(0, 200);
  const where = venue.trim() ? ` at ${venue.trim()}` : city.trim() ? ` in ${city.trim()}` : "";
  return `${n}${where}`.slice(0, 200);
}

/**
 * Admission rules, not a description. Discovery's `pleaseNote` and often `info` are a venue's house
 * rules; relayed as the body they tell an agent about scooters, not the show.
 */
const VENUE_RULES = /will not be admitted|no outside (food|beverage|drink)|permitted (on|in(side)?) the (premises|venue)|subject to (search|security)|no weapons|no re-?entry|bag policy|prohibited items/i;
export const isVenueRules = (text: string): boolean => VENUE_RULES.test(text);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 6, 7:30 PM" from Discovery's local date and time, which are already in the venue's zone. */
export function localWhen(localDate: string, localTime: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!d) return "";
  const day = `${MONTHS[Number(d[2]) - 1] ?? d[2]} ${Number(d[3])}`;
  const t = /^(\d{2}):(\d{2})/.exec(localTime);
  if (!t) return day;
  const h = Number(t[1]);
  return `${day}, ${h % 12 || 12}:${t[2]} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The descriptive line of the body: the event's own description or info text, or, when all
 * Discovery has is venue rules, "<attraction> on <date> at <place>." The second element says which.
 */
export function describe(e: Obj, who: string, when: string, place: string): [line: string, described: boolean] {
  for (const field of ["description", "info", "pleaseNote"]) {
    const text = plainText(str(e[field]), 300);
    if (text && !isVenueRules(text)) return [text, true];
  }
  return [[who, when ? `on ${when}` : "", place ? `at ${place}` : ""].filter(Boolean).join(" ") + ".", false];
}

/** One Discovery record, mapped, with what the merge needs to recognise its twin. */
export type Representation = {
  item: Item;
  id: string;
  /** Venue and start instant: two records of one show share it. Absent when either is unknown. */
  slot?: string;
  attractions: string[];
  /** The name folded to letters and digits, so "August Wilsons" and "August Wilson's" agree. */
  name: string;
  hasTimezone: boolean;
  bareUrl: boolean;
  described: boolean;
};

/** Map one Discovery event. Null when it has no id or no name. */
export function representation(e: Obj, source: Pick<SourceRow, "tags">): Representation | null {
  const id = str(e.id);
  const name = str(e.name).trim();
  if (!id || !name) return null;
  const dates = obj(e.dates);
  const start = obj(dates.start), end = obj(dates.end);
  const status = obj(dates.status).code;
  const startsAt = str(start.dateTime) || (str(start.localDate) ? `${start.localDate}T${str(start.localTime, "12:00:00")}` : "");
  const endsAt = !end.noSpecificTime && str(end.dateTime) && !Number.isNaN(Date.parse(str(end.dateTime))) ? str(end.dateTime) : "";
  const embedded = obj(e._embedded);
  const venue = list(embedded.venues)[0] ?? {};
  const attractions = list(embedded.attractions);
  const vloc = obj(venue.location);
  const city = str(obj(venue.city).name), state = str(obj(venue.state).stateCode);
  const cls = list(e.classifications)[0] ?? {};
  const segment = cname(obj(cls.segment).name), genre = cname(obj(cls.genre).name), sub = cname(obj(cls.subGenre).name);
  const price = list(e.priceRanges)[0] ?? {};
  const min = num(price.min), max = num(price.max);
  const priceStr = min !== undefined ? `${str(price.currency, "USD")} ${min}${max !== undefined && max !== min ? "–" + max : ""}` : "";
  const venueName = str(venue.name).trim();
  const place = [venueName, [city, state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const url = str(e.url);
  const timezone = str(dates.timezone) || str(venue.timezone);
  const [line, described] = describe(e, str(attractions[0]?.name).trim() || name, localWhen(str(start.localDate), str(start.localTime)), place);
  const body = [
    [segment, genre, sub && sub !== genre ? sub : ""].filter(Boolean).join(" · "),
    place && described ? `At ${place}.` : "",
    priceStr ? `Tickets from ${priceStr}.` : "",
    line,
    `Tickets and details: ${url}`,
    "Source: Ticketmaster (relayed by Crier; details may change, check the link).",
  ].filter(Boolean).join("\n");
  const tags = [...source.tags, segment, genre].filter(Boolean).map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter((t) => t.length >= 2 && t.length <= 40);
  const venueKey = str(venue.id) || (num(vloc.latitude) !== undefined && num(vloc.longitude) !== undefined ? `${num(vloc.latitude)!.toFixed(3)},${num(vloc.longitude)!.toFixed(3)}` : "");
  const instant = str(start.dateTime) && !Number.isNaN(Date.parse(str(start.dateTime))) ? new Date(str(start.dateTime)).toISOString() : "";
  return {
    id,
    slot: venueKey && instant ? `${venueKey}@${instant}` : undefined,
    attractions: attractions.map((a) => str(a.id)).filter(Boolean),
    name: name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, ""),
    hasTimezone: !!str(dates.timezone),
    bareUrl: /\/event\/[A-Za-z0-9]+\/?$/.test(url) && !/-\d{2}-\d{2}-\d{4}\/event\//.test(url),
    described,
    item: {
      uid: id,
      title: composeTitle(name, venueName, city),
      body,
      url: url || undefined,
      kind: "event",
      starts_at: startsAt || undefined,
      ends_at: endsAt || undefined,
      timezone: timezone || undefined,
      location: { name: place || undefined, lat: num(vloc.latitude), lng: num(vloc.longitude) },
      tags: [...new Set(tags)],
      cancelled: status === "cancelled",
      metadata: { source: "ticketmaster", segment, genre, venue: venueName, status },
    },
  };
}

/** Same show: they share an attraction, or one name is the other with more billing on the end. */
function sameShow(a: Representation, b: Representation): boolean {
  if (a.attractions.some((x) => b.attractions.includes(x))) return true;
  return !!a.name && !!b.name && (a.name.startsWith(b.name) || b.name.startsWith(a.name));
}

/** The record to publish from: one with a timezone of its own, then a dated slug URL, then the lower id. */
function lead(a: Representation, b: Representation): number {
  return Number(b.hasTimezone) - Number(a.hasTimezone) || Number(a.bareUrl) - Number(b.bareUrl) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * One item per show. Records sharing a venue and start instant that are the same show merge: the
 * lead record's title, URL and body, any record's timezone, end and description, cancelled only
 * when every record is. Each item's `key` is `tm:<venue>@<start>` (suffixed with its lowest id
 * when two different shows share the slot), and its `aliases` are the record ids and URLs that
 * earlier runs stored it under. Records with no venue or no absolute start pass through alone.
 */
export function mergeRepresentations(reps: Representation[]): Item[] {
  const slots = new Map<string, Representation[][]>();
  const out: (Item | Representation[])[] = [];
  for (const r of reps) {
    if (!r.slot) { out.push(r.item); continue; }
    const shows = slots.get(r.slot) ?? [];
    if (!slots.has(r.slot)) slots.set(r.slot, shows);
    const show = shows.find((s) => s.some((x) => sameShow(x, r)));
    if (show) { show.push(r); continue; }
    const fresh = [r];
    shows.push(fresh);
    out.push(fresh);
  }
  return out.map((entry) => {
    if (!Array.isArray(entry)) return entry;
    const slot = entry[0].slot!;
    const shared = slots.get(slot)!.length > 1;
    return merged(entry, shared ? `tm:${slot}:${entry.map((r) => r.id).sort()[0]}` : `tm:${slot}`);
  });
}

function merged(show: Representation[], key: string): Item {
  const sorted = [...show].sort(lead);
  const first = sorted[0];
  const item: Item = { ...first.item, key };
  item.timezone = first.item.timezone ?? sorted.find((r) => r.item.timezone)?.item.timezone;
  item.ends_at = first.item.ends_at ?? sorted.find((r) => r.item.ends_at)?.item.ends_at;
  if (!first.described) {
    const told = sorted.find((r) => r.described);
    if (told) item.body = told.item.url && first.item.url ? told.item.body.replace(told.item.url, first.item.url) : told.item.body;
  }
  item.cancelled = show.every((r) => r.item.cancelled);
  const ids = sorted.map((r) => r.id);
  item.aliases = [...new Set([...sorted.map((r) => normalizeSourceKey(r.item.url)).filter((u): u is string => !!u), ...ids])];
  item.metadata = { ...(first.item.metadata ?? {}), discovery_ids: ids };
  if (item.timezone === undefined) delete item.timezone;
  if (item.ends_at === undefined) delete item.ends_at;
  return item;
}
