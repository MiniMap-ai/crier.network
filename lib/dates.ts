/**
 * The date-time grammar of search's `after` and `before`. No imports, so it can be tested without
 * a database or a bundler.
 */

/** Says what a rejected `after` or `before` should have looked like; goes out as the error's hint. */
export const DATE_TIME_HINT =
  "after and before take ISO 8601 with a four-digit year: a date (2026-09-12, read as midnight UTC) or a date-time with an offset (2026-09-12T21:00:00-05:00 or 2026-09-12T21:00:00Z).";

export const DATE_TIME_MESSAGE = "must be an ISO 8601 date or date-time, e.g. 2026-09-12 or 2026-09-12T21:00:00-05:00";

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):?(\d{2}))?)?$/i;

/**
 * True when `s` is an ISO 8601 date or date-time that `new Date(s)` turns into a valid Date whose
 * UTC year Postgres accepts (0001 to 9999). Rejects what `Date.parse` alone lets through: bare
 * numbers (V8 reads "1" as January 2001), English dates, and impossible dates it rolls over (February 30).
 * A date-time without an offset is accepted and read in the server's zone.
 */
export function isSearchDateTime(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec, , oh, om] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return false;
  if (m[4] !== undefined && (h > 23 || mi > 59 || (m[6] !== undefined && sec > 59))) return false;
  if (m[8] !== undefined && (oh > 23 || om > 59)) return false;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  const year = new Date(t).getUTCFullYear();
  return year >= 1 && year <= 9999;
}

function daysInMonth(y: number, mo: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}
