// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Upsert a single fenced block into a hand-maintained instruction file
// (CLAUDE.md / AGENTS.md) without clobbering the user's content. previewGuardrails
// is pure; applyGuardrails is hash-guarded (abort on on-disk drift) and writes via
// an observable temp+rename (throws on real fs failure — unlike the JSON-only,
// error-swallowing atomicWrite helper). Never appends a duplicate block.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const OPEN = "<!-- agentgem:learnings -->";
const CLOSE = "<!-- /agentgem:learnings -->";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readOrEmpty = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

export function resolveTarget(dir: string): { target: "claude" | "agents" | null; file: string | null; ambiguous: boolean } {
  const claude = existsSync(join(dir, "CLAUDE.md"));
  const agents = existsSync(join(dir, "AGENTS.md"));
  if (claude && agents) return { target: "claude", file: join(dir, "CLAUDE.md"), ambiguous: true };
  if (claude) return { target: "claude", file: join(dir, "CLAUDE.md"), ambiguous: false };
  if (agents) return { target: "agents", file: join(dir, "AGENTS.md"), ambiguous: false };
  return { target: null, file: null, ambiguous: false };
}

function renderBlock(blocks: string[]): string {
  return `${OPEN}\n<!-- Managed by AgentGem. Edit inside; the block is replaced on the next apply. -->\n\n${blocks.join("\n")}\n${CLOSE}`;
}

// Replace an existing managed block, else append one (with a leading blank line).
function upsert(current: string, blocks: string[]): string {
  const block = renderBlock(blocks);
  const start = current.indexOf(OPEN);
  if (start === -1) return current.replace(/\n*$/, "\n") + "\n" + block + "\n";
  const end = current.indexOf(CLOSE, start);
  const tail = end === -1 ? current.length : end + CLOSE.length;
  return current.slice(0, start) + block + current.slice(tail);
}

export function previewGuardrails(file: string, blocks: string[]): { current: string; next: string; hash: string } {
  const current = readOrEmpty(file);
  return { current, next: upsert(current, blocks), hash: sha(current) };
}

export function applyGuardrails(file: string, blocks: string[], expectHash: string):
  { ok: true; path: string; hash: string } | { ok: false; reason: "stale"; hash: string } {
  const current = readOrEmpty(file);
  const actual = sha(current);
  if (actual !== expectHash) return { ok: false, reason: "stale", hash: actual };
  const next = upsert(current, blocks);
  const tmp = join(dirname(file), `.${Date.now().toString(36)}.agentgem.tmp`);
  writeFileSync(tmp, next, "utf8");   // throws on real fs failure — observable by design
  renameSync(tmp, file);
  return { ok: true, path: file, hash: sha(next) };
}
