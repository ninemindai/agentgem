// src/__tests__/schemas.test.ts
import { describe, it, expect } from "vitest";
import {
  InventorySchema, GemSchema, GemRequestSchema, GemCheckSchema, ScaffoldChecksResponseSchema,
  MaterializeRequestSchema, MaterializeResponseSchema, PublishPreviewRequestSchema, PublishRequestSchema, PublishResultSchema,
  GemLockSchema, GemManifestSchema, ArchiveRequestSchema, ArchiveResponseSchema,
  WorkspaceSummarySchema, CreateWorkspaceRequestSchema, RenderRequestSchema, RenderResultSchema,
  DeployTargetIdSchema, DeployReadyQuerySchema, DeployTargetsResponseSchema,
} from "../schemas.js";

describe("wire schemas", () => {
  it("validates an inventory shape", () => {
    const parsed = InventorySchema.parse({
      skills: [{ type: "skill", name: "review", source: "standalone", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { T: "<redacted>" } } }],
      instructions: [{ type: "instructions", name: "CLAUDE.md", content: "y" }],
      hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [] }, source: "user" }],
    });
    expect(parsed.skills[0].name).toBe("review");
    expect(parsed.hooks[0].event).toBe("PreToolUse");
  });

  it("validates a pack-request with an all selection", () => {
    const p = GemRequestSchema.parse({ selection: { all: true }, name: "p" });
    expect("all" in p.selection && p.selection.all).toBe(true);
  });

  it("validates a pack-request with a named selection", () => {
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

  it("accepts a pack-request carrying checks, and a scaffold-checks response", () => {
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
        eve: { supported: 0, skipped: 1 }, flue: { supported: 0, skipped: 1 },
        "openai-sandbox": { supported: 0, skipped: 1 },
      },
    });
    expect(r.files["CLAUDE.md"]).toBe("x");
    expect(r.skipped[0].type).toBe("hook");
  });

  it("requires an idempotency key for publish but not preview, and returns a sandbox id", () => {
    PublishPreviewRequestSchema.parse({ selection: { all: true } });
    expect(() => PublishRequestSchema.parse({ selection: { all: true } })).toThrow();
    PublishRequestSchema.parse({ selection: { all: true }, requestId: "request-123" });
    const result = PublishResultSchema.parse({
      agentId: "agent_1", environmentId: "env_1", version: "1",
      registeredSkills: [], skipped: [], vaultSecrets: [],
    });
    expect(result.environmentId).toBe("env_1");
  });
});

describe("archive schemas", () => {
  it("accepts a well-formed lock and manifest", () => {
    expect(GemLockSchema.safeParse({ formatVersion: 1, files: { "a.md": "sha256:ab" }, packDigest: "sha256:cd", signature: null }).success).toBe(true);
    expect(GemManifestSchema.safeParse({
      formatVersion: 1, name: "p", version: "0.1.0", createdFrom: "/d",
      artifacts: [{ type: "skill", name: "x", path: "skills/x/SKILL.md", source: "standalone" }],
      requiredSecrets: [], checks: [],
    }).success).toBe(true);
  });

  it("archive request requires a selection; response carries files+lock+skipped+path+tarGz", () => {
    expect(ArchiveRequestSchema.safeParse({ selection: { all: true }, outDir: "/tmp/out" }).success).toBe(true);
    expect(ArchiveRequestSchema.safeParse({ selection: { all: true }, tar: true }).success).toBe(true);
    expect(ArchiveRequestSchema.safeParse({ name: "p" }).success).toBe(false);
    expect(ArchiveResponseSchema.safeParse({
      files: { "pack.json": "{}" }, lock: { formatVersion: 1, files: {}, packDigest: "sha256:x", signature: null }, skipped: [], path: null, tarGz: null,
    }).success).toBe(true);
    expect(ArchiveResponseSchema.safeParse({
      files: {}, lock: { formatVersion: 1, files: {}, packDigest: "sha256:x", signature: null }, skipped: [], path: null, tarGz: "H4sIAAAA",
    }).success).toBe(true);
  });

  it("materialize accepts selection OR archivePath, but not neither", () => {
    expect(MaterializeRequestSchema.safeParse({ selection: { all: true }, target: "claude" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ archivePath: "/tmp/pack", target: "eve" }).success).toBe(true);
    expect(MaterializeRequestSchema.safeParse({ target: "claude" }).success).toBe(false);
  });
});

describe("workspace schemas", () => {
  it("validates a workspace summary", () => {
    expect(WorkspaceSummarySchema.safeParse({
      name: "mp", packName: "demo", version: "0.1.0",
      artifactCounts: { skill: 1, mcp_server: 0, instructions: 1, hook: 0 }, checks: 0, renderedTargets: ["eve"],
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

describe("deploy schemas", () => {
  it("validates the deploy target id and rejects unknown", () => {
    expect(DeployTargetIdSchema.safeParse("claude-managed").success).toBe(true);
    expect(DeployTargetIdSchema.safeParse("nope").success).toBe(false);
  });
  it("publish-preview accepts an optional target; ready query + targets response validate", () => {
    expect(PublishPreviewRequestSchema.safeParse({ selection: { all: true } }).success).toBe(true);
    expect(PublishPreviewRequestSchema.safeParse({ selection: { all: true }, target: "claude-managed" }).success).toBe(true);
    expect(DeployReadyQuerySchema.safeParse({}).success).toBe(true);
    expect(DeployReadyQuerySchema.safeParse({ target: "claude-managed" }).success).toBe(true);
    expect(DeployTargetsResponseSchema.safeParse({ targets: [{ id: "claude-managed", label: "Claude Managed Agents", ready: false }] }).success).toBe(true);
  });
});
