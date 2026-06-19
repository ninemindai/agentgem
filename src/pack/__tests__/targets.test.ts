// src/pack/__tests__/targets.test.ts
import { describe, it, expect } from "vitest";
import { materialize, compatibility, TARGET_REGISTRY } from "../targets.js";
import type { Pack, PackArtifact, SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact } from "../types.js";

const pack = (artifacts: PackArtifact[]): Pack => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): SkillArtifact => ({ type: "skill", name: n, source: "standalone", content });
const mcp = (n: string): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "stdio", config: { command: "npx", env: { TOK: "<redacted>" } } });
const httpMcp = (n: string, url = "https://mcp.x/sse"): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "http", config: { url }, secretRefs: [{ name: "X_TOKEN", location: "headers.Authorization" }] });
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

  it("eve: skills/instructions + http connection + stdio proxy runner; hooks skipped", () => {
    const r = materialize(pack([skill("review"), instr("X"), httpMcp("linear"), mcp("local"), hook()]), "eve");
    expect(r.files["agent/skills/review.md"]).toBe("# body");
    expect(r.files["agent/instructions.md"]).toContain("do this");
    // http server -> direct remote connection
    const conn = r.files["agent/connections/linear.ts"];
    expect(conn).toContain('url: "https://mcp.x/sse"');
    expect(conn).toContain('process.env["X_TOKEN"]'); // secret as env-var NAME, never a value
    // stdio server -> a localhost connection + a generated proxy runner
    expect(r.files["agent/connections/local.ts"]).toContain("url: \"http://127.0.0.1:7800/mcp\"");
    const proxy = r.files["agent/proxies/local.mjs"];
    expect(proxy).toContain("StdioClientTransport");
    expect(proxy).toContain('command: "npx"');
    expect(proxy).toContain("7800");
    expect(r.files["agent/connections/local.proxy.mjs"]).toBeUndefined();
    expect(JSON.stringify(r.files)).not.toContain("<redacted>"); // no secret value anywhere
    // hooks unsupported -> skipped
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("eve sanitizes file paths and reports invalid or colliding MCP artifacts", () => {
    const invalid: McpServerArtifact = { type: "mcp_server", name: "missing", transport: "http", config: {} };
    const first = httpMcp("a/b");
    const collision = httpMcp("a?b");
    const r = materialize(pack([skill("../escape"), first, collision, invalid]), "eve");
    expect(r.files["agent/skills/.._escape.md"]).toBeTruthy();
    expect(r.files["agent/connections/a_b.ts"]).toBeTruthy();
    expect(r.skipped.find((s) => s.artifact === "a?b")?.reason).toMatch(/collision/);
    expect(r.skipped.find((s) => s.artifact === "missing")?.reason).toMatch(/no usable URL/);
    expect(compatibility(pack([first, collision, invalid])).eve).toEqual({ supported: 1, skipped: 2 });
  });

  it("eve maps non-Bearer header secrets with bracket-safe environment access", () => {
    const server: McpServerArtifact = {
      type: "mcp_server", name: "api", transport: "http", config: { url: "https://mcp.x/mcp" },
      secretRefs: [{ name: "X-API-KEY", location: "headers.X-Api-Key" }],
    };
    const connection = materialize(pack([server]), "eve").files["agent/connections/api.ts"];
    expect(connection).toContain('"X-Api-Key": process.env["X-API-KEY"]');
    expect(connection).not.toContain("getToken");
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

describe("flue target (agent file + skills)", () => {
  it("emits agents/<packname>.ts importing skills + folding instructions; hooks skipped", () => {
    const p: Pack = { name: "my pack", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind"),
      hook(),
    ] };
    const r = materialize(p, "flue");
    // skill body reuses the shared SKILL.md convention
    expect(r.files["skills/review/SKILL.md"]).toContain("# Review");
    // the composed agent file
    const agent = r.files["agents/my_pack.ts"];
    expect(agent).toContain('import { createAgent');
    expect(agent).toContain('import skill0 from "../skills/review/SKILL.md" with { type: "skill" }');
    expect(agent).toContain("skills: [skill0]");
    expect(agent).toContain("be kind");                 // instructions folded in
    expect(agent).toContain('model: "anthropic/claude-sonnet-4-6"');
    // skill body lives in the SKILL.md file, NOT inlined into the agent file
    expect(r.files["skills/review/SKILL.md"]).toContain("# Review");
    expect(agent).not.toContain("Look");
    // instructions are NOT reported skipped (they're composed, not dropped)
    expect(r.skipped.find((s) => s.type === "instructions")).toBeUndefined();
    // hooks unsupported -> skipped
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("compatibility includes a flue entry", () => {
    const p: Pack = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] };
    expect(compatibility(p).flue).toBeTruthy();
  });
});

describe("flue MCP connections", () => {
  it("http server -> a connectMcpServer connection with env auth, no secret value", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [httpMcp("ctx")] }, "flue");
    const c = r.files["connections/ctx.ts"];
    expect(c).toContain('import { connectMcpServer } from "@flue/runtime"');
    expect(c).toContain('connectMcpServer("ctx"');
    expect(c).toContain("https://mcp.x/sse");
    expect(c).toContain('process.env["X_TOKEN"]');     // auth by env name
    expect(JSON.stringify(r.files)).not.toContain("secret-value"); // no value leaks
  });

  it("sse server -> transport: \"sse\"", () => {
    const sse: McpServerArtifact = { type: "mcp_server", name: "leg", transport: "sse", config: { url: "https://leg/sse" } };
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [sse] }, "flue");
    expect(r.files["connections/leg.ts"]).toContain('transport: "sse"');
  });

  it("stdio server -> a proxy runner plus a localhost connection", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [mcp("gh")] }, "flue");
    expect(r.files["proxies/gh.mjs"]).toBeTruthy();
    expect(r.files["connections/gh.ts"]).toContain("http://127.0.0.1:");
    expect(r.files["connections/gh.ts"]).toContain("/mcp");
    expect(r.skipped).toEqual([]);
  });
});

