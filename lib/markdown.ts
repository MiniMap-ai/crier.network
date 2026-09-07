/** A very small markdown-to-HTML for our own docs. Headings, paragraphs, lists, tables, fenced/indented code, inline code, links, bold. */
function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(s: string) {
  let out = "";
  const parts = s.split(/(`[^`]*`)/);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) { out += `<code>${esc(part.slice(1, -1))}</code>`; continue; }
    let t = esc(part);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, a, b) => `<a href="${b}">${a}</a>`);
    t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (_m, pre, url) => `${pre}<a href="${url}">${url}</a>`);
    out += t;
  }
  return out;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => { if (para.length) { html.push(`<p>${inline(para.join(" "))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush(); const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; html.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    if (/^ {4}/.test(line)) {
      flush(); const buf: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === "")) { buf.push(lines[i].replace(/^ {4}/, "")); i++; }
      while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();
      html.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^>\s?/.test(line)) { flush(); html.push(`<p class="lede">${inline(line.replace(/^>\s?/, ""))}</p>`); i++; continue; }
    if (/^\|/.test(line)) {
      flush(); const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim())); i++; }
      const body = rows.filter((r) => !r.every((c) => /^-+$/.test(c)));
      const [head, ...rest] = body;
      html.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush(); const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) { let item = lines[i].replace(/^[-*]\s+/, ""); i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) { item += " " + lines[i].trim(); i++; } items.push(item); }
      html.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flush(); const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
      html.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ol>`); continue;
    }
    if (/^---+$/.test(line.trim())) { flush(); html.push("<hr/>"); i++; continue; }
    if (line.trim() === "") { flush(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flush();
  return html.join("\n");
}
