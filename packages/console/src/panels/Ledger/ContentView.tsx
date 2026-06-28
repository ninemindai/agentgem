import { useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render markdown to sanitized HTML. Gem content is local but not necessarily
 * trusted (installed .gem files), so DOMPurify strips any XSS vectors. */
export function renderMarkdown(text: string): string {
  // Drop leading YAML frontmatter (---\n…\n---) so it doesn't render as a heading.
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const html = marked.parse(body, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(html);
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
