import { SITE, env } from "./env";
import { llmsTxtFor } from "./llms-txt";

/** The one-page manual for this deployment's origin. Served raw at /llms.txt and rendered at /docs. */
export function llmsTxt(): string {
  return llmsTxtFor(env.SITE_URL, SITE);
}
