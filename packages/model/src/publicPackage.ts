// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Shared classifier: is an MCP stdio server a PUBLIC npm package (→ store as a package
// reference) or something local/private (→ embed with secrets redacted)? Hoisted from the
// Cline reader so every source adapter (Cline, Gemini, future Cursor) shares one security-
// relevant rule. Scoped packages default to private unless the scope is allowlisted.
import type { GemArtifact } from "./types.js";

export const PUBLIC_SCOPES = new Set(["@modelcontextprotocol"]);

/** First non-flag arg is the package spec (skips `-y` etc). */
export function firstPackage(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (const a of args) { if (typeof a === "string" && !a.startsWith("-")) return a; }
  return null;
}

export function isPublicNpm(pkg: string): boolean {
  if (pkg.startsWith("/") || pkg.startsWith(".")) return false; // filesystem path
  if (pkg.startsWith("@")) return PUBLIC_SCOPES.has(pkg.split("/")[0]);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(pkg);
}

/** Classify one MCP server (from any agent's config) into a public-package ReferenceArtifact
 *  or a secret-redacted McpServerArtifact. Redaction = allowlist copy of command/args or url;
 *  env/apiKey/headers/requestOptions are never copied. `httpUrl` is an alias some agents (e.g.
 *  Gemini CLI) use instead of `url`. */
export function classifyMcpServer(name: string, cfg: { command?: string; args?: unknown; url?: string; httpUrl?: string }): GemArtifact {
  const pkg = firstPackage(cfg.args);
  if (cfg.command === "npx" && pkg && isPublicNpm(pkg)) {
    return { type: "reference", name, refKind: "mcp_server", ref: { kind: "package", id: `npx:${pkg}` } };
  }
  const url = cfg.url ?? cfg.httpUrl;
  return { type: "mcp_server", name, transport: url ? "http" : "stdio", config: url ? { url } : { command: cfg.command, args: cfg.args } };
}
