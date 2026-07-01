// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Shared classifier: is an MCP stdio server a PUBLIC npm package (→ store as a package
// reference) or something local/private (→ embed with secrets redacted)? Hoisted from the
// Cline reader so every source adapter (Cline, Gemini, future Cursor) shares one security-
// relevant rule. Scoped packages default to private unless the scope is allowlisted.
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
