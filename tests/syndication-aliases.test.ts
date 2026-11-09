import { test } from "node:test";
import assert from "node:assert/strict";
import { RowIndex, cancelTargets, groupShows, mergedAliases, nameWords, pickLead, planItem, resolveRows, sameShow } from "../lib/syndication/aliases.ts";
import type { ShowRecord, StoredRow } from "../lib/syndication/aliases.ts";
import { collapseInstances } from "../lib/syndication/collapse.ts";
import { showRecord, ticketmasterItems } from "../lib/syndication/ticketmaster.ts";
import type { Item } from "../lib/syndication/types.ts";

/**
 * Fixtures are shaped like Discovery v2 events. The pairs are CRI-61's confirmed twins from
 * src_tmNewYork: a dated slug URL with a timezone, and a bare /event/<id> URL without one, at one
 * venue id and one start instant. Ids and venue ids are invented; the shapes are production's.
 */

const NOW = new Date("2026-10-19T12:00:00Z");
const SOURCE = { tags: ["new-york"] };
type Raw = Record<string, unknown>;

type Rec = { id: string; name: string; slug?: string; venue: string; venueName?: string; at?: string; attraction?: { id: string; name: string } | null; url?: string; cancelled?: boolean };

function record(r: Rec): Raw {
  const at = r.at ?? "2026-10-20T23:00:00Z";
  const date = at.slice(0, 10);
  const [y, m, d] = date.split("-");
  const url = r.url ?? (r.slug ? `https://www.ticketmaster.com/${r.slug}-new-york-new-york-${m}-${d}-${y}/event/${r.id}` : `https://www.ticketmaster.com/event/${r.id}`);
  return {
    id: r.id,
    name: r.name,
    url,
    dates: { start: { localDate: date, localTime: "19:00:00", dateTime: at }, ...(r.slug ? { timezone: "America/New_York" } : {}), status: { code: r.cancelled ? "cancelled" : "onsale" } },
    _embedded: {
      venues: [{ id: r.venue, name: r.venueName ?? "Theatre", city: { name: "New York" }, state: { stateCode: "NY" } }],
      attractions: r.attraction === null ? [] : [r.attraction ?? { id: `att-${r.venue}`, name: r.name }],
    },
  };
}

/** A pair as production served it: the slug twin and the bare twin. */
function pair(slugName: string, bareName: string, slug: string, venue: string, attraction: { id: string; name: string }): [Raw, Raw] {
  return [
    record({ id: `Z1r9${venue}`, name: slugName, slug, venue, attraction }),
    record({ id: `Z7r9${venue}`, name: bareName, venue, attraction }),
  ];
}

const CRI_61: { show: string; records: [Raw, Raw] }[] = [
  { show: "Schmigadoon!", records: pair("Schmigadoon!", "Schmigadoon!", "schmigadoon", "Nederlander", { id: "att-schmig", name: "Schmigadoon!" }) },
  { show: "Hamilton", records: pair("Hamilton (NY)", "Hamilton", "hamilton-ny", "RichardRodgers", { id: "att-ham", name: "Hamilton" }) },
  { show: "Vince Giordano", records: pair("Vince Giordano and the Nighthawks", "Vince Giordano", "vince-giordano-and-the-nighthawks", "Birdland", { id: "att-vg", name: "Vince Giordano" }) },
  { show: "Just In Time", records: pair("Just In Time", "Just In Time", "just-in-time", "CircleSquare", { id: "att-jit", name: "Just In Time" }) },
  { show: "Stranger Things", records: pair("Stranger Things: The First Shadow", "Stranger Things: The First Shadow", "stranger-things-the-first-shadow", "Marquis", { id: "att-st", name: "Stranger Things: The First Shadow" }) },
  { show: "Little Shop", records: pair("Little Shop of Horrors", "Little Shop of Horrors", "little-shop-of-horrors", "Westside", { id: "att-ls", name: "Little Shop of Horrors" }) },
  { show: "Robert Glasper", records: pair("Robert Glasper", "Robert Glasper X Questlove + Special Guest Bilal", "robert-glasper", "BlueNote", { id: "att-rg", name: "Robert Glasper" }) },
  { show: "August Wilson's", records: pair("August Wilson's Seven Guitars", "August Wilsons Seven Guitars", "august-wilsons-seven-guitars", "Friedman", { id: "att-aw", name: "August Wilson's Seven Guitars" }) },
];

const relay = (...events: Raw[]): Item[] => collapseInstances(ticketmasterItems(events, SOURCE), NOW).items;
const keyOf = (e: Raw) => showRecord(e).key!;
const row = (uid: string, aliases: string[] = [], firstSeen = 1, post_id = `p-${uid}`): StoredRow => ({ uid, post_id, hash: "h", aliases, firstSeen });

