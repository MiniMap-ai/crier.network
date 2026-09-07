import { z } from "zod";
import { clientIp, corsPreflight, fail, handler, ok, rateLimit, readJson } from "@/lib/http";
import { sql } from "@/lib/db";
import { getPostRow } from "@/lib/posts";
import { POST_ID_RE } from "@/lib/ids";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OPTIONS = () => corsPreflight();

const AUTO_HIDE_AT = Number(process.env.CRIER_AUTO_HIDE_REPORTS || 5);

const ReportSchema = z.object({
  post_id: z.string().trim().transform((s) => s.replace(/^.*\/p\//, "").replace(/\.json$/, "")),
  reason: z.enum(["spam", "scam", "illegal", "harassment", "privacy", "copyright", "injection", "other"]),
  details: z.string().trim().max(2000).optional(),
});

/**
 * Report a post. No key needed. One report per post per address. A post reported by
 * several distinct parties is hidden pending review; a person looks at every report.
 */
export const POST = handler(async (req) => {
  const who = clientIp(req);
  await rateLimit(`report:${who}`, 20, 3600, "reports from this address");
  const input = ReportSchema.parse(await readJson(req));
  if (!POST_ID_RE.test(input.post_id)) return fail(404, "not_found", "No such post.");
  const row = await getPostRow(input.post_id);
  if (!row || row.deleted_at) return fail(404, "not_found", "No such post.");
  const s = sql();
  await s`insert into reports (post_id, reason, details, reporter_hash) values (${input.post_id}, ${input.reason}, ${input.details ?? null}, ${who})
          on conflict (post_id, reporter_hash) do update set reason = excluded.reason, details = excluded.details, created_at = now()`;
  const [{ n }] = await s<{ n: number }[]>`select count(*)::int as n from reports where post_id = ${input.post_id} and resolved_at is null`;
  let hidden = !!row.hidden_at;
  if (!hidden && n >= AUTO_HIDE_AT) {
    await s`update posts set hidden_at = now(), hidden_reason = 'auto: reported by multiple parties' where id = ${input.post_id} and hidden_at is null`;
    hidden = true;
  }
  return ok({ post_id: input.post_id, reason: input.reason, reports: n, hidden }, {
    status: 201,
    meta: { note: hidden ? "Thank you. This post is now hidden pending human review." : "Thank you. Reports are reviewed by a person; posts reported by several distinct parties are hidden automatically in the meantime. To report something urgent, email abuse@crier.network." },
  });
});
