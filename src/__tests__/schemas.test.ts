// src/__tests__/schemas.test.ts
import { describe, it, expect } from "vitest";
import {
  InventorySchema, GemSchema, GemRequestSchema, GemCheckSchema, ScaffoldChecksResponseSchema,
  MaterializeRequestSchema, MaterializeResponseSchema,
  GemLockSchema, GemManifestSchema, ArchiveRequestSchema, ArchiveResponseSchema,
  WorkspaceSummarySchema, CreateWorkspaceRequestSchema, RenderRequestSchema, RenderResultSchema,
  GemArtifactSchema, SkippedArtifactSchema,
  SkillArtifactSchema, TriggerContractSchema, DistilledSkillSchema,
  GemApplyResponseSchema, RubricInstallResultSchema,
} from "../schemas.js";

describe("wire schemas", () => {
  it("validates an inventory shape", () => {
    const parsed = InventorySchema.parse({
      skills: [{ type: "skill", name: "review", source: "standalone", id: "workspace/skills/standalone/review", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { T: "<redacted>" } } }],
      instructions: [{ type: "instructions", name: "CLAUDE.md", id: "workspace/instructions/CLAUDE.md", content: "y" }],
      hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [] }, source: "user" }],
      subagents: [{ type: "subagent", name: "reviewer", source: "user", id: "workspace/subagents/user/reviewer", content: "z", tools: ["Read"], model: "sonnet" }],
    });
    expect(parsed.skills[0].name).toBe("review");
    expect(parsed.skills[0].id).toBe("workspace/skills/standalone/review");
    expect(parsed.hooks[0].event).toBe("PreToolUse");
    expect(parsed.subagents[0]).toMatchObject({ name: "reviewer", tools: ["Read"], model: "sonnet" });
    // Verify that InventorySchema rejects a skill missing id
    expect(InventorySchema.safeParse({
      skills: [{ type: "skill", name: "review", source: "standalone", content: "x" }],
      mcpServers: [],
      instructions: [],
      hooks: [],
      subagents: [],
    }).success).toBe(false);
  });

  it("validates a gem-request with an all selection", () => {
    const p = GemRequestSchema.parse({ selection: { all: true }, name: "p" });
    expect("all" in p.selection && p.selection.all).toBe(true);
  });

  it("validates a gem-request with a named selection", () => {
    const p = GemRequestSchema.parse({ selection: { skills: ["review"], includeInstructions: true } });
    expect(p.selection).toMatchObject({ skills: ["review"] });
  });

  it("accepts a Gem", () => {
    const pk = GemSchema.parse({
      name: "p",
      createdFrom: "/d",
      artifacts: [{ type: "instructions", name: "CLAUDE.md", content: "y" }],
      checks: [],
      requiredSecrets: [{ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" }],
    });
    expect(pk.artifacts.length).toBe(1);
    expect(pk.requiredSecrets[0].name).toBe("GH_TOKEN");
  });

  it("validates both check kinds and rejects an unknown runner", () => {
    GemCheckSchema.parse({ kind: "behavioral", name: "smoke", task: "do it", assertions: [{ type: "file_exists", path: "out.txt" }] });
    GemCheckSchema.parse({ kind: "external", name: "sec", runner: "skillspector", with: { failAboveRisk: 40 } });
    expect(() => GemCheckSchema.parse({ kind: "external", name: "sec", runner: "totally-made-up" })).toThrow();
    expect(() => GemCheckSchema.parse({ kind: "behavioral", name: "x", task: "t", assertions: [{ type: "nope" }] })).toThrow();
  });

  it("accepts a gem-request carrying checks, and a scaffold-checks response", () => {
    const p = GemRequestSchema.parse({ selection: { all: true }, checks: [{ kind: "external", name: "s", runner: "skillspector" }] });
    expect(p.checks?.length).toBe(1);
    const r = ScaffoldChecksResponseSchema.parse({ checks: [{ kind: "behavioral", name: "smoke", task: "t", assertions: [] }] });
    expect(r.checks[0].name).toBe("smoke");
  });

  it("validates a materialize request and rejects an unknown target", () => {
    MaterializeRequestSchema.parse({ selection: { all: true }, target: "codex" });
    expect(() => MaterializeRequestSchema.parse({ selection: { all: true }, target: "nope" })).toThrow();
  });

  it("validates a materialize response shape", () => {
    const r = MaterializeResponseSchema.parse({
      target: "claude",
      files: { "CLAUDE.md": "x" },
      skipped: [{ artifact: "h", type: "hook", reason: "hook unsupported on claude" }],
      compatibility: {
        claude: { supported: 1, skipped: 0 }, codex: { supported: 0, skipped: 1 },
        agents: { supported: 0, skipped: 1 }, hermes: { supported: 0, skipped: 1 },
        continue: { supported: 0, skipped: 1 },
        eve: { supported: 0, skipped: 1 }, flue: { supported: 0, skipped: 1 },
        "openai-sandbox": { supported: 0, skipped: 1 }, agentcore: { supported: 0, skipped: 1 },
        a2a: { supported: 1, skipped: 0 }, cline: { supported: 1, skipped: 0 }, gemini: { supported: 0, skipped: 1 },
        cursor: { supported: 0, skipped: 1 },
      },
    });
    expect(r.files["CLAUDE.md"]).toBe("x");
    expect(r.skipped[0].type).toBe("hook");
  });

});

