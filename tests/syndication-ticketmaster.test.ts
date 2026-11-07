import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseInstances } from "../lib/syndication/collapse.ts";
import { composeTitle, isVenueRules, localWhen, mergeRepresentations, nameWords, representation, sameShow } from "../lib/syndication/ticketmaster.ts";
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
const RICHARD_RODGERS = { id: "KovZpZAJ6nlA", name: "Richard Rodgers Theatre", timezone: "America/New_York", city: { name: "New York" } };

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

/** A record without `dates.timezone`, so a test can put the timezone on whichever record it likes. */
function withoutZone(raw: Raw): Raw {
  const dates = { ...(raw.dates as Raw) };
  delete dates.timezone;
  return { ...raw, dates };
}

const reps = (...events: Raw[]): Representation[] => events.map((e) => representation(e, SOURCE)).filter((r): r is Representation => r !== null);
const uidAfterFold = (items: ReturnType<typeof mergeRepresentations>) => collapseInstances(items, NOW).items.map((i) => i.uid);

const SLUG_URL = "ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/g5vzz1avzoop";
const BARE_URL = "ticketmaster.com/event/z7r9jz1aavfca";

test("two Discovery records of one show become one item", () => {
  const items = mergeRepresentations(reps(bareTwin({ id: "Z7r9jZ1AAvFCa" }), discovery({ id: "G5vzZ1AvZoOP" })));
  assert.equal(items.length, 1);
  const [one] = items;
  assert.equal(one.title, "August Wilson's Seven Guitars", "the slug record leads");
  assert.equal(one.timezone, "America/New_York");
  assert.match(one.url!, /-11-06-2026\/event\/G5vzZ1AvZoOP$/);
  assert.deepEqual(one.metadata?.discovery_ids, ["G5vzZ1AvZoOP", "Z7r9jZ1AAvFCa"]);
});

test("the merged item's uid is the lead's normalized URL, and the fold keeps it", () => {
  const [one] = mergeRepresentations(reps(bareTwin({ id: "Z7r9jZ1AAvFCa" }), discovery({ id: "G5vzZ1AvZoOP" })));
  assert.equal(one.uid, SLUG_URL);
  assert.deepEqual(uidAfterFold([one]), [SLUG_URL]);
  assert.equal("key" in one, false);
  assert.equal("aliases" in one, false);
});

test("the slug record leads even when only the bare twin has a timezone, which comes from the twin", () => {
  const slug = withoutZone(discovery({ id: "G5vzZ1AvZoOP" }, {}, { ...SAMUEL_FRIEDMAN, timezone: undefined }));
  const bare = bareTwin({ id: "Z7r9jZ1AAvFCa" }, { ...SAMUEL_FRIEDMAN, timezone: undefined });
  (bare.dates as Raw).timezone = "America/New_York";
  const [one] = mergeRepresentations(reps(bare, slug));
  assert.equal(one.uid, SLUG_URL);
  assert.equal(one.timezone, "America/New_York");
});

test("without a slug URL the lowest Discovery id leads, wherever the timezone is", () => {
  const low = bareTwin({ id: "A1" }, { ...SAMUEL_FRIEDMAN, timezone: undefined });
  const high = bareTwin({ id: "B2" }, { ...SAMUEL_FRIEDMAN, timezone: undefined });
  (high.dates as Raw).timezone = "America/New_York";
  for (const order of [[low, high], [high, low]]) {
    const [one] = mergeRepresentations(reps(...order));
    assert.equal(one.uid, "ticketmaster.com/event/a1");
    assert.equal(one.timezone, "America/New_York");
  }
});

test("the lead does not depend on record order", () => {
  const a = mergeRepresentations(reps(discovery({ id: "G5vzZ1AvZoOP" }), bareTwin({ id: "Z7r9jZ1AAvFCa" })));
  const b = mergeRepresentations(reps(bareTwin({ id: "Z7r9jZ1AAvFCa" }), discovery({ id: "G5vzZ1AvZoOP" })));
  assert.deepEqual(a, b);
});

test("a run that fetches only one twin relays it under that twin's own URL", () => {
  assert.deepEqual(uidAfterFold(mergeRepresentations(reps(discovery({ id: "G5vzZ1AvZoOP" })))), [SLUG_URL]);
  assert.deepEqual(uidAfterFold(mergeRepresentations(reps(bareTwin({ id: "Z7r9jZ1AAvFCa" })))), [BARE_URL]);
});

test("a cancelled lead keeps the uid while a live twin keeps the show live", () => {
  const [one] = mergeRepresentations(reps(bareTwin({ id: "B" }), discovery({ id: "A" }, { status: { code: "cancelled" } })));
  assert.equal(one.uid, "ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/a");
  assert.equal(one.cancelled, false);
  assert.equal(one.metadata?.status, "onsale");
});

test("a show is cancelled only when every record of it says so", () => {
  const [one] = mergeRepresentations(reps(discovery({ id: "A" }, { status: { code: "cancelled" } }), bareTwin({ id: "B" })));
  assert.equal(one.cancelled, false);
  const [both] = mergeRepresentations(reps(discovery({ id: "A" }, { status: { code: "cancelled" } }), { ...bareTwin({ id: "B" }), dates: { start: { dateTime: "2026-11-07T01:00:00Z" }, status: { code: "cancelled" } } }));
  assert.equal(both.cancelled, true);
});

