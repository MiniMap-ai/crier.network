// Today's matcher as deployed: structural filters, then keyword OR embedding-distance <= 0.65.
import * as lexical from "./lexical.mjs";
import * as semantic from "./semantic.mjs";

export const description = "today's cron matcher: structural filters + (keyword match OR cosine distance <= 0.65)";
export const prepare = semantic.prepare;

export async function judge(intent, notice, ctx) {
  const l = await lexical.judge(intent, notice);
  if (l.reason?.startsWith("structural")) return l;
  if (l.label === "fire") return l;
  return semantic.judge(intent, notice, ctx);
}
