// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The miniapps registry: ~/.agentgem/miniapps/ is a git repo; each miniapp is <name>/<name>.html +
// <name>/meta.json. saveMiniapp gates the bundle, writes it, git-commits, AND dual-writes a one-artifact
// `game` gem via createWorkspace so a miniapp is both a shareable HTML file and a marketplace gem.
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { safePathSegment, CAP_TOOL, CAP_METHOD } from "@agentgem/model";
import type { Gem, GameArtifact, GameGenre, GameSource, GameCapability, McpNeed } from "@agentgem/model";
import { workspaceDir } from "@agentgem/base";
import { writeGemArchive, writeArchiveDir } from "@agentgem/archive";
import { gameGate } from "./gameGate.js";
import { assertPortable } from "./portability.js";
import { ensureRepo, commitWithLock } from "./git.js";
import { migrateMiniappHtml, ensureClientShim, type MigrateOutcome } from "./migrate.js";
import { MCP_CLIENT_MARKER } from "./mcpAppClient.js";
import { reconcileNeeds, deriveNeeds, hasDynamicToolCall, deriveMcpNeeds, mergeMcpNeeds, mcpUsageWarnings } from "./capabilityScan.js";

export interface MiniappMeta {
  title: string; genre: GameGenre; createdFrom: GameSource; engineVersion: string; needs?: GameCapability[];
  mcpNeeds?: McpNeed[];   // declared-authoritative (D10) — merged with derived literals at save, never pruned
}
export interface SaveMiniappInput { name: string; html: string; meta: MiniappMeta }
export interface SaveMiniappResult { name: string; commit: string | null; prunedNeeds: GameCapability[]; mcpWarnings: string[] }

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