test("a venue-name variant and extra billing still match on venue, start and name prefix", () => {
  const items = mergeRepresentations(reps(
    discovery({ id: "Z1r9uZrrZbpZ1AvqebK", name: "Hamilton (NY)" }, {}, RICHARD_RODGERS, [{ id: "K8vZ9171o0V", name: "Hamilton" }]),
    bareTwin({ id: "Z7r9jZ1AA73F4", name: "Hamilton" }, { ...RICHARD_RODGERS, name: "Richard Rodgers Theatre-NY" }),
  ));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Hamilton (NY)", "thirteen characters and two words: left as Discovery has it");
});

test("two different shows at one venue and instant stay two, each under its own URL", () => {
  const items = mergeRepresentations(reps(
    discovery({ id: "A1", name: "Late Show With Somebody Else" }, {}, SAMUEL_FRIEDMAN, [{ id: "att-1" }]),
    discovery({ id: "B2", name: "August Wilson's Seven Guitars" }, {}, SAMUEL_FRIEDMAN, [{ id: "att-2" }]),
  ));
  assert.equal(items.length, 2);
  assert.notEqual(items[0].uid, items[1].uid);
});

test("a shared attraction alone does not merge two stages' shows", () => {
  const house = [{ id: "K8-second-city", name: "The Second City" }];
  const items = mergeRepresentations(reps(
    discovery({ id: "M1", name: "Second City Mainstage: Big Show" }, {}, SAMUEL_FRIEDMAN, house),
    discovery({ id: "E1", name: "e.t.c. Stage: Small Show" }, {}, SAMUEL_FRIEDMAN, house),
  ));
  assert.equal(items.length, 2);
  const [reordered] = mergeRepresentations(reps(
    discovery({ id: "R1", name: "Robert Glasper x Questlove" }, {}, SAMUEL_FRIEDMAN, [{ id: "att-rg" }]),
    discovery({ id: "R2", name: "Questlove x Robert Glasper" }, {}, SAMUEL_FRIEDMAN, [{ id: "att-rg" }]),
  ));
  assert.deepEqual(reordered.metadata?.discovery_ids, ["R1", "R2"], "the same billing in another order is one show");
});

test("a name is matched on whole words, so one is not another's prefix by accident", () => {
  assert.ok(sameShow({ name: nameWords("Robert Glasper"), attractions: [] }, { name: nameWords("Robert Glasper X Questlove + Special Guest Bilal"), attractions: [] }));
  assert.ok(!sameShow({ name: nameWords("Ann"), attractions: [] }, { name: nameWords("Annie"), attractions: [] }));
  assert.equal(nameWords("August Wilson’s"), "august wilsons");
  assert.equal(nameWords("Beyoncé"), "beyonce");
  assert.notEqual(nameWords("嵐"), "", "a name with no Latin letters still has words");
});

test("records that each match a different show join them into one, whatever order they came in", () => {
  const a = discovery({ id: "T1", name: "Vince Giordano and the Nighthawks" });
  const b = discovery({ id: "T2", name: "Vince Giordano Tribute" });
  const c = discovery({ id: "T3", name: "Vince Giordano" });
  const forward = mergeRepresentations(reps(a, b, c)), backward = mergeRepresentations(reps(c, b, a));
  assert.equal(forward.length, 1);
  assert.equal(forward[0].uid, backward[0].uid);
  assert.match(forward[0].uid, /\/event\/t1$/);
});

test("a record with no venue id, coordinates or absolute start is relayed alone under its own URL", () => {
  const raw = discovery({ id: "LONE1" }, { start: { localDate: "2026-11-06", localTime: "20:00:00" } }, { name: "Somewhere" });
  const items = mergeRepresentations(reps(raw));
  assert.equal(items.length, 1);
  assert.deepEqual(uidAfterFold(items), ["ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/lone1"]);
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

test("a record with no link gets no link line", () => {
  const r = representation(discovery({ id: "NOURL", url: "" }), SOURCE)!;
  assert.ok(!r.item.body.includes("Tickets and details"), r.item.body);
  assert.equal(r.item.url, undefined);
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

test("timed-entry slots are separate instances that fold on their shared URL", () => {
  const museum = { id: "KovZ917ARSV", name: "Balloon Museum", timezone: "America/New_York" };
  const slot = (id: string, at: string) => discovery({ id, name: "Daydream: Air Becomes Art", url: "https://universe.com/events/daydream-balloon-museum-tickets-y5hv92" }, { start: { dateTime: at } }, museum);
  const merged = mergeRepresentations(reps(slot("s1", "2026-11-06T21:45:00Z"), slot("s2", "2026-11-06T22:00:00Z")));
  assert.equal(merged.length, 2, "different starts are different instances, not twins");
  const { items, folded } = collapseInstances(merged, NOW);
  assert.equal(folded, 1);
  assert.equal(items[0].uid, "universe.com/events/daydream-balloon-museum-tickets-y5hv92");
});

test("a run writes at most the policy cap, whatever the source row says", () => {
  assert.equal(MAX_PER_RUN_CAP, 100);
  assert.equal(runLimit({ max_per_run: 150 }), 100);
  assert.equal(runLimit({ max_per_run: 40 }), 40);
  assert.equal(runLimit({ max_per_run: -5 }), 0);
});
