import { test } from "node:test";
import assert from "node:assert/strict";
import { RECURRENCE_CAP, collapseInstances, foldKey } from "../lib/syndication/collapse.ts";
import type { Item } from "../lib/syndication/types.ts";

/**
 * The specification for the fold. What the shapes below are is not invented: they are the two that
 * put 603 repeat rows on the live board — a Ticketmaster timed-entry attraction whose every
 * 15-minute slot is its own event id, and a Localist event whose every instance is its own uid —
 * plus the venue landing page that sells four different brunches from one URL and must not fold.
 */

const NOW = new Date("2026-09-13T12:00:00Z");
const at = (iso: string) => new Date(iso).toISOString();

function item(over: Partial<Item> & { uid: string }): Item {
  return {
    title: "Daydream: Air Becomes Art",
    body: "Arts & Theatre\nAt Balloon Museum, New York, NY.\nSource: Ticketmaster (relayed by Crier).",
    url: "https://universe.com/events/daydream-balloon-museum-tickets-y5hv92",
    kind: "event",
    ...over,
  };
}

/** A timed-entry attraction: one upstream thing, one event id per slot. */
function slots(starts: string[]): Item[] {
  return starts.map((s, i) => item({ uid: `tm-${i}`, starts_at: s, timezone: "America/New_York" }));
}

test("instances of one upstream thing become one item", () => {
  const { items, folded } = collapseInstances(slots([
    "2026-09-13T21:45:00Z", "2026-09-13T22:00:00Z", "2026-09-13T22:15:00Z", "2026-09-14T21:45:00Z",
  ]), NOW);
  assert.equal(items.length, 1);
  assert.equal(folded, 3);
  const [one] = items;
  assert.equal(one.starts_at, "2026-09-13T21:45:00Z", "the next upcoming instance leads");
  assert.deepEqual(one.metadata?.recurrence, [at("2026-09-13T22:00:00Z"), at("2026-09-13T22:15:00Z"), at("2026-09-14T21:45:00Z")]);
  assert.equal(one.metadata?.recurrence_count, 4);
});

test("the item is keyed on what the read path collapses on, not on the instance", () => {
  const [one] = collapseInstances(slots(["2026-09-13T21:45:00Z", "2026-09-13T22:00:00Z"]), NOW).items;
  assert.equal(one.uid, "universe.com/events/daydream-balloon-museum-tickets-y5hv92");
  assert.equal(one.uid, foldKey(one), "stable: folding the fold changes nothing");
});

test("a single instance is keyed the same way, so it does not change identity when a sibling appears", () => {
  const { items, folded } = collapseInstances(slots(["2026-09-13T21:45:00Z"]), NOW);
  assert.equal(folded, 0);
  assert.equal(items[0].uid, "universe.com/events/daydream-balloon-museum-tickets-y5hv92");
  assert.equal(items[0].metadata, undefined, "nothing to carry, nothing added");
});

test("an item without a URL keeps its own uid — nothing folds that cannot be proven the same", () => {
  const floating = [
    item({ uid: "ical-a", url: undefined, title: "Storytime", starts_at: "2026-09-14T15:00:00Z" }),
    item({ uid: "ical-b", url: undefined, title: "Storytime", starts_at: "2026-09-21T15:00:00Z" }),
  ];
  const { items, folded } = collapseInstances(floating, NOW);
  assert.equal(folded, 0);
  assert.deepEqual(items.map((i) => i.uid), ["ical-a", "ical-b"]);
});

test("several different things behind one URL are left alone for the runner's guard to bound", () => {
  const brunches = [1, 2, 3, 4].map((n) => item({
    uid: `tm-gb-${n}`, title: `Gospel Brunch feat. Act ${n}`,
    url: "https://stubbsaustin.com/gospel-brunch", starts_at: `2026-09-${13 + n * 7}T15:30:00Z`,
  }));
  const { items, folded } = collapseInstances(brunches, NOW);
  assert.equal(folded, 0, "folding these would publish one brunch and lose three");
  assert.deepEqual(items.map((i) => i.uid), ["tm-gb-1", "tm-gb-2", "tm-gb-3", "tm-gb-4"]);
});

test("instances already past are not offered as somewhere still to go", () => {
  const [one] = collapseInstances(slots([
    "2026-09-13T09:00:00Z", "2026-09-13T10:00:00Z", "2026-09-13T21:45:00Z", "2026-09-14T21:45:00Z",
  ]), NOW).items;
  assert.equal(one.starts_at, "2026-09-13T21:45:00Z");
  assert.deepEqual(one.metadata?.recurrence, [at("2026-09-14T21:45:00Z")]);
  assert.match(one.body, /^Also at: Sep 14, 17:45 \(America\/New_York\)\.$/m, "21:45Z, shown in the zone the museum is in");
});

