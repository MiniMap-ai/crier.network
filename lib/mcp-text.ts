import { repliesPhrase } from "./repliers.ts";
import type { PublicPost } from "./posts";

/**
 * How MCP tool results show a post in the text the model reads. Its one runtime import is the
 * import-free lib/repliers.ts, so `node --test` can load it.
 */

function fmtTime(iso: string, tz: string | null): string {
  if (!tz) return iso;
  try {
    return new Date(iso).toLocaleString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" });
  } catch { return iso; }
}

/**
 * One post: a head line, an excerpt of the body between « », provenance, then the post's
 * `revision` and `body_sha256` as REST serves them. The excerpt is cut to 400 characters, flattened
 * and has its guillemets swapped, so it is never what `body_sha256` covers.
 */
export function fmtPost(p: PublicPost, i?: number): string {
  const when = p.starts_at ? ` | ${fmtTime(p.starts_at, p.timezone)}${p.ends_at ? " → " + fmtTime(p.ends_at, p.timezone) : ""}` : "";
  const where = p.location?.name ? ` | ${p.location.name}` : "";
  const dist = p.distance_km != null ? ` (${p.distance_km} km)` : "";
  const ver = p.publisher.verified ? " ✓verified" : "";
  const replies = repliesPhrase(p.reply_count, p.replier_count);
  const thr = replies ? ` | ${replies}` : "";
  const closed = p.closed_at ? ` | closed by its publisher ${p.closed_at}` : "";
  const head = `${i != null ? i + 1 + ". " : ""}[${p.parent_id ? "reply" : p.kind}] ${p.title}${when}${where}${dist}${thr}${closed}`;
  // A body may not close the « » delimiter early: swap the guillemets it contains for single ones.
  const body = (p.body.length > 400 ? p.body.slice(0, 400) + "…" : p.body).replace(/«/g, "‹").replace(/»/g, "›");
  const flags = p.flags?.length ? ` · flags: ${p.flags.join(", ")}` : "";
  return `${head}\n   «${body.replace(/\n+/g, " ")}»\n   by ${p.publisher.name}${ver} · ${p.url}${p.link ? " · " + p.link : ""}${p.tags.length ? " · tags: " + p.tags.join(", ") : ""}${flags}` +
    `\n   revision ${p.revision} · body_sha256 ${p.body_sha256}`;
}
