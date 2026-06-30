// src/gem/toml.ts
// Minimal TOML emitter for the MCP-server config shape ONLY (command/url/type scalars,
// args array, env/headers sub-tables). Not a general TOML library.
import type { McpServerArtifact } from "./types.js";

const BARE = /^[A-Za-z0-9_-]+$/;
function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
function key(k: string): string {
  return BARE.test(k) ? k : `"${escapeStr(k)}"`;
}
function scalar(v: unknown): string {
  if (typeof v === "string") return `"${escapeStr(v)}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `"${escapeStr(String(v))}"`;
}
function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

export function tomlMcpServers(servers: McpServerArtifact[]): string {
  const blocks: string[] = [];
  for (const s of servers) {
    const lines: string[] = [`[mcp_servers.${key(s.name)}]`];
    const subTables: string[] = [];
    for (const [k, v] of Object.entries(s.config)) {
      if (isScalar(v)) lines.push(`${key(k)} = ${scalar(v)}`);
      else if (Array.isArray(v)) lines.push(`${key(k)} = [${v.map(scalar).join(", ")}]`);
      else if (v && typeof v === "object") {
        const sub = [`[mcp_servers.${key(s.name)}.${key(k)}]`];
        for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) sub.push(`${key(k2)} = ${scalar(v2)}`);
        subTables.push(sub.join("\n"));
      }
    }
    blocks.push([lines.join("\n"), ...subTables].join("\n\n"));
  }
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

// Inverse of tomlMcpServers for the [mcp_servers.*] subset only (scalars, scalar arrays, one level of
// sub-tables). Not a general TOML parser. Unknown/other top-level tables are ignored.
function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function parseArray(raw: string): unknown[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  // split on commas not inside quotes
  const parts: string[] = []; let cur = ""; let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") inStr = !inStr;
    if (ch === "," && !inStr) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => parseScalar(p));
}
function unquoteKey(k: string): string {
  const s = k.trim();
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}
export function parseTomlMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let server: string | null = null;
  let sub: string | null = null;     // sub-table key (e.g. "env") within the current server
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (header) {
      // split "name" or "name.sub" on the first dot outside quotes
      const segs = header[1].match(/("(?:[^"\\]|\\.)*"|[^.]+)/g) ?? [];
      const name = unquoteKey(segs[0] ?? "");
      server = name; sub = segs[1] ? unquoteKey(segs[1]) : null;
      out[server] ??= {};
      if (sub) (out[server][sub] ??= {});
      continue;
    }
    if (line.startsWith("[")) { server = null; sub = null; continue; } // some other table
    if (!server) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = unquoteKey(line.slice(0, eq));
    const valRaw = line.slice(eq + 1).trim();
    const val = valRaw.startsWith("[") ? parseArray(valRaw) : parseScalar(valRaw);
    if (sub) (out[server][sub] as Record<string, unknown>)[key] = val;
    else out[server][key] = val;
  }
  return out;
}
