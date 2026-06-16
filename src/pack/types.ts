// src/pack/types.ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook";

export interface SkillArtifact {
  type: "skill";
  name: string;
  description?: string;
  source: string;
  content: string;
}

export interface McpServerArtifact {
  type: "mcp_server";
  name: string;
  transport: "stdio" | "http" | "sse";
  config: Record<string, unknown>;
  source?: string;
}

export interface InstructionsArtifact {
  type: "instructions";
  name: string;
  content: string;
}

// One hook is an (event, matcher) group from a `.hooks` map; `config` is the group object
// ({ matcher?, hooks: [{ type, command, … }] }), redacted at capture.
export interface HookArtifact {
  type: "hook";
  name: string;
  event: string;
  matcher?: string;
  config: Record<string, unknown>;
  source?: string;
}

export type PackArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact;

export interface ProjectInventory {
  root: string;
  name: string;
  skills: SkillArtifact[];
  mcpServers: McpServerArtifact[];
  instructions: InstructionsArtifact[];
  hooks: HookArtifact[];
}

export interface ConfigInventory {
  skills: SkillArtifact[];
  mcpServers: McpServerArtifact[];
  instructions: InstructionsArtifact[];
  hooks: HookArtifact[];
  projects?: ProjectInventory[];
}

export interface Pack {
  name: string;
  createdFrom: string;
  artifacts: PackArtifact[];
}
