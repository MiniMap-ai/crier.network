import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUserAgent, searchCounting } from "../lib/user-agent.ts";

const CRAWLERS = {
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  googlebotSmartphone: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.204 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  googleOther: "Mozilla/5.0 (compatible; GoogleOther)",
  bingbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
  duckduckbot: "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
  baiduspider: "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
  yandexbot: "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  applebot: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
  amazonbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36",
  bytespider: "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
  petalbot: "Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
  ahrefs: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  semrush: "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  mj12: "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)",
  dotbot: "Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)",
  ccbot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  oaiSearch: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  claudebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  anthropicAi: "anthropic-ai",
  perplexitybot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  metaAgent: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  twitterbot: "Twitterbot/1.0",
  linkedin: "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  slackbot: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  discordPreview: "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  telegram: "TelegramBot (like TwitterBot)",
  archive: "Mozilla/5.0 (compatible; archive.org_bot +http://archive.org/details/archive.org_bot)",
  genericCrawler: "SomeCompanyCrawler/3.1",
  genericSpider: "Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)",
};

/** Real User-Agents of Crier publishers and of clients fetching for a person; every one is demand. */
const SEEKERS = {
  productShot: "ProductShotBot/1.0 (+https://productshotai.app/)",
  carVideo: "Mozilla/5.0 (compatible; CarVideoAIBot/1.0; +https://carvideoai.com/)",
  ptb: "Mozilla/5.0 (compatible; PTBBot/1.0)",
  skitter: "Skitter/2 (+https://swarmmemo.com)",
  dot: "dot/1.0",
  hermes: "HermesAgent/1.0 (operator-authorized Stilcam campaign)",
  tantive: "tantive.space-discovery/1.0",
  tideScribe: "agent-internet-watch/1.0 (tide_scribe; crier client)",
  flatboard: "flatboard-places-sweep/32 (+https://tools.nyrds.net/board/)",
  nightwire: "Nightwire-ClickThrough-AI/1.0 (AI agent for HappyDuck; signup eligibility research)",
  curl: "curl/8.7.1",
  pythonRequests: "python-requests/2.34.2",
  node: "node",
  nodeFetch: "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  discordJs: "DiscordBot (https://github.com/discordjs/discord.js, 14.0)",
  claudeUser: "Claude-User (claude-code/2.1.0; +https://support.anthropic.com/)",
  chatgptUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  perplexityUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  mistralUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)",
  metaFetcher: "meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  feedly: "Feedly/1.0 (+http://www.feedly.com/fetcher.html; 3 subscribers; like FeedFetcher-Google)",
  feedfetcherGoogle: "Feedfetcher-Google; (+http://www.google.com/feedfetcher.html; 2 subscribers; feed-id=1234567890)",
  newsblur: "NewsBlur Feed Fetcher - 1 subscriber - https://www.newsblur.com/site/123/crier (Mozilla/5.0)",
  inoreader: "Mozilla/5.0 (compatible; inoreader.com; +http://www.inoreader.com/feed-fetcher; 4 subscribers; )",
  feedspot: "Mozilla/5.0 (compatible; Feedspot/1.0 (+https://www.feedspot.com/fs/fetcher; like FeedFetcher-Google)",
  miniflux: "Mozilla/5.0 (compatible; Miniflux/2.2.0; +https://miniflux.app)",
  superfeedr: "Superfeedr bot/2.0 http://superfeedr.com - Make your feeds realtime: get in touch - feed-id:1234567890",
  browser: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};

test("a keyless search from a named index, SEO, AI or link-preview crawler is counted as a crawler", () => {
  for (const [name, ua] of Object.entries(CRAWLERS)) assert.equal(searchCounting(ua, false), "crawler", name);
});

test("a keyless search from a publisher's agent, a script, an assistant fetching for a person or a feed reader is a seeker", () => {
  for (const [name, ua] of Object.entries(SEEKERS)) assert.equal(searchCounting(ua, false), "seeker", name);
});

test("a crawler's name inside an agent's own name does not make it a crawler", () => {
  assert.equal(searchCounting("PineappleBot/1.0", false), "seeker");
  assert.equal(searchCounting("RoboDotBot/2", false), "seeker");
});

test("a search with no User-Agent, or an empty one, is a seeker", () => {
  assert.equal(searchCounting(null, false), "seeker");
  assert.equal(searchCounting("", false), "seeker");
});

test("a search whose API key resolved is a seeker even from a crawler User-Agent", () => {
  for (const [name, ua] of Object.entries(CRAWLERS)) assert.equal(searchCounting(ua, true), "seeker", name);
  assert.equal(searchCounting(null, true), "seeker");
});

test("page views keep the broad crawler pattern, so a publisher's ...Bot agent is still a crawler page view", () => {
  assert.equal(classifyUserAgent(SEEKERS.productShot), "crawler");
  assert.equal(classifyUserAgent(SEEKERS.feedly), "crawler");
  assert.equal(classifyUserAgent(CRAWLERS.googlebot), "crawler");
  assert.equal(classifyUserAgent(SEEKERS.curl), "agent");
  assert.equal(classifyUserAgent(SEEKERS.browser), "human");
  assert.equal(classifyUserAgent(null), "agent");
});
