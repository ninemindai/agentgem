// src/gem/canonicalize.ts
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { McpServerArtifact, SkillArtifact } from "./types.js";

export const CANONICALIZER_VERSION = 2;

export type IdKind = "known" | "registry" | "contentHash" | "package" | "url" | "private" | "name" | "unknown";
export interface Ingredient { id: string; idKind: IdKind; public: boolean }

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function saltedHash(salt: string, value: string): string { return `sha256:${sha256(salt + "\n" + value)}`; }

/** Stable sorted-key JSON stringify — prevents key-order variance in private ids. */
function stableStr(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStr).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + stableStr(o[k])).join(",") + "}";
}

/** Last path segment of a command, lowercased — never leaks directory. */
function runnerName(command: string): string {
  return basename(command).toLowerCase();
}

/**
 * Scopes explicitly known to publish to the public npm registry.
 * Extension point: replace with a live registry-existence check in the future.
 */
const PUBLIC_SCOPES = new Set(["@modelcontextprotocol"]);

export function canonicalModel(id: string): Ingredient { return { id: id.toLowerCase(), idKind: "known", public: true }; }
export function canonicalHarness(flavor: "claude" | "codex"): Ingredient {
  return { id: flavor === "claude" ? "claude-code" : "codex", idKind: "known", public: true };
}

export function canonicalSkill(s: SkillArtifact, salt: string): Ingredient {
  if (s.source && s.source.startsWith("@") && s.source.includes("/")) {
    const scope = s.source.split("/")[0];
    if (PUBLIC_SCOPES.has(scope)) return { id: s.source, idKind: "registry", public: true };
    // Non-public scope: fall back to content-hash to avoid leaking the scope name.
  }
  return { id: `skill:sha256:${sha256(s.content)}`, idKind: "contentHash", public: false };
}

function firstPackageArg(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (a.startsWith("-")) continue;            // skip flags like -y
    return a;
  }
  return null;
}

function isPublicPackage(pkg: string): boolean {
  if (pkg.startsWith("/") || pkg.startsWith(".") || pkg.includes("\\")) return false; // filesystem path
  if (pkg.startsWith("@")) {
    // Scoped packages default to private unless the scope is allowlisted.
    const scope = pkg.split("/")[0];
    return PUBLIC_SCOPES.has(scope);
  }
  // Unscoped bare names are in the public npm default namespace.
  return /^[a-z0-9][a-z0-9._-]*$/i.test(pkg);
}

function isPublicHost(host: string): boolean {
  if (host.startsWith(":")) return false; // any IPv6 literal (e.g. ::1, ::ffff:192.168.x.x)
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) return false;
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return false;
  return host.includes(".");
}

export function canonicalMcpServer(m: McpServerArtifact, salt: string): Ingredient {
  if (m.transport === "stdio") {
    const cfg = m.config as { command?: unknown; args?: unknown };
    const command = typeof cfg.command === "string" ? cfg.command : "";
    const pkg = firstPackageArg(cfg.args);
    if (pkg && isPublicPackage(pkg)) {
      const runner = runnerName(command) || "stdio";
      return { id: `${runner}:${pkg}`, idKind: "package", public: true };
    }
    return { id: `private:${saltedHash(salt, stableStr(m.config))}`, idKind: "private", public: false };
  }
  // http / sse — URL path may carry PII (usernames, tenant ids); emit hostname only.
  const url = typeof (m.config as { url?: unknown }).url === "string" ? (m.config as { url: string }).url : "";
  try {
    const u = new URL(url);
    if (isPublicHost(u.hostname)) return { id: `url:${u.hostname}`, idKind: "url", public: true };
  } catch { /* fall through */ }
  return { id: `private:${saltedHash(salt, stableStr(m.config))}`, idKind: "private", public: false };
}
