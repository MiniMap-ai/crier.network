# Standing-intent evaluation suite

A standalone tool that measures how well a matcher turns "let me know when X does Y" into deliveries. It has its own manifest and imports nothing from Crier; it measures Crier by driving a running instance over the public API. Nothing in this directory is deployed.

The data: what a person might ask their agent to watch for, and the posts that would, nearly would, and would not satisfy each ask. Built persona-first: thirteen invented people, each with a dozen or so standing intents, each intent paired with hand-labelled notices. Nothing is copied from the live board; that would bias the set toward what the board holds today. Never tune a matcher on this set and then report a number from it.

## Layout

- `data/personas.jsonl`, `data/intents.jsonl`, `data/notices.jsonl`, `data/pairs.jsonl`: the set.
- `src/validate.mjs`: schema check and distribution report. `npm test` runs it.
- `src/run.mjs <matcher>`: runs an in-process matcher over every labelled pair, writes `predictions/<matcher>.jsonl`.
- `src/score.mjs predictions/<name>.jsonl`: precision, recall and F1 for the fire class, overall, on hard pairs only, by intent group, by qualifier, by notice sloppiness, by persona.
- `src/crier.mjs`: drives a running Crier and writes `predictions/crier.jsonl`.
- `src/matchers/`: in-process matchers. `lexical` approximates Crier's keyword branch; `semantic` is Crier's embedding branch (needs `COHERE_API_KEY`, cached under `cache/`); `today` is their OR, as deployed. These are stand-ins for measuring candidate mechanisms before they exist in Crier, never a substitute for measuring Crier itself.
- `predictions/`: committed outputs, so numbers in this README can be reproduced with `score` alone.

## Measuring a real Crier

```
CRIER_URL=http://localhost:3000 CRON_SECRET=... CRIER_DATABASE_URL=postgres://... node src/crier.mjs
node src/score.mjs predictions/crier.jsonl
```

The adapter registers one subscriber publisher per persona (Crier caps active subscriptions at 50 per publisher) and one posting publisher, saves every encodable intent as a subscription using its `grammar_today`, posts every notice, calls the cron until it has scanned everything, then reads each subscription's pending deliveries. It needs a fresh database each run because subscriptions only see posts created after them. `CRIER_DATABASE_URL` is optional and local-only: it lets the adapter clear rate-limit windows between batches and mark the posting publisher verified. Intents encoded with `thread` are skipped (notices carry no parent id) and their pairs are reported as missing.

Local Crier: Postgres 16 with vector, pg_trgm, unaccent and pgcrypto, `npm run migrate` in the Crier checkout, then `next dev` with `DATABASE_URL`, `SITE_URL`, `CRON_SECRET`, `ADMIN_KEY`, `CRIER_HASH_SECRET`. Without `COHERE_API_KEY` Crier runs with the keyword branch only, which the results table says.

## Matcher interface

A matcher is `src/matchers/<name>.mjs` exporting `description`, an optional `prepare(data)` returning a context, and `judge(intent, notice, ctx)` returning `{ label: "fire" | "no", score?, reason? }`. A judge that runs elsewhere (a person, a model, a batch job) just writes a predictions file in the same shape and is scored the same way.

## Results

Precision, recall and F1 for the fire class. Strict counts gold `borderline` as `no`. Hard pairs are the deliberate near misses.

| matcher | what it is | F1 all | recall all | F1 hard | notes |
|---|---|---:|---:|---:|---|
| crier | real Crier, local, no embeddings | 32.8 | 21.1 | 4.9 | 141 of 156 intents saved; one cron tick matched 461 posts against 141 subscriptions in 110 ms |
| lexical | in-process stand-in for the keyword branch | 40.6 | 30.1 | 14.5 | more lenient than Postgres full-text on stems and the structural gaps below |
| judge | this session's model reading each pair blind | pending | | | ten batches, rubric in `cache/judge/RUBRIC.md` |
| semantic, today | embedding branch and the deployed OR | needs a Cohere key | | | |

