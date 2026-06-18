// src/pack/__tests__/targets.test.ts
import { describe, it, expect } from "vitest";
import { materialize, compatibility, TARGET_REGISTRY } from "../targets.js";
import type { Pack, PackArtifact, SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact } from "../types.js";

const pack = (artifacts: PackArtifact[]): Pack => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): SkillArtifact => ({ type: "skill", name: n, source: "standalone", content });
const mcp = (n: string): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "stdio", config: { command: "npx", env: { TOK: "<redacted>" } } });
const instr = (n: string, content = "do this"): InstructionsArtifact => ({ type: "instructions", name: n, content });
const hook = (): HookArtifact => ({ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { matcher: "Bash", hooks: [{ type: "command", command: "x" }] }, source: "user" });

describe("materialize", () => {
  it("claude: SKILL.md, CLAUDE.md, .mcp.json, settings.json hooks; nothing skipped", () => {
    const r = materialize(pack([skill("review"), instr("CLAUDE.md"), mcp("gh"), hook()]), "claude");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["CLAUDE.md"]).toContain("do this");
    expect(JSON.parse(r.files[".mcp.json"]).mcpServers.gh.env.TOK).toBe("<redacted>");
    expect(JSON.parse(r.files["settings.json"]).hooks.PreToolUse).toBeTruthy();
    expect(r.skipped).toEqual([]);
  });

  it("codex: AGENTS.md + config.toml; hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("CLAUDE.md"), mcp("gh"), hook()]), "codex");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["AGENTS.md"]).toContain("do this");
    expect(r.files["config.toml"]).toContain("[mcp_servers.gh]");
    expect(r.files["settings.json"]).toBeUndefined();
    expect(r.skipped.map((s) => s.type)).toEqual(["hook"]);
  });

  it("agents: AGENTS.md + skills; mcp + hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("X"), mcp("gh"), hook()]), "agents");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["AGENTS.md"]).toContain("do this");
    expect(r.files[".mcp.json"]).toBeUndefined();
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("hermes: DESCRIPTION.md + SOUL.md; mcp + hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("X"), mcp("gh"), hook()]), "hermes");
    expect(r.files["skills/review/DESCRIPTION.md"]).toBe("# body");
    expect(r.files["SOUL.md"]).toContain("do this");
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("skips the later of two same-named skills (path collision); first wins", () => {
    const r = materialize(pack([skill("dup", "first"), skill("dup", "second")]), "claude");
    expect(r.files["skills/dup/SKILL.md"]).toBe("first");
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain("collision");
  });

  it("never emits a secret value", () => {
    const r = materialize(pack([mcp("gh")]), "claude");
    expect(r.files[".mcp.json"]).toContain("<redacted>");
    expect(JSON.stringify(r.files)).not.toContain("realsecret");
  });
});

describe("compatibility", () => {
  it("summarizes supported/skipped per target", () => {
    const c = compatibility(pack([skill("a"), hook()]));
    expect(c.claude).toEqual({ supported: 2, skipped: 0 });
    expect(c.codex).toEqual({ supported: 1, skipped: 1 });   // hook unsupported
    expect(c.hermes).toEqual({ supported: 1, skipped: 1 });
    expect(Object.keys(TARGET_REGISTRY).sort()).toEqual(["agents", "claude", "codex", "hermes"]);
  });
});
