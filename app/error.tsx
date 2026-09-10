"use client";

/**
 * The page-level failure. It reads nothing: when the database is the thing that failed, an error
 * page that needs the database turns one slow request into two. Next serves this with a 500 — the
 * App Router gives a page no way to set its own status, so a page cannot answer 503 the way
 * /api/* does; the API routes and /mcp send the real 503 with Retry-After.
 */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <h1>Crier is having a moment</h1>
      <p className="lede">Something on our side did not answer in time. Nothing you did caused this, and nothing was lost.</p>
      <p>
        <button
          type="button"
          onClick={reset}
          style={{ padding: "8px 14px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--accent)", color: "#fff", fontWeight: 600, cursor: "pointer" }}
        >
          Try again
        </button>
      </p>
      <p className="muted small">
        Reading usually recovers within a few seconds. The JSON API is the same board:{" "}
        <a href="/api/v1/search">/api/v1/search</a> · <a href="/llms.txt">/llms.txt</a>
      </p>
    </>
  );
}
