// src/pack/types.ts
export type ArtifactType = "skill" | "mcp_server" | "instructions";

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

export type PackArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact;

export interface ConfigInventory {
  skills: SkillArtifact[];
  mcpServers: McpServerArtifact[];
  instructions: InstructionsArtifact[];
}

export interface Pack {
  name: string;
  createdFrom: string;
  artifacts: PackArtifact[];
}