describe("archive schemas", () => {
  it("accepts a well-formed lock and manifest", () => {
    expect(GemLockSchema.safeParse({ formatVersion: 1, files: { "a.md": "sha256:ab" }, gemDigest: "sha256:cd", signature: null }).success).toBe(true);
    expect(GemManifestSchema.safeParse({
      formatVersion: 1, name: "p", version: "0.1.0", createdFrom: "/d",
      artifacts: [{ type: "skill", name: "x", path: "skills/x/SKILL.md", source: "standalone" }],
      requiredSecrets: [], checks: [],
    }).success).toBe(true);
  });

  it("archive request requires a selection; response carries files+lock+skipped+path+gemFile+tarGz", () => {
    expect(ArchiveRequestSchema.safeParse({ selection: { all: true }, outDir: "/tmp/out" }).success).toBe(true);
    expect(ArchiveRequestSchema.safeParse({ selection: { all: true }, outFile: "/tmp/p.gem" }).success).toBe(true);
    expect(ArchiveRequestSchema.safeParse({ selection: { all: true }, tar: true }).success).toBe(true);
    expect(ArchiveRequestSchema.safeParse({ name: "p" }).success).toBe(false);
    expect(ArchiveResponseSchema.safeParse({
      files: { "gem.json": "{}" }, lock: { formatVersion: 1, files: {}, gemDigest: "sha256:x", signature: null }, skipped: [], path: null, gemFile: null, tarGz: null,
    }).success).toBe(true);
    expect(ArchiveResponseSchema.safeParse({
      files: {}, lock: { formatVersion: 1, files: {}, gemDigest: "sha256:x", signature: null }, skipped: [], path: null, gemFile: "/tmp/p.gem", tarGz: "H4sIAAAA",
    }).success).toBe(true);
  });

  it("materialize accepts selection, archivePath, gemPath, or gemUrl, but not none", () => {
    expect(MaterializeRequestSchema.safeParse({ selection: { all: true }, target: "claude" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ archivePath: "/tmp/gem", target: "eve" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ gemPath: "/tmp/x.gem", target: "eve" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ gemUrl: "https://ex.com/x.gem", target: "eve" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ target: "claude" }).success).toBe(false);
  });
});

describe("workspace schemas", () => {
  it("validates a workspace summary", () => {
    expect(WorkspaceSummarySchema.safeParse({
      name: "mp", gemName: "demo", version: "0.1.0",
      artifactCounts: { skill: 1, mcp_server: 0, instructions: 1, hook: 0, subagent: 0, game: 0, rubric: 0 },
      artifacts: [{ type: "skill", name: "pdf" }, { type: "instructions", name: "rules" }],
      modifiedMs: 1_700_000_000_000,
      checks: 0, renderedTargets: ["eve"],
    }).success).toBe(true);
  });
  it("create requires name+selection; render requires name+target", () => {
    expect(CreateWorkspaceRequestSchema.safeParse({ name: "mp", selection: { all: true } }).success).toBe(true);
    expect(CreateWorkspaceRequestSchema.safeParse({ selection: { all: true } }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ name: "mp", target: "eve" }).success).toBe(true);
    expect(RenderRequestSchema.safeParse({ name: "mp", target: "nope" }).success).toBe(false);
    expect(RenderResultSchema.safeParse({ target: "eve", files: {}, skipped: [], path: "/x" }).success).toBe(true);
  });
});


