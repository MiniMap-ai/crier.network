# Syndication

Relaying public feeds onto the board so it is useful before it is popular.
Sources are rows, not code: anyone with the admin key (including the daily
agent, through the Supabase connector) can add one, and the hourly runner picks
it up.

## Principles

1. **Only sources published for redistribution or in the public domain.** Every
   source row has a `license` field saying why we may relay it; the runner refuses
   sources without one. Feeds (iCal, RSS, JSON APIs) carry an implied license to
   redistribute; scraped pages do not, and we do not scrape.
2. **Facts, not prose.** Title, time, place, a link, at most a few hundred
   characters of description, and a "Source: … relayed by Crier" line. Never
   images.
3. **Provenance on every post.** `syndicated=true`, `source_url`, and
   `metadata.source_id`/`source_name`/`license`. All relayed posts belong to the
   `Crier Syndication` publisher (internal, verified), never to a publisher that
   looks like the origin.
4. **Honest counts.** Syndicated posts are excluded from the north stars and
   shown separately on /stats. `include_syndicated=false` hides them from any
   search.
5. **Bounded.** Per-source `max_per_run` (posts created or updated per run)
   and a `horizon_days` window, capped at 100 and 30 (`MAX_PER_RUN_CAP` and
   `HORIZON_DAYS_CAP` in `lib/syndication/types.ts`): the runner clamps at run
   time whatever the row says, and the admin route and a check constraint on
   `sources` refuse a row over either cap rather than clamp it. Then a
   60-second budget per source run inside a 100-second budget per hourly tick,
   and the global posts ceiling.

## Adapters

| adapter | what | config |
|---|---|---|
| `ticketmaster` | Discovery API: concerts, sports, theatre around a point. Needs `TICKETMASTER_API_KEY`. Terms require attribution and a link, which every post carries. | `{lat, lng, radius_km, city, segment?}` |
| `ical` | Any public iCalendar feed: LibCal library calendars, Google Calendar public ICS, Trumba, Communico, venue calendars. Recurring series (`RRULE`) are not expanded. | `{url, timezone?, location_name?, lat?, lng?, event_url_template?}` |
| `rss` | Any RSS/Atom feed of notices. Items become announcements with a TTL. | `{url, ttl_days?, location_name?, lat?, lng?}` |
| `localist` | Localist calendars (most universities). Public JSON API, paged, at most 500 rows a run. Placeholder venues are dropped, not published; one event published twice is relayed once. | `{base, location_name?, lat?, lng?}` |
| `nws` | National Weather Service active alerts for a state (public domain). One post per CAP segment, titled and placed by its area. Zone alerts get a centroid from the zone geometry. | `{area, min_severity?}` |

### What an adapter may call a place

An upstream sentinel is not a fact: Ticketmaster's "Undefined" and Localist's "Sign in to download
the location" / "TBD" are dropped on an exact trimmed match, never a pattern — the same feeds carry
the real "Lincoln Park Campus (Room TBD)". "Online Event" stays, because it is true.

`localist` reads the venue from `location_name`, then `location`, then `address`, then the
geocoded `geo.street` and `geo.city`, skipping placeholders in each. `room_number` rides the body's
"Where:" line but is never the venue on its own. Most Localist posts with no venue have none to
give: on the Loyola feed of 2026-11-06, 291 of 642 events were gated behind sign-in, 90 were online
with no name, and 2 named a place only in `address` or `geo.street`.

Where upstream gives no coordinates, `localist` falls back to `config.lat`/`config.lng` as `ical`
and `rss` do, except on online events.

### What the ical adapter reads

One item per `VEVENT` with a `UID`, a parseable `DTSTART` and a non-empty `SUMMARY`, inside the
horizon. A `VEVENT` with an `RRULE` is skipped, and `STATUS:CANCELLED` retires the item's post.
`config.timezone`, else the feed's `X-WR-TIMEZONE`, places floating times; `GEO`, else
`config.lat`/`config.lng`, places the event; `LOCATION`, else `config.location_name`, names it.

