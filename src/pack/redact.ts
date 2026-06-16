// src/pack/redact.ts
// Strip secret VALUES from an MCP/hook config while preserving its shape, and record the
// NAME + LOCATION of every value stripped so a runtime can re-inject by name. Values never leave.
import type { SecretRef } from "./types.js";

const SECRET_RE = /(api[_-]?key|token|secret|password|passwd|bearer|sk-|ghp_|gho_|xox[a-z]-|credential)/i;

// A long, special-char-free token (no spaces, slashes, or dots) is almost
// certainly a secret; long sentences/paths/urls contain those characters.
function isHighEntropyToken(s: string): boolean {
  return s.length >= 32 && /^[A-Za-z0-9_-]+$/.test(s);
}

function redactNode(node: unknown, underSecretMap: boolean, path: string, key: string | undefined, secrets: SecretRef[]): unknown {
  if (typeof node === "string") {
    const keyIsSecret = key !== undefined && SECRET_RE.test(key);
    if (underSecretMap || keyIsSecret || SECRET_RE.test(node) || isHighEntropyToken(node)) {
      secrets.push({ name: key ?? path, location: path });
      return "<redacted>";
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((x, i) => redactNode(x, underSecretMap, `${path}[${i}]`, key, secrets));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const secretMap = underSecretMap || k === "env" || k === "headers";
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
