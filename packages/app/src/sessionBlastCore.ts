// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/sessionBlastCore.ts
//
// Per-session blast radius: resolve one session (Claude or Codex) and scan its
// transcript into the ordered, scrubbed touch-event series for Inspect → Session.
// Mirrors sessionHygieneCore: guard failures are tagged so the controller maps
// exactly these to a 400 and unexpected faults stay 500s (no echoed paths).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  scanSessionBlast, scanCodexSessionBlast, resolveClaudeSession, resolveCodexSession,
  type BlastReport,
} from "@agentgem/insight";

export class BlastInputError extends Error {}

export async function sessionBlast(id: string, agent: string): Promise<BlastReport> {
  if (agent === "claude") {
    const found = await resolveClaudeSession(id);
    if (!found) throw new BlastInputError(`No Claude session '${id}' found.`);
    const text = await readFile(found.path, "utf8");
    return scanSessionBlast(text, { cwd: found.cwd, sessionId: id, transcript: basename(found.path) });
  }
  if (agent === "codex") {
    const found = await resolveCodexSession(id);
    if (!found) throw new BlastInputError(`No Codex session '${id}' found.`);
    const text = await readFile(found.path, "utf8");
    return scanCodexSessionBlast(text, { cwd: found.cwd, sessionId: id, transcript: basename(found.path) });
  }
  throw new BlastInputError(`Blast radius is not available for agent '${agent}'.`);
}
