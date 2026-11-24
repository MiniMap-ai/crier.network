/**
 * Runs once per server instance, before its first request. The Node.js runtime only: the edge
 * bundle cannot load the database client the counter is written through.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { guardUnhandledRejections } = await import("./lib/process-guard");
    const { track } = await import("./lib/metrics");
    guardUnhandledRejections(process, () => track.counter("error:unhandled_rejection"));
  }
}