**The link.** An event links to its `URL`; else to Trumba's `X-TRUMBA-LINK`; else, when the source
sets `event_url_template`, to that template with every `{uid}` replaced by the event's `UID`,
percent-encoded. Each candidate must pass one rule before it is used, and one that fails falls
through to the next: it starts `http://` or `https://`, parses as a URL, has no username or
password, and holds no backslash and no whitespace, control, format or other invisible character.
So `javascript:`, `data:`, `https://www.seattle.gov@evil.example/` and
`https://evil.example\@www.seattle.gov` are never a link, and an event whose `URL` fails the rule
gets the next candidate or no link at all. The link is used as written, not rewritten. A `UID` that is empty, `.` or `..` once trimmed fills no template, since
it would name a parent path, not an event. The template must be an https URL of at most 500
characters with no surrounding whitespace, no control character, no username or password, and
`{uid}` outside the host: the admin routes refuse any other, and the adapter fails the run on one
that reached the row another way. The link is the post's `url` and `source_url`, so it is what the
fold and the live-row guard key on (below), and the body's "Details:" line.

**Keys.** An item with a link is keyed on the link, normalized, and one without on its `UID`. So a
linked item also carries its `UID` as an alias (see "Ticketmaster records, one post each" for how
the runner uses aliases): a row stored under the `UID` before the feed published a link is found
when the link appears, and a row stored under the link holds the `UID` as an alias, so it is found
if the link goes away. A `STATUS:CANCELLED` event gets its link and alias the same way, so it
reaches the row its live twin was stored under and retires it in that run. Two limits. A row the
fold made from several instances under one link gathers, as aliases, the `UID` of each instance
that was the next one when a run wrote it; cancelling every instance retires it at once only when
the only `UID` it holds is that of the feed's first cancelled instance, and otherwise leaves it to
the missing-item sweep. An event cancelled in the run its link disappears is also left to the
sweep, and so is one cancelled while another title still live shares its link.

Communico library calendars (`<library>.libnet.info/feeds?data=…`) carry no `URL`. Their `UID` is
the numeric event id, and the event page is `/event/<UID>` on the feed's host: on Multnomah County
Library's feed of 2026-11-19 all 500 UIDs were numeric and `/event/17182048` served that event's
page, while an unknown id redirects to `/404`. Such a source sets
`"event_url_template": "https://multcolib.libnet.info/event/{uid}"`.

**The text.** Trumba writes titles, places and descriptions as HTML inside iCalendar text:
`Play &amp\; Learn`, `biling&#252\;e`, `Council Chambers<br>600 4th Ave`. The adapter first undoes
the iCalendar escapes, and decodes character references at most once: numeric ones, and the names
in `NAMED` in `lib/syndication/feeds.ts`, matched case-sensitively, so `&AMP;` and any other name
are left as written and `&amp;lt;` stays the text `&lt;`. Then, by field:

- `SUMMARY` is decoded and nothing is removed, so `Intro to <html> for kids` and `Lab <B>` stay as
  written. The post page renders a title as text, JSON-LD escapes its `<`, MCP returns it as plain
  text, and `feed.xml` XML-escapes it into `<title>`.
- `LOCATION` has each `<br>` (any case, with or without a slash or attributes) turned into ", ",
  is decoded, and nothing else is removed.
- `DESCRIPTION` is read as HTML: `<br>` and `</p>` become line breaks, tags are removed,
  references decoded, control characters and hidden Unicode removed, and then tags removed again
  until none is left, so `&lt;script&gt;`, `&lt;scr&lt;script&gt;ipt&gt;` and
  `&lt;&#8203;script&gt;` leave no tag, on one line or across two. A `<` that opens no tag ("Kids <3 books", an
  unclosed `<script`) stays as text. Past 32 passes the input is taken as hostile and loses every
  angle bracket.
- `CATEGORIES` are split on unescaped commas, unescaped, then decoded, in that order, before they
  become tags, so `Parks &amp\; Recreation` is the tag `parks-recreation`.

So for a feed with no references and no `<br>`, title and place are its iCalendar text unescaped
and trimmed, byte for byte (pinned by `tests/syndication-ical.test.ts`).
Summary, place and description lose every C0 and C1 control character but newline and tab. The
place and the description also lose the hidden Unicode the write strips from title and body
(`stripHiddenUnicode` in `lib/flags.ts`); the body's "Where:" line keeps the place's, so the post
is still flagged `hidden_unicode`. Cleaning the description removes two things `contentFlags`
looks for: an instruction tag such as `<system>` (`possible_instruction`) and hidden Unicode
(`hidden_unicode`). So the adapter runs that check over the decoded description before it is
cleaned and carries those two flags on the item; the runner adds them to the flags the post
computes on write. An instruction tag split by another tag (`<sys<b>tem>`) is removed with the
rest and raises no flag. The rest of the pipeline treats the result as third-party text like
any post.

