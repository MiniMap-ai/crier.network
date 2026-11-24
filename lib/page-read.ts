import { fallbackSql, onOwnClient, sql } from "./db";
import type { Budget, Sql } from "./db";
import { hedgedRead } from "./fallback-read";
import { track } from "./metrics";

/** How long the shared client gets to answer before the read is sent on the fallback client too. */
const RETRY_AFTER_MS = 1000;
/** With less budget than this a new connection is unlikely to open and answer, so no retry is started. */
const RETRY_MIN_MS = 500;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The one read a page cannot render without. If the shared client has not answered within a second,
 * or fails sooner, the read is made again on fallbackSql() and the first answer is used
 * (lib/fallback-read.ts). `run` must make every query through the client and budget it is handed.
 * Both attempts share `at`, so the read takes no longer than `at` allows. If both fail, the shared
 * client's error is thrown, for the page to count as its failure.
 *
 * Counts `read:retried` when the second attempt starts and `read:recovered` when its answer is the
 * one used; docs/metrics.md has both.
 */
export function primaryRead<T>(label: string, at: Budget, run: (s: Sql, at: Budget) => Promise<T>): Promise<T> {
  return hedgedRead(
    () => run(sql(), at),
    async () => {
      const pool = fallbackSql();
      const s = pool.get();
      try {
        return await run(s, onOwnClient(at));
      } catch (e) {
        pool.retire(s);
        console.warn("primary read retry failed", label, message(e));
        throw e;
      }
    },
    {
      afterMs: RETRY_AFTER_MS,
      left: () => at(label).ms,
      minMs: RETRY_MIN_MS,
      onRetry: (why, e) => {
        track.counter("read:retried");
        console.warn("primary read retried", label, why, e === undefined ? "" : message(e));
      },
      onRecovered: () => track.counter("read:recovered"),
    },
  );
}
