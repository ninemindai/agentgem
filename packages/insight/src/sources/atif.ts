// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The ATIF drop-dir source: any *.json trajectory under ~/.agentgem/atif is a
// session. This is the interchange on-ramp — Harbor ships ATIF converters for
// Terminus-2, OpenHands, Mini-SWE-Agent, Gemini CLI, Claude Code, and Codex, so
// agents without a native SourceSpec arrive through this one. baseDir is the
// test override for the drop dir itself (gemini/continue pattern).
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import type { SourceSpec } from "../sources.js";
import type { SessionStat } from "../observeAggregate.js";
import { listFiles } from "../observeScan.js";
import { parseAtifMeta, atifSessionEvents } from "../atif/atifImport.js";
import { atifDropDir } from "../atif/atifView.js";

export async function scanAtifSessions(files: string[]): Promise<SessionStat[]> {
  const out: SessionStat[] = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parseAtifMeta(text, f);
    if (!s) continue;
    if (s.startMs === 0) {
      // Timestamps are optional in ATIF; the file's mtime is the honest fallback.
      let mtime = 0; try { mtime = statSync(f).mtimeMs; } catch { /* keep 0 */ }
      out.push({ ...s, startMs: mtime, endMs: mtime });
    } else out.push(s);
  }
  return out;
}

export const atifSource: SourceSpec = {
  id: "atif", label: "ATIF import", traits: { storage: "json" },
  roots: (env) => [atifDropDir(env.baseDir)],
  scanSessions: (roots) => scanAtifSessions(roots.flatMap((r) => listFiles(r, ".json"))),
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".json")),
  parseMeta: parseAtifMeta,
  // Trajectories carry no reconstructable HTML documents; events feed the live view.
  resolveArtifactPaths: () => [],
  detectEvents: atifSessionEvents,
};