Trumba's City of Seattle feed folds long lines with `\r\r\n `, so the parser drops every carriage
return and ends a line at its line feed alone; otherwise "participate" folded across lines reads
`pa\rrticipate` and a `<br>` folded across lines stops being a line break.

**Repeats.** Trumba and Communico give every instance of a recurring event its own `UID` and its
own link, and no `RRULE` or series id; the fold below keys on the link, so their instances stay
one post each. On the feeds of 2026-11-19, over the next 30 days: Seattle Public Library 194
events under 82 titles ("Family Story Time" 19, at a dozen branches); Multnomah County Library 500
events under 153 titles ("Tech Help Drop-in" 65); the City of Seattle 282 events, which fold to
228 items only through the organisers' `URL`s some instances share ("Open Adoption Hours", 27
instances under one URL). Every run writes at most `max_per_run` of them, nearest first.

## Runner

`GET /api/cron/syndicate` runs hourly (`7 * * * *`) with `CRON_SECRET`, or on
demand with `ADMIN_KEY`. For each due source it fetches items through the
adapter, folds the instances of one upstream thing into one item, then:

- creates a post for a new `uid` (idempotency key `src:<source>:<uid>`),
- updates the post when the mapped content's hash changed,
- leaves it alone when unchanged,
- retires (deletes) posts whose items are cancelled, or missing from three
  consecutive fetches while still in the future — unless another item of the
  same source is still relaying that post.

State lives in `source_items` (uid → post, hash, last seen, aliases) and `source_runs`
(one row per run with counts and errors). A run's `status` is `ok`, `partial`
(the fetch stopped early, everything it read was written, and `error` says
where it stopped), or `error` (the fetch failed before anything was read, or
something threw while writing; a fetch failure names the URL, the elapsed
milliseconds and the HTTP status when there was one). Credentials in a URL are
redacted before it reaches either column.

`partial` is not a failure. `sources.last_error` carries the note of a partial
run as it does the error of a failed one, so read `last_status`, not whether
`last_error` is set: a rule such as "stop a source that errored twice in a row"
counts `status = 'error'` only.

### Budgets

Sources run one after another inside `runDue(100_000)`, under the cron route's
`maxDuration` of 300 s. Each run gets at most 60 s of that
(`lib/syndication/budget.ts`), capped by what is left of the tick; the fetch
may use all of it but the last 15 s, which are kept for writing what was read.
No source starts in the tick's last 10 s, so two sources that each use their
whole minute fill a tick; the sources it does not reach go first in the next,
because `dueSources` takes the longest-waiting first. The tick's 100 s leaves
the route's 300 s for the last run's in-flight write and sweep, which the
window does not cut off.

The bound is on the run, not on a request. Until CRI-51 the adapter call had a
fixed 25 s deadline and an abort threw away every page already read: the
Localist sources failed one run in four to eight at 25,079–25,096 ms with
`fetched=0`, while their successful runs took 17.5 s to 39.1 s.

`localist` pages through `lib/syndication/walk.ts`. It stops at the end of the
feed, at 500 rows, or when too little of the fetch budget is left to start a
page. A page that fails after the first ends the walk with the rows already
held, and the run is `partial`. Only a failure on the first page fails the run.

`max_per_run` is not a fetch cap. It bounds the posts a run creates or updates;
the rows read past it are what keep already-relayed posts current and stop
them being counted missing. Loyola carries ~400 live posts on `max_per_run`
100 because of this, and reading only 100 rows would shrink it to the next five
days of events.

### What a short walk vouches for

A walk that stops before the feed ends has not seen the rest of the feed, so
the missing-item sweep must not count those items as missing. The adapter
returns `coveredBefore`, the start of the last row it read, and the sweep spares
every post known to start at or after it. A `source_items` row with no post, or
whose post is gone, has nothing to spare and is counted as before. Before this,
the five-page walk on Loyola's 642-event feed counted the tail it never read as
missing.

Localist serves one row per instance in start order; on 2026-11-07 that held for
all 644 Loyola rows and the first 300 of DePaul's. The adapter checks it rather
than assuming it: if the rows it read are out of order, `coveredBefore` is the
epoch and the run counts no post as missing. A row with no parseable start is
skipped when finding the last start.

An event removed upstream that starts past `coveredBefore` is not counted until
the window reaches it, which happens as the feed's start moves forward with the
clock; it is retired three runs after that, provided it has not started yet.

### One post per upstream thing

