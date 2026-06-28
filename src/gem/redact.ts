// src/gem/redact.ts
// Strip secret VALUES from an MCP/hook config while preserving its shape, and record the
// NAME + LOCATION of every value stripped so a runtime can re-inject by name. Values never leave.
import type { SecretRef } from "./types.js";

const SECRET_RE = /(api[_-]?key|token|secret|password|passwd|bearer|sk-|ghp_|gho_|xox[a-z]-|credential)/i;

// Map keys whose CHILDREN are credentials by default (default-deny container). `env` and
// `headers` are where credentials normally live; `environment`/`auth`/`credentials`/`secrets`
// are the other conventional credential containers a benign-looking config nests them under.
const SECRET_CONTAINER_KEYS = new Set(["env", "environment", "headers", "auth", "credentials", "secrets"]);

// A long, special-char-free token (no spaces, slashes, or dots) is almost
// certainly a secret; long sentences/paths/urls contain those characters.
function isHighEntropyToken(s: string): boolean {
  return s.length >= 32 && /^[A-Za-z0-9_-]+$/.test(s);
}

// Egress backstop — structure-INDEPENDENT credential patterns. The heuristics above key off
// key-name / container / high-entropy charset, so they miss credentials stored under a benign
// key whose value carries special characters (JWT dots, a `scheme://user:pass@` connection
// string, a PEM block). These patterns catch those by content alone, as a fail-closed net, and
// redact only the matched span so the surrounding shape (host, path, key kind) survives.
const PEM_RE = /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
// Provider-prefixed tokens that can appear mid-string (e.g. a pasted CLI line or a header value).
const PROVIDER_TOKEN_RE =
  /\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|glpat-|xox[a-z]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b/g;
// `scheme://user:password@host` — redact ONLY the password segment, keep userinfo/host shape.
// (A URL with no `user:pass@`, e.g. https://mcp.example.com/sse, never matches.)
const URL_CRED_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)[^/\s:@]+(@)/g;

// Apply the strong-pattern net to one string; returns the (possibly) redacted string.
function applyEgressBackstop(s: string): string {
  return s
    .replace(PEM_RE, "<redacted>")
    .replace(JWT_RE, "<redacted>")
    .replace(PROVIDER_TOKEN_RE, "<redacted>")
    .replace(URL_CRED_RE, (_m, prefix, at) => `${prefix}<redacted>${at}`);
}

function redactNode(node: unknown, underSecretMap: boolean, path: string, key: string | undefined, secrets: SecretRef[]): unknown {
  const keyIsSecret = key !== undefined && SECRET_RE.test(key);
  if (typeof node === "string") {
    // Value-content heuristics are prose-safe: prose uses words like "bearer" or "token"
    // legitimately (e.g. "test bearer authentication flow"), so SECRET_RE on the whole string
    // would produce false positives. Instead:
    //   • Whitespace-free string: treat the whole value as a single token (existing behaviour).
    //   • Multi-word string: only flag it if ANY individual whitespace-free token is high-entropy
    //     (e.g. "use token ghp_abcdefghijklmnopqrstuvwxyz0123" → ghp_… triggers isHighEntropyToken).
    const isWhitespaceFree = !/\s/.test(node);
    const looksLikeToken = isWhitespaceFree
      ? SECRET_RE.test(node) || isHighEntropyToken(node)
      : node.split(/\s+/).some((t) => t.length > 0 && isHighEntropyToken(t));
    if (underSecretMap || keyIsSecret || looksLikeToken) {
      secrets.push({ name: key ?? path, location: path });
      return "<redacted>";
    }
    // Backstop: catch JWTs, PEM private keys, provider tokens, and URL-embedded passwords that
    // slip past the heuristics above (special chars in the value defeat the high-entropy charset).
    const backstopped = applyEgressBackstop(node);
    if (backstopped !== node) {
      secrets.push({ name: key ?? path, location: path });
      return backstopped;
    }
    return node;
  }
  // Numbers/booleans can be secret too (a numeric PIN/token, a flag under a credential map).
  // Redact only when context says so — a secret key name or a default-deny container — so benign
  // scalars like `port: 8080` are untouched.
  if (typeof node === "number" || typeof node === "bigint" || typeof node === "boolean") {
    if (underSecretMap || keyIsSecret) {
      secrets.push({ name: key ?? path, location: path });
      return "<redacted>";
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((x, i) => redactNode(x, underSecretMap, `${path}[${i}]`, key, secrets));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const secretMap = underSecretMap || SECRET_CONTAINER_KEYS.has(k);
      out[k] = redactNode(v, secretMap, path ? `${path}.${k}` : k, k, secrets);
    }
    return out;
  }
  return node;
}

export function redactMcpConfig(config: Record<string, unknown>): { config: Record<string, unknown>; secrets: SecretRef[] } {
  const secrets: SecretRef[] = [];
  const redacted = redactNode(config, false, "", undefined, secrets) as Record<string, unknown>;
  return { config: redacted, secrets };
}
