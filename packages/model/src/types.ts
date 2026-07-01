// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/types.ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel";

export interface SecretRef {
  name: string;     // leaf key, e.g. "OPENAI_API_KEY"
  location: string; // dotted path within the artifact config, e.g. "env.OPENAI_API_KEY"
}

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
  secretRefs?: SecretRef[]; // names+locations redaction stripped from `config`
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
  secretRefs?: SecretRef[]; // names+locations redaction stripped from `config`
}

export type ChannelPlatform = "slack" | "telegram" | "discord" | "teams" | "twilio" | "github";

// A channel declares how the Gem wants to be reached by end users. Neutral + minimal: the
// platform plus the env-var secrets it needs. The "how it's wired" lives in CHANNEL_REGISTRY.
export interface ChannelArtifact {
  type: "channel";
  name: string;             // path segment -> agent/channels/<name>.ts on the Eve target
  platform: ChannelPlatform;
  secretRefs: SecretRef[];  // resolved from the registry at build time (env-var names)
  description?: string;     // optional; for discovery / Card
}

export type GemArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact | ChannelArtifact;

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

// ── Declared secret surface (aggregated onto the Gem) ──
export interface SecretRequirement {
  name: string;      // leaf key, e.g. "OPENAI_API_KEY"
  artifact: string;  // owning artifact name, e.g. mcp server "context7"
  location: string;  // re-injection path, e.g. "env.OPENAI_API_KEY"
  // never a value
}

// ── Checks (discriminated union: behavioral | external) ──
export type GemCheck = BehavioralCheck | ExternalCheck;

export interface BehavioralCheck {
  kind: "behavioral";
  name: string;
  description?: string;
  task: string;                 // prompt given to the clean, gem-loaded agent
  setup?: EvalSetup;            // optional workspace seeding
  assertions: EvalAssertion[];  // deterministic; ALL must pass (AND)
  judge?: EvalJudge;            // opt-in LLM-judge; pass = assertions AND judge>=threshold
  timeoutSec?: number;
}

export interface ExternalCheck {
  kind: "external";
  name: string;
  description?: string;
  runner: string;               // registry id, e.g. "skillspector"
  with?: Record<string, unknown>;
}

export interface EvalSetup {
  files?: { path: string; content: string }[];
}

export type EvalAssertion =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; substring: string }
  | { type: "command_succeeds"; command: string }
  | { type: "output_contains"; substring: string }
  | { type: "tool_called"; tool: string };

export interface EvalJudge {
  rubric: string;
  passThreshold?: number; // 0..1, default 0.7
}

// ── Execution-result types (agentgem owns these; the platform runner produces them) ──
export interface CheckResult {
  checkName: string;
  kind: "behavioral" | "external";
  passed: boolean;
  assertionResults?: { assertion: EvalAssertion; passed: boolean; detail?: string }[];
  judgeScore?: number;
  runner?: string;
  score?: number;
  findings?: { severity: string; title: string; detail?: string }[];
  durationMs: number;
  error?: string;
}

export interface GemVerificationReport {
  gemName: string;
  createdFrom: string;
  results: CheckResult[];
  passed: boolean; // all results passed AND results.length > 0
}

export interface Gem {
  name: string;
  createdFrom: string;
  artifacts: GemArtifact[];
  checks: GemCheck[];                   // 0..n; embedded operator checks
  requiredSecrets: SecretRequirement[];  // declared secret surface; names only
  grade?: number;                        // authoring-quality floor (1..3), baked at build; absent when unmeasured
}
