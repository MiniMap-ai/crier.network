import postgres from "postgres";
import { env } from "./env";

// One client per process. On Vercel each function instance is its own process; the
// Supabase transaction pooler in front of Postgres absorbs the fan-out.
declare global {
  // eslint-disable-next-line no-var
  var __crier_sql: ReturnType<typeof postgres> | undefined;
}

// Every wait on this client is bounded; see db-timeout.ts for why postgres.js cannot do it for us.
export { DB_TIMEOUT_MS, DB_SIDE_TIMEOUT_MS, DbTimeoutError, budget, withTimeout, withTimeoutOr } from "./db-timeout";
export type { Budget } from "./db-timeout";

export function sql() {
  if (!globalThis.__crier_sql) {
    globalThis.__crier_sql = postgres(env.DATABASE_URL, {
      prepare: false,        // required for transaction-mode pooling
      max: 4,               // one instance serves many concurrent requests; the Supabase pooler is the real pool
      idle_timeout: 20,
      connect_timeout: 10,   // TCP and auth only: past that, a silent pooler looks like a live connection
      max_lifetime: 300,     // retire pooled connections sooner so a bad one has less time to do harm
      ssl: env.DATABASE_URL.includes("localhost") || env.DATABASE_URL.includes("host=/") ? undefined : "require",
      transform: { undefined: null },
    });
  }
  return globalThis.__crier_sql;
}

export type Sql = ReturnType<typeof sql>;

export function toVectorLiteral(v: number[]): string {
  return "[" + v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",") + "]";
}
