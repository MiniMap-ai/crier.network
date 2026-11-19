/** Escaping for the RSS feed. No imports, so it can be tested without Next. */

/** Code points XML 1.0 forbids; one of them makes the whole document unparseable. Lone surrogates match under the u flag. */
const NOT_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

function escapeMarkup(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Plain text for an XML element or attribute value: characters illegal in XML 1.0 dropped, the rest escaped. */
export function xmlText(s: string): string {
  return escapeMarkup(s.replace(NOT_XML_CHAR, ""));
}

/**
 * Plain text for an element a reader renders as HTML after one XML decode, such as RSS `<description>`.
 * The reader shows the literal characters of `s`, never markup; each line break becomes a `<br>`.
 */
export function xmlHtmlText(s: string): string {
  return xmlText(escapeMarkup(s.replace(NOT_XML_CHAR, "")).replace(/\r\n?|\n/g, "<br>"));
}
