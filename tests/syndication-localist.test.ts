import { test } from "node:test";
import assert from "node:assert/strict";
import { localist } from "../lib/syndication/adapters.ts";
import type { SourceRow } from "../lib/syndication/types.ts";

/**
 * What the Localist adapter is allowed to call a place. Every fixture shape below is one
 * events.luc.edu and events.depaul.edu actually served on 2026-09-14.
 */

const NOW = new Date("2026-09-14T12:00:00Z");
const START = "2026-09-15T18:00:00-05:00";

const NO_GEO = { latitude: null, longitude: null, street: null, city: null, state: null, country: null, zip: null };

type RawEvent = Record<string, unknown>;

function event(over: RawEvent): RawEvent {
  return {
    id: 53932118963466,
    title: "Mindful Recess: Support for Mindful Living",
    description_text: "Drop in.",
    localist_url: "https://events.luc.edu/event/mindful-recess",
    experience: "inperson",
    geo: NO_GEO,
    event_instances: [{ event_instance: { start: START, end: null, all_day: false } }],
    ...over,
  };
}

function source(config: Record<string, unknown> = {}): SourceRow {
  return {
    id: "src_5ab8db15", name: "Loyola University Chicago events", adapter: "localist",
    config: { base: "https://events.luc.edu", ...config },
    homepage: null, license: "Public Localist calendar", default_kind: "event", tags: ["chicago"],
    enabled: true, run_every_minutes: 360, max_per_run: 100, horizon_days: 30,
    added_by: "test", notes: null, created_at: NOW, last_run_at: null,
    last_status: null, last_error: null, last_counts: null,
  };
}

/** Serve one page of these events to the adapter, then put the real fetch back. */
async function relay(events: RawEvent[], config: Record<string, unknown> = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ events: events.map((e) => ({ event: e })) }), {
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    return await localist(source(config), { now: NOW, horizonEnd: new Date("2026-10-14T12:00:00Z"), signal: AbortSignal.timeout(30_000) });
  } finally {
    globalThis.fetch = real;
  }
}

test("a gated venue is absent, not a place name", async () => {
  const [item] = await relay([event({ location: "Sign in to download the location", location_name: "Sign in to download the location" })]);
  assert.equal(item.location?.name, undefined, "place_name is null, not an instruction to sign in");
  assert.ok(!item.body.includes("Sign in to download"), `the body must not carry it either:\n${item.body}`);
  assert.ok(!item.body.includes("Where:"), "with no place to name, there is no Where line");
  assert.ok(item.body.includes("Details: https://events.luc.edu/event/mindful-recess"), "the rest of the post is untouched");
});

test("an unset venue is absent too", async () => {
  const [item] = await relay([event({ location: "TBD", location_name: "TBD" })]);
  assert.equal(item.location?.name, undefined);
  assert.ok(!item.body.includes("TBD"));
});

test("an empty or whitespace venue is absent", async () => {
  const [blank, spaces, missing] = await relay([
    event({ location: "", location_name: "" }),
    event({ location: "   ", location_name: "   " }),
    event({}),
  ]);
  for (const item of [blank, spaces, missing]) {
    assert.equal(item.location?.name, undefined);
    assert.ok(!item.body.includes("Where:"));
  }
});

test('"Online Event" is a true answer and survives', async () => {
  const [item] = await relay([event({ location: "Online Event", location_name: "Online Event", experience: "virtual" })]);
  assert.equal(item.location?.name, "Online Event");
  assert.ok(item.body.includes("Where: Online Event"));
});

test("a real place whose name contains TBD is not thrown away", async () => {
  const [item] = await relay([event({ location_name: "Lincoln Park Campus (Room TBD)" })]);
  assert.equal(item.location?.name, "Lincoln Park Campus (Room TBD)", "an exact match, not a pattern");
});

test("a real place name is trimmed, and the room still rides the body", async () => {
  const [item] = await relay([event({ location_name: "Madonna della Strada Chapel ", room_number: "Bay 1" })]);
  assert.equal(item.location?.name, "Madonna della Strada Chapel");
  assert.equal(item.body.split("\n")[1], "Where: Madonna della Strada Chapel, Bay 1");
});

test("the room is dropped when it is a placeholder, and stands alone when the venue is one", async () => {
  const [placeholderRoom, placeholderVenue] = await relay([
    event({ location_name: "Damen Student Center", room_number: "TBD" }),
    event({ location_name: "Sign in to download the location", room_number: "Quiet Reading Room (317)" }),
  ]);
  assert.equal(placeholderRoom.body.split("\n")[1], "Where: Damen Student Center");
  assert.equal(placeholderVenue.body.split("\n")[1], "Where: Quiet Reading Room (317)");
  assert.equal(placeholderVenue.location?.name, undefined, "a room is not the venue");
});

test("upstream coordinates are mapped, numeric strings and all", async () => {
  const [item] = await relay([event({
    location_name: "Lake Shore Campus",
    geo: { ...NO_GEO, latitude: "41.998357", longitude: "-87.656937", city: "Chicago" },
  })]);
  assert.equal(item.location?.lat, 41.998357);
  assert.equal(item.location?.lng, -87.656937);
});

test("half a coordinate pair is not a location", async () => {
  const [item] = await relay([event({ location_name: "Lake Shore Campus", geo: { ...NO_GEO, latitude: "41.998357" } })]);
  assert.equal(item.location?.lat, undefined);
  assert.equal(item.location?.lng, undefined);
});

test("the source's point stands in where upstream has no coordinates, so near= can find the event", async () => {
  const [item] = await relay([event({ location_name: "Damen Student Center" })], { lat: 41.9987, lng: -87.6569 });
  assert.equal(item.location?.name, "Damen Student Center", "upstream still names the place");
  assert.equal(item.location?.lat, 41.9987);
  assert.equal(item.location?.lng, -87.6569);
});

test("upstream coordinates win over the source's", async () => {
  const [item] = await relay(
    [event({ location_name: "Health Sciences Campus", geo: { ...NO_GEO, latitude: "41.86036", longitude: "-87.835034" } })],
    { lat: 41.9987, lng: -87.6569 },
  );
  assert.equal(item.location?.lat, 41.86036);
});

test("an online event is not put at the campus", async () => {
  // DePaul marks online events "inperson", so `experience` alone would put them all on campus.
  const [virtual, mislabelled] = await relay([
    event({ location_name: "", experience: "virtual" }),
    event({ location_name: "Online Event", experience: "inperson" }),
  ], { lat: 41.9987, lng: -87.6569, location_name: "Lake Shore Campus" });
  assert.equal(virtual.location?.lat, undefined);
  assert.equal(virtual.location?.name, undefined, "and not given the campus name either");
  assert.equal(mislabelled.location?.lat, undefined);
  assert.equal(mislabelled.location?.name, "Online Event");
});

test("the source's fallback name covers a physical event upstream left blank", async () => {
  const [item] = await relay([event({ location_name: "" })], { location_name: "Lake Shore Campus" });
  assert.equal(item.location?.name, "Lake Shore Campus");
});