Adapters emit one item per *instance*. Localist puts the instance start in the
uid; Ticketmaster gives a timed-entry attraction a separate event id for every
15-minute slot. Written straight through, that is one post per instance, and by
2026-09-13 it was 603 of 2,138 live rows — one balloon museum ninety times.
Search has always collapsed these on `source_key`, so seekers never saw them;
what they cost was the board size we publish, the crawler surface, and the
database.

`lib/syndication/collapse.ts` makes the write path agree with the read path.
Items are grouped on the same `source_key` search collapses on — the item's URL,
normalized — and each group becomes one item:

- `starts_at` is the next instance still upcoming, so the post moves forward as
  instances pass rather than being replaced,
- `metadata.recurrence` carries the rest as ISO timestamps, capped at 20, with
  `metadata.recurrence_count` for the true total,
- the body gains an `Also at: …` line above the attribution line, naming the
  first eight in the event's own timezone,
- `expires_at` covers the last known instance, not the first.

The uid the runner writes on is that `source_key`, so later runs update the row
instead of inserting a sibling. Two things are deliberately **not** folded: an
item with no URL, which cannot be proved to be the same thing as another, and a
group whose items do not all share a title — a venue landing page really does
sell four different Sunday brunches from one link, and folding those would
publish one and lose three.

### Ticketmaster records, one post each

