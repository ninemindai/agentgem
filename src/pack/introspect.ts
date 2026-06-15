// src/pack/introspect.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { redactMcpConfig } from "./redact.js";
import type {
  ConfigInventory,
  SkillArtifact,
  McpServerArtifact,
  InstructionsArtifact,
} from "./types.js";

function frontmatterDescription(content: string): string | undefined {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  return m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
}

function inferTransport(config: Record<string, unknown>): "stdio" | "http" | "sse" {
  if (typeof config.url === "string") return config.type === "sse" ? "sse" : "http";
  return "stdio";
}

// Introspects the operator's user-level config under claudeDir:
// skills/<name>/SKILL.md, settings.json + .mcp.json mcpServers, CLAUDE.md.
export function introspectConfig(claudeDir: string = join(homedir(), ".claude")): ConfigInventory {
  const skills: SkillArtifact[] = [];
  const skillsDir = join(claudeDir, "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const skillMd = join(skillsDir, name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      try {
        const content = readFileSync(skillMd, "utf8");
        skills.push({ type: "skill", name, description: frontmatterDescription(content), source: "standalone", content });
      } catch {
        // skip unreadable skill
      }
    }
  }

  const mcpServers: McpServerArtifact[] = [];
  const seen = new Set<string>();
  for (const file of ["settings.json", ".mcp.json"]) {
    const p = join(claudeDir, file);
    if (!existsSync(p)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    const servers = (parsed as Record<string, unknown> | null)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const config = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
      mcpServers.push({ type: "mcp_server", name, transport: inferTransport(config), config: redactMcpConfig(config) });
    }
  }

  const instructions: InstructionsArtifact[] = [];
  const claudeMd = join(claudeDir, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      instructions.push({ type: "instructions", name: "CLAUDE.md", content: readFileSync(claudeMd, "utf8") });
    } catch {
      // skip unreadable CLAUDE.md
    }
  }

  return { skills, mcpServers, instructions };
}
