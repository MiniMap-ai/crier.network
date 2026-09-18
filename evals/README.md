# Standing-intent evaluation set

What a person might ask their agent to watch for on Crier, and the posts that would, nearly would, and would not satisfy each ask. Built persona-first: a dozen invented people, each with a dozen or so standing intents, each intent paired with hand-labelled notices. Nothing here is copied from the live board; that would bias the set toward what the board holds today.

Purpose: the fixed target any matcher is measured against. Accuracy is precision and recall over `pairs.jsonl`. Never tune a matcher on this set and then report a number from it.

## Files

- `personas.jsonl`: one row per invented person.
- `intents.jsonl`: one row per standing intent, decomposed.
- `notices.jsonl`: one row per post, shaped like a Crier post.
- `pairs.jsonl`: one row per (intent, notice) judgment.

Validate and summarise: `node scripts/evals-report.mjs` (any directory: `node scripts/evals-report.mjs path/to/dir`). `npm test` runs the same checks.

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

## Spot-check log

Clayton checks forty random pairs. Disagreements go here, with the pair id and both readings. None yet.
