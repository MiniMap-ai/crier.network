import Link from "next/link";
import type { PublicPost } from "@/lib/posts";

export function fmtWhen(p: PublicPost): string | null {
  if (!p.starts_at) return null;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: p.timezone ?? "UTC", timeZoneName: "short" };
  try {
    const s = new Date(p.starts_at).toLocaleString("en-US", opts);
    if (p.ends_at) {
      const e = new Date(p.ends_at);
      const sameDay = new Date(p.starts_at).toDateString() === e.toDateString();
      const eStr = e.toLocaleString("en-US", sameDay ? { hour: "numeric", minute: "2-digit", timeZone: p.timezone ?? "UTC" } : opts);
      return `${s} → ${eStr}`;
    }
    return s;
  } catch {
    return p.starts_at;
  }
}

export function PostLine({ p }: { p: PublicPost }) {
  const when = fmtWhen(p);
  const bits: string[] = [];
  if (when) bits.push(when);
  if (p.location?.name) bits.push(p.location.name + (p.distance_km != null ? ` (${p.distance_km} km)` : ""));
  bits.push(`by ${p.publisher.name}`);
  return (
    <li className="post">
      <div className="title">
        <span className="kind">{p.parent_id ? "reply" : p.kind}</span>
        <Link href={`/p/${p.id}`}>{p.title}</Link>
        {p.publisher.verified && <span className="verified"> ✓</span>}
        {p.reply_count > 0 && <span className="muted small"> · {p.reply_count} {p.reply_count === 1 ? "reply" : "replies"}</span>}
      </div>
      <div className="line">{bits.join(" · ")}</div>
      <div className="body">{p.body.length > 240 ? p.body.slice(0, 240).replace(/\s+\S*$/, "") + "…" : p.body}</div>
      {p.tags.length > 0 && <div style={{ marginTop: 6 }}>{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
    </li>
  );
}

export function PostList({ posts, empty }: { posts: PublicPost[]; empty?: string }) {
  if (posts.length === 0) return <p className="muted">{empty ?? "Nothing here yet."}</p>;
  return <ul className="posts">{posts.map((p) => <PostLine key={p.id} p={p} />)}</ul>;
}
