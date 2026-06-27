// src/gem/canonicalize.ts
import { createHash } from "node:crypto";
import type { McpServerArtifact, SkillArtifact } from "./types.js";

export const CANONICALIZER_VERSION = 1;

export type IdKind = "known" | "registry" | "contentHash" | "package" | "url" | "private" | "name" | "unknown";
export interface Ingredient { id: string; idKind: IdKind; public: boolean }

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function saltedHash(salt: string, value: string): string { return `sha256:${sha256(salt + "\n" + value)}`; }

export function canonicalModel(id: string): Ingredient { return { id: id.toLowerCase(), idKind: "known", public: true }; }
export function canonicalHarness(flavor: "claude" | "codex"): Ingredient {
  return { id: flavor === "claude" ? "claude-code" : "codex", idKind: "known", public: true };
}

// A registry coordinate looks like "@scope/name" or "name" with no path separators / dots-as-paths.
function isRegistryCoord(s: string): boolean { return /^@?[a-z0-9][a-z0-9._-]*\/?[a-z0-9._-]*$/i.test(s) && !s.includes("/Users") && !s.startsWith("/"); }

export function canonicalSkill(s: SkillArtifact): Ingredient {
  if (s.source && s.source.startsWith("@") && s.source.includes("/")) return { id: s.source, idKind: "registry", public: true };
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
  return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?$/i.test(pkg);
}
function isPublicHost(host: string): boolean {
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return false;
  return host.includes(".");
}

export function canonicalMcpServer(m: McpServerArtifact): Ingredient {
  if (m.transport === "stdio") {
    const cfg = m.config as { command?: unknown; args?: unknown };
    const command = typeof cfg.command === "string" ? cfg.command : "";
    const pkg = firstPackageArg(cfg.args);
    if (pkg && isPublicPackage(pkg)) {
      const runner = command === "npx" || command.endsWith("/npx") ? "npx" : command || "stdio";
      return { id: `${runner}:${pkg}`, idKind: "package", public: true };
    }
    return { id: `private:sha256:${sha256(JSON.stringify(m.config))}`, idKind: "private", public: false };
  }
  // http / sse
  const url = typeof (m.config as { url?: unknown }).url === "string" ? (m.config as { url: string }).url : "";
  try {
    const u = new URL(url);
    if (isPublicHost(u.hostname)) return { id: `url:${u.hostname}${u.pathname.replace(/\/$/, "")}`, idKind: "url", public: true };
  } catch { /* fall through */ }
  return { id: `private:sha256:${sha256(url || JSON.stringify(m.config))}`, idKind: "private", public: false };
}
