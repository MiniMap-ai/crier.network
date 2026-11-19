import { test } from "node:test";
import assert from "node:assert/strict";
import { xmlHtmlText, xmlText } from "../lib/rss.ts";

/** What an XML parser hands a feed reader: the five predefined entities decoded once, ampersand last. */
const xmlDecode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
/** The text a reader displays after rendering the decoded description as HTML, whose entities for these characters are the same five. */
const shown = (decoded: string) => xmlDecode(decoded.replace(/<br>/g, "\n"));

const hostile = [
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  "<a href='https://evil.example'>click</a>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "]]><evil/>",
  `She said "hi" & it's fine`,
  "When: Friday\nWhere: The Hall\n\nDoors at 8\r\nPosted by Someone.",
];

test("a description decoded once by XML and rendered as HTML has no markup but the <br> it adds", () => {
  for (const body of hostile) {
    const decoded = xmlDecode(xmlHtmlText(body));
    assert.equal(decoded.replace(/<br>/g, "").includes("<"), false, body);
  }
});

test("a reader shows exactly the characters the publisher wrote, already-escaped text included", () => {
  for (const body of hostile) assert.equal(shown(xmlDecode(xmlHtmlText(body))), body.replace(/\r\n/g, "\n"), body);
  assert.equal(shown(xmlDecode(xmlHtmlText("&lt;script&gt;"))), "&lt;script&gt;");
});

test("newlines become <br> so the When, Where, body and Posted-by lines stay lines", () => {
  assert.equal(xmlDecode(xmlHtmlText("a\nb\r\nc\rd")), "a<br>b<br>c<br>d");
});

test("the output is well-formed XML text: no raw <, > or stray &", () => {
  for (const body of hostile) {
    for (const out of [xmlText(body), xmlHtmlText(body)]) {
      assert.doesNotMatch(out, /[<>"']/);
      assert.doesNotMatch(out, /&(?!(amp|lt|gt|quot|#39);)/);
    }
  }
});

test("characters illegal in XML 1.0 are dropped and legal ones kept", () => {
  const illegal = ["\u0000", "\u0001", "\u0008", "\u000B", "\u000C", "\u001F", "\uFFFE", "\uFFFF", "\uD800", "\uDFFF", "\uDFFF\uD800"];
  for (const c of illegal) {
    assert.equal(xmlText(`a${c}b`), "ab", JSON.stringify(c));
    assert.equal(xmlDecode(xmlHtmlText(`a${c}b`)), "ab", JSON.stringify(c));
  }
  assert.equal(xmlText("tab\there\nline\rcr \u00E9 \u65E5\u672C \u{1F600}"), "tab\there\nline\rcr \u00E9 \u65E5\u672C \u{1F600}");
});