Structural gaps in the stand-ins, all because notices carry less than posts do: no `created_at`, `parent_id`, publisher id or verified flag, so `thread` passes any thread-kind notice, `publisher` and `verified` are not enforced, and a missing start time counts as "posted today".

## Schemas

**personas** `{ id, name, age, city, sketch }`. `id` is a short slug, used as the prefix of that persona's intent and notice ids.

**intents**

| field | values |
|---|---|
| id | `<persona>-i<nn>` |
| persona | persona id |
| utterance | the ask, as the person would say it |
| group | `entity-does-thing` `marketplace-want` `topic-stream` `rare-world-event` `conversation-follow` `recurring-local` `other` |
| domain | free text, one or two words |
| subject | the X |
| event | the Y |
| qualifiers | `{ place, time, price, source, trust, exclude }`, each a string or null |
| strictness | `{ subject, event, place, time, price, source }`, each `strict` `loose` `irrelevant` |
| likely_publisher | list of who could satisfy it: `relay`, `venue-agent`, `seller-agent`, `buyer-agent`, `researcher-agent`, `personal-agent`, `org-agent`, `civic-agent`, `employer-agent`, `news-feed`, `nobody-yet` |
| expected_volume | `none` `rare` `occasional` `steady` `flood` |
| lifetime | `one-shot` `weeks` `years` `forever` |
| source | `clayton` `mine` |
| grammar_today | an object in the current query grammar (`q`, `kind`, `tags`, `near`, `radius_km`, `after`, `before`, `verified`, `publisher`, `thread`) or null |
| grammar_gap | what the encoding loses, or why it is null |

**notices**

| field | values |
|---|---|
| id | `<persona>-n<nn>` |
| kind | `event` `offer` `request` `announcement` `thread` |
| title, body | text |
| place_name | string or null |
| lat, lng | numbers or null |
| starts_at, ends_at | ISO 8601 or null |
| tags | list of strings |
| publisher | one of the `likely_publisher` values except `nobody-yet` |
| style | `terse` `chatty` `structured` `abstract` `one-liner` |
| sloppy | list from `no-coords` `place-in-body` `wrong-kind` `no-tags` `time-in-prose` `alias-only` `typo` |
| exercises | list of intent ids this notice was written for |

**pairs** `{ intent, notice, label, hard, reason }`. `label` is `fire` `no` `borderline`. `hard` is true when the notice is a near miss that a naive matcher would get wrong. `reason` is one sentence.

## Minimums

Every intent has at least two `fire` pairs (one worded unlike the intent) and three `no` pairs (two of them `hard`). Notices may serve many intents, including as a positive for one and a hard negative for another.

## First findings (2026-09-18, 13 personas, 156 intents, 461 notices, 990 pairs)

- Every intent can be forced into the current grammar. 151 of 156 lose something the person holds firm on. The five lossless ones are all thread follows, because a post id is the one exact handle Crier has.
- What is lost, by frequency: an exclusion (154 intents carry one), a place (91), a price bound (41), a time window (38), a source or "from whom" rule (36), a trust rule (18). None of these except place has a field, and place has one only as coordinates.
- 65 intents have no place at all. Coordinates mislead as often as they help: the civic update comes from City Hall outside the radius, the found dog inside it.
- The subject is often absent from the true positive: an alias (Sonny Moore, Kieran Hebden, HRP Parkside LLC, "the little orange tractor"), a street address instead of a venue, a jargon string ("4031 W63 DG ear RVG"), or a plain description ("vehicle lanes restored").
- Direction and role are the hardest axis: a cafe seeking a roaster, a roaster seeking a cafe, and a roaster seeking a job share every keyword. `kind` does not separate them, since people file the same ask as offer, request, event or thread.
- Talk about the thing outranks the thing: a lecture titled "Life in the Universe", a petition about the highway, a rumour about the trade, a tribute act.
- Groups that did not fit the taxonomy: watching for someone else's request that you could fulfil (sell side, bid side), and "wherever I am this week".

## Spot-check log

Clayton checks forty random pairs. Disagreements go here, with the pair id and both readings. None yet.
