// The structural half of today's matcher, driven by each intent's grammar_today encoding.
// Mirrors the SQL predicate in Crier's cron matcher as closely as the notice schema allows.
// Known gaps, all noted in the README: notices carry no created_at, parent_id, publisher id
// or verified flag, so `thread` passes any thread-kind notice, `publisher` and `verified`
// are not enforced, and a missing start time is treated as "posted today".
const TODAY = Date.parse("2026-09-18T12:00:00Z");

export function haversineKm(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Returns null when the notice passes every structural filter, else the name of the filter that dropped it. */
export function structuralReject(intent, notice) {
  const g = intent.grammar_today;
  if (!g) return "no-encoding";
  if (g.kind) { const kinds = String(g.kind).split(",").map((s) => s.trim()); if (!kinds.includes(notice.kind)) return "kind"; }
  if (g.tags) { const want = String(g.tags).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); if (!notice.tags.some((t) => want.includes(t.toLowerCase()))) return "tags"; }
  if (g.thread && notice.kind !== "thread") return "thread";
  if (g.include_syndicated === "false" && notice.publisher === "relay") return "syndicated";
  const start = notice.starts_at ? Date.parse(notice.starts_at) : TODAY;
  const end = notice.ends_at ? Date.parse(notice.ends_at) : start;
  if (g.after && end < Date.parse(g.after)) return "after";
  if (g.before && start > Date.parse(g.before)) return "before";
  if (g.near) {
    const [lat, lng] = String(g.near).split(",").map(Number);
    if (notice.lat === null || notice.lng === null) return "no-coords";
    if (haversineKm(lat, lng, notice.lat, notice.lng) > (Number(g.radius_km) || 25)) return "radius";
  }
  return null;
}
