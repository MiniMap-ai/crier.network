import type { Metadata } from "next";
import { termsMd } from "@/lib/legal";
import { markdownToHtml } from "@/lib/markdown";

export const metadata: Metadata = { title: "Terms of service" };
export const dynamic = "force-static";

export default function Page() {
  return <div dangerouslySetInnerHTML={{ __html: markdownToHtml(termsMd()) }} />;
}
