// Applies migrations/*.sql in order against DATABASE_URL, tracking applied files in schema_migrations.
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const sql = postgres(url, { prepare: false, max: 1 });
const dir = path.join(process.cwd(), "migrations");
const files = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();
await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const applied = new Set((await sql`select name from schema_migrations`).map(r => r.name));
for (const f of files) {
  if (applied.has(f)) continue;
  const body = await readFile(path.join(dir, f), "utf8");
  console.log("applying", f);
  await sql.begin(async tx => { await tx.unsafe(body); await tx`insert into schema_migrations (name) values (${f})`; });
}
await sql.end();
console.log("done");
