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
