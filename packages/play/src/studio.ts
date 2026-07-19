// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The Chat studio seam: seed a miniapp dir from a source (scaffold + injected DATA), build the agent's
// studio brief from its meta, and guard which cwd a chat session may adopt. studioCwd is the security
// gate: only a path under the miniapps registry (or the neutral fallback) is ever honored.
import { join, sep, resolve, basename } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { type GameSource, type GameGenre, AUTO_CAPS } from "@agentgem/model";
import { deriveNeeds } from "./capabilityScan.js";
import { extractSource, type SourceReaders } from "./sourceContext.js";
import { genreFor } from "./genres.js";
import { scaffoldFor, minimalTemplate } from "./scaffolds.js";
import { miniappDir, miniappsRoot, claimMiniappDir, miniappHtmlPath, MINIAPP_HTML, type MiniappMeta } from "./miniapps.js";
import { ensureRepo, commitWithLock } from "./git.js";
import { redactForBake } from "./redact.js";
import { MINIAPP_BUILDER_BRIEF } from "./builderBrief.js";
import { writeUploads, type UploadFile } from "./uploads.js";

// Only allow a chat session to adopt a cwd that is inside the miniapps registry; otherwise the neutral
// fallback. The route resolves `miniapp` names via miniappDir (which rejects bad names) BEFORE this, so
// this is defense-in-depth against any raw path ever reaching conn.ctx.open().
export function studioCwd(requested: string | undefined, fallback: string): string {
  if (!requested) return fallback;
  // Normalize before the prefix compare so a path like `<root>/../../etc` can't slip through by merely
  // starting with the root string — this makes the "no raw path escapes" guarantee actually true.
  const norm = resolve(requested);
  const root = resolve(miniappsRoot());
  return norm === resolve(fallback) || norm.startsWith(root + sep) ? norm : fallback;
}

// Fold arbitrary text into a single clean path segment miniappDir() will accept as-is.
export function slugify(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 40);
  return slug || "miniapp"; // strip leading dots too, so a title like ".git" can't target a dotfile dir
}

// Derive a clean single-segment slug BASE for a new miniapp from its source. The base is not the final
// name: claimMiniappDir() suffixes it on collision, so "new miniapp" always yields a new miniapp even
// when the source (a session, a project folder, a title) has been used before.
function slugFor(source: GameSource): string {
  return slugify(
    source.kind === "session" ? `session-${source.sessionId}` :
    source.kind === "skill" ? source.skillName :
    source.kind === "html" || source.kind === "blank" ? source.title :
    (source.path.split(/[\\/]/).filter(Boolean).pop() ?? "project"),
  );
}

// Pick the dir for a new miniapp. `name` is what the user typed, if anything: it is slugified (so "My
// Duel" is accepted, not rejected) and then claimed EXACTLY — a collision is an error, not a silent
// rename. With no explicit name we fall back to the source-derived base, which suffixes on collision.
function claimFor(source: GameSource, name?: string): { name: string; dir: string } {
  const typed = name?.trim();
  return typed
    ? claimMiniappDir(slugify(typed), { exact: true })
    : claimMiniappDir(slugFor(source));
}

