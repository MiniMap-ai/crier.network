/**
 * Paging a feed under a deadline, and saying what happened when the deadline won.
 *
 * Import-free so tests/syndication-walk.test.ts can load it under node's type stripping. The
 * adapter supplies the fetch; this module decides when to stop and composes the message
 * `source_runs.error` records. docs/syndication.md, "Budgets", has the numbers and the reasons.
 */

/** A page request that failed: where, after how long, and with what status if headers came back. */
export class FetchFailure extends Error {
  readonly url: string;
  readonly ms: number;
  readonly status: number | undefined;
  /** True when our own deadline or signal ended it, rather than the server or the network. */
  readonly aborted: boolean;
  constructor(f: { url: string; ms: number; status?: number; aborted?: boolean; cause?: string }) {
    super(describeFailure(f));
    this.name = "FetchFailure";
    this.url = f.url;
    this.ms = f.ms;
    this.status = f.status;
    this.aborted = f.aborted ?? false;
  }

  /** Wrap whatever a fetch threw. A FetchFailure passes through unchanged. */
  static from(e: unknown, at: { url: string; ms: number; status?: number }): FetchFailure {
    if (e instanceof FetchFailure) return e;
    const name = (e as { name?: unknown } | null)?.name;
    const aborted = name === "AbortError" || name === "TimeoutError";
    return new FetchFailure({ ...at, aborted, cause: aborted ? undefined : (e as Error)?.message });
  }
}

/** Query parameters whose values are credentials. */
const SECRET_PARAM = /([?&](?:apikey|api_key|key|token|access_token)=)[^&]*/gi;

/** A URL fit to store: credentials in the query string are replaced with an ellipsis. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_PARAM, "$1…");
}

/**
 * One line naming the URL, the elapsed time and the HTTP status. A non-OK response keeps the
 * `<url> -> HTTP <status>` shape the runner has always recorded.
 */
export function describeFailure(f: { url: string; ms: number; status?: number; aborted?: boolean; cause?: string }): string {
  const url = redactUrl(f.url);
  const ms = Math.round(f.ms);
  if (f.aborted) return `${url} aborted after ${ms} ms (${f.status ? `HTTP ${f.status}, body unread` : "no response"})`;
  if (f.status && !f.cause) return `${url} -> HTTP ${f.status} after ${ms} ms`;
  return `${url} failed after ${ms} ms: ${(f.cause ?? "unknown error").slice(0, 120)}`;
}

/** Why a walk stopped. Only "end" means every page of the feed was read. */
export type Stop = "end" | "cap" | "budget" | "failed";

/** A page shorter than this is not worth starting: it would only be cut off by the signal. */
export const MIN_PAGE_MS = 2000;

/** The decision taken before each further page, given what the last one returned. */
export function nextStep(s: { page: number; lastCount: number; pageSize: number; totalPages?: number; held: number; limit: number; msLeft: number }): "fetch" | Stop {
  if (s.lastCount < s.pageSize) return "end";
  if (s.totalPages !== undefined && s.page >= s.totalPages) return "end";
  if (s.held >= s.limit) return "cap";
  if (s.msLeft < MIN_PAGE_MS) return "budget";
  return "fetch";
}

export type Walk<T> = {
  rows: T[];
  pages: number;
  /** Pages the feed said it has, when it said. */
  totalPages?: number;
  stop: Stop;
  /** Why the walk ended early; set for "budget" and "failed" only. */
  failure?: FetchFailure;
  ms: number;
};

/**
 * Fetch pages 1, 2, ... until the feed runs out, `limit` rows are held, or `until` (epoch ms) is
 * too close to start another page. A page that fails after the first is the end of the walk and
 * the rows already held are returned with it; a failure on the first page is thrown, since there
 * is nothing to keep. Rows past `limit` on the last page are dropped.
 */
export async function walkPages<T>(opts: {
  pageSize: number;
  limit: number;
  until: number;
  fetchPage: (page: number) => Promise<{ rows: T[]; totalPages?: number }>;
  urlOf: (page: number) => string;
  now?: () => number;
}): Promise<Walk<T>> {
  const now = opts.now ?? Date.now;
  const started = now();
  const rows: T[] = [];
  let totalPages: number | undefined;
  for (let page = 1; ; page++) {
    const t0 = now();
    let got: { rows: T[]; totalPages?: number };
    try {
      got = await opts.fetchPage(page);
    } catch (e) {
      const failure = FetchFailure.from(e, { url: opts.urlOf(page), ms: now() - t0 });
      if (page === 1) throw failure;
      return { rows, pages: page - 1, totalPages, stop: failure.aborted ? "budget" : "failed", failure, ms: now() - started };
    }
    rows.push(...got.rows.slice(0, Math.max(0, opts.limit - rows.length)));
    totalPages = got.totalPages ?? totalPages;
    const step = nextStep({ page, lastCount: got.rows.length, pageSize: opts.pageSize, totalPages, held: rows.length, limit: opts.limit, msLeft: opts.until - now() });
    if (step !== "fetch") return { rows, pages: page, totalPages, stop: step, ms: now() - started };
  }
}

/**
 * What `source_runs.error` says about a walk that kept rows but did not finish: how long it ran,
 * what it kept, and the page that ended it. Undefined for a walk that read everything or stopped
 * at its cap, which is a normal run.
 */
export function walkNote(w: Pick<Walk<unknown>, "rows" | "pages" | "totalPages" | "stop" | "failure" | "ms">): string | undefined {
  if (w.stop === "end" || w.stop === "cap") return undefined;
  const of = w.totalPages ? ` of ${w.totalPages}` : "";
  const why = w.failure ? w.failure.message : `out of time before page ${w.pages + 1}`;
  return `partial after ${Math.round(w.ms)} ms: kept ${w.rows.length} rows from ${w.pages}${of} pages; ${why}`.slice(0, 500);
}
