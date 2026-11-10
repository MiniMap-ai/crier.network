#!/usr/bin/env node
/**
 * Fails a change whose added comments narrate history, run long, or outweigh the code they sit on.
 * Only added lines are judged, so touching a file does not make its past yours.
 *
 *   node scripts/check-comments.mjs <base-ref> [head-ref]     e.g. origin/main
 */
import { execFileSync } from "node:child_process";

const LIMITS = {
  blockLines: 12,   // longest run of added comment lines in one place
  ratio: 1.5,       // added comment lines per added code line, per file...
  ratioFloor: 15,   // ...judged only once a file adds this many comment lines
};
const DATE = /\b20\d\d-\d\d(-\d\d)?\b/;
const EXTENSIONS = ["*.ts", "*.tsx", "*.mjs", "*.js"];

const [base, head = "HEAD"] = process.argv.slice(2);
if (!base) { console.error("usage: node scripts/check-comments.mjs <base-ref> [head-ref]"); process.exit(2); }

const diff = execFileSync("git", ["diff", "--unified=0", "--no-color", `${base}...${head}`, "--", ...EXTENSIONS], { encoding: "utf8", maxBuffer: 64 << 20 });

/** Added lines per file, with their line numbers in the new file. */
function addedLines(text) {
  const files = new Map();
  let file = null, line = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ ")) { file = raw.slice(6); files.set(file, []); continue; }
    if (raw.startsWith("@@")) { line = Number(/\+(\d+)/.exec(raw)[1]); continue; }
    if (!file || raw.startsWith("---") || raw.startsWith("diff ")) continue;
    if (raw.startsWith("+")) files.get(file).push({ line, text: raw.slice(1) });
    if (raw.startsWith("+") || raw.startsWith(" ")) line++;
  }
  return files;
}

const isComment = (t) => /^\s*(\/\/|\/\*|\*)/.test(t);
/** The comment after code on the same line, if any; `://` inside a URL is not one. */
const trailingComment = (t) => /(?:^|[^:])\/\/(.*)$/.exec(t)?.[1];
const problems = [];

for (const [file, lines] of addedLines(diff)) {
  let code = 0, comments = 0, block = null;
  for (const { line, text } of lines) {
    if (!text.trim()) continue;
    if (!isComment(text)) {
      code++; block = null;
      const tail = trailingComment(text);
      if (tail !== undefined && DATE.test(tail)) problems.push(`${file}:${line}: a date in a comment is history; put it in docs/ or the commit message and state the rule here`);
      continue;
    }
    comments++;
    if (DATE.test(text)) problems.push(`${file}:${line}: a date in a comment is history; put it in docs/ or the commit message and state the rule here`);
    if (block && block.end === line - 1) { block.end = line; block.n++; } else block = { start: line, end: line, n: 1, reported: false };
    if (block.n > LIMITS.blockLines && !block.reported) { block.reported = true; problems.push(`${file}:${block.start}: comment block runs past ${LIMITS.blockLines} lines; keep the rule and the non-obvious why, move the rest to docs/`); }
  }
  if (comments >= LIMITS.ratioFloor && comments > LIMITS.ratio * code) problems.push(`${file}: ${comments} comment lines added against ${code} code lines; cut the comments or move them to docs/`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s). Comments state a rule or a non-obvious why in a few lines; history and narrative belong in docs/, the commit message or the PR.`);
  process.exit(1);
}
console.log("check-comments: added comments are within limits.");
