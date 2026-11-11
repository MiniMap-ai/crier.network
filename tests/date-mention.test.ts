import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsCalendarDate } from "../lib/date-mention.ts";

const fires = (s: string) => assert.equal(mentionsCalendarDate(s), true, `expected a date in: ${s}`);
const quiet = (s: string) => assert.equal(mentionsCalendarDate(s), false, `expected no date in: ${s}`);

test("month name then day, with or without a year", () => {
  fires("Jazz Improv Night in Denver — Seeking Bassist & Drummer (Fri, Oct 9)");
  fires("Doors open Sept. 12 at the hall");
  fires("Sale ends October 31st");
  fires("Due OCT 9, 2026");
  fires("Last day: Dec 3, then we close for winter");
  fires("Opening night: May 15");
});

test("day then month name", () => {
  fires("Rehearsal on 9 October");
  fires("Market every week until 30 Nov 2026");
  fires("Fireworks on the 4th of July");
});

test("ISO dates", () => {
  fires("Starts 2026-10-09 at 7pm");
  fires("Window: 2026-10-09T19:00:00-06:00");
});

test("weekday then a numeric date", () => {
  fires("Gig Fri 10/9, load-in at 6");
  fires("Friday, 9/10/2026 in the park");
  fires("SAT 4/20/26");
});

test("does not fire on versions, prices or counts", () => {
  quiet("Now on v32 with 150 venues listed");
  quiet("Tickets $40, or $35 for members");
  quiet("Release 2.1.3 fixes the parser");
  quiet("Fits 3 to 5 people, 2 hours");
  quiet("Rent is $1200/mo, deposit $15,000");
  quiet("Build v2026-10-09 is out");
  quiet("Item #3 May sell out");
});

test("does not fire on a bare weekday or month name", () => {
  quiet("Open every Friday night");
  quiet("Our October lineup is coming soon");
  quiet("Jam sessions run all through March");
});

test("does not fire on month words used as ordinary words or numbers that cannot be a date", () => {
  quiet("You may 2x your reach if you march 10 blocks");
  quiet("Oct 2026 newsletter");
  quiet("May 15,000 people come");
  quiet("Mar 3.5 rating");
  quiet("Sun 40/50 split");
  quiet("Sat 1/2/3/4 combo");
  quiet("Room 2026-13-40 is a part number");
});
