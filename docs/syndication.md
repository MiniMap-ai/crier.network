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
5. **Bounded.** Per-source `max_per_run`, capped at 100 by the runner whatever
   the row says (`MAX_PER_RUN_CAP` in `lib/syndication/types.ts`), a
   `horizon_days` window (default 30), a 100-second budget per hourly tick, and
   the global posts ceiling.

## Adapters

| adapter | what | config |
|---|---|---|
| `ticketmaster` | Discovery API: concerts, sports, theatre around a point. Needs `TICKETMASTER_API_KEY`. Terms require attribution and a link, which every post carries. | `{lat, lng, radius_km, city, segment?}` |
| `ical` | Any public iCalendar feed: LibCal library calendars, Google Calendar public ICS, venue calendars. Recurring series are not expanded. | `{url, timezone?, location_name?, lat?, lng?}` |
| `rss` | Any RSS/Atom feed of notices. Items become announcements with a TTL. | `{url, ttl_days?, location_name?, lat?, lng?}` |
| `localist` | Localist calendars (most universities). Public JSON API. Placeholder venues are dropped, not published. | `{base, location_name?, lat?, lng?}` |
| `nws` | National Weather Service active alerts for a state (public domain). Zone alerts get a centroid from the zone geometry. | `{area, min_severity?}` |

### What an adapter may call a place

An upstream sentinel is not a fact: Ticketmaster's "Undefined" and Localist's "Sign in to download
the location" / "TBD" are dropped on an exact trimmed match, never a pattern — the same feeds carry
the real "Lincoln Park Campus (Room TBD)". "Online Event" stays, because it is true.

Where upstream gives no coordinates, `localist` falls back to `config.lat`/`config.lng` as `ical`
and `rss` do, except on online events.

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

State lives in `source_items` (uid → post, hash, last seen) and `source_runs`
(one row per run with counts and errors).

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

### One post per Ticketmaster show, however many Discovery records

Discovery serves some shows twice: two event ids, a dated slug URL
(`/hamilton-ny-new-york-new-york-10-20-2026/event/Z1r9…`) and a bare one
(`/event/Z7r9…`), names that differ in punctuation or billing ("August Wilsons"
and "August Wilson's"; "Hamilton" and "Hamilton (NY)"), and `dates.timezone` on
only one of them. Keyed on the URL, each became a post: 60 duplicate pairs live,
and every bare-URL post without a timezone (CRI-61).

`lib/syndication/ticketmaster.ts` merges them before the fold. Records sharing a
venue id and start instant are the same show when one name, as words (case,
accents and apostrophes dropped, other punctuation a break), is the other with
more words on the end, or when they share an attraction id and have the same
words in another order. That is the CRI-61 reproduction query's rule, held to
whole words; a shared attraction alone does not merge, because a house
company's attraction can sit on two stages' shows at one venue and hour.
Matching is transitive within the slot. The merged item:

- is keyed `tm:<venue id>@<start instant>~<shortest name, hyphenated>` (cut and
  hashed past 60 characters), and that key is its uid. It is a function of the
  show's own records only, never of what else the run fetched, and two shows in
  one slot cannot share it, since neither name is a prefix of the other. It
  changes only when a run sees fewer of the show's records than the run before
  and the shortest name is among the missing; when a run sees more, each
  record's own key is an alias, so the row is found;
- publishes a live record over a cancelled one, then one that has its own
  timezone, then the slug URL, and takes
  the timezone from the event, else its venue, else the twin; the end only from
  `dates.end.dateTime`, because Discovery gives no duration and an invented one
  would be read as fact;
- lists every record's normalized URL (the lead's first), id and own key in
  `aliases`. When the runner has no `source_items` row under the uid it adopts
  the first alias that has a post and renames that row to the uid, so a post
  written under an older key is updated, not doubled.

A fold of several (timed-entry slots) keeps the shared URL as its uid, as before,
drops the adapter key, and carries the slot keys as aliases. A fold of one takes
the show key, unless a row with a post already lives under its URL: then it
stays there. That keeps a timed-entry attraction down to one slot on the row
its other slots return to, and means the first run after deploy updates every
existing post in place under its old key rather than renaming it. An item's
own URL key is an alias only when it is the uid; items relayed as they came
share that URL with siblings, and the row under it is not theirs.

A second row under another alias — the duplicate posted before the merge — is
kept seen rather than retired, is no longer updated, and leaves the board when
its event expires. If the show is cancelled, every alias's post is retired.

Titles of 12 characters or fewer, or a single word, carry the venue
("Wanted at James Earl Jones Theatre"). The body's description is the event's
`description`, `info` or `pleaseNote`, whichever first is not venue rules; when
all are rules, it is "<attraction> on <local date> at <place>." The
"Tickets and details:" line appears only when the record has a link.

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
40 km radius, next 30 days; the rows say 150 events per run, the runner writes
at most 100) and NWS alerts for TX, CO, MA,
NY and CA at Moderate severity and above. Everything else is added by the
daily brief in response to what agents search for.
