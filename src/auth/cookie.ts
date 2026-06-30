// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Session cookie (de)serialization. The value is an opaque token; attributes make it a first-party,
// XSS-safe, same-site cookie shared across *.agentgem.ai subdomains.
export const SESSION_COOKIE = "ag_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

function base(token: string, domain?: string): string {
  const attrs = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (domain) attrs.push(`Domain=${domain}`);
  return attrs.join("; ");
}

export function serializeSessionCookie(token: string, opts: { domain?: string; maxAgeSec: number }): string {
  return `${base(token, opts.domain)}; Max-Age=${opts.maxAgeSec}`;
}

export function clearSessionCookie(opts: { domain?: string }): string {
  return `${base("", opts.domain)}; Max-Age=0`;
}
