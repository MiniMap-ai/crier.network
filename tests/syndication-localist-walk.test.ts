import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALIST_MAX_ROWS, dropLocalistRepeats, localist, localistCoveredBefore, localistVenue } from "../lib/syndication/adapters.ts";
import { asFetched } from "../lib/syndication/types.ts";
import type { SourceRow } from "../lib/syndication/types.ts";

/**
 * Fixture ids, slugs, titles and venues are pairs events.luc.edu served side by side: one event
 * published twice, each copy under its own id and URL.
 */

const NOW = new Date("2026-11-06T12:00:00Z");
const HORIZON_END = new Date("2026-12-06T12:00:00Z");

const source: SourceRow = {
  id: "src_5ab8db15", name: "Loyola University Chicago events", adapter: "localist",
  config: { base: "https://events.luc.edu" },
  homepage: null, license: "Public Localist calendar", default_kind: "event", tags: [],
  enabled: true, run_every_minutes: 360, max_per_run: 100, horizon_days: 30,
  added_by: "test", notes: null, created_at: NOW, last_run_at: null,
  last_status: null, last_error: null, last_counts: null,
};

const NO_GEO = { latitude: null, longitude: null, street: null, city: null, state: null, country: null, zip: null };

function event(id: number, slug: string, title: string, start: string, over: Record<string, unknown> = {}) {
  return {
    id, title, urlname: slug, localist_url: `https://events.luc.edu/event/${slug}`,
    description_text: "", experience: "inperson", geo: NO_GEO, location_name: "", location: "", address: "",
    event_instances: [{ event_instance: { start, end: null, all_day: false } }],
    ...over,
  };
}

/** Serve `pages` (each a list of events) by page number, recording which pages were asked for. */
async function run(pages: unknown[][], opts: { fetchUntil?: number; abortPage?: number } = {}) {
  const real = globalThis.fetch;
  const asked: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get("page"));
    asked.push(page);
    if (page === opts.abortPage) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const events = (pages[page - 1] ?? []).map((event) => ({ event }));
    return new Response(JSON.stringify({ events, page: { current: page, size: 100, total: pages.length } }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const r = asFetched(await localist(source, { now: NOW, horizonEnd: HORIZON_END, signal: AbortSignal.timeout(30_000), fetchUntil: opts.fetchUntil }));
    return { ...r, asked };
  } finally {
    globalThis.fetch = real;
  }
}

/** A full page of distinct events, an hour apart from `fromHour` on. */
function fullPage(fromHour: number) {
  return Array.from({ length: 100 }, (_, i) => {
    const h = fromHour + i;
    return event(54000000000000 + h, `e-${h}`, `Event ${h}`, new Date(Date.parse("2026-11-07T00:00:00Z") + h * 3600e3).toISOString());
  });
}

test("one event published under two URLs relays once, as the older of the two", async () => {
  const { items } = await run([[
    event(54441190053794, "tree-and-campus-lighting-4468", "Tree and Campus Lighting", "2026-11-15T18:00:00-06:00", { location_name: "Sign in to download the location" }),
    event(54409125422356, "tree-and-campus-lighting", "Tree and Campus Lighting", "2026-11-15T18:00:00-06:00", { location_name: "St. Ignatius Community Plaza, Gentile Arena" }),
  ]]);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://events.luc.edu/event/tree-and-campus-lighting");
  assert.equal(items[0].uid, "54409125422356:2026-11-15T18:00:00-06:00");
  assert.equal(items[0].location?.name, "St. Ignatius Community Plaza, Gentile Arena");
});

test("a venue that extends the other's name is the same venue", () => {
  const kept = dropLocalistRepeats([
    { id: "53701849454203", title: "Fall 2026 Biology and Bioinformatics Seminar Series", start: "2026-11-18T11:30:00-06:00", venue: "Regis Hall" },
    { id: "54319241719588", title: "Fall 2026 Biology and Bioinformatics Seminar Series", start: "2026-11-18T11:30:00-06:00", venue: "Regis Hall MPR" },
  ]);
  assert.deepEqual(kept.map((k) => k.id), ["53701849454203"]);
});

