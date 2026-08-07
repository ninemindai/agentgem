// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Import a conformant Agent Plugin 1.0.0 directory tree as a Gem. Plugin-level
// schema violations are fatal (InvalidInputError); component-level failures are
// isolated as SkippedArtifact, matching the spec's failure-handling table.
import type { FileTree, Gem, GemArtifact, McpServerArtifact, SkillArtifact, SkippedArtifact } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";
import { PLUGIN_SCHEMA_URI, MCP_SCHEMA_URI } from "./archive.js";

const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const KNOWN_MANIFEST_FIELDS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);

export interface AgentPluginImport { gem: Gem; skipped: SkippedArtifact[]; notes: string[] }

export function readAgentPlugin(files: FileTree): AgentPluginImport {
  const raw = files["plugin.json"];
  if (raw === undefined) throw new InvalidInputError("not an Agent Plugin: plugin.json is missing");
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(raw) as Record<string, unknown>; } catch { throw new InvalidInputError("plugin.json is not valid JSON"); }
  if (manifest.$schema !== PLUGIN_SCHEMA_URI) throw new InvalidInputError(`unsupported plugin.json $schema '${String(manifest.$schema)}'`);
  const name = manifest.name;
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("--") || name.includes("..")) {
    throw new InvalidInputError(`invalid Agent Plugin name '${String(name)}'`);
  }
  const notes: string[] = [];
  for (const k of Object.keys(manifest)) if (!KNOWN_MANIFEST_FIELDS.has(k)) notes.push(`plugin.json: unknown field '${k}' ignored`);

  const skipped: SkippedArtifact[] = [];
  const artifacts: GemArtifact[] = [];

  // Skills: immediate children of skills/ that contain SKILL.md; no recursion.
  const skillDirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m) skillDirs.add(m[1]);
  }
  for (const dir of [...skillDirs].sort()) {
    const a: SkillArtifact = { type: "skill", name: dir, source: "agent-plugin", content: files[`skills/${dir}/SKILL.md`] };
    const siblings = Object.keys(files)
      .filter((p) => p.startsWith(`skills/${dir}/`) && p !== `skills/${dir}/SKILL.md`)
      .sort();
    // Defense in depth: a hostile tree can carry traversal-shaped keys. The archive
    // writer guards again on the next write, but the in-memory Gem must never hold them.
    const safe: { path: string; content: string }[] = [];
    for (const p of siblings) {
      const rel = p.slice(`skills/${dir}/`.length);
      if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
        skipped.push({ artifact: `${dir}:${rel}`, type: "skill", reason: "unsafe skill file path in plugin" });
        continue;
      }
      safe.push({ path: rel, content: files[p] });
    }
    if (safe.length > 0) a.files = safe;
    artifacts.push(a);
  }

  // MCP servers: optional mcp.json; a version mismatch invalidates only this component.
  const mcpRaw = files["mcp.json"];
  if (mcpRaw !== undefined) {
    type McpDoc = { $schema?: unknown; mcpServers?: Record<string, Record<string, unknown>> };
    let doc: McpDoc | null = null;
    try { doc = JSON.parse(mcpRaw) as McpDoc; } catch { notes.push("mcp.json: invalid JSON — component skipped"); }
    if (doc !== null && doc.$schema !== MCP_SCHEMA_URI) { notes.push(`mcp.json: unsupported $schema — component skipped`); doc = null; }
    for (const [key, s] of Object.entries(doc?.mcpServers ?? {})) {
      const a = importServer(key, s);
      if (typeof a === "string") skipped.push({ artifact: key, type: "mcp_server", reason: a });
      else artifacts.push(a);
    }
  }

  const version = typeof manifest.version === "string" ? ` v${manifest.version}` : "";
  const gem: Gem = { name, createdFrom: `Imported from Agent Plugin '${name}'${version}`, artifacts, checks: [], requiredSecrets: [] };
  return { gem, skipped, notes };
}

function importServer(key: string, s: Record<string, unknown>): McpServerArtifact | string {
  const pick = (keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
    return out;
  };
  if (s.type === "stdio") {
    if (typeof s.command !== "string" || s.command === "") return "stdio server has no command";
    return { type: "mcp_server", name: key, transport: "stdio", config: pick(["command", "args", "env", "cwd"]) };
  }
  if (s.type === "streamable-http" || s.type === "sse") {
    if (typeof s.url !== "string") return `${s.type} server has no url`;
    return { type: "mcp_server", name: key, transport: s.type === "sse" ? "sse" : "http", config: pick(["url", "headers"]) };
  }
  return `unsupported transport '${String(s.type)}'`;
}
