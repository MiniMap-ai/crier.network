/** Small, dependency-free parsers for iCalendar and RSS/Atom. Enough for event and notice feeds; not a full implementation. */

/* ---------------- iCalendar ---------------- */

export type VEvent = Record<string, { value: string; params: Record<string, string> }[]>;

export function parseICal(text: string): VEvent[] {
  // Trumba folds with "\r\r\n ", so every CR goes: a line ends at its LF alone.
  const lines = text.replace(/\r/g, "").replace(/\n[ \t]/g, "").split("\n");   // unfold
  const events: VEvent[] = [];
  let cur: VEvent | null = null;
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") { cur = {}; continue; }
    if (raw === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = raw.indexOf(":");
    if (idx < 0) continue;
    const left = raw.slice(0, idx), value = raw.slice(idx + 1);
    const [name, ...paramParts] = left.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) { const [k, v] = p.split("="); if (k && v) params[k.toUpperCase()] = v.replace(/^"|"$/g, ""); }
    const key = name.toUpperCase();
    (cur[key] ??= []).push({ value, params });
  }
  return events;
}

export function icalText(v: string | undefined): string {
  if (!v) return "";
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** A multi-valued property such as `CATEGORIES`: split on the commas iCalendar did not escape, then each value unescaped. */
export function icalList(v: string | undefined): string[] {
  if (!v) return [];
  const values = [""];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && i + 1 < v.length) values[values.length - 1] += v[i] + v[++i];
    else if (v[i] === ",") values.push("");
    else values[values.length - 1] += v[i];
  }
  return values.map(icalText);
}

/** Latin-1 entity names, in code point order from U+00A0. */
const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml").split(" ");

// A Map, not an object literal, so a name such as `constructor` finds nothing rather than a prototype member.
const NAMED = new Map<string, number>(Object.entries({
  ...Object.fromEntries(LATIN1.map((name, i) => [name, 0xa0 + i])),
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
  ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, rarr: 8594,
}));

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * Decode HTML character references in one pass, so `&amp;lt;` becomes the text `&lt;`, never `<`.
 * Numeric references and the names in `NAMED`, matched case-sensitively, are decoded; any other
 * name, `&AMP;` included, is left as written. A no-break space becomes a plain space. A reference
 * to no character (zero, a surrogate, past U+10FFFF) becomes U+FFFD. Control characters are
 * decoded like any other: pass the result through `dropControls`.
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    const cp = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : NAMED.get(name!);
    if (cp === undefined) return whole;
    if (cp === 0xa0) return " ";
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
    return String.fromCodePoint(cp);
  });
}

/** Anything shaped like a tag, a comment or a doctype. "<3" and "a < b" are not. */
const TAG = /<[!/?a-zA-Z][^<>]*>/g;

/** `<br>`, `<BR/>`, `<br />`, `<br clear="all">`. */
const BR = /<br(?:\s[^<>]*)?\/?>/i;

/** Past this many passes the input is hostile, not HTML, and loses every angle bracket instead. */
const MAX_TAG_PASSES = 32;

/** Remove tag-shaped text until none is left, so a tag hidden inside another (`<scr<b>ipt>`) goes too. */
function stripTags(s: string): string {
  for (let pass = 0; pass < MAX_TAG_PASSES; pass++) {
    const next = s.replace(TAG, " ");
    if (next === s) return s;
    s = next;
  }
  return s.replace(/[<>]/g, " ");
}

/**
 * Upstream HTML as plain text, for a description: `<br>` and `</p>` made line breaks, tags out,
 * references decoded once, `scrub` applied, then tags removed again until none is left, so neither
 * `&lt;script&gt;` nor `&lt;scr&lt;b&gt;ipt&gt;` leaves a tag, on one line or across two. `scrub`
 * removes the characters a later step would remove, so none of them can hold a tag apart until
 * then; by default the control characters. A `<` that opens no tag ("<3", "a < b", an unclosed
 * `<script`) is kept as text. Lines are trimmed and empty ones dropped.
 */
