// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The Chat studio seam: seed a miniapp dir from a source (scaffold + injected DATA), build the agent's
// studio brief from its meta, and guard which cwd a chat session may adopt. studioCwd is the security
// gate: only a path under the miniapps registry (or the neutral fallback) is ever honored.
import { join, sep, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { GameSource } from "@agentgem/model";
import { extractSource, type SourceReaders } from "./sourceContext.js";
import { genreFor } from "./genres.js";
import { scaffoldFor } from "./scaffolds.js";
import { miniappDir, miniappsRoot, type MiniappMeta } from "./miniapps.js";
import { ensureRepo, commitAll } from "./git.js";

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

// Derive a clean single-segment slug for a new miniapp from its source.
function slugFor(source: GameSource): string {
  const raw =
    source.kind === "session" ? `session-${source.sessionId}` :
    source.kind === "skill" ? source.skillName :
    source.kind === "html" ? source.title :
    (source.path.split(/[\\/]/).filter(Boolean).pop() ?? "project");
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 40);
  return slug || "miniapp"; // strip leading dots too, so a title like ".git" can't target a dotfile dir
}

// Inject the source DATA as an inert JSON <script> the game reads. It goes in <head> so it's parsed
// BEFORE the scaffold's body script runs (otherwise getElementById("game-data") is null during parse).
function seedHtml(scaffold: string, data: unknown): string {
  const tag = `<script id="game-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  if (/<\/head>/i.test(scaffold)) return scaffold.replace(/<\/head>/i, `${tag}</head>`);
  return scaffold.replace("</body>", `${tag}</body>`); // fallback for a head-less scaffold
}

function studioInstructions(name: string): string {
  return (
    `You are building the miniapp in ${name}.html (edit ONLY that file). It must stay a single ` +
    `self-contained, SEALED HTML file: inline all JS/CSS, use only data: URIs, and make NO network calls ` +
    `(no fetch/XHR/WebSocket/external src/href/import). Replace the block between the ` +
    `"AGENTGEM:GAME-LOGIC" markers. Read the JSON in <script id="game-data"> for the source content. ` +
    `The file must run without throwing on load.`
  );
}

export async function seedStudio(source: GameSource, readers: SourceReaders): Promise<{ name: string; brief: string }> {
  const input = await extractSource(source, readers);
  const name = slugFor(source);
  const dir = miniappDir(name);                       // validates the slug + jails the path
  const g = genreFor(input.genre);
  await ensureRepo(miniappsRoot());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), seedHtml(scaffoldFor(g.scaffold), input.data));
  const meta: MiniappMeta = { title: name, genre: input.genre, createdFrom: input.createdFrom, engineVersion: "1" };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitAll(miniappsRoot(), `seed miniapp ${name}`);
  return { name, brief: `${input.brief}\n\n${studioInstructions(name)}` };
}

// Import a miniapp from existing self-contained HTML. The HTML becomes the miniapp verbatim (a draft);
// NOT gated here — Save enforces the seal, so imperfect HTML can be brought in and fixed in the studio.
export async function importStudio(title: string, html: string): Promise<{ name: string; brief: string }> {
  const source: GameSource = { kind: "html", title };
  const name = slugFor(source);
  const dir = miniappDir(name); // validates the slug + jails the path
  await ensureRepo(miniappsRoot());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), html);
  const meta: MiniappMeta = { title, genre: "project-fun", createdFrom: source, engineVersion: "1" };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitAll(miniappsRoot(), `import miniapp ${name}`);
  return { name, brief: `You are refining "${title}", a self-contained HTML mini-game the user imported.\n\n${studioInstructions(name)}` };
}

export function studioBrief(name: string): string {
  const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8")) as MiniappMeta;
  return `Continue building the "${meta.title}" miniapp (a ${meta.genre}).\n\n${studioInstructions(name)}`;
}
