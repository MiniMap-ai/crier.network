import { env } from "./env";

const KEY = "3c7fd1d380692d5d0022451b2f8d56eb";

/** Tell Bing/Yandex (and anyone else on IndexNow) that a page exists or changed. Fire-and-forget. */
export function indexNow(urls: string[]) {
  if (!env.IS_PROD || urls.length === 0) return;
  fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(env.SITE_URL).host, key: KEY, keyLocation: `${env.SITE_URL}/${KEY}.txt`, urlList: urls.slice(0, 100) }),
  }).catch(() => {});
}
