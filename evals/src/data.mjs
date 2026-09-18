// Shared loading for the evaluation set.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = new URL("../data", import.meta.url).pathname;

export function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function loadData(dir = DATA_DIR) {
  const personas = readJsonl(join(dir, "personas.jsonl"));
  const intents = readJsonl(join(dir, "intents.jsonl"));
  const notices = readJsonl(join(dir, "notices.jsonl"));
  const pairs = readJsonl(join(dir, "pairs.jsonl"));
  return {
    personas, intents, notices, pairs,
    intentById: new Map(intents.map((i) => [i.id, i])),
    noticeById: new Map(notices.map((n) => [n.id, n])),
  };
}
