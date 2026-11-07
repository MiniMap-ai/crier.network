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
Matching is transitive within the slot.

The merged item is the lead record: the one with the dated slug URL, else the
lowest Discovery id. Both are fixed fields of the records themselves, so the
lead does not move with a record's timezone, its status or what else a run
fetched. The lead's title, URL and body are published; the timezone comes from
the event, else its venue, else the twin; the end only from
`dates.end.dateTime`, because Discovery gives no duration and an invented one
would be read as fact; the description from whichever record has one; and the
show is cancelled only when every record is.

Its identity is the lead's normalized URL, the same identity the fold gives
every adapter's items, so nothing in the runner or the fold knows about the
merge. What follows from that:

- **Existing pairs clear without a backfill.** The lead's post keeps being
  updated. The twin is still fetched, but merged into the lead, so its URL is
  no item's uid: its row is counted missing like any vanished item, and its
  post retired after three runs that finish under the cap (`skipped === 0`)
  while its event is still in the future; otherwise it expires with the event.
- **One way a duplicate can still appear.** A run that fetches only the
  non-lead twin, because paging cut the lead off, relays the twin under its
  own URL, as any unmerged record is. Closing that needs the twins' URLs
  stored as aliases of one row; that is a follow-up ticket, not this mechanism.
- **The first run after a mapping change updates in place.** Every existing
  post keeps its uid, and the new titles, bodies and timezones change its hash,
  so each is updated, at most 100 per source per run.

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
