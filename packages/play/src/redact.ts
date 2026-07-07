// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// De-identify the source data BEFORE it is baked into a shareable, publicly-runnable miniapp bundle.
// Best-effort scrubbing (home-dir path + common secret token shapes), NOT a security guarantee — a
// determined leak in free-form transcript text can still slip through. The point is to keep the obvious
// author-identifying bits (home path, API keys) out of an artifact that will run on app.agentgem.ai.
import { homedir } from "node:os";
import { basename } from "node:path";

// Common secret shapes: OpenAI (sk-…), GitHub (ghp_/gho_/ghu_/ghs_/ghr_…), AWS access key (AKIA…),
// Slack (xoxb-/xoxp-…), and JWTs (three base64url segments).
const TOKEN =
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

const MAX_TIMELINE = 500;

function redactText(s: string): string {
  const home = homedir();
  const dehomed = home ? s.split(home).join("~") : s;
  return dehomed.replace(TOKEN, "‹redacted›");
}

export function redactForBake(data: unknown): unknown {
  return walk(data);
  function walk(v: unknown): unknown {
    if (typeof v === "string") return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "timeline" && Array.isArray(val)) { out[k] = val.slice(0, MAX_TIMELINE).map(walk); continue; }
        if (k === "files" && Array.isArray(val)) { out[k] = val.map((f) => (typeof f === "string" ? basename(f) : walk(f))); continue; }
        if (k === "path" && typeof val === "string") { out[k] = basename(val); continue; }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
}
