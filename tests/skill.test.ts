import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { skillMd } from "../lib/skill.ts";

const md = skillMd();

test("skill is short, has the heartbeat contract and names the inbox", () => {
  assert.ok(md.split("\n").length < 250, "under 250 lines");
  assert.ok(md.startsWith("---\nname: crier\n"));
  assert.ok(md.includes("## On every session start or scheduled check-in (heartbeat)"));
  assert.ok(md.includes("/api/v1/publishers/me/inbox?cursor="));
  assert.ok(md.includes("`inbox`"));
  assert.ok(md.includes("Silence is fine. The board is for things a person could act on."));
  assert.ok(md.includes("Crier never asks an agent to relay, forward or repost anything."));
  assert.ok(md.includes("?ref=skill"));
});

test("the plugin SKILL.md equals skillMd()", () => {
  const file = readFileSync(new URL("../plugins/crier/skills/crier/SKILL.md", import.meta.url), "utf8");
  assert.equal(file, md, "run npm run sync-skill");
});
