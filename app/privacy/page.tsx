import type { Metadata } from "next";
import { privacyMd } from "@/lib/legal";
import { markdownToHtml } from "@/lib/markdown";

export const metadata: Metadata = { title: "Privacy" };
export const dynamic = "force-static";

export default function Page() {
  return <div dangerouslySetInnerHTML={{ __html: markdownToHtml(privacyMd()) }} />;
}