test("two named campuses at the same hour are two sessions", () => {
  const kept = dropLocalistRepeats([
    { id: "54294005016917", title: "Jesuit Heritage Month Book Club for Employees", start: "2026-11-12T12:00:00-06:00", venue: "Lake Shore Campus" },
    { id: "54294011787663", title: "Jesuit Heritage Month Book Club for Employees", start: "2026-11-12T12:00:00-06:00", venue: "Water Tower Campus" },
  ]);
  assert.equal(kept.length, 2);
});

test("the same title at another start is another occurrence, not a repeat", () => {
  const kept = dropLocalistRepeats([
    { id: "53755540863551", title: "Mindful Recess: Support for Mindful Living", start: "2026-11-09T15:30:00-06:00", venue: "Information Commons" },
    { id: "53755540863551", title: "Mindful Recess: Support for Mindful Living", start: "2026-11-16T15:30:00-06:00", venue: "Information Commons" },
    { id: "53932121690906", title: "Mindful Recess: Support for Mindful Living", start: "2026-11-16T15:30:00-06:00", venue: "" },
  ]);
  assert.deepEqual(kept.map((k) => k.start), ["2026-11-09T15:30:00-06:00", "2026-11-16T15:30:00-06:00"]);
  assert.ok(kept.every((k) => k.id === "53755540863551"));
});

test("one instant written with two offsets is one start", () => {
  const kept = dropLocalistRepeats([
    { id: "2", title: "Turkey Talk Community Circle", start: "2026-11-18T22:00:00Z", venue: "" },
    { id: "1", title: "turkey talk  community circle", start: "2026-11-18T16:00:00-06:00", venue: "Regis Hall" },
  ]);
  assert.deepEqual(kept.map((k) => k.id), ["1"]);
});

test("the older id is kept whichever order the feed lists them in, and order is otherwise kept", () => {
  const a = { id: "999", title: "A", start: "2026-11-10T10:00:00Z", venue: "" };
  const b = { id: "1000", title: "A", start: "2026-11-10T10:00:00Z", venue: "" };
  const c = { id: "5", title: "C", start: "2026-11-09T10:00:00Z", venue: "" };
  assert.deepEqual(dropLocalistRepeats([b, c, a]), [c, a], "999 is older than 1000 though it sorts after it as text");
});

test("the venue comes from the street address when the location has no name", () => {
  assert.equal(localistVenue({ location_name: "", location: "", address: "6349 N. Kenmore", room_number: "Room 111" }), "6349 N. Kenmore");
});

test("the venue comes from the geocoded street when nothing else names it", () => {
  assert.equal(localistVenue({ location_name: "", address: "", geo: { ...NO_GEO, street: "6500 North Clark Street", city: "Chicago" } }), "6500 North Clark Street, Chicago");
});

test("a named location wins over its address", () => {
  assert.equal(localistVenue({ location_name: "Damen Student Center", address: "6511 N Sheridan Rd" }), "Damen Student Center");
});

test("a placeholder in every venue field still leaves no venue", () => {
  assert.equal(localistVenue({ location_name: "Sign in to download the location", location: "Sign in to download the location", address: "TBD", room_number: "Quiet Reading Room (317)" }), "");
});

test("an address-only event is posted with that address as its place", async () => {
  const { items } = await run([[event(1, "tour", "School of Environmental Sustainability Tours", "2026-11-10T15:00:00-06:00", { address: "6349 N. Kenmore", room_number: "Room 111" })]]);
  assert.equal(items[0].location?.name, "6349 N. Kenmore");
  assert.ok(items[0].body.includes("Where: 6349 N. Kenmore, Room 111"));
});

