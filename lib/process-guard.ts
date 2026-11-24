/**
 * The process-level record of a promise rejection nothing handled.
 *
 * Such a rejection can come from inside a client library, where no await of ours can catch it:
 * postgres.js runs an internal query on each new connection and drops its promise. Whether the
 * process survives one is decided by the platform's own listeners, not here; what this adds is a
 * log line with the stack and a counted error. docs/metrics.md says when that count can land.
 *
 * No imports, so tests can load it; instrumentation.ts installs it with the real counter.
 */

type Listener = (reason: unknown) => void;
type Proc = { prependListener(event: "unhandledRejection", listener: Listener): unknown };

const INSTALLED = Symbol.for("crier.unhandledRejectionGuard");

function describe(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const code = (reason as { code?: unknown }).code;
      return `${reason.stack ?? `${reason.name}: ${reason.message}`}${code === undefined ? "" : ` (code ${String(code)})`}`;
    }
    return String(reason);
  } catch {
    return "(a reason that cannot be printed)";
  }
}

/**
 * Log every unhandled rejection with its stack, then `count` it. Installed ahead of every other
 * listener, so the line is written before a listener that ends the process can run. Never throws,
 * since a throw from this listener would be an uncaught exception. Installs once per process and
 * returns whether this call was the one that installed it.
 */
export function guardUnhandledRejections(proc: Proc, count: Listener, log: (...args: unknown[]) => void = console.error): boolean {
  const mark = proc as { [INSTALLED]?: true };
  if (mark[INSTALLED]) return false;
  mark[INSTALLED] = true;
  proc.prependListener("unhandledRejection", (reason) => {
    try { log("unhandled rejection", describe(reason)); } catch { /* nowhere left to say it */ }
    try { count(reason); } catch { /* the line above is the record */ }
  });
  return true;
}