test("each CRI-61 pair is relayed as one item under the slug twin's URL key, carrying the bare twin's key and both ids", () => {
  for (const { show, records: [slug, bare] } of CRI_61) {
    const out = relay(slug, bare);
    assert.equal(out.length, 1, show);
    assert.equal(out[0].uid, keyOf(slug), show);
    assert.deepEqual(out[0].aliases, [slug.id, keyOf(bare), bare.id], show);
    assert.equal(out[0].timezone, "America/New_York", `${show}: the lead's content`);
  }
});

test("today's live pair, each twin stored under its own uid, keeps the slug twin's row and retires the bare one into it", () => {
  const [slug, bare] = CRI_61[0].records;
  const [item] = relay(slug, bare);
  const rows = new RowIndex([row(keyOf(slug), [], 2), row(keyOf(bare), [], 1)]);
  const plan = planItem(rows, item);
  assert.equal(plan.uid, keyOf(slug), "the row under the item's uid is kept even though the other is older");
  assert.deepEqual(plan.retire.map((r) => r.uid), [keyOf(bare)]);
  assert.deepEqual(new Set(plan.aliases), new Set([slug.id, keyOf(bare), bare.id]));
});

test("when no matched row is stored under the item's uid, the oldest is kept and the rest retired", () => {
  const found = resolveRows("new-lead", [row("b", [], 30), row("a", [], 10), row("c", [], 10)]);
  assert.equal(found?.keep.uid, "a", "oldest, ties broken by uid");
  assert.deepEqual(found?.retire.map((r) => r.uid), ["b", "c"]);
  assert.equal(resolveRows("x", []), null, "nothing matched: insert");
});

test("a run that fetches only one twin finds the merged row by alias and keeps its uid", () => {
  const [slug, bare] = CRI_61[1].records;
  const [merged] = relay(slug, bare);
  const stored = row(merged.uid, merged.aliases);
  for (const alone of [bare, slug]) {
    const [item] = relay(alone);
    assert.deepEqual(item.aliases, [alone.id], "a lone record carries its own id alone");
    const plan = planItem(new RowIndex([stored]), item);
    assert.equal(plan.uid, keyOf(slug));
    assert.equal(plan.keep, stored);
    assert.deepEqual(plan.retire, []);
  }
});

test("a lead flip keeps the stored uid", () => {
  const venue = "Lyceum", attraction = { id: "att-oh", name: "Oh, Mary!" };
  const bareA = record({ id: "Z7r9A", name: "Oh, Mary!", venue, attraction });
  const bareB = record({ id: "Z7r9B", name: "Oh, Mary!", venue, attraction, url: "https://www.ticketmaster.com/event/Z7r9B" });
  const [first] = relay(bareA, bareB);
  assert.equal(first.uid, keyOf(bareA), "no dated slug: the lowest id leads");
  const stored = row(first.uid, first.aliases);

  const slug = record({ id: "Z9r9C", name: "Oh, Mary!", slug: "oh-mary", venue, attraction });
  const [next] = relay(bareA, bareB, slug);
  assert.equal(next.uid, keyOf(slug), "a dated slug now leads");
  const plan = planItem(new RowIndex([stored]), next);
  assert.equal(plan.uid, keyOf(bareA), "the row keeps the uid it was stored under");
  assert.ok(plan.aliases.includes(keyOf(slug)) && plan.aliases.includes("Z9r9C"));
  assert.ok(!plan.aliases.includes(plan.uid));
});

test("a reschedule of a stored show finds its row and creates no new identity", () => {
  const attraction = { id: "att-jit", name: "Just In Time" };
  const before = [record({ id: "Z1r9J", name: "Just In Time", slug: "just-in-time", venue: "CircleSquare", attraction }), record({ id: "Z7r9J", name: "Just In Time", venue: "CircleSquare", attraction })];
  const [merged] = relay(...before);
  const stored = row(merged.uid, merged.aliases);

  const moved = { at: "2026-10-21T18:00:00Z" };
  const after = [record({ id: "Z1r9J", name: "Just In Time", slug: "just-in-time", venue: "CircleSquare", attraction, ...moved }), record({ id: "Z7r9J", name: "Just In Time", venue: "CircleSquare", attraction, ...moved })];
  for (const fetched of [after, [after[0]]]) {
    const [item] = relay(...fetched);
    assert.notEqual(item.uid, stored.uid, "the dated slug URL moved with the date");
    const plan = planItem(new RowIndex([stored]), item);
    assert.equal(plan.uid, stored.uid, `${fetched.length} record(s) fetched`);
    assert.deepEqual(plan.retire, []);
  }
});