// Inject the source DATA as an inert JSON <script> the game reads. It goes in <head> so it's parsed
// BEFORE the scaffold's body script runs (otherwise getElementById("game-data") is null during parse).
function seedHtml(scaffold: string, data: unknown): string {
  const tag = `<script id="game-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  if (/<\/head>/i.test(scaffold)) return scaffold.replace(/<\/head>/i, `${tag}</head>`);
  return scaffold.replace("</body>", `${tag}</body>`); // fallback for a head-less scaffold
}

// The full authoring contract, injected on the agent's first turn only (chatSession.ts nulls the brief
// afterwards). The leading line names the file the agent must edit — new miniapps are index.html, older
// ones <name>.html — and everything below it is the shared contract, which also ships as
// skills/agentgem-miniapp/SKILL.md.
function studioInstructions(file: string): string {
  return `You are building the miniapp in ${file}.\n\n${MINIAPP_BUILDER_BRIEF}`;
}

// Names the author's seed dirs so the agent uses them on every build (durable — read from meta each
// session, not the one-shot seedPrompt). Ship assets inline from uploads/assets.json; ref/ is read-only.
function uploadsBrief(uploads: { ship: number; ref: number } | undefined): string {
  if (!uploads || (!uploads.ship && !uploads.ref)) return "";
  const parts: string[] = [];
  if (uploads.ship) parts.push(`${uploads.ship} ship file(s) in ./uploads/ — inline the ones this miniapp needs into index.html (ready-to-use data: URIs are in ./uploads/assets.json)`);
  if (uploads.ref) parts.push(`${uploads.ref} reference file(s) in ./ref/ — read them for context, but do NOT ship them`);
  return `\n\nThis project has author-supplied files: ${parts.join("; ")}.`;
}

// Write uploads into an already-claimed dir; if it throws (oversize/bad-base64 that slipped past the
// client mirror), remove the claimed-but-empty dir so the name is reusable instead of a 409 on retry.
function writeUploadsOrRelease(dir: string, files: UploadFile[] | undefined): { ship: number; ref: number } {
  try { return writeUploads(dir, files ?? []); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

export async function seedStudio(source: GameSource, readers: SourceReaders, name?: string, genre?: GameGenre): Promise<{ name: string; brief: string }> {
  const input = await extractSource(source, readers, genre);
  const g = genreFor(input.genre);
  await ensureRepo(miniappsRoot());                   // must exist before we can claim a dir inside it
  const { name: id, dir } = claimFor(source, name);
  // Bake a REDACTED, self-contained snapshot so the miniapp runs everywhere — offline and on
  // app.agentgem.ai, which has no capability broker. Broker-fed genres additionally keep their `needs`
  // (below) so a LOCAL host that pushes a ui/notifications/tool-result refresh can still upgrade the baked snapshot
  // to fresh/full data; the scaffold already renders from the baked <script id="game-data"> and
  // re-renders when that refresh arrives.
  writeFileSync(join(dir, MINIAPP_HTML), seedHtml(scaffoldFor(g.scaffold), redactForBake(input.data)));
  const meta: MiniappMeta = { title: id, genre: input.genre, createdFrom: input.createdFrom, engineVersion: "1", ...(g.needs ? { needs: g.needs } : {}) };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitWithLock(miniappsRoot(), `seed miniapp ${id}`);
  return { name: id, brief: `${input.brief}\n\n${studioInstructions(MINIAPP_HTML)}` };
}

// Import a miniapp from existing self-contained HTML. The HTML becomes the miniapp verbatim (a draft);
// NOT gated here — Save enforces the seal, so imperfect HTML can be brought in and fixed in the studio.
export async function importStudio(title: string, html: string, name?: string, files?: UploadFile[]): Promise<{ name: string; brief: string }> {
  const source: GameSource = { kind: "html", title };
  await ensureRepo(miniappsRoot());
  const { name: id, dir } = claimFor(source, name);
  const uploads = writeUploadsOrRelease(dir, files);
  writeFileSync(join(dir, MINIAPP_HTML), html);
  // Declare the capabilities the imported html already uses so it actually works before the first Save —
  // otherwise the Runner never wires the host and every capability call silently fails (an <a>-CTA that
  // openLinks does nothing). Import IS the authored act, so deriving needs from the code is a legitimate
  // initial declaration, NOT the silent widening saveMiniapp guards against. AUTO caps are excluded: they
  // bypass the consent prompt, so auto-declaring one (session-data) would let imported html read the
  // viewer's sessions with no gate — that stays an explicit Save. Gated caps keep their per-use prompt.
  const needs = deriveNeeds(html).filter((c) => !AUTO_CAPS.has(c));
  const meta: MiniappMeta = { title, genre: "project-fun", createdFrom: source, engineVersion: "1", ...(needs.length ? { needs } : {}), ...((uploads.ship || uploads.ref) ? { uploads } : {}) };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitWithLock(miniappsRoot(), `import miniapp ${id}`);
  return { name: id, brief: `You are refining "${title}", a self-contained HTML mini-game the user imported.${uploadsBrief(uploads)}\n\n${studioInstructions(MINIAPP_HTML)}` };
}

// Create a miniapp from scratch — no source context. Seeds a fresh blank sealed canvas titled with the
// user's title; the user then builds it by chatting in the studio. `prompt` is optional creative
// direction (NOT baked into the HTML — it just opens the studio brief).
export async function blankStudio(title: string, prompt?: string, name?: string, files?: UploadFile[]): Promise<{ name: string; brief: string }> {
  const source: GameSource = { kind: "blank", title };
  await ensureRepo(miniappsRoot());
  const { name: id, dir } = claimFor(source, name);
  const uploads = writeUploadsOrRelease(dir, files);
  writeFileSync(join(dir, MINIAPP_HTML), minimalTemplate(title, "✦ new"));
  const meta: MiniappMeta = { title, genre: "project-fun", createdFrom: source, engineVersion: "1", ...((uploads.ship || uploads.ref) ? { uploads } : {}) };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitWithLock(miniappsRoot(), `create miniapp ${id}`);
  const want = prompt?.trim()
    ? `The user wants to build: ${prompt.trim()}`
    : `Ask the user what kind of mini-game they want, then build it. If they don't say, make a small, delightful arcade game.`;
  return { name: id, brief: `You are building "${title}" from scratch — a self-contained HTML mini-game with no source data. ${want}${uploadsBrief(uploads)}\n\n${studioInstructions(MINIAPP_HTML)}` };
}

export function studioBrief(name: string): string {
  const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8")) as MiniappMeta;
  // Name the file that actually exists: a legacy miniapp is still <name>.html on disk.
  return `Continue building the "${meta.title}" miniapp (a ${meta.genre}).${uploadsBrief(meta.uploads)}\n\n${studioInstructions(basename(miniappHtmlPath(name)))}`;
}
