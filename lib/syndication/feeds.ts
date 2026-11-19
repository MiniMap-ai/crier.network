/** Small, dependency-free parsers for iCalendar and RSS/Atom. Enough for event and notice feeds; not a full implementation. */

/* ---------------- iCalendar ---------------- */

export type VEvent = Record<string, { value: string; params: Record<string, string> }[]>;

export function parseICal(text: string): VEvent[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");   // unfold
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

/** Latin-1 entity names, in code point order from U+00A0. */
const LATIN1 = ("nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml").split(" ");

const NAMED: Record<string, number> = {
  ...Object.fromEntries(LATIN1.map((name, i) => [name, 0xa0 + i])),
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218,
  ldquo: 8220, rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243,
  lsaquo: 8249, rsaquo: 8250, euro: 8364, trade: 8482, larr: 8592, rarr: 8594,
};

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * Decode HTML character references in one pass, so `&amp;lt;` becomes the text `&lt;`, never `<`.
 * Numeric references and the HTML 4 Latin-1 and punctuation names are decoded; any other name is
 * left as written. A no-break space becomes a plain space. A reference to no character (zero, a
 * surrogate, past U+10FFFF) becomes U+FFFD.
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    const cp = dec !== undefined ? Number(dec) : hex !== undefined ? parseInt(hex, 16) : NAMED[name!];
    if (cp === undefined) return whole;
    if (cp === 0xa0) return " ";
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "\uFFFD";
    return String.fromCodePoint(cp);
  });
}

/** Anything shaped like a tag, a comment or a doctype. "<3" and "a < b" are not. */
const TAG = /<[!/?a-zA-Z][^<>]*>/g;

/**
 * Upstream HTML as plain text: tags out, references decoded, then anything the decoding made
 * tag-shaped out as well, so `&lt;script&gt;` yields no markup. The pieces between `<br>` and `</p>`
 * are trimmed and joined with `lineBreak`, empty ones dropped; whitespace inside a piece is kept.
 */
export function htmlToText(s: string, lineBreak = "\n"): string {
  return s.split(/<br\s*\/?>|<\/p>/i)
    .map((piece) => decodeEntities(piece.replace(TAG, " ")).replace(TAG, " ").trim())
    .filter(Boolean)
    .join(lineBreak);
}

/** Runs of spaces and tabs made one, line breaks kept single, then cut at `max` on a word boundary with "…". */
export function clipText(s: string, max: number): string {
  let t = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return t;
}

/**
 * Why a source's `event_url_template` is unusable, as a phrase that follows its name, or undefined
 * when it is usable: an https URL of at most 500 characters with `{uid}` outside the host.
 */
export function eventUrlTemplateProblem(template: unknown): string | undefined {
  if (typeof template !== "string" || template.length > 500) return "must be a string of at most 500 characters";
  if (!template.includes("{uid}")) return "must contain {uid}";
  try {
    const a = new URL(template.replaceAll("{uid}", "a")), b = new URL(template.replaceAll("{uid}", "b"));
    if (a.protocol !== "https:") return "must be an https URL";
    if (a.host !== b.host) return "must not put {uid} in the host";
  } catch { return "must be a URL"; }
  return undefined;
}

/** The template with every `{uid}` replaced by the percent-encoded UID. Pass only a template `eventUrlTemplateProblem` accepts. */
export function eventUrl(template: string, uid: string): string {
  return template.replaceAll("{uid}", encodeURIComponent(uid));
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
