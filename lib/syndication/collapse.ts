/**
 * One post per upstream thing.
 *
 * Adapters emit one item per *instance*. Localist keys its uid on the instance start, so a class
 * that meets weekly arrives as twenty items; Ticketmaster gives a timed-entry attraction a separate
 * event id for every 15-minute slot, so one balloon museum arrived as ninety. Each of those became
 * its own post, and 28% of the live board was the same 48 upstream events said over and over.
 *
 * Search has always collapsed these on `source_key` (lib/search.ts), so seekers never saw them.
 * This is the write path agreeing with the read path: the instances of one upstream item fold into
 * one item whose next upcoming instance is `starts_at`, whose `metadata.recurrence` carries the
 * rest, and whose body says "Also at: …".
 *
 * The fold key is the same `source_key` the read path uses, which makes the two agree by
 * construction — with one exception it has to make. Some URLs really do carry several different
 * things: a venue's Ticketmaster landing page sells four different Sunday brunches from one link.
 * Folding those would publish one of the four and quietly lose three, so a group whose items do not
 * all share a title is left alone here. The runner's live-row guard is what keeps *that* shape
 * bounded, which is why the two are separate mechanisms.
 *
 * Pure: no database, no `next/server`. tests/syndication-collapse.test.ts is the specification,
 * which is also why the imports below carry their extension: `npm test` runs these files through
 * node's type stripping, and its resolver wants the path as written.
 */
import { normalizeSourceKey } from "../source-key.ts";
import type { Item } from "./types.ts";

/** How many further instances a folded post carries in `metadata.recurrence`. */
export const RECURRENCE_CAP = 20;

/** How many of those the body's "Also at" line names before it says "and N more". */
const ALSO_AT_SHOWN = 8;

/**
 * The identity the write path now uses: what the read path collapses on, which is the item's URL
 * normalized. Items without a URL — a floating iCalendar event, say — keep their own uid, so
 * nothing folds that we cannot prove is the same thing.
 */
export function foldKey(item: Item): string {
  return normalizeSourceKey(item.url) ?? item.uid;
}

const startMs = (i: Item): number => (i.starts_at ? Date.parse(i.starts_at) : NaN);
const endMs = (i: Item): number => {
  const t = i.ends_at ? Date.parse(i.ends_at) : startMs(i);
  return Number.isNaN(t) ? -Infinity : t;
};

/** Earliest first; undated last. */
function byStart(a: Item, b: Item): number {
  const x = startMs(a), y = startMs(b);
  if (Number.isNaN(x) && Number.isNaN(y)) return 0;
  if (Number.isNaN(x)) return 1;
  if (Number.isNaN(y)) return -1;
  return x - y;
}

const sameThing = (i: Item): string => i.title.trim().toLowerCase();

export type Collapsed = {
  /** What to relay: one item per upstream thing, plus anything that could not be folded. */
  items: Item[];
  /** How many items the fold removed — the posts this run did not write. */
  folded: number;
};

/** Fold each group of instances into one item. Order of first appearance is kept. */
export function collapseInstances(items: Item[], now: Date): Collapsed {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = foldKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const out: Item[] = [];
  let folded = 0;
  for (const [key, group] of groups) {
    const cancelled = group.filter((i) => i.cancelled);
    const live = group.filter((i) => !i.cancelled);

    if (live.length === 0) {
      // Every instance is off. Retire the folded post, and any post an older per-instance key made.
      const seen = new Set<string>();
      for (const c of [{ ...cancelled[0], uid: key }, ...cancelled]) {
        if (seen.has(c.uid)) continue;
        seen.add(c.uid);
        out.push(c);
      }
      continue;
    }

    if (new Set(live.map(sameThing)).size > 1) {
      // Several different things behind one URL. Relay them as they came; the runner's live-row
      // guard is what stops this shape from growing without bound.
      out.push(...group);
      continue;
    }

    folded += group.length - 1;
    out.push(fold(key, live, now));
  }
  return { items: out, folded };
}

/** One item standing for all the instances: the next one upcoming, carrying the others. */
function fold(key: string, live: Item[], now: Date): Item {
  const sorted = [...live].sort(byStart);
  const next = sorted.find((i) => startMs(i) >= now.getTime()) ?? sorted[0];
  const item: Item = { ...next, uid: key };
  if (sorted.length === 1) return item;

  const rest = [...new Set(
    sorted.filter((i) => i !== next && startMs(i) >= now.getTime()).map((i) => new Date(i.starts_at!).toISOString()),
  )];
  if (rest.length === 0) return item;

  item.metadata = { ...(next.metadata ?? {}), recurrence: rest.slice(0, RECURRENCE_CAP), recurrence_count: rest.length + 1 };
  item.body = withAlsoAt(next.body, alsoAt(rest, next.timezone));

  // An attraction that runs for a month must not expire a day after its first slot, which is what
  // the next instance's start alone would give it.
  const last = Math.max(...live.map(endMs));
  const until = Number.isFinite(last) ? last + 86400e3 : NaN;
  if (Number.isFinite(until) && (!item.expires_at || Date.parse(item.expires_at) < until)) {
    item.expires_at = new Date(until).toISOString();
  }
  return item;
}

/** "Also at: Sep 14, 22:00 · Sep 14, 22:15, and 74 more (America/New_York)." */
function alsoAt(instants: string[], timezone: string | undefined): string {
  const clock = clockIn(timezone || "UTC");
  const shown = instants.slice(0, ALSO_AT_SHOWN).map(clock.at).join(" · ");
  const more = instants.length - Math.min(instants.length, ALSO_AT_SHOWN);
  return `Also at: ${shown}${more > 0 ? `, and ${more} more` : ""} (${clock.zone}).`;
}

/**
 * Times in the zone the event is actually in, labelled with the zone they are in. The label is what
 * the formatter settled on rather than what upstream asked for: an unresolvable zone falls back to
 * UTC, and saying "America/Chicago" over UTC times would be worse than saying nothing.
 */
function clockIn(want: string): { at: (iso: string) => string; zone: string } {
  for (const zone of [want, "UTC"]) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      return { at: (iso) => fmt.format(new Date(iso)), zone };
    } catch { /* a zone this runtime cannot resolve */ }
  }
  return { at: (iso) => iso, zone: "UTC" };
}

/**
 * Put the line above the provenance line rather than after it: "Source: … relayed by Crier" is what
 * every relayed post ends with, and the attribution the licence asks for should stay last.
 */
function withAlsoAt(body: string, line: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Source: "));
  if (at === -1) return `${body}\n${line}`;
  lines.splice(at, 0, line);
  return lines.join("\n");
}
