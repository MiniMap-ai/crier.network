/**
 * The nearest-live-posts statements, in one place so the app and scripts/check-live-index.mjs run
 * the same text: that check is only worth something if it holds the planner to the query that ships.
 *
 * Every one of these starts with `set local enable_sort = off`, and that line is the fix. The
 * planner costs a nearest-neighbour query two ways: walk the HNSW index, or read every live row,
 * compute every distance and sort. Its model of the second has no term for the TOAST reads the
 * embeddings take, so it comes out at a cost of about 26 and wins against any index at any size —
 * on 2026-11-02 it was 15,800 buffer pages per call on production, and the 2.5 s tail of CRI-56
 * once those pages were cold. With sorting ruled out for the one statement, the ordered index scan
 * is the only plan left: 395 pages, in the index that stays cached (migrations/0012).
 *
 * SET LOCAL needs a transaction. Sent as one simple-protocol query, "set local …; select …" runs
 * as one implicit transaction on one backend, which is what makes it hold through the transaction
 * pooler and leak to nothing after. The simple protocol has no parameters, so what goes into these
 * statements is only ever ours — a vector read back from the database or produced by lib/cohere.ts,
 * a post id, a limit — and each is checked here before it is inlined: the vector against pgvector's
 * literal grammar, the id against a safe character set (relatedPosts has already required
 * POST_ID_RE of it), the limit clamped to an integer.
 * Caller-supplied filters never come this way: lib/search.ts runs its semantic arm with parameters
 * inside an explicit transaction instead.
 *
 * No imports, so a script can load this without the app.
 */

/** A pgvector text literal: what `embedding::text` returns and what toVectorLiteral builds. */
const VECTOR_RE = /^\[-?\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:,-?\d+(?:\.\d+)?(?:e[+-]?\d+)?){0,4095}\]$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const NO_SORT = "set local enable_sort = off;";

function vectorLiteral(v: string): string {
  if (!VECTOR_RE.test(v)) throw new Error("live-sql: not a vector literal");
  return `'${v}'::vector`;
}
function idLiteral(id: string): string {
  if (!ID_RE.test(id)) throw new Error("live-sql: not a post id");
  return `'${id}'`;
}
function limitLiteral(n: number): string {
  return String(Math.max(1, Math.min(100, Math.trunc(Number(n) || 1))));
}

export type Statement = { prelude: string; query: string; text: string };
function statement(query: string): Statement {
  return { prelude: NO_SORT, query, text: `${NO_SORT} ${query}` };
}

/**
 * The related posts for a post: nearest live, top-level posts by embedding, excluding the post
 * itself, within the 0.85 cosine bound. `p.live` is what lets the planner use the partial index; the
 * explicit expiry and moderation filters stay so a row the minute sweep has not reached yet is kept
 * out all the same.
 */
export function relatedPostsStatement(columns: string, vector: string, excludeId: string, limit: number): Statement {
  const v = vectorLiteral(vector);
  return statement(
    `select ${columns}
       from posts p join publishers u on u.id = p.publisher_id
      where p.live and p.id <> ${idLiteral(excludeId)} and p.parent_id is null and p.deleted_at is null and p.hidden_at is null and p.expires_at > now()
        and p.embedding is not null and (p.embedding <=> ${v}) <= 0.85
      order by p.embedding <=> ${v}
      limit ${limitLiteral(limit)}`);
}

/** The nearest live post to a new one, for the near-duplicate note in createPost. */
export function nearestLiveStatement(vector: string): Statement {
  const v = vectorLiteral(vector);
  return statement(
    `select p.id, p.title, (p.embedding <=> ${v}) as d
       from posts p
      where p.live and p.deleted_at is null and p.hidden_at is null and p.parent_id is null and p.expires_at > now()
        and p.embedding is not null and p.created_at > now() - interval '30 days'
      order by p.embedding <=> ${v}
      limit 1`);
}

/** The rows of the last statement in a multi-statement simple-protocol result: the SET's empty result comes first. */
export function lastResult<T>(results: unknown): T[] {
  const r = results as unknown[];
  if (!Array.isArray(r)) return [];
  const last = r.length > 0 && Array.isArray(r[r.length - 1]) ? (r[r.length - 1] as T[]) : (r as T[]);
  return last;
}
