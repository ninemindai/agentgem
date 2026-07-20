// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubContents.ts
//
// Shared, thin GitHub Contents-API reader plus flat-scalar frontmatter helpers, used by the
// curated-source adapters (agencyAgents, skillsLayout). All network goes through an injected
// `Http` (the shape from registryTypes.ts) so directory walks and transforms stay unit-testable
// with a fake. Reads use the token-optional Contents API, so browsing public repos needs no
// credentials — a token only lifts the 60/hr unauthenticated rate limit.
import type { Http, GithubCfg } from "./registryTypes.js";

const API = "https://api.github.com";

export const defaultHttp: Http = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { status: res.status, text: () => res.text() };
};

function ghHeaders(cfg: GithubCfg): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "agentgem" };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}

export interface ContentsEntry { name: string; path: string; type: "file" | "dir" }
export interface ContentsFile { content: string; encoding: string }

// GET /repos/{repo}/contents/{path}?ref={ref}. A directory returns an array of entries; a file
// returns a single base64 node. Path segments are encoded but "/" is kept as a separator.
export async function ghContents(http: Http, cfg: GithubCfg, path: string): Promise<ContentsEntry[] | ContentsFile> {
  const p = encodeURIComponent(path).replace(/%2F/g, "/");
  const url = `${API}/repos/${cfg.repo}/contents/${p}?ref=${encodeURIComponent(cfg.ref)}`;
  const res = await http(url, { headers: ghHeaders(cfg) });
  const body = await res.text();
  if (res.status >= 300) throw new Error(`GitHub GET contents/${path} → ${res.status}: ${body}`);
  return JSON.parse(body) as ContentsEntry[] | ContentsFile;
}

export function decodeFile(node: ContentsFile): string {
  // Contents API base64 is chunked with newlines; Buffer tolerates them.
  return Buffer.from(node.content, node.encoding === "base64" ? "base64" : "utf8").toString("utf8");
}

// GET /repos/{repo}/git/trees/{ref}?recursive=1 — a flat listing of every blob/tree in the repo
// at that ref, in one call. Used by adapters (skillsLayout) that need to find every file
// matching a name convention (e.g. `SKILL.md`) rather than walk directories one at a time.
export async function ghTree(http: Http, cfg: GithubCfg): Promise<{ path: string; type: string }[]> {
  const url = `${API}/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.ref)}?recursive=1`;
  const res = await http(url, { headers: ghHeaders(cfg) });
  const body = await res.text();
  if (res.status >= 300) throw new Error(`GitHub GET git/trees/${cfg.ref} → ${res.status}: ${body}`);
  const parsed = JSON.parse(body) as { tree: { path: string; type: string }[] };
  return parsed.tree;
}

// ── flat-scalar frontmatter (these files use simple `key: value` frontmatter) ──────────────

// Split a leading `---\n…\n---` YAML block from the body. Returns the raw frontmatter text and
// everything after it. No frontmatter → empty fm, whole input as body.
export function splitFrontmatter(md: string): { fm: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: "", body: md };
  return { fm: m[1], body: md.slice(m[0].length) };
}

// Read a single scalar `key: value` from a frontmatter block. Strips matching surrounding quotes.
// Intentionally not a full YAML parser — these files are flat scalar frontmatter.
export function fmField(fm: string, key: string): string | undefined {
  // Escape the key: it's interpolated into a RegExp, so a metacharacter (all callers pass literals
  // today, but nothing enforces it) would otherwise be treated as a pattern, not matched literally.
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = fm.match(new RegExp(`^${k}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  if (!m) return undefined;
  let v = m[1].trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return v || undefined;
}
