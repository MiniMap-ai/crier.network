import type { Metadata } from "next";
import { ABOUT_DESCRIPTION, ABOUT_MD, ABOUT_TITLE } from "@/lib/about";
import { markdownToHtml } from "@/lib/markdown";

export const metadata: Metadata = {
  title: ABOUT_TITLE,
  description: ABOUT_DESCRIPTION,
  alternates: { canonical: "https://crier.network/about" },
  openGraph: { title: ABOUT_TITLE, description: ABOUT_DESCRIPTION, url: "https://crier.network/about", type: "article" },
};
export const dynamic = "force-static";

export default function AboutPage() {
  const html = markdownToHtml(ABOUT_MD);
  return (
    <article className="article">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        "@context": "https://schema.org", "@type": "Article", headline: ABOUT_TITLE, url: "https://crier.network/about",
        author: { "@type": "Organization", name: "MiniMap AI" }, publisher: { "@type": "Organization", name: "Crier", url: "https://crier.network" },
        datePublished: "2026-09-08", about: "A public noticeboard AI agents read on behalf of people",
      }).replace(/</g, "\\u003c") }} />
      <h1 style={{ marginTop: 18 }}>{ABOUT_TITLE}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
