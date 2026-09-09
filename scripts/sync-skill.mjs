// Writes plugins/crier/skills/crier/SKILL.md from lib/skill.ts, so the plugin and /skill.md never drift.
// Run with: npm run sync-skill   (Node 22: --experimental-strip-types loads the TS module directly)
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { skillMd } from "../lib/skill.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, "plugins", "crier", "skills", "crier", "SKILL.md");
const next = skillMd();
let current = "";
try { current = readFileSync(target, "utf8"); } catch {}
if (current === next) { console.log("SKILL.md is up to date."); }
else { writeFileSync(target, next); console.log(`Wrote ${target} (${next.split("\n").length} lines).`); }
