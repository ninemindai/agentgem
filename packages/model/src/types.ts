// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/types.ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel" | "subagent" | "game";

export interface SecretRef {
  name: string;     // leaf key, e.g. "OPENAI_API_KEY"
  location: string; // dotted path within the artifact config, e.g. "env.OPENAI_API_KEY"
}

export interface TriggerContract {
  intent: string;          // one-line: what this skill is for
  triggers: string[];      // positive signals — when it SHOULD fire
  antiTriggers: string[];  // boundaries — when it must NOT fire
  inputs?: string[];       // optional: what it expects to be present
  outputs?: string[];      // optional: what it produces
}

export interface SkillArtifact {
  type: "skill";
  name: string;
  description?: string;
  source: string;
  content: string;
  trigger?: TriggerContract;
}

// A Claude Code subagent — a `.claude/agents/<name>.md` definition (frontmatter +
// system-prompt body). Structurally skill-like, but a distinct primitive: invoked via
// the Task tool rather than auto-triggered, and it carries a tool allowlist / model
// override. `content` is the full file (verbatim, for lossless re-materialization);
// `tools`/`model`/`description` are parsed out for discovery. `tools` absent = inherit all.
export interface SubagentArtifact {
  type: "subagent";
  name: string;
  description?: string;
  source: string;
  content: string;
  tools?: string[];
  model?: string;
}

// A pre-bundled, self-contained mini-game authored by the Play feature. `html` carries its own
// inline JS/CSS and data: assets — it is run in a sealed sandboxed iframe (no network, no LLM at
// runtime). `createdFrom` is provenance only (a reference + one-line summary), never the raw source.
export type GameGenre = "replay" | "skill-run" | "project-fun"; // v2: "watch" | "team"

// A capability a game may DECLARE. The trusted Play host — never the game — decides whether to grant
// it, consent-gated per gem. Absent `needs` = a pure sealed offline snapshot (the safe default). The
// first two are read-only data feeds brokered into the sealed iframe; "invoke-agent" is privileged
// code execution (the host runs an ACP agent in the run-sandbox and streams back a sanitized
// transcript) and is restricted at runtime to locally-authored games, never shared/marketplace ones.
export type GameCapability =
  | "session-data"          // read-only: the game's own source-session transcript ({meta,timeline}), host-brokered on demand
  | "live-session-events"   // read-only: streamed live session events (host -> /api/watch/stream)
  | "local-project-access"  // read-only: local projects / setup / inventory (host-brokered)
  | "invoke-agent";         // privileged: host runs a local ACP agent in the sandbox; game gets the transcript

export type GameSource =
  | { kind: "session"; agent: string; project?: string; sessionId: string; summary: string }
  | { kind: "skill"; skillName: string; sourceId?: string }
  | { kind: "project"; path: string; flavor: string }
  | { kind: "html"; title: string }; // imported from an existing self-contained HTML file (provenance = title)

export interface GameArtifact {
  type: "game";
  name: string;             // slug, e.g. "auth-bugfix-replay"
  title: string;            // display, e.g. "The Great Auth Bug Hunt"
  genre: GameGenre;
  html: string;             // the pre-bundled, self-contained game
  poster?: string;          // data-URI thumbnail (the preview gate's screenshot)
  createdFrom: GameSource;  // provenance reference + summary — NOT the raw source
  engineVersion: string;    // scaffold/genre version, for future migration
  needs?: GameCapability[]; // declared, read-only; host decides. Absent = pure snapshot.
  meta?: { controls?: string; estPlaySeconds?: number };
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

export interface ArtifactRef {
  kind: "package" | "gem";  // npx/npm package  |  registry gem digest
  id: string;               // e.g. "npx:@scope/pkg"  |  "sha256:<hex>"
  digest?: string;          // pinned in the lock at resolve time
}

// An artifact provided by reference rather than embedded bytes. `refKind` is what it stands
// in for. Discriminated by type:"reference" so existing type-narrowing on the 5 value kinds is unaffected.
export interface ReferenceArtifact {
  type: "reference";
  name: string;
  refKind: ArtifactType;
  ref: ArtifactRef;
}

export type GemArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact | ChannelArtifact | SubagentArtifact | GameArtifact | ReferenceArtifact;

export interface ProjectInventory {
  root: string;
  name: string;
  skills: SkillArtifact[];
  mcpServers: McpServerArtifact[];
  instructions: InstructionsArtifact[];
  hooks: HookArtifact[];
  subagents: SubagentArtifact[];
}

export interface ConfigInventory {
  skills: SkillArtifact[];
  mcpServers: McpServerArtifact[];
  instructions: InstructionsArtifact[];
  hooks: HookArtifact[];
  subagents: SubagentArtifact[];
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

// Per-harness execution overlay — delta-only (only what the neutral artifacts can't express).
// Unsigned: NOT serialized into the archive, so it never affects the gem digest.
export interface AgentBinding {
  agent: string;                      // AgentId this binding is for
  origin: "imported" | "rendered";    // mined FROM this harness, or exported TO it
  model?: string;
  entry?: string;
  secretMap?: Record<string, string>; // requiredSecret name -> this harness's env var NAME
  config?: Record<string, unknown>;
}

// A Gem's portable completion contract: the task a runner should hand an agent to
// exercise the Gem, and the behavior evidence that proves it worked. String-only
// (no RegExp) so it serializes into the archive manifest verbatim.
export interface GemContract {
  task: string;
  expect: {
    tools?: string[];              // each must substring-match an invoked tool title
    text?: string;                 // substring the agent's output must contain
    forbidToolFailures?: boolean;  // default true at verification time
  };
}

export interface Gem {
  name: string;
  createdFrom: string;
  artifacts: GemArtifact[];
  checks: GemCheck[];                   // 0..n; embedded operator checks
  requiredSecrets: SecretRequirement[];  // declared secret surface; names only
  grade?: number;                        // authoring-quality floor (1..3), baked at build; absent when unmeasured
  contract?: GemContract;                // portable completion contract; absent = not contract-bearing
  bindings?: AgentBinding[];  // in-memory overlay; absent = none. Not archived (see AgentBinding).
}