describe("openai-sandbox target (agent file + skills)", () => {
  it("emits <packname>.agent.ts (SandboxAgent + manifest + capabilities) and skill files; hooks + mcp skipped in v1-step1", () => {
    const p: Pack = { name: "my pack", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind\n`here` and ${there}."),
      hook(),
    ] };
    const r = materialize(p, "openai-sandbox");
    expect(r.files["skills/review/SKILL.md"]).toContain("# Review");
    const agent = r.files["my_pack.agent.ts"];
    expect(agent).toContain('from "@openai/agents/sandbox"');
    expect(agent).toContain("new SandboxAgent({");
    expect(agent).toContain('model: "gpt-5.5"');
    expect(agent).toContain("capabilities: [shell(), filesystem(), skills()]");
    expect(agent).toContain('localDir({ from: "skills", readOnly: true })');
    expect(agent).toContain("be kind");                          // instructions folded in
    expect(agent).not.toContain("Look");                          // skill body NOT inlined
    expect(agent).toContain("\\`here\\`");                        // template escaping
    expect(agent).toContain("\\${there}");
    expect(r.skipped.find((s) => s.type === "instructions")).toBeUndefined();
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("no-skills pack -> capabilities without skills() and an empty manifest", () => {
    const p: Pack = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [instr("i", "hi")] };
    const agent = materialize(p, "openai-sandbox").files["p.agent.ts"];
    expect(agent).toContain("capabilities: [shell(), filesystem()]");
    expect(agent).not.toContain("skills()");
    expect(agent).toContain("new Manifest({ entries: {} })");
  });

  it("compatibility includes an openai-sandbox entry", () => {
    expect(compatibility({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] })["openai-sandbox"]).toBeTruthy();
  });
});

describe("compatibility", () => {
  it("summarizes supported/skipped per target", () => {
    const c = compatibility(pack([skill("a"), hook()]));
    expect(c.claude).toEqual({ supported: 2, skipped: 0 });
    expect(c.codex).toEqual({ supported: 1, skipped: 1 });   // hook unsupported
    expect(c.hermes).toEqual({ supported: 1, skipped: 1 });
    expect(c.eve).toEqual({ supported: 1, skipped: 1 }); // skill ok, hook unsupported
    expect(Object.keys(TARGET_REGISTRY).sort()).toEqual(["agents", "claude", "codex", "eve", "flue", "hermes", "openai-sandbox"]);
  });
});
