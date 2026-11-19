import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ical } from "../lib/syndication/adapters.ts";
import { decodeEntities } from "../lib/syndication/feeds.ts";
import { SourcePatch } from "../lib/syndication/source-schema.ts";
import { asFetched } from "../lib/syndication/types.ts";
import type { Item, SourceRow } from "../lib/syndication/types.ts";

/**
 * The ical adapter on VEVENTs cut from the live feeds it relays (tests/fixtures/syndication):
 * Trumba (City of Seattle, Seattle Public Library), Communico (Multnomah County Library),
 * Shift2Bikes and Calagator. Contact fields and staff names are cut from the Trumba descriptions;
 * everything else is as served, folding included.
 */

const NOW = new Date("2026-11-18T12:00:00Z");
const fixture = (name: string) => readFileSync(new URL(`./fixtures/syndication/${name}`, import.meta.url), "utf8");

function icalSource(config: Record<string, unknown> = {}): SourceRow {
  return {
    id: "src_ical_test", name: "Test calendar", adapter: "ical",
    config: { url: "https://feeds.example.org/calendar.ics", timezone: "America/Los_Angeles", ...config },
    homepage: "https://example.org", license: "Public iCalendar feed offered for subscription", default_kind: "event", tags: ["portland"],
    enabled: true, run_every_minutes: 360, max_per_run: 100, horizon_days: 30,
    added_by: "test", notes: null, created_at: NOW, last_run_at: null,
    last_status: null, last_error: null, last_counts: null,
  };
}

/** Serve this calendar text to the adapter, then put the real fetch back. */
async function relay(text: string, config: Record<string, unknown> = {}): Promise<Item[]> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(text, { headers: { "Content-Type": "text/calendar" } })) as typeof fetch;
  try {
    return asFetched(await ical(icalSource(config), { now: NOW, horizonEnd: new Date(NOW.getTime() + 30 * 86400e3), signal: AbortSignal.timeout(30_000) })).items;
  } finally {
    globalThis.fetch = real;
  }
}

const byUid = (items: Item[], tail: string) => {
  const item = items.find((i) => i.uid.endsWith(tail));
  assert.ok(item, `no item with uid ending ${tail}`);
  return item;
};

