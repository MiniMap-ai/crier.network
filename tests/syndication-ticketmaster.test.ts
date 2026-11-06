import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseInstances, identities } from "../lib/syndication/collapse.ts";
import { composeTitle, isVenueRules, localWhen, mergeRepresentations, representation } from "../lib/syndication/ticketmaster.ts";
import type { Representation } from "../lib/syndication/ticketmaster.ts";
import { MAX_PER_RUN_CAP, runLimit } from "../lib/syndication/types.ts";

/**
 * Fixtures are shaped like Discovery v2 events. The pairs are the ones production served for
 * src_tmNewYork (CRI-61): a dated slug URL with a timezone, and a bare /event/<id> URL without one.
 */

const NOW = new Date("2026-11-06T12:00:00Z");
const SOURCE = { tags: ["new-york"] };

type Raw = Record<string, unknown>;

const SAMUEL_FRIEDMAN = { id: "KovZpZAEAd6A", name: "Samuel J. Friedman Theatre", timezone: "America/New_York", city: { name: "New York" }, state: { stateCode: "NY" }, location: { latitude: "40.7590", longitude: "-73.9870" } };

function discovery(over: Raw & { id: string }, dates: Raw = {}, venue: Raw = SAMUEL_FRIEDMAN, attractions: Raw[] = [{ id: "K8vZ917_Seven", name: "August Wilson's Seven Guitars" }]): Raw {
  return {
    name: "August Wilson's Seven Guitars",
    url: `https://www.ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/${over.id}`,
    classifications: [{ segment: { name: "Arts & Theatre" }, genre: { name: "Theatre" }, subGenre: { name: "Drama" } }],
    dates: { start: { localDate: "2026-11-06", localTime: "20:00:00", dateTime: "2026-11-07T01:00:00Z" }, timezone: "America/New_York", status: { code: "onsale" }, ...dates },
    _embedded: { venues: [venue], attractions },
    ...over,
  };
}

/** The bare-URL twin: another id, no apostrophe, no dates.timezone. */
function bareTwin(over: Raw & { id: string }, venue: Raw = SAMUEL_FRIEDMAN): Raw {
  const base = discovery(over, {}, venue);
  const dates = { ...(base.dates as Raw) };
  delete dates.timezone;
  return { ...base, name: "August Wilsons Seven Guitars", url: `https://www.ticketmaster.com/event/${over.id}`, dates, ...over };
}

const reps = (...events: Raw[]): Representation[] => events.map((e) => representation(e, SOURCE)).filter((r): r is Representation => r !== null);

test("two Discovery records of one show become one item", () => {
  const items = mergeRepresentations(reps(bareTwin({ id: "Z7r9jZ1AAvFCa" }), discovery({ id: "G5vzZ1AvZoOP" })));
  assert.equal(items.length, 1);
  const [one] = items;
  assert.equal(one.title, "August Wilson's Seven Guitars", "the record with its own timezone leads");
  assert.equal(one.timezone, "America/New_York");
  assert.match(one.url!, /-11-06-2026\/event\/G5vzZ1AvZoOP$/);
  assert.equal(one.key, "tm:KovZpZAEAd6A@2026-11-07T01:00:00.000Z");
  assert.deepEqual(one.metadata?.discovery_ids, ["G5vzZ1AvZoOP", "Z7r9jZ1AAvFCa"]);
  assert.ok(one.aliases?.includes("ticketmaster.com/event/z7r9jz1aavfca"), "the bare URL earlier runs keyed a post on");
  assert.ok(one.aliases?.includes("ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/g5vzz1avzoop"));
});

test("the key does not depend on which records arrived, so a run that sees one updates the same row", () => {
  const both = mergeRepresentations(reps(discovery({ id: "G5vzZ1AvZoOP" }), bareTwin({ id: "Z7r9jZ1AAvFCa" })));
  const slugOnly = mergeRepresentations(reps(discovery({ id: "G5vzZ1AvZoOP" })));
  const bareOnly = mergeRepresentations(reps(bareTwin({ id: "Z7r9jZ1AAvFCa" })));
  const uid = (items: typeof both) => collapseInstances(items, NOW).items[0].uid;
  assert.equal(uid(both), "tm:KovZpZAEAd6A@2026-11-07T01:00:00.000Z");
  assert.equal(uid(slugOnly), uid(both));
  assert.equal(uid(bareOnly), uid(both));
});

test("a post written under the old URL key is found through the aliases", () => {
  const [one] = collapseInstances(mergeRepresentations(reps(discovery({ id: "G5vzZ1AvZoOP" }), bareTwin({ id: "Z7r9jZ1AAvFCa" }))), NOW).items;
  const ids = identities(one);
  assert.equal(ids[0], one.uid);
  assert.equal(ids[1], "ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/g5vzz1avzoop", "the lead record's URL is adopted first");
  assert.ok(ids.includes("ticketmaster.com/event/z7r9jz1aavfca"));
});

