// tests/gem/buildGem.test.ts
import { describe, it, expect } from "vitest";
import { buildGem } from "../buildGem.js";
import type { ConfigInventory } from "../types.js";

const inv: ConfigInventory = {
  skills: [
    { type: "skill", name: "review", source: "standalone", content: "a" },
    { type: "skill", name: "plan", source: "standalone", content: "b" },
  ],
  mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { GH_TOKEN: "<redacted>" } }, secretRefs: [{ name: "GH_TOKEN", location: "env.GH_TOKEN" }] }],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [] }, source: "user" }],
};

describe("buildGem", () => {
  it("selects a named subset and includes instructions when asked", () => {
    const gem = buildGem(inv, { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, { name: "p", createdFrom: "/d" });
    expect(gem.name).toBe("p");
    expect(gem.createdFrom).toBe("/d");
    expect(gem.artifacts.map((a) => a.type)).toEqual(["skill", "mcp_server", "instructions"]);
    expect(gem.artifacts.map((a) => a.name)).toEqual(["review", "gh", "CLAUDE.md"]);
  });

  it("excludes instructions when not requested", () => {
    const gem = buildGem(inv, { skills: ["review"] });
    expect(gem.artifacts.some((a) => a.type === "instructions")).toBe(false);
  });

  it("{ all: true } includes everything", () => {
    const gem = buildGem(inv, { all: true });
    expect(gem.artifacts.length).toBe(5); // 2 skills + 1 mcp + 1 instructions + 1 hook
  });

  it("selects a hook by name", () => {
    const gem = buildGem(inv, { hooks: ["PreToolUse · Bash"] });
    expect(gem.artifacts.map((a) => a.type)).toEqual(["hook"]);
    expect(gem.artifacts[0].name).toBe("PreToolUse · Bash");
  });

  it("throws listing available names on an unknown selection", () => {
    expect(() => buildGem(inv, { skills: ["nope"] })).toThrow(/Available: review, plan/);
  });

  it("rejects a selection referencing a missing artifact as 400 InvalidInputError, not a 500", () => {
    // A selection that names an artifact absent from the inventory is a bad REQUEST
    // (e.g. suggest-from-a-project offered a skill that isn't materializable for that
    // project), so it must surface as a 400 with the actionable message — not an opaque 500.
    const expect400 = (fn: () => unknown) => {
      let err: any;
      try { fn(); } catch (e) { err = e; }
      expect(err, "expected a throw").toBeDefined();
      expect(err.name).toBe("InvalidInputError");
      expect(err.statusCode).toBe(400);
      return err;
    };
    expect400(() => buildGem(inv, { skills: ["nope"] }));
    expect400(() => buildGem(inv, { mcpServers: ["nope"] }));
    expect400(() => buildGem(inv, { hooks: ["nope"] }));
    // The reproduced agentback case: a project-scoped skill absent from the project's inventory.
    const withProj: ConfigInventory = { ...inv, projects: [{ root: "/p/agentback", name: "agentback", skills: [], mcpServers: [], instructions: [], hooks: [] }] };
    const e = expect400(() => buildGem(withProj, { projects: { "/p/agentback": { skills: ["agentback"] } } }));
    expect(e.message).toMatch(/No skill 'agentback' in project 'agentback'/);
    // Unknown project root is also a bad request.
    expect400(() => buildGem(inv, { projects: { "/nope": { skills: ["x"] } } }));
  });

  it("embeds operator checks and defaults to empty when none given", () => {
    const withChecks = buildGem(inv, { skills: ["review"] }, {
      checks: [{ kind: "behavioral", name: "smoke", task: "do it", assertions: [] }],
    });
    expect(withChecks.checks.map((c) => c.name)).toEqual(["smoke"]);
    expect(buildGem(inv, { skills: ["review"] }).checks).toEqual([]);
  });

  it("aggregates requiredSecrets from selected artifacts only (names, never values)", () => {
    const withMcp = buildGem(inv, { mcpServers: ["gh"] });
    expect(withMcp.requiredSecrets).toEqual([{ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" }]);
    // a selection without the gh server carries no secret requirement
    expect(buildGem(inv, { skills: ["review"] }).requiredSecrets).toEqual([]);
  });

  it("preserves benign task prose while still scrubbing real secret tokens", () => {
    const gem = buildGem(inv, { skills: ["review"] }, {
      checks: [{ kind: "behavioral", name: "smoke", task: "test bearer authentication flow", assertions: [] }],
    });
    expect((gem.checks[0] as { task: string }).task).toBe("test bearer authentication flow");
  });

  it("redacts a secret accidentally embedded in operator check text", () => {
    const gem = buildGem(inv, { skills: ["review"] }, {
      checks: [{ kind: "behavioral", name: "smoke", task: "use token ghp_abcdefghijklmnopqrstuvwxyz0123", assertions: [] }],
    });
    expect(JSON.stringify(gem.checks)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  // Defense in depth: a RAW inventory (mcp config with real secret, secretRefs undefined — as
  // introspectConfig({redact:false}) produces) must still yield a redacted gem, even via {all:true}.
  it("re-redacts raw artifacts that arrive without secretRefs (e.g. all:true over a raw inventory)", () => {
    const rawInv: ConfigInventory = {
      skills: [], instructions: [], hooks: [],
      mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { GH_TOKEN: "ghp_realsecretvalue" } }, source: "user" }],
    };
    const gem = buildGem(rawInv, { all: true }, { name: "g" });
    expect(JSON.stringify(gem)).not.toContain("ghp_realsecretvalue");           // raw value scrubbed
    expect(gem.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
  });

  it("leaves already-redacted artifacts (secretRefs present) untouched", () => {
    const gem = buildGem(inv, { mcpServers: ["gh"] }, { name: "g" });
    const mcp = gem.artifacts.find((a) => a.type === "mcp_server");
    const env = (mcp as { config: Record<string, Record<string, string>> }).config.env;
    expect(env.GH_TOKEN).toBe("<redacted>");
    expect(gem.requiredSecrets).toEqual([{ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" }]); // no dup
  });

  describe("declared channels", () => {
    const emptyInv = { skills: [], mcpServers: [], instructions: [], hooks: [] };

    it("adds a channel artifact and aggregates its secrets into requiredSecrets", () => {
      const gem = buildGem(emptyInv, { all: false }, { channels: [{ platform: "slack" }] });
      const ch = gem.artifacts.find((a) => a.type === "channel");
      expect(ch).toMatchObject({ type: "channel", platform: "slack", name: "slack" });
      expect(gem.requiredSecrets).toContainEqual({ name: "SLACK_BOT_TOKEN", artifact: "slack", location: "env.SLACK_BOT_TOKEN" });
    });

    it("adds no channels when none are declared", () => {
      const gem = buildGem(emptyInv, { all: false }, {});
      expect(gem.artifacts.some((a) => a.type === "channel")).toBe(false);
    });
  });
});
