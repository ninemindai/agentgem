// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The miniapps registry: ~/.agentgem/miniapps/ is a git repo; each miniapp is <name>/<name>.html +
// <name>/meta.json. saveMiniapp gates the bundle, writes it, git-commits, AND dual-writes a one-artifact
// `game` gem via createWorkspace so a miniapp is both a shareable HTML file and a marketplace gem.
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { safePathSegment } from "@agentgem/model";
import type { Gem, GameArtifact, GameGenre, GameSource, GameCapability } from "@agentgem/model";
import { workspaceDir } from "@agentgem/base";
import { writeGemArchive, writeArchiveDir } from "@agentgem/archive";
import { gameGate } from "./gameGate.js";
import { assertPortable } from "./portability.js";
import { ensureRepo, commitAll } from "./git.js";

export interface MiniappMeta {
  title: string; genre: GameGenre; createdFrom: GameSource; engineVersion: string; needs?: GameCapability[];
}
export interface SaveMiniappInput { name: string; html: string; meta: MiniappMeta }

export function miniappsRoot(): string {
  // SAME convention as workspacesRoot(): AGENTGEM_HOME is already the ~/.agentgem dir.
  return join(process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem"), "miniapps");
}

export function miniappDir(name: string): string {
  // safePathSegment SANITIZES (never throws): "../escape" -> ".._escape", "." -> "unnamed". We want a
  // clear rejection of a bad name, not a silently-mangled one — so require the name to already be clean.
  if (safePathSegment(name) !== name) throw new Error(`invalid miniapp name '${name}' (use letters, digits, . _ -)`);
  const dir = join(miniappsRoot(), name);
  if (!dir.startsWith(miniappsRoot() + sep)) throw new Error("miniapp dir escaped the registry root");
  return dir;
}

export async function saveMiniapp(input: SaveMiniappInput): Promise<{ name: string; commit: string | null }> {
  const dir = miniappDir(input.name);             // validates the name (throws on bad) + jails the path
  const safe = input.name;
  const gate = await gameGate(input.html);
  if (!gate.ok) throw new Error(`miniapp failed the gate: ${gate.failures.join("; ")}`);
  const port = assertPortable(input.html, input.meta.needs);
  if (!port.ok) throw new Error(`miniapp is not portable: ${port.failures.join("; ")}`);
  const root = miniappsRoot();
  await ensureRepo(root);                          // the registry is a git repo
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe}.html`), input.html);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(input.meta, null, 2));
  const commit = await commitAll(root, `save miniapp ${safe}`);

  // dual-write the matching game gem (marketplace-capable), UPSERTING so a re-save stays in sync with
  // the registry file. Writing the archive in place (create or overwrite) avoids createWorkspace's
  // throw-if-exists; errors propagate rather than being swallowed.
  const artifact: GameArtifact = {
    type: "game", name: safe, title: input.meta.title, genre: input.meta.genre,
    html: input.html, createdFrom: input.meta.createdFrom, engineVersion: input.meta.engineVersion,
    ...(input.meta.needs ? { needs: input.meta.needs } : {}),
  };
  const gem: Gem = { name: safe, createdFrom: "play", artifacts: [artifact], checks: [], requiredSecrets: [] };
  const wdir = workspaceDir(safe);
  mkdirSync(wdir, { recursive: true });
  writeArchiveDir(wdir, writeGemArchive(gem).files);

  return { name: safe, commit };
}

export function readMiniapp(name: string): { name: string; html: string; meta: MiniappMeta } {
  const dir = miniappDir(name); // validates + jails
  const html = readFileSync(join(dir, `${name}.html`), "utf8");
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as MiniappMeta;
  return { name, html, meta };
}

export function listMiniapps(): { name: string; meta: MiniappMeta }[] {
  const root = miniappsRoot();
  if (!existsSync(root)) return [];
  const out: { name: string; meta: MiniappMeta }[] = [];
  for (const name of readdirSync(root)) {
    if (name === ".git") continue;
    const metaPath = join(root, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try { out.push({ name, meta: JSON.parse(readFileSync(metaPath, "utf8")) as MiniappMeta }); } catch { /* skip malformed */ }
  }
  return out;
}
