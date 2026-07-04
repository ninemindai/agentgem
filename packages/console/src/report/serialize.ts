// Pure report → text serialization. A small block intermediate is defined once
// per report (insightsToBlocks / analyzeToBlocks) and rendered to two targets so
// the markdown and print-HTML layouts cannot drift apart.

export type ReportBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "list"; items: string[] };

export function blocksToMarkdown(blocks: ReportBlock[]): string {
  const esc = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|"); // one-line, valid table cells
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

import type { InsightsReportView } from "../panels/Insights/insightsStream.js";
import type { AnalyzeCandidate } from "../panels/Curate/analyzeStream.js";

export function insightsToBlocks(report: InsightsReportView, scanned?: number | null): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const t = report.totals;
  if (report.narrative) blocks.push({ kind: "para", text: report.narrative });
  if (report.outcomes_summary) blocks.push({ kind: "para", text: report.outcomes_summary });

  const capped = scanned != null && scanned > t.sessions;
  blocks.push({
    kind: "para",
    text:
      `${t.sessions} session${t.sessions === 1 ? "" : "s"} judged — ` +
      `${t.mostly} mostly, ${t.partially} partially, ${t.not} not.` +
      (capped ? ` (most-recent ${t.sessions} of ${scanned} scanned)` : ""),
  });

  const byModel = report.by_model ?? [];
  if (byModel.length > 1) {
    blocks.push({ kind: "heading", text: "By model" });
    blocks.push({
      kind: "table",
      head: ["model", "mostly", "partially", "not", "sessions"],
      rows: byModel.map((m) => [m.model, String(m.mostly), String(m.partially), String(m.not), String(m.total)]),
    });
  }

  const candidates = report.publish_candidates ?? [];
  if (candidates.length > 0) {
    blocks.push({ kind: "heading", text: "Worth publishing" });
    blocks.push({ kind: "table", head: ["goal", "why"], rows: candidates.map((c) => [c.goal, c.why]) });
  }

  const friction = report.friction ?? [];
  if (friction.length > 0) {
    blocks.push({ kind: "heading", text: "Friction" });
    blocks.push({ kind: "list", items: friction.map((f) => f.detail) });
  }

  return blocks;
}

export function analyzeToBlocks(candidates: AnalyzeCandidate[]): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  for (const c of candidates) {
    blocks.push({ kind: "heading", text: c.name });
    blocks.push({
      kind: "para",
      text: `Confidence: ${c.confidence} · ${c.include.length} artifact${c.include.length === 1 ? "" : "s"}`,
    });
    if (c.description) blocks.push({ kind: "para", text: c.description });
    if (c.include.length > 0) {
      blocks.push({ kind: "list", items: c.include.map((a) => `${a.type}: ${a.name}`) });
    }
  }
  return blocks;
}
