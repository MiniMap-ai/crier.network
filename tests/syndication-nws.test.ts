import { test } from "node:test";
import assert from "node:assert/strict";
import { NWS_END_GRACE_MS, nws, nwsExpiry, nwsTimezone } from "../lib/syndication/adapters.ts";
import type { SourceRow } from "../lib/syndication/types.ts";

/**
 * When an NWS alert leaves the board, and what zone its times are in. The fixture is the shape
 * api.weather.gov/alerts/active served for the Pueblo flood watch of 2026-10-22 (`kGeHRieh`): CAP
 * <expires> the same afternoon, <ends> the next evening, and a post that left the board 27 h 45 min
 * before the flood watch ended (CRI-50).
 */

const NOW = new Date("2026-10-22T12:30:00Z");

type Props = Record<string, unknown>;

function feature(over: Props): { properties: Props; geometry: Record<string, unknown> } {
  return {
    properties: {
      id: "urn:oid:2.49.0.1.840.0.c1f149982e15ed02a8a60af965ba186d9b0662b3.001.1",
      event: "Flood Watch",
      headline: "Flood Watch issued October 22 at 6:05AM MDT until October 23 at 6:00PM MDT by NWS Pueblo CO",
      senderName: "NWS Pueblo CO",
      areaDesc: "Alamosa Vicinity/Central San Luis Valley Below 8500 Ft",
      description: "Minor flooding on the Rio Grande at Alamosa.",
      instruction: "Monitor forecasts.",
      severity: "Severe", urgency: "Expected", certainty: "Likely",
      effective: "2026-10-22T06:05:00-06:00",
      onset: "2026-10-22T06:05:00-06:00",
      ends: "2026-10-23T18:00:00-06:00",
      expires: "2026-10-22T14:15:00-06:00",
      affectedZones: [],
      ...over,
    },
    // A polygon, so the adapter does not go looking for a zone centroid.
    geometry: { type: "Polygon", coordinates: [[[-105.9, 37.4], [-105.8, 37.4], [-105.8, 37.5], [-105.9, 37.5], [-105.9, 37.4]]] },
  };
}

function source(): SourceRow {
  return {
    id: "src_nwsCO", name: "NWS alerts, Colorado", adapter: "nws",
    config: { area: "CO" },
    homepage: null, license: "National Weather Service, public domain", default_kind: "announcement", tags: ["colorado"],
    enabled: true, run_every_minutes: 60, max_per_run: 100, horizon_days: 7,
    added_by: "test", notes: null, created_at: NOW, last_run_at: null,
    last_status: null, last_error: null, last_counts: null,
  };
}

async function relay(features: ReturnType<typeof feature>[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ features }), { headers: { "Content-Type": "application/geo+json" } })) as typeof fetch;
  try {
    return await nws(source(), { now: NOW, horizonEnd: new Date("2026-10-29T12:30:00Z"), signal: AbortSignal.timeout(30_000) });
  } finally {
    globalThis.fetch = real;
  }
}

const iso = (s: string) => new Date(s).toISOString();

test("an alert whose refresh deadline precedes its end stays on the board until the hazard is over", async () => {
  const [item] = await relay([feature({})]);
  assert.equal(item.ends_at, "2026-10-23T18:00:00-06:00");
  assert.equal(item.expires_at, iso("2026-10-23T19:00:00-06:00"), "ends plus the hour of grace, not the 14:15 refresh deadline");
  assert.ok(Date.parse(item.expires_at!) > Date.parse(item.ends_at!), "searchable for the whole hazard window");
});

test("an alert whose refresh deadline already outlives its end is left alone: this is a floor, not a ceiling", async () => {
  const [item] = await relay([feature({ ends: "2026-10-22T14:00:00-06:00", expires: "2026-10-22T22:00:00-06:00" })]);
  assert.equal(item.expires_at, iso("2026-10-22T22:00:00-06:00"));
});

test("an alert with no end keeps the refresh deadline as its only bound", async () => {
  const [item] = await relay([feature({ ends: null, headline: "Special Weather Statement issued October 22 at 6:05AM MDT by NWS Pueblo CO" })]);
  assert.equal(item.ends_at, undefined);
  assert.equal(item.expires_at, iso("2026-10-22T14:15:00-06:00"));
});

test("nwsExpiry on its own", () => {
  const ends = "2026-10-23T18:00:00-06:00";
  assert.equal(nwsExpiry("2026-10-22T14:15:00-06:00", ends), new Date(Date.parse(ends) + NWS_END_GRACE_MS).toISOString());
  assert.equal(nwsExpiry("2026-10-24T06:00:00Z", ends), iso("2026-10-24T06:00:00Z"), "the later of the two wins: a deadline past the end plus grace is kept as it is");
  assert.equal(nwsExpiry("2026-10-22T14:15:00-06:00", ""), iso("2026-10-22T14:15:00-06:00"));
  assert.equal(nwsExpiry("", ends), new Date(Date.parse(ends) + NWS_END_GRACE_MS).toISOString());
  assert.equal(nwsExpiry("", ""), undefined, "nothing to bound on: the runner falls back to its defaults");
  assert.equal(nwsExpiry("not a date", "also not"), undefined);
});

test("the zone comes from the abbreviation in the headline, which the CAP timestamps' offsets cannot give", async () => {
  const [item] = await relay([feature({})]);
  assert.equal(item.timezone, "America/Denver");
  assert.equal(nwsTimezone("Dense Fog Advisory issued November 2 at 5:03AM CST until November 2 at 10:00AM CST by NWS Corpus Christi TX", "NWS Corpus Christi TX"), "America/Chicago");
  assert.equal(nwsTimezone("Beach Hazards Statement issued October 19 at 1:23AM PDT until October 20 at 9:00AM PDT by NWS San Diego CA", "NWS San Diego CA"), "America/Los_Angeles");
  assert.equal(nwsTimezone("Winter Weather Advisory issued December 1 at 4:00 PM EST until December 2 at 7:00 AM EST by NWS Burlington VT", "NWS Burlington VT"), "America/New_York", "a space before the abbreviation is fine");
  assert.equal(nwsTimezone("Extreme Heat Warning issued October 7 at 1:00PM MST until October 8 at 8:00PM MST by NWS Phoenix AZ", "NWS Phoenix AZ"), "America/Phoenix", "Arizona keeps MST all year");
  assert.equal(nwsTimezone("Extreme Heat Warning issued October 7 at 1:00PM MST until October 8 at 8:00PM MST by NWS Las Vegas NV", "NWS Las Vegas NV"), "America/Denver", "MST anywhere else is the Mountain zone in winter");
  assert.equal(nwsTimezone("Flood Watch: Alamosa Vicinity", "NWS Pueblo CO"), undefined, "no time in the headline, no guess");
  assert.equal(nwsTimezone("issued at 3:13AM XYZ by someone", "NWS Pueblo CO"), undefined, "an abbreviation we do not know is left null rather than wrong");
});
