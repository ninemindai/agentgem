import { useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render markdown to sanitized HTML. Gem content is local but not necessarily
 * trusted (installed .gem files), so DOMPurify strips any XSS vectors. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unquote = (s: string) =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;

/** Minimal YAML-frontmatter parse (top-level scalars + one nesting level). */
export function parseFrontmatter(src: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  let parent = "";
  for (const raw of src.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = /^(\s*)([A-Za-z0-9_.-]+):\s?(.*)$/.exec(raw);
    if (!m) continue;
    const [, indent, key, rest] = m;
    const value = unquote(rest.trim());
    if (indent.length === 0) {
      if (value === "") parent = key;             // a nested mapping follows
      else { out.push({ key, value }); parent = ""; }
    } else if (value !== "") {
      out.push({ key: parent ? `${parent}.${key}` : key, value });
    }
  }
  return out;
}

export function renderMarkdown(text: string): string {
  // Split off leading YAML frontmatter and render it as a metadata table above the prose.
  let front = "";
  let body = text;
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    const rows = parseFrontmatter(fm[1]);
    if (rows.length) {
      front = `<table class="cv-front"><tbody>${rows
        .map((r) => `<tr><th>${escapeHtml(r.key)}</th><td>${escapeHtml(r.value)}</td></tr>`)
        .join("")}</tbody></table>`;
    }
  }
  const html = marked.parse(body, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(front + html);
}

/** A markdown content viewer with a Markdown ⇄ Raw toggle (markdown by default). */
export function ContentView({ text }: { text: string }) {
  const [mode, setMode] = useState<"md" | "raw">("md");
  return (
    <div className="cv">
      <div className="cv-modes">
        <button type="button" className={mode === "md" ? "is-active" : ""} onClick={() => setMode("md")}>Markdown</button>
        <button type="button" className={mode === "raw" ? "is-active" : ""} onClick={() => setMode("raw")}>Raw</button>
      </div>
      {mode === "md"
        ? <div className="cv-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        : <pre className="cv-raw">{text}</pre>}
    </div>
  );
}
