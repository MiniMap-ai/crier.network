/**
 * Discovery event records to items, one per show. Each record maps to an item whose uid is its
 * Discovery id; records the same-show rule in ./aliases.ts finds to be one show merge into the
 * lead's item, which carries its own id and the others' URL keys and ids as aliases.
 * docs/syndication.md has why.
 *
 * Pure: no database, no `next/server`, so tests/syndication-ticketmaster.test.ts can load it.
 */
import { normalizeSourceKey } from "../source-key.ts";
import { aliasesFor, groupShows, pickLead } from "./aliases.ts";
import { plainText } from "./types.ts";
import type { ShowRecord } from "./aliases.ts";
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

/** What a body is built from. `described` is false when `line` is the composed fallback, which names the place itself. */
type BodyParts = { category: string; place: string; price: string; line: string; described: boolean };

/** The body: category, place, price, the descriptive line, the link when there is one, attribution last. */
function composeBody(b: BodyParts, url: string): string {
  return [
    b.category,
    b.place && b.described ? `At ${b.place}.` : "",
    b.price ? `Tickets from ${b.price}.` : "",
    b.line,
    url ? `Tickets and details: ${url}` : "",
    "Source: Ticketmaster (relayed by Crier; details may change, check the link).",
  ].filter(Boolean).join("\n");
}

/** Map one Discovery event record to an item whose uid is its event id. Null when it has no id. */
export function ticketmasterItem(e: Obj, source: Pick<SourceRow, "tags">): Item | null {
  const id = str(e.id);
  if (!id) return null;
  const name = str(e.name).trim();
  const dates = obj(e.dates);
  const start = obj(dates.start), end = obj(dates.end);
  const status = obj(dates.status).code;
  const localDate = str(start.localDate);
  const startsAt = str(start.dateTime) || (localDate ? `${localDate}T${str(start.localTime, "12:00:00")}` : "");
  const endsAt = !end.noSpecificTime && str(end.dateTime) && !Number.isNaN(Date.parse(str(end.dateTime))) ? str(end.dateTime) : "";
  const embedded = obj(e._embedded);
  const venue = list(embedded.venues)[0] ?? {};
  const attraction = str(list(embedded.attractions)[0]?.name).trim();
  const vloc = obj(venue.location);
  const city = str(obj(venue.city).name), state = str(obj(venue.state).stateCode);
  const cls = list(e.classifications)[0] ?? {};
  const segment = cname(obj(cls.segment).name), genre = cname(obj(cls.genre).name), sub = cname(obj(cls.subGenre).name);
  const price = list(e.priceRanges)[0] ?? {};
  const min = num(price.min), max = num(price.max);
  const priceStr = min !== undefined ? `${str(price.currency, "USD")} ${min}${max !== undefined && max !== min ? "–" + max : ""}` : "";
  const venueName = str(venue.name).trim();
  const place = [venueName, [city, state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const url = str(e.url).trim();
  const timezone = str(dates.timezone) || str(venue.timezone);
  const [line, described] = describe(e, attraction || name, localWhen(localDate, str(start.localTime)), place);
  const body: BodyParts = { category: [segment, genre, sub && sub !== genre ? sub : ""].filter(Boolean).join(" · "), place, price: priceStr, line, described };
  const tags = [...source.tags, segment, genre].filter(Boolean).map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter((t) => t.length >= 2 && t.length <= 40);
  return {
    uid: id,
    title: composeTitle(name, venueName, city),
    body: composeBody(body, url),
    url: url || undefined,
    kind: "event",
    starts_at: startsAt || undefined,
    ends_at: endsAt || undefined,
    timezone: timezone || undefined,
    location: { name: place || undefined, lat: num(vloc.latitude), lng: num(vloc.longitude) },
    tags: [...new Set(tags)],
    cancelled: status === "cancelled",
    metadata: { source: "ticketmaster", segment, genre, venue: venueName, status },
  };
}

/** What the same-show rule reads from a Discovery record. */
export function showRecord(e: Obj): ShowRecord {
  const start = obj(obj(e.dates).start);
  const instant = Date.parse(str(start.dateTime));
  const local = str(start.localDate) ? `local:${str(start.localDate)}T${str(start.localTime)}` : "";
  const embedded = obj(e._embedded);
  return {
    id: str(e.id),
    key: normalizeSourceKey(str(e.url).trim()),
    venueId: str(list(embedded.venues)[0]?.id),
    start: Number.isNaN(instant) ? local : new Date(instant).toISOString(),
    name: str(e.name).trim(),
    attractions: list(embedded.attractions).map((a) => ({ id: str(a.id), name: str(a.name) })),
  };
}

/**
 * Map Discovery records to items, one per show. Every item carries its lead's Discovery id in
 * `aliases`; a show served as several records is relayed as its lead's item with every other
 * record's URL key and id there too. It is cancelled only when every record in this fetch is, and
 * then the lead is chosen among all of them; otherwise among those still on.
 */
export function ticketmasterItems(events: Obj[], source: Pick<SourceRow, "tags">): Item[] {
  const mapped = events.flatMap((e) => {
    const item = ticketmasterItem(e, source);
    return item ? [{ ...showRecord(e), item }] : [];
  });
  return groupShows(mapped).map((group) => {
    const live = group.filter((r) => !r.item.cancelled);
    const lead = pickLead(live.length ? live : group);
    return { ...lead.item, aliases: aliasesFor(lead, group) };
  });
}