describe("channel schema", () => {
  it("GemArtifactSchema parses a channel artifact", () => {
    const ok = GemArtifactSchema.safeParse({
      type: "channel", name: "slack", platform: "slack",
      secretRefs: [{ name: "SLACK_BOT_TOKEN", location: "env.SLACK_BOT_TOKEN" }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown platform", () => {
    const bad = GemArtifactSchema.safeParse({ type: "channel", name: "x", platform: "myspace", secretRefs: [] });
    expect(bad.success).toBe(false);
  });

  it("SkippedArtifactSchema accepts a channel skip", () => {
    expect(SkippedArtifactSchema.safeParse({ artifact: "slack", type: "channel", reason: "unsupported" }).success).toBe(true);
  });
});

describe("TriggerContract", () => {
  it("parses a full trigger contract", () => {
    const c = TriggerContractSchema.parse({
      intent: "distill a session into a shareable skill",
      triggers: ["user asks to save this workflow", "repeated manual steps"],
      antiTriggers: ["one-off throwaway command"],
      inputs: ["a transcript"],
      outputs: ["a SkillArtifact"],
    });
    expect(c.triggers).toHaveLength(2);
    expect(c.inputs).toEqual(["a transcript"]);
  });

  it("accepts a skill artifact WITHOUT a trigger (backward-compat)", () => {
    const s = SkillArtifactSchema.parse({
      type: "skill", name: "x", source: "s", content: "c",
    });
    expect(s.trigger).toBeUndefined();
  });

  it("accepts a skill artifact WITH a trigger", () => {
    const s = SkillArtifactSchema.parse({
      type: "skill", name: "x", source: "s", content: "c",
      trigger: { intent: "i", triggers: ["t"], antiTriggers: [] },
    });
    expect(s.trigger?.intent).toBe("i");
  });
});

describe("DistilledSkillSchema triggerContract", () => {
  const base = {
    name: "do-x", description: "d", triggers: ["t"], tools: [], mutating: false, body: "b",
    evidence: { sessions: 1, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
    status: "draft" as const, confidence: "medium" as const, origin: "llm" as const,
  };
  it("parses a distilled skill WITHOUT a trigger contract (backward-compat)", () => {
    const s = DistilledSkillSchema.parse(base);
    expect(s.triggerContract).toBeUndefined();
  });
  it("parses and preserves a trigger contract", () => {
    const s = DistilledSkillSchema.parse({ ...base, triggerContract: { intent: "i", triggers: ["a"], antiTriggers: ["b"] } });
    expect(s.triggerContract?.intent).toBe("i");
    expect(s.triggerContract?.antiTriggers).toEqual(["b"]);
  });
});

describe("RubricArtifactSchema", () => {
  const valid = {
    type: "rubric",
    name: "my-rubric",
    title: "My rubric",
    target: "overview",
    naturalScope: "project",
    factors: [{ factor: "retry-storm", weight: 2 }],
    criteria: [{ id: "c1", title: "T", question: "Q?", advice: "A", severity: "warn" }],
  };

  it("GemArtifactSchema parses a valid rubric artifact", () => {
    expect(GemArtifactSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a non-kebab name", () => {
    expect(GemArtifactSchema.safeParse({ ...valid, name: "Bad Name" }).success).toBe(false);
  });

  it("rejects an empty factors array", () => {
    expect(GemArtifactSchema.safeParse({ ...valid, factors: [] }).success).toBe(false);
  });
});

describe("install responses carry an optional rubrics result", () => {
  it("RubricInstallResultSchema parses installed/skipped and rejects a missing array", () => {
    expect(RubricInstallResultSchema.safeParse({ installed: ["a"], skipped: [] }).success).toBe(true);
    expect(RubricInstallResultSchema.safeParse({ installed: ["a"] }).success).toBe(false);
  });
  it("GemApplyResponseSchema accepts rubrics and also omits it", () => {
    const base = { dir: "/d", name: "g", written: [], skipped: [] };
    expect(GemApplyResponseSchema.safeParse(base).success).toBe(true);
    expect(GemApplyResponseSchema.safeParse({ ...base, rubrics: { installed: ["r"], skipped: [] } }).success).toBe(true);
  });
});