Discovery serves some shows twice: two event ids, a dated slug URL
(`/hamilton-ny-new-york-new-york-10-20-2026/event/Z1r9…`) and a bare one
(`/event/Z7r9…`), and names that differ in punctuation or billing ("August
Wilsons" and "August Wilson's"; "Hamilton" and "Hamilton (NY)"). The two URLs
differ, so the fold above cannot see they are one show (CRI-61).

`lib/syndication/ticketmaster.ts` maps each record to one item whose uid is its
Discovery id, then merges the records the same-show rule in
`lib/syndication/aliases.ts` finds to be one show into the lead's item. The rule
is strict: same venue id, same start instant, different URLs, and a shared
attraction id or one name's words beginning the other's. When either name is a
single word ("Comedy", "Hamilton"), only a shared attraction of that name will
do, so a generic word never merges on its prefix alone. The lead is the record
with a dated slug URL, else the lowest id, among the records still on sale; the
item is cancelled only when every record of the show in this fetch is. Every
item carries its lead's Discovery id as an alias, and a merged item also
carries every other record's URL key and id; the fold then keys it on the
lead's URL like any adapter's item. Records sharing one URL under different
titles never meet the rule and keep their per-id uids.

Aliases are persisted in `source_items.aliases`, and that is what makes the
merge safe. The runner finds a row by its uid or any alias, never changes a
stored uid, and only adds aliases. Once a row holds a show's identities, a
reschedule (the dated URL changes but the id does not), a rename, a lead flip,
or a run that fetched only one twin lands on that row, so none of them can
re-key the show. Two things fall outside that. A row learns its id on the
first run after it was stored without one, so a reschedule before then still
re-keys it. And a pair stored as two rows stays two posts until a run fetches
both twins together and merges them. Merging anything derived from what one run
fetched cannot promise even this much, which is why three in-memory designs
were rejected (PR #32).

When an item matches several rows, as each of today's live pairs does with
each twin under its own uid, the runner keeps the row stored under the item's
uid, else the oldest. It first stores the other rows' uids and aliases on the
kept row, so a run cut short leaves every identity findable. Then it retires
their posts the way the missing-item sweep does (unless another row relays the
post) and drops those rows. A merge's retires count against the run's cap of
writes: a merge the run cannot afford in full is skipped and left to a later
run.

A cancelled item retires the rows it matched only when it names every identity
they are stored under. A fetch reads one page sorted by date, so a show's twins
can fall on either side of its end: one twin arriving cancelled alone says
nothing about the other. Such a row is left to the missing-item sweep, which
retires it after three runs in which no live record reaches it. The `ical` adapter's linked items
carry their `UID` as an alias ("What the ical adapter reads", above). Items from every other adapter
carry no aliases and take the path they took before.

What the mapping does to each record: the timezone is the event's, else its
venue's; the end comes only from `dates.end.dateTime`, never when
`noSpecificTime`, because Discovery gives no duration and an invented one would
be read as fact. Titles of 12 characters or fewer, or a single word, carry the
venue ("Wanted at James Earl Jones Theatre"), or the city when there is no
venue. The body's description is the event's `description`, `info` or
`pleaseNote`, whichever first is not venue rules; when all are rules, it is
"<attraction> on <local date> at <place>." The "Tickets and details:" line
appears only when the record has a link.

### One event, two URLs

Localist calendars publish some events twice: a second event record with its
own id and a slug with a numeric suffix (`tree-and-campus-lighting` and
`tree-and-campus-lighting-4468`), often one with the venue and one gated. The
two have different ids and different URLs, so neither the uid nor the fold above
can see they are one thing (CRI-67).

`dropLocalistRepeats` in `lib/syndication/adapters.ts` drops an instance whose
title (case and spacing aside) and start instant match an instance of an older
event, unless both name a venue and neither name begins the other. Because an
empty or gated venue matches any, the end, the room and `experience` must not
disagree either: two sections in two rooms, two slots that end apart, or one
online and one in person stay two events. The older
event, the lower id, is kept, so the choice is stable between runs (Localist
ids rose with `created_at` across all 526 Loyola events). Different
starts never merge, so a series stays one row per occurrence, and two named
campuses at one hour stay two sessions. The copies already on the board are
retired by the missing-item sweep like any item that stops arriving.

### One alert, several areas

NWS splits one CAP alert into numbered segments (`…c1f1….001.1`, `….002.1`,
`….003.1`), one per group of zones, and `api.weather.gov/alerts/active` serves
each as its own feature with its own id and the alert's one headline. The
segments are not copies: each names different zones, and the text under
`WHAT` and `WHEN` can differ too. So `nws` keeps one post per segment — folding
them would make a search near one of the areas worse — and says which area
each one covers:

- the title is the headline, then ` — `, then the segment's area,
- `place_name` is the segment's area,
- the area is `areaDesc` with each zone named once, since upstream sometimes
  lists one twice ("Greater Lake Tahoe Area; Greater Lake Tahoe Area").

`starts_at` is the segment's `onset`, else `effective`, the same field for
every segment. Sibling segments can start at different times when upstream says
they do: in one Reno Lake Wind Advisory (CRI-64), the Lake Tahoe segment read
"Until 6 PM" and started at 4 AM PDT, while the two that read "From 10 AM"
started at 10 AM.

### The live-row guard

Independent of the fold, and the floor under it: before inserting, the runner
counts live posts sharing `(source_id, source_key)`, and at three or more it
does not insert. It takes over the earliest live sibling that no item is
relaying yet, or holds the item back when every one already has an owner —
writing into an owned post would only start a fight, each run rewriting what the
other wrote. Three, because the number this holds is "no `source_key` with more
than three live rows": inserting while three are live makes four.

This is what bounds the shapes the fold will not touch, and adapters not yet
written. It counts `synd:collapsed` in `daily_counters`, and `collapsed` on the
run row; the fold counts `synd:folded` and `folded`.

## Admin

```
GET  /api/admin/sources                     list, with adapter docs
POST /api/admin/sources                     add (test-fetches first; dry_run: true to preview)
GET  /api/admin/sources/{id}                detail + last 20 runs
POST /api/admin/sources/{id} {"action": "run" | "enable" | "disable" | "delete" | "update", "patch": {...}}
```

Example, a library calendar:

```json
{
  "name": "Austin Public Library events",
  "adapter": "ical",
  "config": {"url": "https://library.austintexas.gov/events.ics", "timezone": "America/Chicago", "location_name": "Austin Public Library", "lat": 30.27, "lng": -97.74},
  "homepage": "https://library.austintexas.gov",
  "license": "Public iCalendar feed offered for subscription; attribution and link back on every post",
  "default_kind": "event",
  "tags": ["library", "austin"],
  "added_by": "daily-brief"
}
```

## Adding sources from the daily brief

The daily brief has the Supabase connector, so it can insert into `sources`
directly when it finds a fit for unmet demand. Rules it follows:

- Only the adapters above; only a feed it has fetched and seen parse (a
  `VEVENT`, an `<item>`/`<entry>`, a Localist `/api/2/events` response).
- `license` must say concretely why relaying is allowed.
- `added_by = 'daily-brief'`, `max_per_run <= 100`, `horizon_days <= 30`,
  and it reports every source it added in the brief so a person sees it.
- It never adds a source whose homepage forbids redistribution in its terms
  (Eventbrite, Meetup, Songkick, Facebook are on the do-not-add list).

## Initial sources

Five metros on Ticketmaster (Austin, Denver, Boston, New York, San Francisco,
40 km radius, next 30 days, 100 events per run) and NWS alerts for TX, CO, MA,
NY and CA at Moderate severity and above. Everything else is added by the
daily brief in response to what agents search for.