// A miniapp's bundle filename. New miniapps store it as `index.html`, so the file no longer has to be
// renamed alongside the id (and `duel-2.html` never has to exist). Miniapps created before that store
// `<name>.html` and KEEP it: writing index.html beside an existing <name>.html would leave two bundles in
// one dir, and the gate/portability checks would only ever see one of them. Reads AND writes go through
// here, so a legacy miniapp keeps its filename for life and a new one is index.html from birth.
export const MINIAPP_HTML = "index.html";
export function miniappHtmlPath(name: string): string {
  const dir = miniappDir(name);                   // validates the name + jails the path
  const legacy = join(dir, `${name}.html`);
  const current = join(dir, MINIAPP_HTML);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

// Claim a FRESH dir for a newly-created miniapp. Only the create paths (seed/import/blank) call this —
// opening an existing miniapp to edit it keeps its name, so saveMiniapp still upserts in place.
//
// The non-recursive mkdirSync IS the claim: it throws EEXIST when the name is taken, which makes the
// check-and-take a single atomic syscall. An existsSync() test would leave a window in which two
// concurrent creates both see "free" and pick the same name, and the second would clobber the first.
//
// A DERIVED name (from a session id, folder, or title) suffixes on collision: `duel`, `duel-2`, `duel-3`.
// A name the user typed is honored exactly or rejected — quietly handing back `duel-2` when they asked
// for `duel` is worse than failing.
export function claimMiniappDir(base: string, opts: { exact?: boolean } = {}): { name: string; dir: string } {
  if (opts.exact) {
    const dir = miniappDir(base);
    try { mkdirSync(dir); return { name: base, dir }; }
    catch (e) {
      // Stable prefix: play.controller.ts keys the 409-vs-400 split off it.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`miniapp already exists: '${base}'`);
      throw e;
    }
  }
  for (let n = 1; n <= 999; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const dir = miniappDir(name);                 // validates the (suffixed) name + jails the path
    try { mkdirSync(dir); return { name, dir }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  throw new Error(`too many miniapps named '${base}'`);
}

// Write (create-or-overwrite) the marketplace game-gem for a miniapp. Shared by saveMiniapp (strict,
// after a throwing gate) and checkpointMiniapp (opportunistic, only when sealed). UPSERT: overwrites in
// place, never deletes — so a re-save/re-checkpoint stays in sync, and a skipped write keeps the prior gem.
function writeGameGem(name: string, html: string, meta: MiniappMeta): void {
  const artifact: GameArtifact = {
    type: "game", name, title: meta.title, genre: meta.genre,
    html, createdFrom: meta.createdFrom, engineVersion: meta.engineVersion,
    ...(meta.needs ? { needs: meta.needs } : {}),
    ...(meta.mcpNeeds ? { mcpNeeds: meta.mcpNeeds } : {}),
  };
  const gem: Gem = { name, createdFrom: "play", artifacts: [artifact], checks: [], requiredSecrets: [] };
  const wdir = workspaceDir(name);
  mkdirSync(wdir, { recursive: true });
  writeArchiveDir(wdir, writeGemArchive(gem).files);
}

export async function saveMiniapp(input: SaveMiniappInput): Promise<SaveMiniappResult> {
  const dir = miniappDir(input.name);             // validates the name (throws on bad) + jails the path
  const safe = input.name;

  // A stored bundle must carry its TRANSPORT. Every scaffold ships the shim now, but the studio agent
  // regenerates the document wholesale and drops whatever <head> held — so html that calls
  // `window.agentgemApp` still arrives here with nothing that defines it. Normalize before anything reads
  // the bytes, so the gate, the scan, the stored file and the dual-written gem all see the same document
  // the player will run.
  //
  // ensureClientShim, NOT migrateMiniappHtml: the full codemod also rewrites the old bridge, and that
  // path INJECTS a `callTool("agentgem_get_session_data")` — a capability the caller never declared.
  // Widening a grant must stay an authored act, so the save path only ever adds transport. Migrating old
  // html is migrateAllMiniapps's job, where the derived declaration is written alongside it.
  const html = ensureClientShim(input.html);

  const gate = await gameGate(html);
  if (!gate.ok) throw new Error(`miniapp failed the gate: ${gate.failures.join("; ")}`);

  // The reconciler below reads the SOURCE, so a tool name it cannot see is a capability it prunes — and
  // the call then fails in a viewer's browser with -32601. MINIAPP_BUILDER_BRIEF requires literal names;
  // enforce it here, where the failure is actionable, instead of leaving it to blow up at play time.
  if (hasDynamicToolCall(html)) {
    throw new Error(`miniapp passes a non-literal tool name to callTool(...) — pass the name as a literal string, e.g. callTool("${CAP_TOOL["local-project-access"]}")`);
  }

  // Reconcile the DECLARATION against the CODE. The two drift directions are not symmetric: calling an
  // undeclared tool WIDENS what the app reaches, so it must be a deliberate authored act (throw, and let
  // the agent self-repair from the failure string, exactly as it does for a gate failure). Declaring a
  // tool nothing calls NARROWS to nothing — always safe — so prune it, but never silently. This runs
  // BEFORE assertPortable so a pruned phantom `session-data` no longer demands a baked fallback.
  const rec = reconcileNeeds(html, input.meta.needs);
  if (rec.missing.length) {
    const detail = rec.missing.map((c) => {
      const via = (CAP_TOOL as Record<string, string>)[c] ?? `agentgemApp.${(CAP_METHOD as Record<string, string>)[c]}`;
      return `${via} (declare "${c}")`;
    }).join("; ");
    throw new Error(`miniapp uses a capability it does not declare: ${detail} — add it to meta.json "needs"`);
  }
  const meta: MiniappMeta = { ...input.meta };
  if (rec.needs.length) meta.needs = rec.needs; else delete meta.needs;

  // MCP connectors are the OTHER reconciliation policy (spec D10): declared-authoritative. The
  // scan auto-fills literal calls (a convenience, mirroring how a claude.ai artifact's manifest is
  // authored), warnings surface what it cannot verify, and nothing is ever pruned or blocked —
  // the /api/play/mcp/call manifest check is the boundary that actually holds.
  const mcpNeeds = mergeMcpNeeds(input.meta.mcpNeeds, deriveMcpNeeds(html));
  const mcpWarnings = mcpUsageWarnings(html, input.meta.mcpNeeds);
  if (mcpNeeds.length) meta.mcpNeeds = mcpNeeds; else delete meta.mcpNeeds;

  // `needs` is what the HOST grants: the Runner only attaches a host when it is non-empty, and answers
  // ui/initialize with the tool list it selects. So a bundle that declares needs and carries no shim is
  // one the host talks to and that cannot answer — it degrades in silence to its baked data. The
  // normalization above makes this unreachable for any bundle that names `window.agentgemApp`; what is
  // left is the bundle that trips deriveNeeds on a bare tool-name string without ever holding a bridge
  // reference. That would store an over-granting miniapp, so fail loudly rather than ship it mute.
  // A connector app with no bridge is just as unreachable, so mcpNeeds widens the same check.
  if ((meta.needs?.length || meta.mcpNeeds?.length) && !html.includes(MCP_CLIENT_MARKER)) {
    const declared = [...(meta.needs ?? []), ...(meta.mcpNeeds ?? []).map((n) => `mcp:${n.server}`)];
    throw new Error(`miniapp declares capabilities (${declared.join(", ")}) but never references window.agentgemApp — it cannot reach the host`);
  }

  const port = assertPortable(html, meta.needs);
  if (!port.ok) throw new Error(`miniapp is not portable: ${port.failures.join("; ")}`);
  const root = miniappsRoot();
  await ensureRepo(root);                          // the registry is a git repo
  mkdirSync(dir, { recursive: true });
  writeFileSync(miniappHtmlPath(safe), html);      // legacy miniapps keep <name>.html; new ones index.html
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  const note = rec.pruned.length ? ` (pruned unused capability: ${rec.pruned.join(", ")})` : "";
  const commit = await commitWithLock(root, `save miniapp ${safe}${note}`);
  writeGameGem(safe, html, meta);                  // the PRUNED meta — a phantom cap must not reach the gem
  return { name: safe, commit, prunedNeeds: rec.pruned, mcpWarnings };
}

// Remove the dual-written game gem — but ONLY the one WE wrote. workspaceDir() is a shared, name-keyed
// namespace, so a gem authored by another producer can sit at the very same path, and unlike the
// registry it is NOT under git, so a wrong delete is unrecoverable. `createdFrom: "play"` in the
// manifest is the proof of authorship; anything foreign, missing, or unreadable is left untouched.
function deletePlayGem(name: string): void {
  const wdir = workspaceDir(name);
  try {
    const m = JSON.parse(readFileSync(join(wdir, "gem.json"), "utf8")) as { name?: string; createdFrom?: string };
    if (m.createdFrom !== "play" || m.name !== name) return;
  } catch { return; }
  rmSync(wdir, { recursive: true, force: true });
}

export async function deleteMiniapp(name: string): Promise<{ name: string; commit: string | null }> {
  const dir = miniappDir(name);                    // validates the name (throws on bad) + jails the path
  // Stable prefix: play.controller.ts keys the 404-vs-400 split off it, the way chatRoutes.ts keys off
  // miniappDir's "invalid miniapp name".
  if (!existsSync(dir)) throw new Error(`miniapp not found: '${name}'`);
  const root = miniappsRoot();
  await ensureRepo(root);
  rmSync(dir, { recursive: true, force: true });
  // Commit AFTER the rm: commitAll's `git add -A` stages the deletion, so the removed miniapp stays
  // recoverable from history. This is the only reason a delete is safe to offer without a hard confirm.
  const commit = await commitWithLock(root, `delete miniapp ${name}`);
  deletePlayGem(name);
  return { name, commit };
}

// Auto-checkpoint: persist the CURRENT on-disk miniapp WITHOUT gating (durability for in-progress agent
// work), then opportunistically refresh the marketplace gem IFF the bundle is sealed. A gate failure never
// blocks the commit and is never thrown — the gem simply isn't rewritten, preserving the last sealed build.
export async function checkpointMiniapp(name: string): Promise<{ name: string; commit: string | null }> {
  const { html, meta } = readMiniapp(name);        // validates the name + jails; meta.json exists post seed/import
  const root = miniappsRoot();
  await ensureRepo(root);
  const commit = await commitWithLock(root, `checkpoint ${name}`);
  // `html` is a snapshot taken above, and gameGate awaits — so a deleteMiniapp can land in between and
  // this write would RESURRECT the gem it just removed (the workspace is not under git: unrecoverable).
  // Re-check the registry dir immediately before writing; existsSync and writeGameGem are both sync, so
  // nothing can delete between them.
  try { if ((await gameGate(html)).ok && existsSync(miniappDir(name))) writeGameGem(name, html, meta); }
  catch { /* gate/gem is best-effort — a checkpoint must never fail on it */ }
  return { name, commit };
}

// The RAW stored bytes, with NO migration backstop applied. `migrateAllMiniapps()` needs this — it must
// see the true on-disk html to decide whether a rewrite is needed; reading through the backstopped
// `readMiniapp()` would always look already-migrated and the stored file would never get rewritten.
function readMiniappRaw(name: string): { name: string; html: string; meta: MiniappMeta } {
  const dir = miniappDir(name); // validates + jails
  const html = readFileSync(miniappHtmlPath(name), "utf8");  // index.html, else the legacy <name>.html
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
// whole registry, AND reconciles every miniapp's declaration against its code. This is an OPTIMIZATION
// for the html — readMiniapp()'s on-read backstop already serves migrated html regardless — but the
// meta reconciliation is a real repair: a stale `needs` makes the Runner prompt a viewer for consent to
// a capability the bundle never exercises. Reads the RAW stored file (never readMiniapp) so it sees the
// true on-disk bytes; otherwise the backstop would make a raw miniapp look already-migrated and its
// file would never actually get rewritten.
//
// A miniapp that cannot be saved (e.g. it declares a content capability but bakes no fallback) is
// RECORDED and skipped, never thrown: one bad entry must not abort the registry-wide pass.
export async function migrateAllMiniapps(): Promise<{ name: string; outcome: MigrateOutcome; commit: string | null; error?: string }[]> {
  const results: { name: string; outcome: MigrateOutcome; commit: string | null; error?: string }[] = [];
  const root = miniappsRoot();
  for (const { name } of listMiniapps()) {
    const raw = readMiniappRaw(name);
    const { html, outcome } = migrateMiniappHtml(raw.html);

    if (outcome !== "migrated") {
      // The html is current, but the DECLARATION can still be stale. Prune what the code never uses.
      // `missing` cannot be repaired here (widening is an authored act) — record it and move on.
      const rec = reconcileNeeds(raw.html, raw.meta.needs);
      if (rec.missing.length) {
        results.push({ name, outcome, commit: null, error: `calls undeclared ${rec.missing.join(", ")}` });
        continue;
      }
      if (!rec.pruned.length) { results.push({ name, outcome, commit: null }); continue; }
      const meta: MiniappMeta = { ...raw.meta };
      if (rec.needs.length) meta.needs = rec.needs; else delete meta.needs;
      // Same contract as the migrated path below: one miniapp that cannot be repaired — a read-only
      // meta.json, a git failure — is RECORDED and skipped, never thrown. A registry-wide pass must not
      // die on one bad entry.
      try {
        await ensureRepo(root);
        writeFileSync(join(miniappDir(name), "meta.json"), JSON.stringify(meta, null, 2));
        // Keep the shareable gem in step, or it keeps the phantom capability. Best-effort, like a
        // checkpoint: a gate failure must never abort the pass.
        try { if ((await gameGate(raw.html)).ok) writeGameGem(name, raw.html, meta); } catch { /* best-effort */ }
        const commit = await commitWithLock(root, `reconcile ${name} (pruned unused capability: ${rec.pruned.join(", ")})`);
        results.push({ name, outcome, commit });
      } catch (e) {
        results.push({ name, outcome, commit: null, error: (e as Error).message });
      }
      continue;
    }

    const meta: MiniappMeta = {
      ...raw.meta,
      engineVersion: `${raw.meta.engineVersion}+mcp`,
      // On the old-bridge rewrite the codemod INJECTS `callTool("agentgem_get_session_data")`, so the
      // bundle now uses a capability the stored meta may not declare — and saveMiniapp rightly throws on
      // a called-but-undeclared tool. The codemod authored the code, so it authors the declaration. Safe
      // ONLY because the sole capability it ever injects is `session-data`, which is auto-approved
      // (AUTO_CAPS); a codemod that injects a consent-gated capability must NOT auto-declare it. The
      // shim-injection path adds TRANSPORT and no capability at all, so deriveNeeds simply re-reads the
      // calls the bundle already made — it cannot widen a grant here either.
      needs: deriveNeeds(html),
    };
    try {
      const { commit } = await saveMiniapp({ name, html, meta });
      results.push({ name, outcome, commit });
    } catch (e) {
      results.push({ name, outcome, commit: null, error: (e as Error).message });
    }
  }
  return results;
}
