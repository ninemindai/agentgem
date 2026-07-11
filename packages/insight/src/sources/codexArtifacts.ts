// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/sources/codexArtifacts.ts
//
// Codex artifact-path resolver — the thin, file-driven half of the Watch feature
// for Codex sessions. Codex doesn't emit whole-file writes the way Claude's Write
// does; it mutates files through `apply_patch` (a diff) and `shell` redirections,
// so reconstructing full document snapshots from the transcript is unreliable.
// Instead we answer the easier question — "which *.html files did this session
// touch" — and let the live layer watch those real files on disk. Paths are
// resolved against the session's own cwd (from session_meta) and returned absolute,
// in first-seen order.
import { isAbsolute, resolve } from "node:path";
import { jsonLines } from "../observeScan.js";

// A path-like token ending in .htm/.html. The class excludes ':' so a URL like
// http://x/a.html can't be mistaken for a local file path.
// The hyphen is escaped so `+-` is not read as a range from '+' (0x2B) to '-' (0x2D), which would
// silently include ',' (0x2C) and merge two comma-separated .html paths into one bogus token.
const HTML_TOKEN = /([~\w.@/+\-]+\.html?)\b/gi;
// apply_patch section headers name the file being added/updated.
const PATCH_FILE = /\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?\.html?)\b/gi;

export function resolveCodexHtmlPaths(text: string): string[] {
  let cwd = "";
  const seen = new Set<string>();
  const order: string[] = [];

  const add = (raw: string) => {
    const p = raw.trim();
    if (!p || p.startsWith("//")) return;              // '//x' → not a real local path
    let abs: string;
    if (isAbsolute(p)) abs = resolve(p);
    else if (cwd) abs = resolve(cwd, p);
    else return;                                        // relative but no cwd yet → can't resolve
    if (!seen.has(abs)) { seen.add(abs); order.push(abs); }
  };

  for (const rec of jsonLines(text)) {
    const p = rec.payload as Record<string, unknown> | undefined;
    if (rec.type === "session_meta" && p && typeof p.cwd === "string") cwd = p.cwd;
    if (rec.type === "response_item" && p?.type === "function_call") {
      const args = typeof p.arguments === "string" ? p.arguments : "";
      for (const m of args.matchAll(PATCH_FILE)) add(m[1]);
      for (const m of args.matchAll(HTML_TOKEN)) add(m[1]);
    }
  }
  return order;
}