test("when every instance is past, the earliest still stands for the thing", () => {
  const { items } = collapseInstances(slots(["2026-09-11T21:45:00Z", "2026-09-12T21:45:00Z"]), NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].starts_at, "2026-09-11T21:45:00Z");
  assert.equal(items[0].metadata, undefined, "nothing upcoming to carry");
});

test("the recurrence list is capped, and the body says how many it is not showing", () => {
  const starts = Array.from({ length: 40 }, (_, i) => `2026-09-${14 + Math.floor(i / 4)}T${String(12 + (i % 4)).padStart(2, "0")}:00:00Z`);
  const [one] = collapseInstances(slots(starts), NOW).items;
  assert.equal((one.metadata?.recurrence as string[]).length, RECURRENCE_CAP);
  assert.equal(one.metadata?.recurrence_count, 40);
  assert.match(one.body, /, and 31 more \(America\/New_York\)\.$/m, "8 shown of the 39 that are not the first");
});

test("the Also at line goes above the attribution, which stays last", () => {
  const [one] = collapseInstances(slots(["2026-09-13T21:45:00Z", "2026-09-14T21:45:00Z"]), NOW).items;
  const lines = one.body.split("\n");
  assert.equal(lines[lines.length - 1], "Source: Ticketmaster (relayed by Crier).");
  assert.equal(lines[lines.length - 2], "Also at: Sep 14, 17:45 (America/New_York).");
});

test("times are shown in the item's zone, and UTC when it has none", () => {
  const naive = slots(["2026-09-13T21:45:00Z", "2026-09-14T02:30:00Z"]).map((i) => ({ ...i, timezone: undefined }));
  assert.match(collapseInstances(naive, NOW).items[0].body, /Also at: Sep 14, 02:30 \(UTC\)\./);
  const bogus = slots(["2026-09-13T21:45:00Z", "2026-09-14T02:30:00Z"]).map((i) => ({ ...i, timezone: "Mars/Olympus" }));
  assert.match(collapseInstances(bogus, NOW).items[0].body, /Also at: Sep 14, 02:30 \(UTC\)\./, "an unresolvable zone falls back to UTC times, labelled UTC");
});

test("a folded post outlives its first instance, not its last", () => {
  const [one] = collapseInstances([
    item({ uid: "a", starts_at: "2026-09-13T21:45:00Z", ends_at: "2026-09-13T23:00:00Z" }),
    item({ uid: "b", starts_at: "2026-10-30T21:45:00Z", ends_at: "2026-10-30T23:00:00Z" }),
  ], NOW).items;
  assert.equal(one.ends_at, "2026-09-13T23:00:00Z", "the window is the instance we are showing");
  assert.equal(one.expires_at, at("2026-10-31T23:00:00Z"), "but it stays on the board a day past the last one");
});

test("a cancelled instance of something still running is simply gone from the list", () => {
  const { items } = collapseInstances([
    item({ uid: "a", starts_at: "2026-09-13T21:45:00Z" }),
    item({ uid: "b", starts_at: "2026-09-14T21:45:00Z", cancelled: true }),
    item({ uid: "c", starts_at: "2026-09-15T21:45:00Z" }),
  ], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].cancelled, undefined);
  assert.deepEqual(items[0].metadata?.recurrence, [at("2026-09-15T21:45:00Z")]);
});

test("when every instance is cancelled, both the folded post and the per-instance ones are retired", () => {
  const { items } = collapseInstances([
    item({ uid: "a", starts_at: "2026-09-13T21:45:00Z", cancelled: true }),
    item({ uid: "b", starts_at: "2026-09-14T21:45:00Z", cancelled: true }),
  ], NOW);
  assert.ok(items.every((i) => i.cancelled));
  assert.deepEqual(items.map((i) => i.uid), ["universe.com/events/daydream-balloon-museum-tickets-y5hv92", "a", "b"]);
});

test("unrelated items are untouched and keep their order", () => {
  const mixed = [
    item({ uid: "x", url: "https://example.org/a", title: "A", starts_at: "2026-09-14T12:00:00Z" }),
    item({ uid: "y", url: "https://example.org/b", title: "B", starts_at: "2026-09-15T12:00:00Z" }),
  ];
  const { items, folded } = collapseInstances(mixed, NOW);
  assert.equal(folded, 0);
  assert.deepEqual(items.map((i) => i.title), ["A", "B"]);
});
