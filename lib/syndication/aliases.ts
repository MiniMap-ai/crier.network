/**
 * One show, one `source_items` row, however many records upstream serves it as.
 *
 * Two halves. The same-show rule decides which records of one fetch are one show, picks the lead
 * and names the aliases the merged item carries. The row index decides, for an item, which stored
 * rows it matches by uid or alias, which one it keeps and which it retires. A stored uid never
 * changes, so a reschedule, a rename, a lead flip or a run that fetched one twin all land on the
 * same row. docs/syndication.md, "Ticketmaster records, one post each", has the reasoning.
 *
 * Pure: no imports, so tests/syndication-aliases.test.ts can load it.
 */

/** What the same-show rule reads from one upstream record. Empty strings mean "not given". */
export type ShowRecord = {
  id: string;
  /** The record's URL normalized as `source_key` is, or null when it has none. */
  key: string | null;
  venueId: string;
  /** The start as an ISO instant, or as `local:<date>T<time>` when upstream gives no instant. */
  start: string;
  name: string;
  attractions: { id: string; name: string }[];
};

/** A name's words: lower case, apostrophes dropped, anything else that is not a letter or digit a break. */
export function nameWords(name: string): string[] {
  return name.toLowerCase().replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const isPrefix = (short: string[], long: string[]) => short.length <= long.length && short.every((w, i) => long[i] === w);

/**
 * Are two records one show? Same venue id, same start, different URLs, and then a shared attraction
 * id or one name's words beginning the other's. When either name is a single word ("Comedy",
 * "Hamilton") the prefix says too little, so the pair merges only when it shares an attraction whose
 * name is that word: the attraction is the show, not a room or a series. Records sharing a URL are
 * the fold's business (lib/syndication/collapse.ts), never this rule's.
 */
export function sameShow(a: ShowRecord, b: ShowRecord): boolean {
  if (a.id === b.id || !a.venueId || a.venueId !== b.venueId || !a.start || a.start !== b.start) return false;
  if (a.key === b.key) return false;
  const wa = nameWords(a.name), wb = nameWords(b.name);
  if (wa.length === 0 || wb.length === 0) return false;
  const shared = a.attractions.filter((x) => x.id && b.attractions.some((y) => y.id === x.id));
  const prefix = isPrefix(wa, wb) || isPrefix(wb, wa);
  if (wa.length === 1 || wb.length === 1) {
    const word = (wa.length <= wb.length ? wa : wb)[0];
    return prefix && shared.some((x) => nameWords(x.name).join(" ") === word);
  }
  return shared.length > 0 || prefix;
}

/** A Discovery URL whose slug ends in the show's date: `/<slug>-10-20-2026/event/<id>`. */
const DATED_SLUG = /-\d{2}-\d{2}-\d{4}\/event\/[^/]+$/;

const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** The lead of a group: the record with a dated slug URL, else the lowest id. Stable between runs. */
export function pickLead<T extends ShowRecord>(group: T[]): T {
  const sorted = [...group].sort(byId);
  return sorted.find((r) => r.key !== null && DATED_SLUG.test(r.key)) ?? sorted[0];
}

/**
 * Split records into shows. A record joins a group only when it is the same show as every record
 * already in it, so one loose pair cannot chain two different shows together. Groups come back in
 * the order their first record came in; a record nothing matches is a group of one.
 */
export function groupShows<T extends ShowRecord>(records: T[]): T[][] {
  const groups: T[][] = [];
  const bySlot = new Map<string, T[][]>();
  for (const r of records) {
    const slot = `${r.venueId}\u0000${r.start}`;
    const candidates = bySlot.get(slot) ?? [];
    const g = candidates.find((members) => members.every((m) => sameShow(m, r)));
    if (g) { g.push(r); continue; }
    const fresh = [r];
    groups.push(fresh);
    candidates.push(fresh);
    bySlot.set(slot, candidates);
  }
  return groups;
}

/**
 * The aliases of a group's item: the lead's own id, which survives a reschedule that changes the
 * lead's dated URL, then every other record's URL key and id. A group of one carries its id alone.
 */
export function aliasesFor(lead: ShowRecord, group: ShowRecord[]): string[] {
  const out = [lead.id];
  for (const r of group) if (r !== lead) out.push(...(r.key ? [r.key, r.id] : [r.id]));
  return [...new Set(out.filter(Boolean))];
}

/** One `source_items` row as the runner holds it. `firstSeen` is epoch ms. */
export type StoredRow = { uid: string; post_id: string | null; hash: string; aliases: string[]; firstSeen: number };

/** Every identity an item may be stored under: its uid, then its aliases. */
export function itemKeys(item: { uid: string; aliases?: string[] }): string[] {
  return [...new Set([item.uid, ...(item.aliases ?? [])])];
}

/**
 * The rows of one source, findable by uid or by any alias: the in-memory form of
 * `uid = $1 or $1 = any(aliases)`. The runner keeps it current as it writes, so an item later in
 * the run sees the rows an earlier one inserted, merged or retired.
 */
export class RowIndex {
  private byUid = new Map<string, StoredRow>();
  private byAlias = new Map<string, Set<string>>();

  constructor(rows: StoredRow[]) { for (const r of rows) this.put(r); }

  get(uid: string): StoredRow | undefined { return this.byUid.get(uid); }

  /** Rows whose uid or any alias is one of `keys`, each once, in the order the keys found them. */
  match(keys: string[]): StoredRow[] {
    const uids = new Set<string>();
    for (const k of keys) {
      if (this.byUid.has(k)) uids.add(k);
      for (const u of this.byAlias.get(k) ?? []) uids.add(u);
    }
    return [...uids].map((u) => this.byUid.get(u)).filter((r): r is StoredRow => r !== undefined);
  }

  /** Add a row, or replace the one under its uid. */
  put(row: StoredRow): void {
    this.remove(row.uid);
    this.byUid.set(row.uid, row);
    for (const a of row.aliases) {
      const set = this.byAlias.get(a) ?? new Set<string>();
      set.add(row.uid);
      this.byAlias.set(a, set);
    }
  }

  remove(uid: string): void {
    const row = this.byUid.get(uid);
    if (!row) return;
    this.byUid.delete(uid);
    for (const a of row.aliases) this.byAlias.get(a)?.delete(uid);
  }
}

/**
 * Of the rows an item matched, the one that stands for the show and the ones to retire into it:
 * the row stored under the item's uid, else the oldest (ties by uid). Null when nothing matched,
 * which means insert under the item's uid.
 */
export function resolveRows(itemUid: string, matched: StoredRow[]): { keep: StoredRow; retire: StoredRow[] } | null {
  if (matched.length === 0) return null;
  const oldest = [...matched].sort((x, y) => x.firstSeen - y.firstSeen || (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0));
  const keep = matched.find((r) => r.uid === itemUid) ?? oldest[0];
  return { keep, retire: matched.filter((r) => r !== keep) };
}

/**
 * The aliases the kept row ends with: what it had, then the item's identities and every retired
 * row's uid and aliases, distinct, never its own uid. A row only ever gains aliases.
 */
export function mergedAliases(keep: StoredRow, keys: string[], retired: StoredRow[]): string[] {
  const all = [...keep.aliases, ...keys, ...retired.flatMap((r) => [r.uid, ...r.aliases])];
  return [...new Set(all)].filter((a) => a && a !== keep.uid);
}

/**
 * What the runner does with one item: write under `uid`, update `keep` (null means insert), retire
 * `retire` into it, and leave the row holding `aliases`. `aliased` is true when an alias took part,
 * either the item carrying some or the kept row's uid not being the item's.
 */
export type Plan = { uid: string; keep: StoredRow | null; retire: StoredRow[]; aliases: string[]; aliased: boolean };

export function planItem(index: RowIndex, item: { uid: string; aliases?: string[] }): Plan {
  const keys = itemKeys(item);
  const found = resolveRows(item.uid, index.match(keys));
  if (!found) return { uid: item.uid, keep: null, retire: [], aliases: keys.slice(1), aliased: keys.length > 1 };
  const { keep, retire } = found;
  return { uid: keep.uid, keep, retire, aliases: mergedAliases(keep, keys, retire), aliased: keys.length > 1 || keep.uid !== item.uid };
}

/**
 * The rows a cancelled item retires: every row it matched, but only when the item names every
 * identity each of them is stored under. One record of a show arriving cancelled says nothing about
 * a twin this fetch did not reach, so a row known by any identity the item lacks is not retired
 * here; null means leave it to the missing-item sweep. Nothing matched gives an empty list.
 */
export function cancelTargets(plan: Plan, item: { uid: string; aliases?: string[] }): StoredRow[] | null {
  const matched = plan.keep ? [plan.keep, ...plan.retire] : [];
  const keys = new Set(itemKeys(item));
  const covered = matched.every((r) => keys.has(r.uid) && r.aliases.every((a) => keys.has(a)));
  return covered ? matched : null;
}

/** Do two alias lists hold the same identities, order aside? */
export function sameAliases(a: string[], b: string[]): boolean {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}
