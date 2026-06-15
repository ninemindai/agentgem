// src/pack/redact.ts
// Strip secret VALUES from an MCP server config while preserving its shape.
const SECRET_RE = /(api[_-]?key|token|secret|password|passwd|bearer|sk-|ghp_|gho_|xox[a-z]-|credential)/i;

// A long, special-char-free token (no spaces, slashes, or dots) is almost
// certainly a secret; long sentences/paths/urls contain those characters.
function isHighEntropyToken(s: string): boolean {
  return s.length >= 32 && /^[A-Za-z0-9_-]+$/.test(s);
}

function redactNode(node: unknown, underSecretMap: boolean, key?: string): unknown {
  if (typeof node === "string") {
    const keyIsSecret = key !== undefined && SECRET_RE.test(key);
    return underSecretMap || keyIsSecret || SECRET_RE.test(node) || isHighEntropyToken(node)
      ? "<redacted>"
      : node;
  }
  if (Array.isArray(node)) return node.map((x) => redactNode(x, underSecretMap, key));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const secretMap = underSecretMap || k === "env" || k === "headers";
      out[k] = redactNode(v, secretMap, k);
    }
    return out;
  }
  return node;
}

export function redactMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  return redactNode(config, false) as Record<string, unknown>;
}
