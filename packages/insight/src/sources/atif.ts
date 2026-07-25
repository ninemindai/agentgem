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
import { createLogger } from "@agentgem/base";
import type { SourceSpec, SourceEnv } from "../sources.js";
import type { SessionStat } from "../observeAggregate.js";
import { listFiles } from "../observeScan.js";
import { parseAtifMeta, atifSessionEvents } from "../atif/atifImport.js";
import { summarizeDiagnostics, groupDiagnostics, type AtifDiagnostics, type AtifHealthGroup } from "../atif/atifDiagnostics.js";
import { atifDropDir } from "../atif/atifView.js";

const log = createLogger("insight");

/**
 * Scan the drop dir, collecting a diagnostic for every file that was rejected
 * or imported lossily. The stats half is unchanged; `diagnostics` is the new
 * half, and it is the only reason a caller can tell an empty drop dir apart
 * from a drop dir full of files this parser refused.
 */
export async function scanAtifSessions(files: string[]): Promise<{ stats: SessionStat[]; diagnostics: AtifDiagnostics }> {
  const stats: SessionStat[] = [];
  const diagnostics: AtifDiagnostics = [];
  for (const f of files) {
    let text: string; try { text = await readFile(f, "utf8"); } catch { continue; }
    const s = parseAtifMeta(text, f, diagnostics);
    if (!s) continue;
    if (s.startMs === 0) {
      // Timestamps are optional in ATIF; the file's mtime is the honest fallback.
      let mtime = 0; try { mtime = statSync(f).mtimeMs; } catch { /* keep 0 */ }
      stats.push({ ...s, startMs: mtime, endMs: mtime });
    } else stats.push(s);
  }
  return { stats, diagnostics };
}

export const atifSource: SourceSpec = {
  id: "atif", label: "ATIF import", traits: { storage: "json" },
  roots: (env) => [atifDropDir(env.baseDir)],
  // SourceSpec.scanSessions returns stats only, so the diagnostics land in the
  // log rather than being dropped. A rejected drop-dir file used to be silent;
  // one warn line per distinct code is the cheapest sink that changes that.
  scanSessions: async (roots) => {
    const { stats, diagnostics } = await scanAtifSessions(roots.flatMap((r) => listFiles(r, ".json")));
    for (const line of summarizeDiagnostics(diagnostics)) log.warn("atif import: %s", line);
    return stats;
  },
  watchFiles: (roots) => roots.flatMap((r) => listFiles(r, ".json")),
  parseMeta: parseAtifMeta,
  // Trajectories carry no reconstructable HTML documents; events feed the live view.
  resolveArtifactPaths: () => [],
  detectEvents: atifSessionEvents,
};

export interface AtifHealth {
  /** *.json files present in the drop dir. */
  totalFiles: number;
  /** How many of them parsed into a session. */
  imported: number;
  /** Import problems, grouped by reason; empty when the drop dir is clean. */
  groups: AtifHealthGroup[];
}

/**
 * Scan the drop dir for a health snapshot: totals plus grouped diagnostics.
 * Resolves the root exactly as the source does and reuses scanAtifSessions, so
 * it sees the same files the telemetry scan sees. `env.baseDir` is the test
 * override for the drop dir (same as the source).
 */
export async function scanAtifHealth(env: SourceEnv = {}): Promise<AtifHealth> {
  const files = atifSource.roots(env).flatMap((r) => listFiles(r, ".json"));
  const { stats, diagnostics } = await scanAtifSessions(files);
  return { totalFiles: files.length, imported: stats.length, groups: groupDiagnostics(diagnostics) };
}
