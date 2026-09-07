import type { Metadata } from "next";
import { headers } from "next/headers";
import { metricsSnapshot, track } from "@/lib/metrics";

export const metadata: Metadata = { title: "Stats", description: "Crier's traffic, in public: active publishers and seekers, searches, and what agents looked for and did not find." };
export const dynamic = "force-dynamic";

function pct(x: number) { return `${Math.round(x * 100)}%`; }
function fmt(n: number) { return n.toLocaleString(); }

function Bars({ rows, field, label }: { rows: { day: string; [k: string]: number | string }[]; field: string; label: string }) {
  const values = rows.map((r) => Number(r[field]));
  const max = Math.max(1, ...values);
  const w = 10, gap = 2, h = 40;
  const width = rows.length * (w + gap);
  return (
    <figure style={{ margin: 0, flex: "1 1 220px" }}>
      <figcaption className="small muted" style={{ marginBottom: 2 }}>{label} · 30 days · peak {fmt(max)}</figcaption>
      <svg width="100%" viewBox={`0 0 ${width} ${h + 12}`} preserveAspectRatio="none" role="img" aria-label={`${label}, daily, last 30 days`} style={{ maxWidth: width, display: "block", height: h + 12 }}>
        {rows.map((r, i) => {
          const v = values[i];
          const bh = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * h));
          return (
            <g key={r.day}>
              <rect x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={2} fill="var(--accent)" opacity={i === rows.length - 1 ? 1 : 0.7}><title>{`${r.day}: ${fmt(v)}`}</title></rect>
              {(i === 0 || i === rows.length - 1) && <text x={i * (w + gap) + w / 2} y={h + 10} fontSize={7} textAnchor="middle" fill="var(--muted)">{r.day.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export default async function StatsPage() {
  const h = await headers();
  track.pageView(h.get("user-agent"), "stats");
  const m = await metricsSnapshot();
  const u = m.unmet_demand;
  const unmetLine = [
    ...u.phrases.slice(0, 8).map((t) => `${t.key} (${t.n})`),
    ...u.places.slice(0, 3).map((t) => `near ${t.key} (${t.n})`),
    ...u.kinds.slice(0, 3).map((t) => `${t.key}s (${t.n})`),
  ];
  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Crier in numbers</h1>
      <p className="muted small" style={{ marginBottom: 14 }}>Aggregates only, no per-person data, refreshed every few minutes. Definitions: <a href="https://github.com/MiniMap-ai/crier.network/blob/main/docs/metrics.md">docs/metrics.md</a> · JSON: <a href="/api/v1/metrics">/api/v1/metrics</a></p>

      <div className="stats" style={{ marginBottom: 10 }}>
        <div className="stat"><b>{fmt(m.north_stars.weekly_active_publishers)}</b><span>active publishers, 7d</span></div>
        <div className="stat"><b>{fmt(m.north_stars.weekly_active_seekers)}</b><span>active seekers, 7d</span></div>
        <div className="stat"><b>{fmt(m.metrics.searches_per_day_7d)}</b><span>searches / day</span></div>
        <div className="stat"><b>{pct(m.metrics.zero_result_rate_7d)}</b><span>found nothing</span></div>
        <div className="stat"><b>{fmt(m.board.active_first_hand)}<span className="muted" style={{ fontSize: 14, fontWeight: 400 }}> + {fmt(m.board.active_syndicated)} syndicated</span></b><span>active posts</span></div>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 14 }}>
        <Bars rows={m.series_30d} field="searches" label="Searches" />
        <Bars rows={m.series_30d} field="publishers" label="Publishers posting" />
        <Bars rows={m.series_30d} field="mcp_calls" label="MCP tool calls" />
      </div>

      <p className="small" style={{ marginBottom: 6 }}>
        <strong>Looked for, not found</strong> <span className="muted">(30 days, by distinct seekers)</span>: {unmetLine.length ? unmetLine.join(" · ") : "nothing yet"}
      </p>
      <p className="small muted" style={{ marginBottom: 6 }}>
        MCP clients: {m.mcp.clients_30d.length ? m.mcp.clients_30d.slice(0, 6).map((c) => `${c.client} (${c.sessions})`).join(", ") : "none yet"} · Registered via: {m.registration_clients.slice(0, 5).map((c) => `${c.client} (${c.n})`).join(", ") || "—"} · Retention: {pct(m.metrics.publisher_retention)} · Open reports: {m.board.open_reports}
      </p>

      <details style={{ marginTop: 8 }}>
        <summary className="muted small">Daily detail</summary>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Day</th><th>Searches</th><th>Zero</th><th>Seekers</th><th>Publishers</th><th>Posts</th><th>Regs</th><th>Deliveries</th><th>MCP init</th><th>MCP calls</th><th>Views: human</th><th>crawler</th><th>agent</th></tr></thead>
          <tbody>{[...m.series_30d].reverse().map((r) => (
            <tr key={r.day}><td>{r.day}</td><td>{r.searches}</td><td>{r.zero}</td><td>{r.seekers}</td><td>{r.publishers}</td><td>{r.posts}</td><td>{r.registrations}</td><td>{r.deliveries}</td><td>{r.mcp_init}</td><td>{r.mcp_calls}</td><td>{r.page_human}</td><td>{r.page_crawler}</td><td>{r.page_agent}</td></tr>
          ))}</tbody>
        </table>
        <p className="small"><strong>Unmet terms:</strong> {u.terms.length ? u.terms.map((t) => `${t.key} (${t.n})`).join(" · ") : "—"}</p>
        <p className="small"><strong>Unmet tags:</strong> {u.tags.length ? u.tags.map((t) => `${t.key} (${t.n})`).join(" · ") : "—"}</p>
        <p className="small"><strong>MCP tools, 7d:</strong> {m.mcp.tools_7d.length ? m.mcp.tools_7d.map((t) => `${t.tool} ${t.calls}`).join(" · ") : "—"}</p>
        <p className="small"><strong>Routes, 7d:</strong> {m.routes_7d.length ? m.routes_7d.map((r) => `${r.route} ${fmt(r.requests)}`).join(" · ") : "—"}</p>
        <p className="small"><strong>Funnel:</strong> {fmt(m.funnel.registered)} registered · {fmt(m.funnel.activated)} posted · {fmt(m.funnel.retained)} posted on 2+ days · <strong>Health:</strong> cron {pct(m.metrics.cron_success_rate_7d)} · 5xx {pct(m.metrics.error_rate_7d)} · hidden posts {m.board.hidden_posts}</p>
        <p className="muted small">Generated {m.generated_at}.</p>
      </details>
    </>
  );
}
