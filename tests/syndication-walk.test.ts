import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchFailure, MIN_PAGE_MS, describeFailure, nextStep, redactUrl, walkNote, walkPages } from "../lib/syndication/walk.ts";
import { MIN_FETCH_MS, RUN_BUDGET_MS, WRITE_MARGIN_MS, WRITE_RESERVE_MS, runWindow } from "../lib/syndication/budget.ts";

const URL_OF = (page: number) => `https://events.luc.edu/api/2/events?days=30&pp=100&page=${page}`;

/** A clock the test moves by hand, and a feed of `pages` full pages that costs `msPerPage` each on it. */
function feed(pages: number, opts: { pageSize?: number; msPerPage?: number; fail?: Record<number, unknown> } = {}) {
  const pageSize = opts.pageSize ?? 100;
  let t = 0;
  const asked: number[] = [];
  return {
    now: () => t,
    asked,
    fetchPage: async (page: number) => {
      asked.push(page);
      t += opts.msPerPage ?? 1000;
      if (opts.fail?.[page]) throw opts.fail[page];
      const rows = page <= pages ? Array.from({ length: pageSize }, (_, i) => (page - 1) * pageSize + i) : [];
      return { rows, totalPages: pages };
    },
  };
}

const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

test("a short page is the end of the feed", () => {
  assert.equal(nextStep({ page: 1, lastCount: 40, pageSize: 100, held: 40, limit: 500, msLeft: 60_000 }), "end");
});

test("the page the feed says is its last is the end, even when full", () => {
  assert.equal(nextStep({ page: 3, lastCount: 100, pageSize: 100, totalPages: 3, held: 300, limit: 500, msLeft: 60_000 }), "end");
});

test("holding the limit stops the walk before the feed runs out", () => {
  assert.equal(nextStep({ page: 5, lastCount: 100, pageSize: 100, totalPages: 7, held: 500, limit: 500, msLeft: 60_000 }), "cap");
});

test("no further page is started with less than a page's time left", () => {
  assert.equal(nextStep({ page: 2, lastCount: 100, pageSize: 100, totalPages: 7, held: 200, limit: 500, msLeft: MIN_PAGE_MS - 1 }), "budget");
  assert.equal(nextStep({ page: 2, lastCount: 100, pageSize: 100, totalPages: 7, held: 200, limit: 500, msLeft: MIN_PAGE_MS }), "fetch");
});

test("a walk stops requesting pages once it holds the limit", async () => {
  const f = feed(7);
  const w = await walkPages({ pageSize: 100, limit: 250, until: Infinity, urlOf: URL_OF, fetchPage: f.fetchPage, now: f.now });
  assert.deepEqual(f.asked, [1, 2, 3], "page 4 is never requested");
  assert.equal(w.rows.length, 250, "rows past the limit on the last page are dropped");
  assert.equal(w.stop, "cap");
  assert.equal(walkNote(w), undefined, "stopping at the cap is a normal run");
});

test("a walk reads to the end of a feed smaller than the limit", async () => {
  const f = feed(2);
  const w = await walkPages({ pageSize: 100, limit: 500, until: Infinity, urlOf: URL_OF, fetchPage: f.fetchPage, now: f.now });
  assert.deepEqual(f.asked, [1, 2]);
  assert.equal(w.stop, "end");
  assert.equal(w.rows.length, 200);
});

test("a page aborted by the budget keeps the pages before it", async () => {
  const f = feed(7, { msPerPage: 9000, fail: { 3: abortError() } });
  const w = await walkPages({ pageSize: 100, limit: 500, until: 45_000, urlOf: URL_OF, fetchPage: f.fetchPage, now: f.now });
  assert.equal(w.stop, "budget");
  assert.equal(w.rows.length, 200, "pages 1 and 2 are kept, not discarded");
  assert.equal(w.pages, 2);
  assert.ok(w.failure?.aborted);
  assert.equal(w.failure?.url, URL_OF(3));
  assert.equal(w.failure?.ms, 9000);
});

test("a walk that runs out of time between pages stops without starting another", async () => {
  const f = feed(7, { msPerPage: 10_000 });
  const w = await walkPages({ pageSize: 100, limit: 500, until: 21_000, urlOf: URL_OF, fetchPage: f.fetchPage, now: f.now });
  assert.deepEqual(f.asked, [1, 2]);
  assert.equal(w.stop, "budget");
  assert.equal(w.rows.length, 200);
  assert.equal(walkNote(w), "partial after 20000 ms: kept 200 rows from 2 of 7 pages; out of time before page 3");
});

