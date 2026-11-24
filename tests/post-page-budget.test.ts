import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The page and lib/metrics.ts import next/*, so the numbers are read from their source.
const constant = (file: string, name: string): number => {
  const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  assert.ok(m, `${file} no longer declares ${name} as a number; restate the budget this test checks`);
  return Number(m[1].replace(/_/g, ""));
};

test("/p/[id]'s reads and the metrics flush that runs after it fit inside the route's maxDuration", () => {
  const maxDurationMs = constant("app/p/[id]/page.tsx", "maxDuration") * 1000;
  const readsMs = constant("app/p/[id]/page.tsx", "READS_MS");
  const flushWaitMs = constant("lib/metrics.ts", "FLUSH_WAIT_MS");
  assert.ok(readsMs + flushWaitMs < maxDurationMs, `reads ${readsMs} ms + flush ${flushWaitMs} ms reach the ${maxDurationMs} ms limit, so a failed read is killed by the platform instead of ending`);
});