export function htmlToText(s: string, scrub: (t: string) => string = dropControls): string {
  const lines = s.replace(new RegExp(`${BR.source}|<\\/p\\s*>`, "gi"), "\n");
  return stripTags(scrub(decodeEntities(stripTags(lines)))).split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

/** A tag that can only be markup: one with attributes (`<a href="…">`), or a closing tag (`</a>`). */
const MARKUP_TAG = /<[a-zA-Z][a-zA-Z0-9]*\s[^<>]*>|<\/[a-zA-Z][a-zA-Z0-9]*\s*>/g;

/**
 * A place name from upstream HTML: the pieces between `<br>`s and line breaks joined with ", ",
 * tags that can only be markup removed, and references decoded once. A bare bracketed word is
 * kept, so "Lab <B>" stays as written. A line break a reference decodes to splits too, and a piece
 * ending in a dash with nothing after it ("Central Library -") loses the dash. Without any of
 * those, the trimmed input comes back unchanged.
 */
export function placeText(s: string): string {
  return s.split(BR)
    .flatMap((piece) => decodeEntities(piece.replace(MARKUP_TAG, " ")).split(/[\n\u2028\u2029]/))
    .map((piece) => piece.trim())
    .map((piece) => (/\s[-–—]$/.test(piece) ? piece.slice(0, -1).trimEnd() : piece))
    .filter(Boolean)
    .join(", ");
}

/**
 * Template text of Communico's staff-only field, which is what its iCalendar `DESCRIPTION` serves:
 * a description with either phrase in it is staff notes (docs/syndication.md, "What a description
 * keeps").
 */
const STAFF_ONLY = /this\s+field\s+is\s+for\s+internal\s+use\s+only|\bupdate\s+long\s+description\b/i;

/** A labelled field at the start of a line or a `<br>` piece: "Contact Email: …", "Building/Room #: …". */
const FIELD = /^\s*([A-Za-z][A-Za-z0-9 /&'()#.-]{0,59}):(?=\s|$)/;

/** A label of at most three words: longer, the "label" is a sentence ending in a colon. */
const shortLabel = (label: string) => label.trim().split(/\s+/).length <= 3;

/**
 * Labels whose value is how to reach someone: "Contact", "Contact Us", "Event Contact Email", "Site
 * Contact Details", "Email", "Teléfono". "First Contact" and "Contact Improv" are not.
 */
const CONTACT_LABEL = String.raw`(?:(?:site|event|program|staff|media|press|presenter)\s+)?contacts?(?:\s+(?:us|name|person|e-?mail|phone|information|info|details))?|e-?mail|phone|telephone|tel|fax|contacto|correo(?:\s+electr[oó]nico)?|tel[eé]fono`;
const CONTACT_FIELD = new RegExp(String.raw`^\s*(?:${CONTACT_LABEL})\s*$`, "iu");
/** A line opening with a contact label and ":" or " - ": "Contact - Pat Example". */
const CONTACT_LINE = new RegExp(String.raw`^\s*(?:${CONTACT_LABEL})[ \t]*(?::|[ \t]-[ \t])`, "iu");

/** Whether a field's label says its value is how to reach someone. */
const contactLabel = (label: string) => CONTACT_FIELD.test(label);

const EMAIL = String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`;
/** "name at example dot org", "name [at] example [dot] org", "name (at) example.org": a dot part is required, so "at 5 pm" is no address. */
const SPOKEN_EMAIL = String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+[ \t]{1,3}at[ \t]{1,3}[A-Za-z0-9-]+(?:[ \t]{1,3}dot[ \t]{1,3}[A-Za-z0-9-]+)+`;
const BRACKET_EMAIL = String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+[ \t]{0,3}[[({]at[\])}][ \t]{0,3}[A-Za-z0-9-]+(?:(?:\.|[ \t]{0,3}[[({]dot[\])}][ \t]{0,3}|[ \t]{1,3}dot[ \t]{1,3})[A-Za-z0-9-]+)+`;
/** Between digit groups: a dot, a hyphen or any dash, with up to two spaces either side, or one or two spaces. */
const SEP = String.raw`(?:[ \t]{0,2}[.\-‐-—][ \t]{0,2}|[ \t]{1,2})`;
const NOT_BEFORE = String.raw`(?<![\w/=?&.%+@\-‐-—])`;
const NOT_AFTER = String.raw`(?![\w/@]|[.\-‐-—]\d)`;
/** A North American number with its groups set apart, or an international one: "+" and 8 to 15 digits. */
const PHONE = String.raw`${NOT_BEFORE}(?:(?:\+?1${SEP}?)?(?:\([2-9]\d\d\)${SEP}?|[2-9]\d\d${SEP})[2-9]\d\d${SEP}\d{4}|\+\d(?:[ \t.\-‐-—()]{0,2}\d){7,14})${NOT_AFTER}`;
/** Read as a number only on a line with a phone cue: ten digits run together, or seven. */
const CUED_PHONE = String.raw`${NOT_BEFORE}(?:(?:\+?1)?[2-9]\d\d[2-9]\d{6}|[2-9]\d\d${SEP}\d{4})${NOT_AFTER}`;
const PHONE_CUE = /\b(?:call|phone|tel|text|fax|line|dial)/i;
const REACH = new RegExp(`${EMAIL}|${SPOKEN_EMAIL}|${BRACKET_EMAIL}|${PHONE}`, "i");
const REACH_CUED = new RegExp(`${EMAIL}|${SPOKEN_EMAIL}|${BRACKET_EMAIL}|${PHONE}|${CUED_PHONE}`, "i");
/** The verb "contact" before a name of two capitalised words or more: "contact Pat Example", "contact Executive Assistant …". One word, as in "contact LEAP", is an organisation. */
const NAMED_CONTACT = /\bcontact[ \t]+\p{Lu}[\p{L}.'’-]*[ \t]+\p{Lu}/u;
const SENTENCE_BREAK = /(?<=[.!?])[ \t]+/;
/** What is left of a trimmed line that only named a way to reach someone: a bare label, or punctuation. */
const EMPTIED = /^(?:[A-Za-z][A-Za-z0-9 /&'()#.-]{0,59}:)?[\s\p{P}]*$/u;

/** A test for a way to reach someone in a piece of `line`, reading cued number shapes when the line has a cue. */
function reachTest(line: string): (piece: string) => boolean {
  const re = PHONE_CUE.test(line) ? REACH_CUED : REACH;
  return (piece) => re.test(piece) || NAMED_CONTACT.test(piece);
}

/** Without leading or trailing spaces, commas or semicolons. */
function trimSeparators(s: string): string {
  let start = 0, end = s.length;
  while (start < end && /[\s,;]/.test(s[start])) start++;
  while (end > start && /[\s,;]/.test(s[end - 1])) end--;
  return s.slice(start, end);
}

/** The comma- or semicolon-separated segments of `s` that name no way to reach someone. */
function keptSegments(s: string, reaches: (piece: string) => boolean): string {
  return trimSeparators(s.split(/(?<=[,;])/).filter((seg) => !reaches(seg)).join(""));
}

/**
 * Plain text with no way to reach a person in it. A line opening with a contact label ("Contact",
 * "Contact Phone", "Event Contact Email", "Contact Us", "Contacto") goes whole. A sentence holding
 * an email address (spelled out or bracketed too), a phone number, or the verb "contact" before a
 * name of two capitalised words or more goes whole, and a line with no sentence end goes whole; but in a labelled line
 * with no sentence end only the comma-separated segment goes, so "Committee Chair: <name>, <address>"
 * keeps the name. A line left holding only its label or punctuation goes too. Seven digits, or ten
 * run together, are a number only on a line that says call, phone, tel, text, fax, line or dial.
 * Web links and social handles stay. Lines are kept, so `htmlToText` can trim and drop empty ones.
 */
export function withoutContacts(text: string): string {
  return text.split("\n").map((line) => {
    if (CONTACT_LINE.test(line)) return "";
    const reaches = reachTest(line);
    if (!reaches(line)) return line;
    const found = FIELD.exec(line)?.[0];
    const label = found !== undefined && !reaches(found) ? found : "";
    const value = line.slice(label.length);
    const sentences = value.split(SENTENCE_BREAK);
    const kept = sentences.length > 1 || /[.!?]$/.test(value.trimEnd()) ? sentences.filter((s) => !reaches(s)).join(" ")
      : label ? keptSegments(value, reaches) : "";
    const out = label + (label && kept ? " " : "") + kept.trim();
    return EMPTIED.test(out.trim()) ? "" : out;
  }).join("\n");
}

/** A place with every comma-separated segment that names a way to reach someone removed ("Listen Line: 206-…"). */
export function placeWithoutContacts(place: string): string {
  const reaches = reachTest(place);
  return reaches(place) ? keptSegments(place, reaches) : place;
}

/**
 * Trumba's custom fields reordered behind the prose. A Trumba description is `<br>`-separated
 * "Label: value" fields, each value running on until the next label, then a blank piece
 * (`<br><br>`) and the event's own text. What comes back: the value of any field whose label names a
 * description ("Detailed Description"), then the text after the first blank, then the other fields
 * as written, so a clip keeps the description. After the blank a label is read only to drop a
 * contact field, since the event's own text can open a line with "Learn more:", and a rich field
 * value can itself hold a blank. Contact fields are dropped with every piece of their value.
 * Anything that does not open with a field, or has no `<br>`, comes back unchanged.
 */
export function proseFirst(html: string): string {
  const pieces = html.split(BR);
  const first = pieces.find((p) => p.trim());
  if (pieces.length < 2 || first === undefined || !FIELD.test(first)) return html;
  type Field = { label: string; pieces: string[] };
  const prose: string[] = [], fields: Field[] = [];
  let open: Field | undefined, inProse = false;
  for (const piece of pieces) {
    if (!piece.trim()) { open = undefined; inProse = fields.length > 0; continue; }
    const label = FIELD.exec(piece)?.[1];
    if (label !== undefined && (!inProse || contactLabel(label))) fields.push(open = { label, pieces: [piece] });
    else if (open && !(inProse && label !== undefined)) open.pieces.push(piece);
    else { open = undefined; prose.push(piece); }
  }
  const described = (f: Field) => shortLabel(f.label) && /\bdescription\b/i.test(f.label);
  const kept = fields.filter((f) => !contactLabel(f.label));
  return [
    ...kept.filter(described).flatMap((f) => [f.pieces[0].replace(FIELD, ""), ...f.pieces.slice(1)]),
    ...prose,
    ...kept.filter((f) => !described(f)).flatMap((f) => f.pieces),
  ].join("<br>");
}

/**
 * An iCalendar `DESCRIPTION` as the text a relayed post may carry: empty for Communico staff notes,
 * Trumba's fields put behind the prose (`proseFirst`), read as HTML (`htmlToText`, with `scrub`),
 * and then every way to reach a person removed (`withoutContacts`) before the last tag pass, so a
 * removal cannot join a tag together. Not clipped.
 */
export function descriptionText(html: string, scrub: (t: string) => string = dropControls): string {
  if (STAFF_ONLY.test(html)) return "";
  return htmlToText(proseFirst(html), (t) => withoutContacts(scrub(t)));
}

/** The brackets, colon, dash, asterisks and spaces that may set a cancel marker off. */
const MARKER_EDGE = String.raw`[\s*\[\](){}:\-–—!.]*`;
const CANCEL_START = new RegExp(String.raw`^${MARKER_EDGE}(?:cancell?ed|postponed)(?![\p{L}\p{N}])`, "iu");
/** No edge before the marker: unanchored, a leading run would be rescanned from every position in it. */
const CANCEL_END = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:cancell?ed|postponed)${MARKER_EDGE}$`, "iu");
const isEdge = (c: string) => /[\s*\[\](){}:\-–—!.]/u.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const CANCEL_WORDS = ["cancelled", "canceled", "postponed"];

/**
 * Whether a title says the event is off: it begins or ends with "cancelled", "canceled" or
 * "postponed", in any case, bracketed or set off by a colon, dash or asterisks or not
 * ("CANCELLED - Council Briefing", "Story Time [Postponed]"). A title with the word inside it ("How
 * to cope with a cancelled flight") does not.
 */
export function cancelledTitle(title: string): boolean {
  return CANCEL_START.test(title) || CANCEL_END.test(title);
}

/**
 * The title without the markers `cancelledTitle` looks for, however many open or close it
 * ("CANCELLED - CANCELLED: Commission Meeting"), and without the spaces, brackets, dashes and other
 * marks that may set a marker off at either end, whether or not a marker is there.
 */
export function withoutCancelMarker(title: string): string {
  // Indices, not repeated replaces: a title of a thousand markers must not be copied a thousand times.
  const markerAt = (at: number) => CANCEL_WORDS.find((w) => title.slice(at, at + w.length).toLowerCase() === w);
  let start = 0, end = title.length;
  for (;;) {
    while (start < end && isEdge(title[start])) start++;
    const w = markerAt(start);
    if (!w || start + w.length > end || isWordChar(title[start + w.length])) break;
    start += w.length;
  }
  for (;;) {
    while (end > start && isEdge(title[end - 1])) end--;
    const w = CANCEL_WORDS.find((m) => end - m.length >= start && markerAt(end - m.length) === m);
    if (!w || isWordChar(title[end - w.length - 1])) break;
    end -= w.length;
  }
  return title.slice(start, end).trim();
}

/** Every C0 and C1 control character except newline and tab removed. */
export function dropControls(s: string): string {
  return s.replace(/[^\P{Cc}\n\t]/gu, "");
}

/** Runs of spaces and tabs made one, line breaks kept single, then cut at `max` on a word boundary with "…". */
export function clipText(s: string, max: number): string {
  let t = s.replace(/[ \t]+/g, " ").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return t;
}

/**
 * Why a source's `event_url_template` is unusable, as a phrase that follows its name, or undefined
 * when it is usable: an https URL of at most 500 characters, with no surrounding whitespace, no
 * control character, no username or password, and `{uid}` outside the host.
 */
export function eventUrlTemplateProblem(template: unknown): string | undefined {
  if (typeof template !== "string" || template.length > 500) return "must be a string of at most 500 characters";
  if (template !== template.trim() || /\p{Cc}/u.test(template)) return "must not carry surrounding whitespace or control characters";
  if (!template.includes("{uid}")) return "must contain {uid}";
  try {
    const a = new URL(template.replaceAll("{uid}", "a")), b = new URL(template.replaceAll("{uid}", "b"));
    if (a.protocol !== "https:") return "must be an https URL";
    if (a.username || a.password || b.username || b.password) return "must not carry a username or password";
    if (a.host !== b.host) return "must not put {uid} in the host";
  } catch { return "must be a URL"; }
  return undefined;
}

/**
 * The template with every `{uid}` replaced by the percent-encoded UID, or undefined for a UID that
 * is empty, `.` or `..` once trimmed, which would name a parent path rather than an event. Pass only
 * a template `eventUrlTemplateProblem` accepts.
 */
export function eventUrl(template: string, uid: string): string | undefined {
  const id = uid.trim();
  if (id === "" || id === "." || id === "..") return undefined;
  return template.replaceAll("{uid}", encodeURIComponent(id));
}

/**
 * The value, trimmed, when it is a link a reader may follow and reads as the place it leads: it
 * starts `http://` or `https://`, parses, and has no username or password, no backslash, and no
 * whitespace, control, format or other invisible character inside. Otherwise undefined.
 */
export function httpLink(v: string | undefined): string | undefined {
  const s = v?.trim();
  if (!s || !/^https?:\/\/[^\\\s\p{C}]+$/iu.test(s)) return undefined;
  let u: URL;
  try { u = new URL(s); } catch { return undefined; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  return u.username || u.password ? undefined : s;
}

/** Offset (minutes) of an IANA zone at a given UTC instant. */
function zoneOffsetMinutes(zone: string, at: Date): number {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch { return 0; }
}

/** Parse an iCal DATE or DATE-TIME into ISO UTC. Returns { iso, allDay }. */
export function icalDate(field: { value: string; params: Record<string, string> } | undefined, defaultZone?: string): { iso: string; allDay: boolean } | null {
  if (!field) return null;
  const v = field.value.trim();
  const zone = field.params.TZID || defaultZone;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, Y, M, D, h, mi, s, z] = m;
  const allDay = !h;
  if (z) return { iso: new Date(Date.UTC(+Y, +M - 1, +D, +h, +mi, +(s || 0))).toISOString(), allDay };
  const local = Date.UTC(+Y, +M - 1, +D, +(h || 0), +(mi || 0), +(s || 0));
  if (!zone) return { iso: new Date(local).toISOString(), allDay };
  // Convert wall-clock in zone to UTC: subtract the zone's offset (iterate once for DST edges).
  let guess = local - zoneOffsetMinutes(zone, new Date(local)) * 60000;
  guess = local - zoneOffsetMinutes(zone, new Date(guess)) * 60000;
  return { iso: new Date(guess).toISOString(), allDay };
}

/* ---------------- RSS / Atom ---------------- */

export type FeedItem = { id: string; title: string; link?: string; summary: string; published?: string; categories: string[] };

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return undefined;
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function attr(block: string, name: string, attrName: string): string | undefined {
  const re = new RegExp(`<${name}\\b([^>]*)\\/?>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const rel = /rel="([^"]*)"/i.exec(m[1])?.[1];
    const href = new RegExp(`${attrName}="([^"]*)"`, "i").exec(m[1])?.[1];
    if (href && (!rel || rel === "alternate")) return href;
  }
  return undefined;
}

export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const title = tag(xml.slice(0, 5000), "title") ?? "";
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const items: FeedItem[] = blocks.map((b) => {
    const t = tag(b, "title") ?? "";
    const link = tag(b, "link") || attr(b, "link", "href");
    const summary = tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content") ?? tag(b, "content:encoded") ?? "";
    const published = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const id = tag(b, "guid") ?? tag(b, "id") ?? link ?? t;
    const categories = [...b.matchAll(/<category\b[^>]*?(?:term="([^"]*)"[^>]*)?>([^<]*)<\/category>|<category\b[^>]*term="([^"]*)"[^>]*\/>/gi)].map((m) => (m[1] || m[2] || m[3] || "").trim()).filter(Boolean);
    return { id: (id || t).trim(), title: t, link: link?.trim(), summary, published, categories };
  });
  return { title, items };
}
