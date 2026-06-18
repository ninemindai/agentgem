// src/pack/toml.ts
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
