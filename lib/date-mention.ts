/**
 * Does a post's text name a calendar day? Used on create to nudge a publisher who wrote a date into
 * the text but set no starts_at, ends_at or expires_at, so the post's expiry has nothing to do with
 * that date: it may stay live after it, or expire before it. Never blocks a post or changes its
 * expiry. The text is third-party: it is only matched, never acted on.
 *
 * Deliberately narrow: a missed date costs one note, a false one teaches publishers to ignore notes.
 * No imports, so it can be tested without a database.
 */

// Capitalised or all-caps only, so "may" and "march" as ordinary words do not count.
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)";
const WEEKDAY = "(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?|MON(?:DAY)?|TUE(?:S(?:DAY)?)?|WED(?:NESDAY)?|THU(?:R(?:S(?:DAY)?)?)?|FRI(?:DAY)?|SAT(?:URDAY)?|SUN(?:DAY)?)";
const DAY = "(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?";
// The day number ends there: not "Oct 2026", "May 15,000" or "Mar 3.5".
const DAY_END = "\\b(?!\\d|[.,:]\\d)";

type Rule = { re: RegExp; valid?: (m: RegExpExecArray) => boolean };

const RULES: Rule[] = [
  { re: new RegExp(`\\b${MONTH}\\.?\\s+${DAY}${DAY_END}`, "g") },
  { re: new RegExp(`(?<![\\d.$#])\\b${DAY}\\s+(?:of\\s+)?${MONTH}\\b`, "g") },
  { re: /(?<![\w.-])\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d-])/g },
  {
    re: new RegExp(`\\b${WEEKDAY}\\.?,?\\s+(\\d{1,2})/(\\d{1,2})(?:/(?:\\d{4}|\\d{2}))?(?![\\d/])`, "g"),
    // Month first or day first, one of the two has to be a month.
    valid: (m) => {
      const a = Number(m[1]), b = Number(m[2]);
      return a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
    },
  },
];

/**
 * True when the text names a calendar day in one of the forms covered: an English month name or
 * abbreviation with a day ("Oct 9", "9 October"), an ISO YYYY-MM-DD, or a weekday with a numeric
 * date ("Fri 10/9"), each with or without a year. Other forms, such as a bare "10/9", are missed.
 */
export function mentionsCalendarDate(text: string): boolean {
  return RULES.some(({ re, valid }) => [...text.matchAll(re)].some((m) => !valid || valid(m)));
}
