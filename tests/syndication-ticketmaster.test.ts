import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseInstances } from "../lib/syndication/collapse.ts";
import { composeTitle, isVenueRules, localWhen, ticketmasterItem } from "../lib/syndication/ticketmaster.ts";
import { MAX_PER_RUN_CAP, runLimit } from "../lib/syndication/types.ts";

/**
 * Fixtures are shaped like Discovery v2 events. The twins are a pair production served for
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

const items = (...events: Raw[]) => events.map((e) => ticketmasterItem(e, SOURCE)).filter((i) => i !== null);
const uidsAfterFold = (...events: Raw[]) => collapseInstances(items(...events), NOW).items.map((i) => i.uid);

test("ticketmasterItem maps each record alone, under its own id and URL; merging twins is ticketmasterItems' job", () => {
  const twins = items(discovery({ id: "G5vzZ1AvZoOP" }), bareTwin({ id: "Z7r9jZ1AAvFCa" }));
  assert.deepEqual(twins.map((i) => i.uid), ["G5vzZ1AvZoOP", "Z7r9jZ1AAvFCa"]);
  assert.deepEqual(uidsAfterFold(discovery({ id: "G5vzZ1AvZoOP" }), bareTwin({ id: "Z7r9jZ1AAvFCa" })), [
    "ticketmaster.com/august-wilsons-seven-guitars-new-york-new-york-11-06-2026/event/g5vzz1avzoop",
    "ticketmaster.com/event/z7r9jz1aavfca",
  ]);
});

test("records sharing one URL under different titles are relayed unfolded, each under its own id", () => {
  const url = "https://www.ticketmaster.com/venue/123";
  const uids = uidsAfterFold(
    discovery({ id: "BR1", name: "Jazz Brunch with the Nighthawks", url }),
    discovery({ id: "BR2", name: "Gospel Brunch with the Harlem Choir", url }),
  );
  assert.deepEqual(uids, ["BR1", "BR2"]);
});

test("timezone comes from the event, then from the venue", () => {
  assert.equal(ticketmasterItem(discovery({ id: "E1" }), SOURCE)?.timezone, "America/New_York");
  assert.equal(ticketmasterItem(bareTwin({ id: "E2" }, { ...SAMUEL_FRIEDMAN, timezone: "America/Denver" }), SOURCE)?.timezone, "America/Denver", "the venue's zone when the event has none");
  assert.equal(ticketmasterItem(bareTwin({ id: "E3" }, { ...SAMUEL_FRIEDMAN, timezone: undefined }), SOURCE)?.timezone, undefined, "nothing to fall back on, nothing invented");
});

test("ends_at is set only when Discovery gives an end instant", () => {
  assert.equal(ticketmasterItem(discovery({ id: "E1" }), SOURCE)?.ends_at, undefined);
  const ended = discovery({ id: "E2" }, { end: { localDate: "2026-11-06", dateTime: "2026-11-07T03:30:00Z" } });
  assert.equal(ticketmasterItem(ended, SOURCE)?.ends_at, "2026-11-07T03:30:00Z");
  const vague = discovery({ id: "E3" }, { end: { dateTime: "2026-11-07T03:30:00Z", noSpecificTime: true } });
  assert.equal(ticketmasterItem(vague, SOURCE)?.ends_at, undefined);
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
  const r = ticketmasterItem(discovery({ id: "uxh6", name: "Wanted", pleaseNote: rules, info: "No outside food or beverages, electric scooters, e-bikes." }, {}, { ...SAMUEL_FRIEDMAN, name: "James Earl Jones Theatre" }, [{ id: "att-w", name: "Wanted" }]), SOURCE)!;
  assert.ok(!r.body.includes("admitted") && !r.body.includes("scooters"), r.body);
  assert.match(r.body, /^Wanted on Nov 6, 8:00 PM at James Earl Jones Theatre, New York, NY\.$/m);
  assert.equal(r.body.split("\n").at(-1), "Source: Ticketmaster (relayed by Crier; details may change, check the link).");
});

test("the event's own info text is the description when it has one", () => {
  const r = ticketmasterItem(discovery({ id: "E1", info: "Ruben Santiago-Hudson directs a revival of August Wilson's 1948 drama." }), SOURCE)!;
  assert.match(r.body, /^At Samuel J\. Friedman Theatre, New York, NY\.$/m);
  assert.match(r.body, /^Ruben Santiago-Hudson directs/m);
});

test("a record with no link gets no link line", () => {
  const r = ticketmasterItem(discovery({ id: "NOURL", url: "" }), SOURCE)!;
  assert.ok(!r.body.includes("Tickets and details"), r.body);
  assert.equal(r.url, undefined);
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
  const { items: out, folded } = collapseInstances(items(slot("s1", "2026-11-06T21:45:00Z"), slot("s2", "2026-11-06T22:00:00Z"), slot("s3", "2026-11-06T22:15:00Z")), NOW);
  assert.equal(folded, 2);
  assert.deepEqual(out.map((i) => i.uid), ["universe.com/events/daydream-balloon-museum-tickets-y5hv92"]);
});

test("a run writes at most the policy cap, whatever the source row says", () => {
  assert.equal(MAX_PER_RUN_CAP, 100);
  assert.equal(runLimit({ max_per_run: 150 }), 100);
  assert.equal(runLimit({ max_per_run: 40 }), 40);
  assert.equal(runLimit({ max_per_run: -5 }), 0);
});
