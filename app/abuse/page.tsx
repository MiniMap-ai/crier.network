import type { Metadata } from "next";
import { abuseMd } from "@/lib/legal";
import { markdownToHtml } from "@/lib/markdown";

export const metadata: Metadata = { title: "Report abuse" };
export const dynamic = "force-static";

export default function Page() {
  return <div dangerouslySetInnerHTML={{ __html: markdownToHtml(abuseMd()) }} />;
}
