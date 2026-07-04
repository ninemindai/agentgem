// Pure report → text serialization. A small block intermediate is defined once
// per report (insightsToBlocks / analyzeToBlocks) and rendered to two targets so
// the markdown and print-HTML layouts cannot drift apart.

export type ReportBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "list"; items: string[] };

export function blocksToMarkdown(blocks: ReportBlock[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|"); // keep table cells valid
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") out.push(`## ${b.text}`);
    else if (b.kind === "para") out.push(b.text);
    else if (b.kind === "list") out.push(b.items.map((i) => `- ${i}`).join("\n"));
    else {
      out.push(
        `| ${b.head.map(esc).join(" | ")} |`,
        `| ${b.head.map(() => "---").join(" | ")} |`,
        ...b.rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
      );
    }
  }
  return out.join("\n\n") + "\n";
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function blocksToHtml(blocks: ReportBlock[], title: string): string {
  const body = blocks
    .map((b) => {
      if (b.kind === "heading") return `<h2>${escapeHtml(b.text)}</h2>`;
      if (b.kind === "para") return `<p>${escapeHtml(b.text)}</p>`;
      if (b.kind === "list") return `<ul>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
      const head = `<tr>${b.head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
      return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page { margin: 2cm; }
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #111; max-width: 46rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 1.4em; }
table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f4f4f4; }
ul { padding-left: 1.2em; }
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
