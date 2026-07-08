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
import { ensureRepo, commitWithLock } from "./git.js";
import { migrateMiniappHtml, type MigrateOutcome } from "./migrate.js";

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

// Write (create-or-overwrite) the marketplace game-gem for a miniapp. Shared by saveMiniapp (strict,
// after a throwing gate) and checkpointMiniapp (opportunistic, only when sealed). UPSERT: overwrites in
// place, never deletes — so a re-save/re-checkpoint stays in sync, and a skipped write keeps the prior gem.
function writeGameGem(name: string, html: string, meta: MiniappMeta): void {
  const artifact: GameArtifact = {
    type: "game", name, title: meta.title, genre: meta.genre,
    html, createdFrom: meta.createdFrom, engineVersion: meta.engineVersion,
    ...(meta.needs ? { needs: meta.needs } : {}),
  };
  const gem: Gem = { name, createdFrom: "play", artifacts: [artifact], checks: [], requiredSecrets: [] };
  const wdir = workspaceDir(name);
  mkdirSync(wdir, { recursive: true });
  writeArchiveDir(wdir, writeGemArchive(gem).files);
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
  const commit = await commitWithLock(root, `save miniapp ${safe}`);
  writeGameGem(safe, input.html, input.meta);      // strict path: gate already passed above
  return { name: safe, commit };
}

// Auto-checkpoint: persist the CURRENT on-disk miniapp WITHOUT gating (durability for in-progress agent
// work), then opportunistically refresh the marketplace gem IFF the bundle is sealed. A gate failure never
// blocks the commit and is never thrown — the gem simply isn't rewritten, preserving the last sealed build.
export async function checkpointMiniapp(name: string): Promise<{ name: string; commit: string | null }> {
  const { html, meta } = readMiniapp(name);        // validates the name + jails; meta.json exists post seed/import
  const root = miniappsRoot();
  await ensureRepo(root);
  const commit = await commitWithLock(root, `checkpoint ${name}`);
  try { if ((await gameGate(html)).ok) writeGameGem(name, html, meta); }
  catch { /* gate/gem is best-effort — a checkpoint must never fail on it */ }
  return { name, commit };
}

// The RAW stored bytes, with NO migration backstop applied. `migrateAllMiniapps()` needs this — it must
// see the true on-disk html to decide whether a rewrite is needed; reading through the backstopped
// `readMiniapp()` would always look already-migrated and the stored file would never get rewritten.
function readMiniappRaw(name: string): { name: string; html: string; meta: MiniappMeta } {
  const dir = miniappDir(name); // validates + jails
  const html = readFileSync(join(dir, `${name}.html`), "utf8");
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as MiniappMeta;
  return { name, html, meta };
}

export function readMiniapp(name: string): { name: string; html: string; meta: MiniappMeta } {
  const r = readMiniappRaw(name);
  // On-read migration backstop: the player always gets migrated html, even if the stored file hasn't
  // been rewritten yet by migrateAllMiniapps()/the /play/migrate route. Idempotent — a no-op on html
  // that's already current. The stored file itself is unchanged here.
  return { ...r, html: migrateMiniappHtml(r.html).html };
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

// Rewrites every stored miniapp's html to the current MCP Apps client shim, one codemod pass over the
// whole registry. This is an OPTIMIZATION, not a correctness prerequisite — readMiniapp()'s on-read
// backstop already serves migrated html regardless. Reads the RAW stored file (never readMiniapp) so
// it sees the true on-disk bytes; otherwise the backstop would make a raw miniapp look already-migrated
// and its file would never actually get rewritten.
export async function migrateAllMiniapps(): Promise<{ name: string; outcome: MigrateOutcome; commit: string | null }[]> {
  const results: { name: string; outcome: MigrateOutcome; commit: string | null }[] = [];
  for (const { name } of listMiniapps()) {
    const raw = readMiniappRaw(name);
    const { html, outcome } = migrateMiniappHtml(raw.html);
    if (outcome !== "migrated") { results.push({ name, outcome, commit: null }); continue; }
    const meta: MiniappMeta = {
      ...raw.meta,
      engineVersion: `${raw.meta.engineVersion}+mcp`,
    };
    const { commit } = await saveMiniapp({ name, html, meta });
    results.push({ name, outcome, commit });
  }
  return results;
}