test("a reschedule of a show stored alone finds its row by the record's own id", () => {
  const attraction = { id: "att-oh", name: "Oh, Mary!" };
  const [first] = relay(record({ id: "Z1r9O", name: "Oh, Mary!", slug: "oh-mary", venue: "Lyceum", attraction }));
  const stored = row(first.uid, first.aliases);
  const [moved] = relay(record({ id: "Z1r9O", name: "Oh, Mary!", slug: "oh-mary", venue: "Lyceum", attraction, at: "2026-10-22T23:00:00Z" }));
  assert.notEqual(moved.uid, stored.uid);
  assert.equal(planItem(new RowIndex([stored]), moved).uid, stored.uid);
});

test("a twin arriving cancelled alone does not retire the merged show; the sweep decides", () => {
  const [slug, bare] = CRI_61[7].records;
  const [merged] = relay(slug, bare);
  const stored = row(merged.uid, merged.aliases);
  const cancel = (e: Raw): Raw => ({ ...e, dates: { ...(e.dates as Raw), status: { code: "cancelled" } } });
  for (const alone of [cancel(bare), cancel(slug)]) {
    const [item] = relay(alone);
    assert.equal(item.cancelled, true);
    const plan = planItem(new RowIndex([stored]), item);
    assert.equal(plan.keep, stored, "it does reach the show's row");
    assert.equal(cancelTargets(plan, item), null);
  }
  const [both] = relay(cancel(slug), cancel(bare));
  assert.deepEqual(cancelTargets(planItem(new RowIndex([stored]), both), both), [stored], "every record cancelled: retire");
});

test("a cancelled item retires rows it names in full: its own, and today's twin rows without aliases", () => {
  const [slug, bare] = CRI_61[3].records;
  const cancel = (e: Raw): Raw => ({ ...e, dates: { ...(e.dates as Raw), status: { code: "cancelled" } } });
  const [alone] = relay(cancel(bare));
  const legacy = [row(keyOf(slug), [], 1), row(keyOf(bare), [], 2)];
  assert.deepEqual(cancelTargets(planItem(new RowIndex(legacy), alone), alone)?.map((r) => r.uid), [keyOf(bare)]);
  const [both] = relay(cancel(slug), cancel(bare));
  assert.deepEqual(cancelTargets(planItem(new RowIndex(legacy), both), both)?.map((r) => r.uid), [keyOf(slug), keyOf(bare)]);
  assert.deepEqual(cancelTargets(planItem(new RowIndex(legacy), { uid: "nothing" }), { uid: "nothing" }), [], "nothing matched");
});

test("a cancelled item does not retire a row under its own uid that holds identities it lacks", () => {
  const timedEntry = row("universe.com/events/daydream", ["slot-1", "slot-2"]);
  const cancelled = { uid: "universe.com/events/daydream", aliases: ["slot-3"] };
  assert.equal(cancelTargets(planItem(new RowIndex([timedEntry]), cancelled), cancelled), null, "slot ids gathered over earlier runs");
  const [slug, bare] = CRI_61[5].records;
  const [merged] = relay(slug, bare);
  const [slugAlone] = relay({ ...slug, dates: { ...(slug.dates as Raw), status: { code: "cancelled" } } });
  assert.equal(slugAlone.uid, merged.uid, "the row is stored under this item's own uid");
  assert.equal(cancelTargets(planItem(new RowIndex([row(merged.uid, merged.aliases)]), slugAlone), slugAlone), null);
});

test("another adapter's cancelled item retires the row under its uid, as before aliases", () => {
  const rows = new RowIndex([row("a"), row("b")]);
  assert.deepEqual(cancelTargets(planItem(rows, { uid: "a" }), { uid: "a" })?.map((r) => r.uid), ["a"]);
});

test("records sharing one URL under different titles stay separate items under their own ids", () => {
  const url = "https://www.ticketmaster.com/venue/123";
  const out = relay(
    record({ id: "BR1", name: "Gospel Brunch feat. Act 1", venue: "Sylvia", url, attraction: null }),
    record({ id: "BR2", name: "Gospel Brunch feat. Act 2", venue: "Sylvia", url, attraction: null }),
  );
  assert.deepEqual(out.map((i) => i.uid), ["BR1", "BR2"]);
  assert.deepEqual(out.map((i) => i.aliases), [["BR1"], ["BR2"]], "each its own id, which is also its uid");
});

test("a single generic-word name does not merge, even as the prefix of another name at the same venue and time", () => {
  const venue = "Cellar";
  const comedy = record({ id: "C1", name: "Comedy", venue, attraction: { id: "att-cellar", name: "Comedy Cellar" } });
  const night = record({ id: "C2", name: "Comedy Night with Jim Gaffigan", venue, attraction: { id: "att-cellar", name: "Comedy Cellar" } });
  assert.equal(relay(comedy, night).length, 2);
  const twin = record({ id: "C3", name: "Comedy", venue, attraction: null });
  assert.equal(relay(comedy, twin).length, 2, "one word alike, nothing naming the show");
});

