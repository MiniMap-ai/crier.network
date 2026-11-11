/**
 * What kind of client sent a request, from its User-Agent, for splitting counts. A User-Agent is
 * whatever the caller chose to send, so this only ever decides what a request is counted as, never
 * whether it is answered. docs/metrics.md, "Weekly active seekers", says who is on which side.
 *
 * No imports, so it can be tested without a database or a bundler.
 */

const CRAWLER_RE = /bot|crawl|spider|slurp|fetch|scan|archiver|preview|facebookexternalhit|embedly|quora link|pinterest|whatsapp|telegram|discord|skype|slack|twitter|linkedin|google|bing|yandex|baidu|duckduck|applebot|petalbot|semrush|ahrefs|mj12|dotbot|gptbot|claudebot|perplexity|anthropic|openai|ccbot|bytespider|amazonbot|cohere-ai|meta-external/i;
const BROWSER_RE = /Mozilla\/5\.0 .*(Chrome|Safari|Firefox|Edg|OPR)\//;

/** `crawler` is a known bot or link previewer, `human` a browser, `agent` everything else, including no User-Agent at all. */
export function classifyUserAgent(ua: string | null): "human" | "crawler" | "agent" {
  if (!ua) return "agent";
  if (CRAWLER_RE.test(ua)) return "crawler";
  if (BROWSER_RE.test(ua)) return "human";
  return "agent";
}

/**
 * Crawlers that index, train on or preview what they fetch, by the product token each sends. A
 * search from one of these is not demand. Agents name themselves "...Bot" too, so nothing broader
 * than a named crawler is on this list; user-triggered fetchers (Claude-User, ChatGPT-User,
 * Perplexity-User, MistralAI-User, meta-externalfetcher, Feedfetcher-Google) are left off on purpose.
 */
export const SEARCH_CRAWLERS: readonly string[] = [
  // Search engines
  "Googlebot", "Storebot-Google", "Google-InspectionTool", "GoogleOther", "AdsBot-Google", "Mediapartners-Google",
  "APIs-Google", "bingbot", "msnbot", "BingPreview", "AdIdxBot", "DuckDuckBot", "DuckAssistBot", "Baiduspider",
  "YandexBot", "Applebot", "Amazonbot", "PetalBot", "SeznamBot", "MojeekBot",
  // SEO and link indexes
  "AhrefsBot", "AhrefsSiteAudit", "SemrushBot", "SiteAuditBot", "MJ12bot", "DotBot", "BLEXBot", "DataForSeoBot",
  "serpstatbot", "Barkrowler",
  // AI training and AI search indexes
  "GPTBot", "OAI-SearchBot", "ClaudeBot", "Claude-SearchBot", "anthropic-ai", "PerplexityBot", "CCBot", "Bytespider",
  "Google-CloudVertexBot", "meta-externalagent", "FacebookBot", "cohere-ai", "Diffbot", "ImagesiftBot", "Timpibot",
  // Link previewers. "Discordbot/" with its slash is Discord's unfurler; the discord.js library sends "DiscordBot (".
  "facebookexternalhit", "Twitterbot", "LinkedInBot", "Slackbot", "Discordbot/", "TelegramBot", "Pinterestbot",
  "redditbot", "Embedly", "Iframely", "SkypeUriPreview",
  // Archives
  "archive.org_bot", "ia_archiver",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A named token must start a word, so an agent called "PineappleBot" is not Applebot; the two generic words match anywhere. */
const SEARCH_CRAWLER_RE = new RegExp(`(?<![a-z0-9])(?:${SEARCH_CRAWLERS.map(escape).join("|")})|crawler|spider`, "i");

/** User-triggered fetchers SEARCH_CRAWLER_RE would catch: meta-externalfetcher links to a ".../crawler" page. */
const ON_BEHALF_RE = /meta-externalfetcher/i;

/**
 * How a REST search, REST listing or `/feed.xml` read is counted. `keyed` is whether the request's
 * API key resolved to a publisher: a registered publisher is always a seeker, whatever its agent is
 * called. Otherwise a User-Agent naming a SEARCH_CRAWLERS entry, or containing "crawler" or "spider",
 * and not exempted by ON_BEHALF_RE, is a `crawler`: answered in full, but counted only as
 * `search:crawler`. A missing or empty User-Agent is a seeker.
 */
export function searchCounting(ua: string | null, keyed: boolean): "seeker" | "crawler" {
  if (keyed || !ua) return "seeker";
  return SEARCH_CRAWLER_RE.test(ua) && !ON_BEHALF_RE.test(ua) ? "crawler" : "seeker";
}