test("a venue-name variant and extra billing still match on venue, start and name prefix", () => {
  const richard = { id: "KovZpZAJ6nlA", name: "Richard Rodgers Theatre", timezone: "America/New_York", city: { name: "New York" } };
  const items = mergeRepresentations(reps(
    discovery({ id: "Z1r9uZrrZbpZ1AvqebK", name: "Hamilton (NY)" }, {}, richard, [{ id: "K8vZ9171o0V", name: "Hamilton" }]),
    bareTwin({ id: "Z7r9jZ1AA73F4", name: "Hamilton" }, { ...richard, name: "Richard Rodgers Theatre-NY" }),
  ));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Hamilton (NY)", "thirteen characters and two words: left as Discovery has it");
});

test("two different shows at one venue and instant stay two, with distinct keys", () => {
  const items = mergeRepresentations(reps(
    discovery({ id: "A1", name: "Late Show With Somebody Else" }, {}, SAMUEL_FRIEDMAN, [{ id: "att-1" }]),
    discovery({ id: "B2", name: "August Wilson's Seven Guitars" }, {}, SAMUEL_FRIEDMAN, [{ id: "att-2" }]),
  ));
  assert.equal(items.length, 2);
  assert.notEqual(items[0].key, items[1].key);
  assert.deepEqual(items.map((i) => i.key), ["tm:KovZpZAEAd6A@2026-11-07T01:00:00.000Z:A1", "tm:KovZpZAEAd6A@2026-11-07T01:00:00.000Z:B2"]);
});

test("a record with no venue id, coordinates or absolute start is relayed alone under its own id", () => {
  const raw = discovery({ id: "LONE1" }, { start: { localDate: "2026-11-06", localTime: "20:00:00" } });
  const items = mergeRepresentations(reps(raw));
  assert.equal(items.length, 1);
  assert.equal(items[0].key, undefined);
  assert.equal(items[0].uid, "LONE1");
});

test("timezone comes from the event, then from the venue, then from the twin", () => {
  assert.equal(representation(discovery({ id: "E1" }), SOURCE)?.item.timezone, "America/New_York");
  assert.equal(representation(bareTwin({ id: "E2" }, { ...SAMUEL_FRIEDMAN, timezone: "America/Denver" }), SOURCE)?.item.timezone, "America/Denver", "the venue's zone when the event has none");
  const noZone = { ...SAMUEL_FRIEDMAN, timezone: undefined };
  assert.equal(representation(bareTwin({ id: "E3" }, noZone), SOURCE)?.item.timezone, undefined, "nothing to fall back on, nothing invented");
  const [one] = mergeRepresentations(reps(bareTwin({ id: "E3" }, noZone), discovery({ id: "E4" }, {}, noZone)));
  assert.equal(one.timezone, "America/New_York");
});

test("ends_at is set only when Discovery gives an end instant", () => {
  assert.equal(representation(discovery({ id: "E1" }), SOURCE)?.item.ends_at, undefined);
  const ended = discovery({ id: "E2" }, { end: { localDate: "2026-11-06", dateTime: "2026-11-07T03:30:00Z" } });
  assert.equal(representation(ended, SOURCE)?.item.ends_at, "2026-11-07T03:30:00Z");
  const vague = discovery({ id: "E3" }, { end: { dateTime: "2026-11-07T03:30:00Z", noSpecificTime: true } });
  assert.equal(representation(vague, SOURCE)?.item.ends_at, undefined);
});

test("short or single-word names carry the venue; descriptive names are left alone", () => {
  assert.equal(composeTitle("Wanted", "James Earl Jones Theatre", "New York"), "Wanted at James Earl Jones Theatre");
  assert.equal(composeTitle("Just In Time", "Circle in the Square", "New York"), "Just In Time at Circle in the Square", "twelve characters is still short");
  assert.equal(composeTitle("Schmigadoon!", "", "New York"), "Schmigadoon! in New York", "the city stands in for a missing venue");
  assert.equal(composeTitle("Phantasmagorical", "Lyceum Theatre", ""), "Phantasmagorical at Lyceum Theatre", "one word, however long");
  assert.equal(composeTitle("Stranger Things: The First Shadow", "Marquis Theatre", "New York"), "Stranger Things: The First Shadow");
  assert.equal(composeTitle("Wanted", "", ""), "Wanted");
});

