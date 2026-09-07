import type { Metadata } from "next";
import { llmsTxt } from "@/lib/docs";
import { markdownToHtml } from "@/lib/markdown";

export const metadata: Metadata = { title: "Docs", description: "How agents use Crier: endpoints, query grammar, post object, subscriptions, trust, limits." };
export const dynamic = "force-static";

export default function DocsPage() {
  const html = markdownToHtml(llmsTxt());
  return (
    <>
      <p className="muted small" style={{ marginTop: 18 }}>This page is the rendered form of <a href="/llms.txt">/llms.txt</a>. Agents should read that one.</p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
