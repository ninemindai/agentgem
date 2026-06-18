// src/__tests__/schemas.test.ts
import { describe, it, expect } from "vitest";
import { InventorySchema, PackSchema, PackRequestSchema, PackCheckSchema, ScaffoldChecksResponseSchema, MaterializeRequestSchema, MaterializeResponseSchema } from "../schemas.js";

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
    const p = PackRequestSchema.parse({ selection: { all: true }, name: "p" });
    expect("all" in p.selection && p.selection.all).toBe(true);
  });

  it("validates a pack-request with a named selection", () => {
    const p = PackRequestSchema.parse({ selection: { skills: ["review"], includeInstructions: true } });
    expect(p.selection).toMatchObject({ skills: ["review"] });
  });

  it("accepts a Pack", () => {
    const pk = PackSchema.parse({
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
    PackCheckSchema.parse({ kind: "behavioral", name: "smoke", task: "do it", assertions: [{ type: "file_exists", path: "out.txt" }] });
    PackCheckSchema.parse({ kind: "external", name: "sec", runner: "skillspector", with: { failAboveRisk: 40 } });
    expect(() => PackCheckSchema.parse({ kind: "external", name: "sec", runner: "totally-made-up" })).toThrow();
    expect(() => PackCheckSchema.parse({ kind: "behavioral", name: "x", task: "t", assertions: [{ type: "nope" }] })).toThrow();
  });

  it("accepts a pack-request carrying checks, and a scaffold-checks response", () => {
    const p = PackRequestSchema.parse({ selection: { all: true }, checks: [{ kind: "external", name: "s", runner: "skillspector" }] });
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
        eve: { supported: 0, skipped: 1 },
      },
    });
    expect(r.files["CLAUDE.md"]).toBe("x");
    expect(r.skipped[0].type).toBe("hook");
  });
});
