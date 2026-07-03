// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/artifactScan.ts
//
// Pure reconstruction of HTML "artifacts" from a coding-session transcript — the
// data half of the Watch tab. A regular coding session (Claude Code, etc.) never
// emits Claude.ai-style typed artifact blocks; it just writes files. So we INFER
// the artifact from the file-mutation tool_use records the transcript already
// carries: every Write/Edit/MultiEdit targeting a `*.html` path produces a new
// full-document snapshot, in order. Reconstructing full snapshots (not diffs) lets
// the UI render each version directly in a sandboxed iframe.
//
// Deliberately pure + I/O-free: it folds parsed jsonl records (see jsonLines in
// observeScan.ts) into an ordered version list, so it is fully unit-testable and
// safe to share. Redaction is applied by the caller (watchStream.ts) via scrubText
// before anything leaves the process — this module keeps content verbatim.

/** One reconstructed full-document snapshot of an HTML artifact file. */
export interface HtmlArtifactVersion {
  /** Absolute (or transcript-relative) path of the written file. */
  path: string;
  /** The full HTML document as of this mutation. */
  html: string;
  /** The tool that produced this snapshot (Write | Edit | MultiEdit). */
  tool: string;
  /** Assistant-turn timestamp in ms, or null when the record carried none. */
  tsMs: number | null;
  /** 1-based version index WITHIN this path (a path's Nth mutation). */
  version: number;
}

const isHtmlPath = (p: unknown): p is string =>
  typeof p === "string" && /\.html?$/i.test(p.trim());

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : "";

// Apply one Edit (old_string → new_string). Mirrors Claude Code's Edit semantics:
// replace the first occurrence, or all occurrences when replace_all is true. A
// missing old_string leaves the document unchanged (best-effort, never throws).
function applyEdit(html: string, input: Record<string, unknown>): string {
  const oldStr = str(input, "old_string");
  const newStr = str(input, "new_string");
  if (!oldStr) return html;
  if (input.replace_all === true) return html.split(oldStr).join(newStr);
  const at = html.indexOf(oldStr);
  return at === -1 ? html : html.slice(0, at) + newStr + html.slice(at + oldStr.length);
}

// Fold a single tool_use item into `latest` (path → current document), returning
// the new snapshot for that path or null when the item is not an HTML mutation we
// can reconstruct. Write carries the whole document; Edit/MultiEdit mutate the last
// known snapshot (skipped if we've never seen a full Write for that path — we can't
// invent the base document, so an edit-before-write simply doesn't render).
function foldToolUse(
  name: string,
  input: Record<string, unknown>,
  latest: Map<string, string>,
): { path: string; html: string } | null {
  const path = str(input, "file_path");
  if (!isHtmlPath(path)) return null;

  if (name === "Write") {
    const html = str(input, "content");
    latest.set(path, html);
    return { path, html };
  }
  if (name === "Edit") {
    const base = latest.get(path);
    if (base === undefined) return null;
    const html = applyEdit(base, input);
    latest.set(path, html);
    return { path, html };
  }
  if (name === "MultiEdit") {
    const base = latest.get(path);
    if (base === undefined) return null;
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let html = base;
    for (const e of edits) html = applyEdit(html, asObj(e));
    latest.set(path, html);
    return { path, html };
  }
  return null;
}

/**
 * Reconstruct the ordered list of HTML artifact snapshots from parsed transcript
 * records (assistant messages whose content arrays carry tool_use items). Each
 * Write/Edit/MultiEdit to a `*.html` path yields one snapshot; versions are numbered
 * per-path so the UI can show "index.html · v3". Order follows record order.
 */
export function detectHtmlArtifacts(
  records: Iterable<Record<string, unknown>>,
): HtmlArtifactVersion[] {
  const latest = new Map<string, string>();
  const counts = new Map<string, number>();
  const out: HtmlArtifactVersion[] = [];

  for (const rec of records) {
    // Only assistant turns invoke tools; a string content block carries no tool_use.
    const msg = asObj(rec.message);
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    const tsMs = Number.isNaN(ts) ? null : ts;

    for (const raw of content) {
      const it = asObj(raw);
      if (it.type !== "tool_use" || typeof it.name !== "string") continue;
      const snap = foldToolUse(it.name, asObj(it.input), latest);
      if (!snap) continue;
      const version = (counts.get(snap.path) ?? 0) + 1;
      counts.set(snap.path, version);
      out.push({ path: snap.path, html: snap.html, tool: it.name, tsMs, version });
    }
  }
  return out;
}

/** Distinct artifact paths in first-seen order — used to summarize a session. */
export function artifactPaths(versions: HtmlArtifactVersion[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of versions) if (!seen.has(v.path)) { seen.add(v.path); out.push(v.path); }
  return out;
}
