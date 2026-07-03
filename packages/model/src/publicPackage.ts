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

// A query string or fragment on an MCP url commonly carries an API key/token (?api_key=...,
// #access_token=...); strip everything but origin+pathname. Args are redacted per-element: a
// `--flag secret` pair (flag name mentions key/token/secret/password) redacts the VALUE, and a
// `flag=secret` single arg redacts the value half in place.
const SECRET_ARG_RE = /(key|token|secret|password|bearer)[=:]/i;
const SECRET_FLAG_RE = /^--?[\w-]*(key|token|secret|password)[\w-]*$/i;

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }              // not a real URL — keep as-is rather than mangle it
}

function redactArgs(args: unknown): unknown {
  if (!Array.isArray(args)) return args;
  return args.map((a, i) => {
    if (typeof a !== "string") return a;
    if (SECRET_ARG_RE.test(a)) return a.includes("=") ? `${a.slice(0, a.indexOf("=") + 1)}<redacted>` : "<redacted>";
    if (i > 0 && typeof args[i - 1] === "string" && SECRET_FLAG_RE.test(args[i - 1] as string)) return "<redacted>";
    return a;
  });
}

/** Classify one MCP server (from any agent's config) into a public-package ReferenceArtifact
 *  or a secret-redacted McpServerArtifact. Redaction = allowlist copy of command/args or url —
 *  env/apiKey/headers/requestOptions are never copied, url query/credentials/hash are stripped
 *  down to origin+pathname, and args that look secret-bearing (by flag name or `key=value` shape)
 *  are replaced with "<redacted>". `httpUrl` is an alias some agents (e.g. Gemini CLI) use instead
 *  of `url`. */
export function classifyMcpServer(name: string, cfg: { command?: string; args?: unknown; url?: string; httpUrl?: string }): GemArtifact {
  const pkg = firstPackage(cfg.args);
  if (cfg.command === "npx" && pkg && isPublicNpm(pkg)) {
    return { type: "reference", name, refKind: "mcp_server", ref: { kind: "package", id: `npx:${pkg}` } };
  }
  const url = cfg.url ?? cfg.httpUrl;
  return {
    type: "mcp_server", name, transport: url ? "http" : "stdio",
    config: url ? { url: redactUrl(url) } : { command: cfg.command, args: redactArgs(cfg.args) },
  };
}