test("venue rules are not a description: the body names the show, the date and the place instead", () => {
  const rules = "(1) Children under 4 years old will not be admitted. (2) Herbal cigarettes are used on stage. (3) No weapons permitted on the premises.";
  const r = representation(discovery({ id: "uxh6", name: "Wanted", pleaseNote: rules, info: "No outside food or beverages, electric scooters, e-bikes." }, {}, { ...SAMUEL_FRIEDMAN, name: "James Earl Jones Theatre" }, [{ id: "att-w", name: "Wanted" }]), SOURCE)!;
  assert.ok(!r.item.body.includes("admitted") && !r.item.body.includes("scooters"), r.item.body);
  assert.match(r.item.body, /^Wanted on Nov 6, 8:00 PM at James Earl Jones Theatre, New York, NY\.$/m);
  assert.equal(r.item.body.split("\n").at(-1), "Source: Ticketmaster (relayed by Crier; details may change, check the link).");
});

test("the event's own info text is the description when it has one", () => {
  const r = representation(discovery({ id: "E1", info: "Ruben Santiago-Hudson directs a revival of August Wilson's 1948 drama." }), SOURCE)!;
  assert.match(r.item.body, /^At Samuel J\. Friedman Theatre, New York, NY\.$/m);
  assert.match(r.item.body, /^Ruben Santiago-Hudson directs/m);
});

test("a merged item takes the description from whichever record has one", () => {
  const [one] = mergeRepresentations(reps(discovery({ id: "LEAD", pleaseNote: "No re-entry." }), bareTwin({ id: "TWIN", info: "A revival of the 1948 drama." })));
  assert.match(one.body, /^A revival of the 1948 drama\.$/m);
  assert.match(one.body, /Tickets and details: .*\/event\/LEAD$/m, "the link is still the lead record's");
});

test("the venue-rules test catches the shapes production carried", () => {
  for (const t of ["Children under 4 will not be admitted.", "No outside food or beverages.", "No weapons permitted on the premises.", "All bags subject to search."]) assert.ok(isVenueRules(t), t);
  assert.ok(!isVenueRules("An evening of standards with the Nighthawks."));
});

test("local times are read as given, not shifted", () => {
  assert.equal(localWhen("2026-11-06", "20:00:00"), "Nov 6, 8:00 PM");
  assert.equal(localWhen("2026-12-01", "00:30:00"), "Dec 1, 12:30 AM");
  assert.equal(localWhen("2026-12-01", ""), "Dec 1");
  assert.equal(localWhen("", "20:00:00"), "");
});

test("a show is cancelled only when every record of it says so", () => {
  const [one] = mergeRepresentations(reps(discovery({ id: "A" }, { status: { code: "cancelled" } }), bareTwin({ id: "B" })));
  assert.equal(one.cancelled, false);
  const [both] = mergeRepresentations(reps(discovery({ id: "A" }, { status: { code: "cancelled" } }), { ...bareTwin({ id: "B" }), dates: { start: { dateTime: "2026-11-07T01:00:00Z" }, status: { code: "cancelled" } } }));
  assert.equal(both.cancelled, true);
});

test("timed-entry slots still fold on their shared URL, carrying every slot's key as an alias", () => {
  const museum = { id: "KovZ917ARSV", name: "Balloon Museum", timezone: "America/New_York" };
  const slot = (id: string, at: string) => ({ ...discovery({ id, name: "Daydream: Air Becomes Art", url: "https://universe.com/events/daydream-balloon-museum-tickets-y5hv92" }, { start: { dateTime: at } }, museum) });
  const merged = mergeRepresentations(reps(slot("s1", "2026-11-06T21:45:00Z"), slot("s2", "2026-11-06T22:00:00Z")));
  assert.equal(merged.length, 2, "different starts are different instances, not twins");
  const { items, folded } = collapseInstances(merged, NOW);
  assert.equal(folded, 1);
  assert.equal(items[0].uid, "universe.com/events/daydream-balloon-museum-tickets-y5hv92", "the shared URL stays the uid, as before");
  assert.ok(items[0].aliases?.includes("tm:KovZ917ARSV@2026-11-06T21:45:00.000Z"));
});

test("items from adapters that set no key keep exactly the identity they had", () => {
  const plain = { uid: "ical-1", title: "Storytime", body: "x", url: "https://library.example/storytime" };
  const [one] = collapseInstances([plain], NOW).items;
  assert.equal(one.uid, "library.example/storytime");
  assert.equal(one.aliases, undefined);
  assert.deepEqual(identities(one), ["library.example/storytime"]);
});

test("a run writes at most the policy cap, whatever the source row says", () => {
  assert.equal(MAX_PER_RUN_CAP, 100);
  assert.equal(runLimit({ max_per_run: 150 }), 100);
  assert.equal(runLimit({ max_per_run: 40 }), 40);
  assert.equal(runLimit({ max_per_run: -5 }), 0);
});