function vcalendar(...events: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((e) => ["BEGIN:VEVENT", e.trim(), "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n");
}

test("a Trumba event with no URL links to its X-TRUMBA-LINK", async () => {
  const visions = byUid(await relay(fixture("trumba-seattlegov.ics")), "/211497880");
  const link = "https://www.seattle.gov/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D211497880";
  assert.equal(visions.url, link);
  assert.match(visions.body, new RegExp(`^Details: ${link.replace(/[?.]/g, "\\$&")}$`, "m"));
});

test("URL wins over X-TRUMBA-LINK when an event has both", async () => {
  const committee = byUid(await relay(fixture("trumba-seattlegov.ics")), "/195091479");
  assert.equal(committee.url, "https://seattle.gov/council/meetings/committees-and-agendas/parks-and-city-light");
});

test("every Seattle Public Library event links to its own Trumba page", async () => {
  const items = await relay(fixture("trumba-spl.ics"));
  assert.deepEqual(items.map((i) => i.url), [
    "https://www.spl.org/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D209046653",
    "https://www.spl.org/event-calendar?trumbaEmbed=view%3Devent%26eventid%3D205883828",
  ]);
});

test("event_url_template builds a Communico event page from the UID", async () => {
  const template = "https://multcolib.libnet.info/event/{uid}";
  const items = await relay(fixture("communico-multcolib.ics"), { event_url_template: template });
  assert.deepEqual(items.map((i) => i.url), ["https://multcolib.libnet.info/event/17182048", "https://multcolib.libnet.info/event/16188124"]);
  assert.deepEqual((await relay(fixture("communico-multcolib.ics"))).map((i) => i.url), [undefined, undefined]);
});

test("the UID is percent-encoded into the template, and URL and X-TRUMBA-LINK still come first", async () => {
  const items = await relay(vcalendar(
    "UID:http://uid.trumba.com/event/42 a&b?c\r\nDTSTART:20261120T180000Z\r\nSUMMARY:Encoded",
    "UID:with-url\r\nDTSTART:20261120T180000Z\r\nSUMMARY:Has URL\r\nURL:https://example.org/own",
    "UID:with-trumba\r\nDTSTART:20261120T180000Z\r\nSUMMARY:Has Trumba link\r\nX-TRUMBA-LINK:https://example.org/trumba",
    "UID:with-script-link\r\nDTSTART:20261120T180000Z\r\nSUMMARY:Unusable Trumba link\r\nX-TRUMBA-LINK:javascript:alert(1)",
  ), { event_url_template: "https://events.example.org/e/{uid}?from=feed" });
  assert.deepEqual(items.map((i) => i.url), [
    "https://events.example.org/e/http%3A%2F%2Fuid.trumba.com%2Fevent%2F42%20a%26b%3Fc?from=feed",
    "https://example.org/own",
    "https://example.org/trumba",
    "https://events.example.org/e/with-script-link?from=feed",
  ]);
});

test("an event_url_template must be https and carry {uid} outside the host", async () => {
  const config = (event_url_template: unknown) => SourcePatch.safeParse({ config: { url: "https://x.example/c.ics", event_url_template } }).success;
  assert.equal(config("https://multcolib.libnet.info/event/{uid}"), true);
  assert.equal(config("http://multcolib.libnet.info/event/{uid}"), false);
  assert.equal(config("https://multcolib.libnet.info/event/"), false);
  assert.equal(config("https://{uid}.example.org/"), false);
  assert.equal(config("javascript:alert('{uid}')"), false);
  assert.equal(config(42), false);
  assert.equal(SourcePatch.safeParse({ config: { url: "https://x.example/c.ics" } }).success, true);
  // Rows inserted directly never meet the schema, so the adapter refuses the template itself.
  await assert.rejects(relay(fixture("communico-multcolib.ics"), { event_url_template: "http://multcolib.libnet.info/event/{uid}" }), /event_url_template must be an https URL/);
});

test("entities are decoded in title, location and description", async () => {
  const spl = await relay(fixture("trumba-spl.ics"));
  const story = byUid(spl, "/205883828");
  assert.equal(story.title, "Bilingual Toddler Story Time / Hora de cuentos bilingüe para niños pequeños");
  assert.equal(byUid(spl, "/209046653").title, "\"Battle for Paradise: Puerto Rico, restrictions apply*\" Exhibit");
  assert.match(story.body, /dancing, music, and stories\.\n/);

  const city = await relay(fixture("trumba-seattlegov.ics"));
  assert.equal(byUid(city, "/195091479").title, "Parks & City Light Committee");
  assert.equal(byUid(city, "/177478325").location?.name, "In person - City Hall - 600 – 4th Avenue, Room L-280, MS Teams Online - See meeting access instructions below");
  assert.match(byUid(city, "/211497880").body, /our relationships & the ways we move/);

  for (const item of [...spl, ...city]) {
    for (const text of [item.title, item.body, item.location?.name ?? ""]) assert.doesNotMatch(text, /&(#\d+|#x[0-9a-f]+|[a-z]+);/i, text);
  }
});

test("decodeEntities reads named, decimal and hex references once, and leaves unknown names alone", () => {
  assert.equal(decodeEntities("los ni&ntilde;os aprenden c&oacute;mo, biling&#252;e"), "los niños aprenden cómo, bilingüe");
  assert.equal(decodeEntities("&#x1F331; Oak Understory Planting"), "🌱 Oak Understory Planting");
  assert.equal(decodeEntities("Sip &#8216;n&#8217; Shop&nbsp;&#160;now &hellip;"), "Sip ‘n’ Shop  now …");
  assert.equal(decodeEntities("&amp;lt;b&amp;gt; &notanentity; &#0; &#xD800;"), "&lt;b&gt; &notanentity; � �");
});

test("<br> in a location becomes a comma, and no tag is left", async () => {
  const city = await relay(fixture("trumba-seattlegov.ics"));
  assert.equal(byUid(city, "/211497880").location?.name, "ARTS at King Street Station, 303 South Jackson Street, Top Floor, Seattle, WA 98104");
  assert.equal(byUid(city, "/195091479").location?.name, "Council Chambers, 600 4th Ave., Floor 2, Seattle, WA 98104");
  assert.match(byUid(city, "/195091479").body, /^Where: Council Chambers, 600 4th Ave\., Floor 2, Seattle, WA 98104$/m);
});

test("decoding never yields markup: an escaped tag is dropped like a real one, and one pass leaves &amp;lt; as text", async () => {
  const [item] = await relay(vcalendar([
    "UID:hostile-1",
    "DTSTART:20261120T180000Z",
    "SUMMARY:&lt\\;script&gt\\;alert(1)&lt\\;/script&gt\\;Story Time",
    "LOCATION:Branch&lt\\;br&gt\\;&lt\\;img src=x onerror=alert(1)&gt\\;<br>Room 1",
    "DESCRIPTION:<script>alert(2)</script>Read &amp\\;lt\\;b&amp\\;gt\\; aloud. &lt\\;!-- x --&gt\\;Kids &lt\\;3 books\\, and a &lt\\; b.",
    "CATEGORIES:Parks &amp; Recreation",
  ].join("\r\n")));
  for (const text of [item.title, item.body, item.location?.name ?? ""]) assert.doesNotMatch(text, /<[!/?a-z]/i, text);
  assert.match(item.title, /^alert\(1\)\s+Story Time$/);
  assert.equal(item.location?.name, "Branch, Room 1");
  assert.match(item.body, /^alert\(2\) Read &lt;b&gt; aloud\. Kids <3 books, and a < b\.$/m);
  assert.ok(item.tags?.includes("parks-recreation"), String(item.tags));
});

test("Shift2Bikes and Calagator parse exactly as they did before Trumba and Communico support", async () => {
  for (const feed of ["shift2bikes", "calagator"]) {
    const expected = JSON.parse(fixture(`${feed}.expected.json`));
    assert.deepEqual(JSON.parse(JSON.stringify(await relay(fixture(`${feed}.ics`)))), expected, feed);
  }
});