test("a one-word show merges only through an attraction of that name", () => {
  const [slug, bare] = CRI_61[1].records;
  const strip = (e: Raw): Raw => ({ ...e, _embedded: { ...(e._embedded as Raw), attractions: [] } });
  assert.equal(relay(strip(slug), strip(bare)).length, 2, "Hamilton with no attraction stays two");
  assert.equal(relay(slug, bare).length, 1);
});

test("different venue ids or different starts never merge", () => {
  const attraction = { id: "att-ls", name: "Little Shop of Horrors" };
  const a = record({ id: "L1", name: "Little Shop of Horrors", slug: "little-shop-of-horrors", venue: "Westside", attraction });
  assert.equal(relay(a, record({ id: "L2", name: "Little Shop of Horrors", venue: "Westside-NY", attraction })).length, 2);
  assert.equal(relay(a, record({ id: "L3", name: "Little Shop of Horrors", venue: "Westside", attraction, at: "2026-10-21T23:00:00Z" })).length, 2);
});

test("one loose pair cannot chain two different shows together", () => {
  const base: ShowRecord = { id: "", key: null, venueId: "v", start: "2026-10-20T23:00:00.000Z", name: "", attractions: [] };
  const a = { ...base, id: "1", key: "a", name: "Robert Glasper" };
  const b = { ...base, id: "2", key: "b", name: "Robert Glasper X Questlove" };
  const c = { ...base, id: "3", key: "c", name: "Robert Glasper Trio" };
  assert.ok(sameShow(a, b) && sameShow(a, c) && !sameShow(b, c));
  assert.deepEqual(groupShows([a, b, c]).map((g) => g.map((r) => r.id)), [["1", "2"], ["3"]]);
});

test("the lead is the dated slug record, else the lowest id", () => {
  const base: ShowRecord = { id: "", key: null, venueId: "v", start: "s", name: "x", attractions: [] };
  assert.equal(pickLead([{ ...base, id: "A", key: "ticketmaster.com/event/a" }, { ...base, id: "B", key: "ticketmaster.com/x-new-york-new-york-10-20-2026/event/b" }]).id, "B");
  assert.equal(pickLead([{ ...base, id: "B", key: "ticketmaster.com/event/b" }, { ...base, id: "A", key: "ticketmaster.com/event/a" }]).id, "A");
});

test("a show is cancelled only when every record of it is", () => {
  const attraction = { id: "att-aw", name: "August Wilson's Seven Guitars" };
  const slug = record({ id: "W1", name: "August Wilson's Seven Guitars", slug: "august-wilsons-seven-guitars", venue: "Friedman", attraction, cancelled: true });
  const bare = record({ id: "W2", name: "August Wilsons Seven Guitars", venue: "Friedman", attraction });
  const [one] = ticketmasterItems([slug, bare], SOURCE);
  assert.equal(one.cancelled, false);
  assert.equal(one.uid, "W2", "the lead is chosen among the records still on");
  const [off] = ticketmasterItems([slug, { ...bare, dates: { ...(bare.dates as Raw), status: { code: "cancelled" } } }], SOURCE);
  assert.equal(off.cancelled, true);
});

test("an item without aliases matches only the row under its own uid, as before aliases", () => {
  const rows = new RowIndex([row("a"), row("b", ["x"])]);
  const plan = planItem(rows, { uid: "a" });
  assert.equal(plan.keep?.uid, "a");
  assert.deepEqual(plan.retire, []);
  assert.deepEqual(plan.aliases, []);
  assert.equal(plan.aliased, false);
  assert.deepEqual(planItem(rows, { uid: "new" }), { uid: "new", keep: null, retire: [], aliases: [], aliased: false });
});

test("a kept row only gains aliases, including every retired row's, and never lists its own uid", () => {
  const keep = row("k", ["old"]);
  assert.deepEqual(mergedAliases(keep, ["k", "new"], [row("t", ["t-alias"])]), ["old", "new", "t", "t-alias"]);
});

test("a retired row leaves the index, so a later lone twin finds only the kept row", () => {
  const rows = new RowIndex([row("slug", ["bare"]), row("bare")]);
  assert.equal(planItem(rows, { uid: "bare" }).keep?.uid, "bare", "both still stored: the row under the item's uid wins");
  rows.remove("bare");
  assert.equal(planItem(rows, { uid: "bare" }).keep?.uid, "slug");
});

test("names compare by words, apostrophes dropped", () => {
  assert.deepEqual(nameWords("August Wilson's Seven Guitars"), nameWords("August Wilsons Seven Guitars"));
  assert.deepEqual(nameWords("Hamilton (NY)"), ["hamilton", "ny"]);
});