test("the walk stops at its row limit and never asks for the page after", async () => {
  const pages = Array.from({ length: 7 }, (_, p) => fullPage(p * 100));
  const r = await run(pages);
  assert.equal(LOCALIST_MAX_ROWS, 500);
  assert.deepEqual(r.asked, [1, 2, 3, 4, 5]);
  assert.equal(r.note, undefined, "stopping at the limit is a normal run");
  assert.equal(r.coveredBefore, new Date(Date.parse("2026-11-07T00:00:00Z") + 499 * 3600e3).toISOString(), "only what starts before the last row read is vouched for");
});

test("a feed read to its end vouches for everything", async () => {
  const r = await run([fullPage(0), fullPage(100).slice(0, 30)]);
  assert.deepEqual(r.asked, [1, 2]);
  assert.equal(r.items.length, 130);
  assert.equal(r.coveredBefore, undefined);
});

test("an abort on a later page keeps the earlier pages and says where it stopped", async () => {
  const r = await run(Array.from({ length: 7 }, (_, p) => fullPage(p * 100)), { abortPage: 3 });
  assert.equal(r.items.length, 200);
  assert.match(r.note ?? "", /^partial after \d+ ms: kept 200 rows from 2 of 7 pages; https:\/\/events\.luc\.edu\/api\/2\/events\?days=30&pp=100&page=3 aborted after \d+ ms \(no response\)$/);
  assert.equal(r.coveredBefore, new Date(Date.parse("2026-11-07T00:00:00Z") + 199 * 3600e3).toISOString());
});

test("an abort on the first page fails the run with the URL in the error", async () => {
  await assert.rejects(run([fullPage(0)], { abortPage: 1 }), /page=1 aborted after \d+ ms \(no response\)/);
});

test("a spent budget starts no page at all after the first", async () => {
  const r = await run(Array.from({ length: 7 }, (_, p) => fullPage(p * 100)), { fetchUntil: Date.now() });
  assert.deepEqual(r.asked, [1]);
  assert.equal(r.items.length, 100);
  assert.match(r.note ?? "", /out of time before page 2$/);
});

test("the covered window is the last row's first instance, in UTC", () => {
  assert.equal(localistCoveredBefore([event(1, "a", "A", "2026-11-10T10:00:00-06:00")]), "2026-11-10T16:00:00.000Z");
  assert.equal(localistCoveredBefore([]), new Date(0).toISOString(), "no rows vouch for nothing");
});

test("a last row with no usable start leaves the window at the last row that has one", () => {
  const rows = [event(1, "a", "A", "2026-11-10T10:00:00Z"), event(2, "b", "B", "2026-11-11T10:00:00Z"), event(3, "c", "C", "not a date")];
  assert.equal(localistCoveredBefore(rows), "2026-11-11T10:00:00.000Z");
});

test("rows out of start order vouch for nothing", () => {
  const rows = [event(1, "a", "A", "2026-11-12T10:00:00Z"), event(2, "b", "B", "2026-11-11T10:00:00Z"), event(3, "c", "C", "2026-11-13T10:00:00Z")];
  assert.equal(localistCoveredBefore(rows), new Date(0).toISOString());
});

test("an empty venue matches any, but a different room, end or mode is another event", () => {
  const base = { title: "Luc Utsav Practice", start: "2026-11-24T19:00:00-06:00", venue: "" };
  const pair = (a: object, b: object) => dropLocalistRepeats([{ ...base, id: "1", ...a }, { ...base, id: "2", ...b }]).length;
  assert.equal(pair({ end: "2026-11-24T21:00:00-06:00" }, { end: "2026-11-24T21:00:00-06:00" }), 1, "both gated, same hours: one event");
  assert.equal(pair({ room: "Quiet Reading Room (317)" }, {}), 1, "a room on one side only does not split them");
  assert.equal(pair({ room: "Room 111" }, { room: "Room 204" }), 2, "two sections in two rooms");
  assert.equal(pair({ end: "2026-11-24T20:00:00-06:00" }, { end: "2026-11-24T21:00:00-06:00" }), 2, "two slots that end apart");
  assert.equal(pair({ experience: "virtual" }, { experience: "inperson" }), 2, "one online, one in person");
});