test("a server error after the first page keeps what was read", async () => {
  const f = feed(7, { fail: { 2: new FetchFailure({ url: URL_OF(2), status: 503, ms: 812 }) } });
  const w = await walkPages({ pageSize: 100, limit: 500, until: Infinity, urlOf: URL_OF, fetchPage: f.fetchPage, now: f.now });
  assert.equal(w.stop, "failed");
  assert.equal(w.rows.length, 100);
  assert.equal(walkNote(w), `partial after 2000 ms: kept 100 rows from 1 of 7 pages; ${URL_OF(2)} -> HTTP 503 after 812 ms`);
});

test("a failure on the first page is thrown, with the URL and elapsed time", async () => {
  const f = feed(7, { msPerPage: 45_000, fail: { 1: abortError() } });
  await assert.rejects(
    walkPages({ pageSize: 100, limit: 500, until: 45_000, urlOf: URL_OF, fetchPage: f.fetchPage, now: f.now }),
    (e: unknown) => e instanceof FetchFailure && e.message === `${URL_OF(1)} aborted after 45000 ms (no response)`,
  );
});

test("an abort after the headers arrived names the status", () => {
  assert.equal(describeFailure({ url: URL_OF(4), ms: 12_345.6, status: 200, aborted: true }), `${URL_OF(4)} aborted after 12346 ms (HTTP 200, body unread)`);
});

test("a network error carries its own message", () => {
  const f = FetchFailure.from(new TypeError("fetch failed"), { url: URL_OF(1), ms: 31 });
  assert.equal(f.aborted, false);
  assert.equal(f.message, `${URL_OF(1)} failed after 31 ms: fetch failed`);
});

test("a stored URL never carries a key", () => {
  const raw = "https://app.ticketmaster.com/discovery/v2/events.json?apikey=SECRET123&latlong=1,2&size=200";
  assert.equal(redactUrl(raw), "https://app.ticketmaster.com/discovery/v2/events.json?apikey=…&latlong=1,2&size=200");
  assert.ok(!new FetchFailure({ url: raw, status: 401, ms: 5 }).message.includes("SECRET123"));
});

test("a failure keeps no key anywhere on the object, its url field included", () => {
  const raw = "https://app.ticketmaster.com/discovery/v2/events.json?latlong=1,2&apikey=SECRET123";
  const f = FetchFailure.from(new TypeError(`Failed to parse URL from ${raw}`), { url: raw, ms: 5 });
  assert.equal(f.url, "https://app.ticketmaster.com/discovery/v2/events.json?latlong=1,2&apikey=…");
  assert.ok(!JSON.stringify({ ...f, message: f.message }).includes("SECRET123"), "the cause quoted the URL; the message must not");
});

test("every credential shape a feed URL carries is redacted", () => {
  assert.equal(redactUrl("https://x.localist.com/api/2/events?access_token=T0K&page=2"), "https://x.localist.com/api/2/events?access_token=…&page=2");
  assert.equal(redactUrl("https://a.example/feed?api-key=K#top"), "https://a.example/feed?api-key=…#top");
  assert.equal(redactUrl("https://user:pa55@cal.example/x.ics"), "https://…@cal.example/x.ics");
  assert.equal(redactUrl(URL_OF(3)), URL_OF(3), "a URL with no credential is unchanged");
});

test("a run alone in its tick gets the whole run budget, minus the write reserve for fetching", () => {
  const w = runWindow(1_000, 1_000 + 100_000);
  assert.equal(w.end, 1_000 + RUN_BUDGET_MS);
  assert.equal(w.fetchUntil, 1_000 + RUN_BUDGET_MS - WRITE_RESERVE_MS);
  assert.equal(w.writeUntil, 1_000 + RUN_BUDGET_MS - WRITE_MARGIN_MS);
});

test("a run late in its tick ends with the tick", () => {
  const w = runWindow(0, 30_000);
  assert.equal(w.end, 30_000);
  assert.equal(w.fetchUntil, 30_000 - WRITE_RESERVE_MS);
});

test("a run with less than the reserve left still gets the minimum fetch", () => {
  assert.equal(runWindow(0, 12_000).fetchUntil, MIN_FETCH_MS);
});
