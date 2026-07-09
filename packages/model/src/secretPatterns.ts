// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/secretPatterns.ts
//
// Strong, low-false-positive credential patterns shared by the capture-time redactor
// (`redact.ts` egress backstop) and the pre-publish leak canary (`leakCanary.ts`). They match
// credentials by CONTENT alone — independent of key name or container — so they catch values the
// structural heuristics miss (a JWT under a benign key, a password inside a connection string).
//
// They are deliberately HIGH-PRECISION (provider prefixes, JWT, PEM, URL-embedded passwords), NOT
// generic entropy: the canary scans an ENTIRE built Gem, so a low-precision rule would false-positive
// on content hashes / digests (gemDigest, signalDigest, lock hashes) that legitimately live there.

export const REDACTED = "<redacted>";

// A PEM private-key block (any key type).
const PEM_RE = /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g;
// A JSON Web Token: three dot-separated base64url segments starting with the `eyJ` header.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
// Provider-prefixed tokens that can appear mid-string (pasted CLI line, header value, prose).
const PROVIDER_TOKEN_RE =
  /\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|glpat-|xox[a-z]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b/g;
// `scheme://user:password@host` — capture the password segment so callers can redact JUST it and
// keep the surrounding shape. A URL with no `user:pass@` (e.g. https://mcp.example.com/sse) never matches.
const URL_CRED_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s:@]+)(@)/g;

// Redact every strong-pattern match in a string; URL-embedded passwords keep the surrounding shape.
// `.replace` resets each regex's lastIndex, so reusing the module-level globals here is safe.
export function redactStrongCredentials(s: string): string {
  return s
    .replace(PEM_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(PROVIDER_TOKEN_RE, REDACTED)
    .replace(URL_CRED_RE, (_m, prefix: string, _pw: string, at: string) => `${prefix}${REDACTED}${at}`);
}

export interface StrongCredentialHit {
  kind: string; // "pem-private-key" | "jwt" | "provider-token" | "url-credential"
  sample: string; // masked preview — prefix + length only, never the raw secret
}

// Show only a short, non-sensitive prefix + length, so a leak REPORT never re-leaks the secret.
function mask(s: string): string {
  const head = s.replace(/\s+/g, " ").slice(0, 4);
  return `${head}…(${s.length} chars)`;
}

// Find strong-pattern credentials that are NOT already redacted. Used by the leak canary to scan a
// built Gem: any hit means a real secret survived capture-time redaction. A URL-embedded password is
// reported only when its segment is not the redaction placeholder (a redacted DSN is `user:<redacted>@`).
export function findStrongCredentials(text: string): StrongCredentialHit[] {
  const hits: StrongCredentialHit[] = [];
  // Fresh RegExp copies so matchAll never trips over a shared lastIndex.
  for (const m of text.matchAll(new RegExp(PEM_RE))) hits.push({ kind: "pem-private-key", sample: mask(m[0]) });
  for (const m of text.matchAll(new RegExp(JWT_RE))) hits.push({ kind: "jwt", sample: mask(m[0]) });
  for (const m of text.matchAll(new RegExp(PROVIDER_TOKEN_RE))) hits.push({ kind: "provider-token", sample: mask(m[0]) });
  for (const m of text.matchAll(new RegExp(URL_CRED_RE))) {
    if (m[2] !== REDACTED) hits.push({ kind: "url-credential", sample: mask(m[0]) });
  }
  return hits;
}
