// src/gem/__tests__/targets.test.ts
import { describe, it, expect } from "vitest";
import { materialize, compatibility, TARGET_REGISTRY, buildAgentcoreHarness, agentcoreComposeProject } from "../targets.js";
import type { Gem, GemArtifact, SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact } from "../types.js";

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): SkillArtifact => ({ type: "skill", name: n, source: "standalone", content });
const mcp = (n: string): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "stdio", config: { command: "npx", env: { TOK: "<redacted>" } } });
const httpMcp = (n: string, url = "https://mcp.x/sse"): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "http", config: { url }, secretRefs: [{ name: "X_TOKEN", location: "headers.Authorization" }] });
const instr = (n: string, content = "do this"): InstructionsArtifact => ({ type: "instructions", name: n, content });
const hook = (): HookArtifact => ({ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { matcher: "Bash", hooks: [{ type: "command", command: "x" }] }, source: "user" });

describe("materialize", () => {
  it("claude: SKILL.md, CLAUDE.md, .mcp.json, settings.json hooks; nothing skipped", () => {
    const r = materialize(gem([skill("review"), instr("CLAUDE.md"), mcp("gh"), hook()]), "claude");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["CLAUDE.md"]).toContain("do this");
    expect(JSON.parse(r.files[".mcp.json"]).mcpServers.gh.env.TOK).toBe("<redacted>");
    expect(JSON.parse(r.files["settings.json"]).hooks.PreToolUse).toBeTruthy();
    expect(r.skipped).toEqual([]);
  });

  it("codex: AGENTS.md + config.toml; hooks skipped", () => {
    const r = materialize(gem([skill("review"), instr("CLAUDE.md"), mcp("gh"), hook()]), "codex");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["AGENTS.md"]).toContain("do this");
    expect(r.files["config.toml"]).toContain("[mcp_servers.gh]");
    expect(r.files["settings.json"]).toBeUndefined();
    expect(r.skipped.map((s) => s.type)).toEqual(["hook"]);
  });

  it("agents: AGENTS.md + skills; mcp + hooks skipped", () => {
    const r = materialize(gem([skill("review"), instr("X"), mcp("gh"), hook()]), "agents");
    expect(r.files["skills/review/SKILL.md"]).toBe("# body");
    expect(r.files["AGENTS.md"]).toContain("do this");
    expect(r.files[".mcp.json"]).toBeUndefined();
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("hermes: DESCRIPTION.md + SOUL.md; mcp + hooks skipped", () => {
    const r = materialize(gem([skill("review"), instr("X"), mcp("gh"), hook()]), "hermes");
    expect(r.files["skills/review/DESCRIPTION.md"]).toBe("# body");
    expect(r.files["SOUL.md"]).toContain("do this");
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("eve: skills/instructions + http connection; stdio + hooks skipped", () => {
    const r = materialize(gem([skill("review"), instr("X"), httpMcp("linear"), mcp("local"), hook()]), "eve");
    expect(r.files["agent/skills/review.md"]).toBe("# body");
    expect(r.files["agent/instructions.md"]).toContain("do this");
    // http server -> direct remote connection
    const conn = r.files["agent/connections/linear.ts"];
    expect(conn).toContain('url: "https://mcp.x/sse"');
    expect(conn).toContain('process.env["X_TOKEN"]'); // secret as env-var NAME, never a value
    // stdio server -> unsupported (eve connections are URL-only); no connection, no proxy
    expect(r.files["agent/connections/local.ts"]).toBeUndefined();
    expect(r.files["agent/proxies/local.mjs"]).toBeUndefined();
    expect(r.skipped.find((s) => s.artifact === "local")?.reason).toMatch(/stdio MCP unsupported/);
    expect(JSON.stringify(r.files)).not.toContain("<redacted>"); // no secret value anywhere
    // hooks unsupported -> skipped
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("eve: skill name starting with a non-alphanumeric is made eve-valid", () => {
    const r = materialize(gem([skill("_gstack-command")]), "eve");
    expect(r.files["agent/skills/gstack-command.md"]).toBeTruthy();
    expect(r.files["agent/skills/_gstack-command.md"]).toBeUndefined();
  });

  it("eve sanitizes file paths and reports invalid or colliding MCP artifacts", () => {
    const invalid: McpServerArtifact = { type: "mcp_server", name: "missing", transport: "http", config: {} };
    const first = httpMcp("a/b");
    const collision = httpMcp("a?b");
    const r = materialize(gem([skill("../escape"), first, collision, invalid]), "eve");
    expect(r.files["agent/skills/escape.md"]).toBeTruthy();
    expect(r.files["agent/connections/a_b.ts"]).toBeTruthy();
    expect(r.skipped.find((s) => s.artifact === "a?b")?.reason).toMatch(/collision/);
    expect(r.skipped.find((s) => s.artifact === "missing")?.reason).toMatch(/HTTP\/SSE URL/);
    expect(compatibility(gem([first, collision, invalid])).eve).toEqual({ supported: 1, skipped: 2 });
  });

  it("eve: strips disallowed skill frontmatter, keeps only description + body", () => {
    const messy: SkillArtifact = {
      type: "skill", name: "gst", source: "standalone", description: "Use for QA",
      content: "---\nname: gst\npreamble-tier: 1\nallowed-tools:\n  - Bash\nmetadata:\n  priority: 1\n---\n# Body\n\nDo the thing.\n",
    };
    const out = materialize(gem([messy]), "eve").files["agent/skills/gst.md"];
    expect(out).toBe('---\ndescription: "Use for QA"\n---\n# Body\n\nDo the thing.\n');
    expect(out).not.toContain("preamble-tier");
    expect(out).not.toContain("allowed-tools");
  });

  it("eve: skill with no description emits the body alone (no frontmatter)", () => {
    const plain: SkillArtifact = { type: "skill", name: "p", source: "standalone", content: "# Just body\n" };
    expect(materialize(gem([plain]), "eve").files["agent/skills/p.md"]).toBe("# Just body\n");
  });

  it("eve maps non-Bearer header secrets with bracket-safe environment access", () => {
    const server: McpServerArtifact = {
      type: "mcp_server", name: "api", transport: "http", config: { url: "https://mcp.x/mcp" },
      secretRefs: [{ name: "X-API-KEY", location: "headers.X-Api-Key" }],
    };
    const connection = materialize(gem([server]), "eve").files["agent/connections/api.ts"];
    expect(connection).toContain('"X-Api-Key": process.env["X-API-KEY"]');
    expect(connection).not.toContain("getToken");
  });

  it("skips the later of two same-named skills (path collision); first wins", () => {
    const r = materialize(gem([skill("dup", "first"), skill("dup", "second")]), "claude");
    expect(r.files["skills/dup/SKILL.md"]).toBe("first");
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain("collision");
  });

  it("never emits a secret value", () => {
    const r = materialize(gem([mcp("gh")]), "claude");
    expect(r.files[".mcp.json"]).toContain("<redacted>");
    expect(JSON.stringify(r.files)).not.toContain("realsecret");
  });
});

describe("flue target (deployable cloudflare project)", () => {
  it("emits src/ layout, flue.config.ts, package.json, wrangler.jsonc with DO migration", () => {
    const p: Gem = { name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind"),
      hook(),
    ] };
    const r = materialize(p, "flue");
    expect(r.files["src/skills/review/SKILL.md"]).toContain("# Review");
    const agent = r.files["src/agents/my-gem.ts"];
    expect(agent).toContain('import { createAgent');
    expect(agent).toContain('import skill0 from "../skills/review/SKILL.md" with { type: "skill" }');
    expect(agent).toContain("skills: [skill0]");
    expect(agent).toContain("be kind");
    expect(agent).toContain('model: "anthropic/claude-sonnet-4-6"');
    expect(agent).not.toContain("Look");
    // flue.config.ts
    expect(r.files["flue.config.ts"]).toContain('defineConfig({ target: "cloudflare" })');
    // package.json: type module + required deps
    const pkg = JSON.parse(r.files["package.json"]);
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("my-gem");
    expect(pkg.dependencies).toMatchObject({ "@flue/runtime": expect.any(String), valibot: expect.any(String), agents: expect.any(String) });
    expect(pkg.devDependencies).toMatchObject({ "@flue/cli": expect.any(String), wrangler: expect.any(String) });
    // wrangler.jsonc: name + nodejs_compat + DO migration including the agent's class
    const wr = JSON.parse(r.files["wrangler.jsonc"]);
    expect(wr.name).toBe("my-gem");
    expect(wr.compatibility_flags).toContain("nodejs_compat");
    expect(wr.migrations[0].new_sqlite_classes).toEqual(expect.arrayContaining(["FlueRegistry", "FlueMyGemAgent"]));
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("compatibility includes a flue entry", () => {
    const p: Gem = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] };
    expect(compatibility(p).flue).toBeTruthy();
  });
});

describe("flue MCP connections (src/ layout)", () => {
  it("http server -> a connectMcpServer connection with env auth, no secret value", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [httpMcp("ctx")] }, "flue");
    const c = r.files["src/connections/ctx.ts"];
    expect(c).toContain('import { connectMcpServer } from "@flue/runtime"');
    expect(c).toContain('connectMcpServer("ctx"');
    expect(c).toContain("https://mcp.x/sse");
    expect(c).toContain('process.env["X_TOKEN"]');
    expect(JSON.stringify(r.files)).not.toContain("secret-value");
  });

  it("sse server -> transport: \"sse\"", () => {
    const sse: McpServerArtifact = { type: "mcp_server", name: "leg", transport: "sse", config: { url: "https://leg/sse" } };
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [sse] }, "flue");
    expect(r.files["src/connections/leg.ts"]).toContain('transport: "sse"');
  });

  it("stdio server -> a proxy runner plus a localhost connection", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [mcp("gh")] }, "flue");
    expect(r.files["src/proxies/gh.mjs"]).toBeTruthy();
    expect(r.files["src/connections/gh.ts"]).toContain("http://127.0.0.1:");
    expect(r.files["src/connections/gh.ts"]).toContain("/mcp");
    expect(r.skipped).toEqual([]);
  });
});

describe("flue MCP wiring (connections reach the agent)", () => {
  it("imports each emitted connection and awaits its tools into the agent (async initializer)", () => {
    const r = materialize({ name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review"), httpMcp("ctx"), mcp("gh"),
    ] }, "flue");
    const agent = r.files["src/agents/my-gem.ts"];
    expect(agent).toContain('import conn0 from "../connections/ctx.ts"');
    expect(agent).toContain('import conn1 from "../connections/gh.ts"');
    expect(agent).toContain("await Promise.all([conn0(), conn1()])");
    expect(agent).toContain("tools: connections.flatMap((c) => c.tools)");
  });
});

describe("openai-sandbox target (agent file + skills)", () => {
  it("emits <gemname>.agent.ts (SandboxAgent + manifest + capabilities) and skill files; hooks + mcp skipped in v1-step1", () => {
    const p: Gem = { name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind\n`here` and ${there}."),
      hook(),
    ] };
    const r = materialize(p, "openai-sandbox");
    expect(r.files["skills/review/SKILL.md"]).toContain("# Review");
    const agent = r.files["my_gem.agent.ts"];
    expect(agent).toContain('from "@openai/agents/sandbox"');
    expect(agent).toContain("new SandboxAgent({");
    expect(agent).toContain('model: "gpt-5.5"');
    expect(agent).toContain("capabilities: [shell(), filesystem(), skills(), compaction()]");
    expect(agent).toContain('localDir({ from: "skills", readOnly: true })');
    expect(agent).toContain("be kind");                          // instructions folded in
    expect(agent).not.toContain("Look");                          // skill body NOT inlined
    expect(agent).toContain("\\`here\\`");                        // template escaping
    expect(agent).toContain("\\${there}");
    expect(r.skipped.find((s) => s.type === "instructions")).toBeUndefined();
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("no-skills gem -> capabilities without skills() and an empty manifest", () => {
    const p: Gem = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [instr("i", "hi")] };
    const agent = materialize(p, "openai-sandbox").files["p.agent.ts"];
    expect(agent).toContain("capabilities: [shell(), filesystem(), compaction()]");
    expect(agent).not.toContain("skills()");
    expect(agent).toContain("new Manifest({ entries: {} })");
  });

  it("compatibility includes an openai-sandbox entry", () => {
    expect(compatibility({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] })["openai-sandbox"]).toBeTruthy();
  });
});

describe("openai-sandbox MCP (inline, native stdio)", () => {
  it("http server -> inline MCPServerStreamableHttp with env auth, no secret value", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [httpMcp("ctx")] }, "openai-sandbox");
    const agent = r.files["p.agent.ts"];
    expect(agent).toContain('import { MCPServerStreamableHttp } from "@openai/agents"');
    expect(agent).toContain("new MCPServerStreamableHttp({");
    expect(agent).toContain("https://mcp.x/sse");
    expect(agent).toContain('requestInit: { headers: { "Authorization": process.env["X_TOKEN"]! } }');
    expect(JSON.stringify(r.files)).not.toContain("secret-value");
    expect(r.skipped).toEqual([]);                                // mcp not skip-reported
  });

  it("stdio server -> inline MCPServerStdio (native, no proxy file)", () => {
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [mcp("gh")] }, "openai-sandbox");
    const agent = r.files["p.agent.ts"];
    expect(agent).toContain('import { MCPServerStdio } from "@openai/agents"');
    expect(agent).toContain("new MCPServerStdio({");
    expect(agent).toContain('command: "npx"');
    expect(Object.keys(r.files).some((k) => k.startsWith("proxies/"))).toBe(false); // native: NO proxy
  });

  it("a non-header MCP secret is skipped with a reason; no mcp import when none map", () => {
    const bad: McpServerArtifact = { type: "mcp_server", name: "weird", transport: "http", config: { url: "https://w/sse" }, secretRefs: [{ name: "K", location: "query.key" }] };
    const r = materialize({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [bad] }, "openai-sandbox");
    expect(r.skipped.find((s) => s.artifact === "weird")).toBeTruthy();
    expect(r.files["p.agent.ts"]).not.toContain('from "@openai/agents"'); // no MCP import when none mapped
  });
});

describe("eve compose (runnable project scaffold)", () => {
  it("eve: compose emits a runnable project scaffold", () => {
    const r = materialize(gem([skill("review")]), "eve");
    const pkg = JSON.parse(r.files["package.json"]);
    expect(pkg.name).toBe("p");                       // from gem name "p"
    expect(pkg.engines.node).toBe("24.x");
    expect(pkg.dependencies.eve).toBe("^0.11.7");
    expect(pkg.dependencies.microsandbox).toBe("^0.5.0");
    expect(pkg.dependencies.ai).toBe("7.0.0-beta.178");
    expect(pkg.scripts.start).toBe("eve start");
    expect(r.files["agent/agent.ts"]).toContain('model: "anthropic/claude-sonnet-4.6"');
    expect(r.files["agent/agent.ts"]).toContain('defineAgent');
    expect(r.files["agent/channels/eve.ts"]).toContain("eveChannel");
    expect(r.files["tsconfig.json"]).toContain('"moduleResolution": "NodeNext"');
    expect(r.files[".gitignore"]).toContain(".eve");
    expect(r.files[".vercelignore"]).toContain("node_modules");
  });
});

describe("buildAgentcoreHarness", () => {
  it("maps instructions->systemPrompt, http MCP->remote_mcp, skills->path, defaults the model", () => {
    const g = gem([skill("scrape"), httpMcp("exa"), instr("CLAUDE.md", "be terse")]);
    const { harness, skipped } = buildAgentcoreHarness(g);
    expect(harness.model).toEqual({ bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-4-6" } });
    expect(harness.systemPrompt).toEqual([{ text: expect.stringContaining("be terse") }]);
    expect(harness.skills).toEqual([{ path: ".agents/skills/scrape" }]);
    const tools = harness.tools as Array<{ type: string; name: string; config: { remoteMcp: { url: string; headers: Record<string, string> } } }>;
    expect(tools[0]).toMatchObject({ type: "remote_mcp", name: "exa", config: { remoteMcp: { url: "https://mcp.x/sse" } } });
    // secret header is a token-vault placeholder, never a raw value
    expect(tools[0].config.remoteMcp.headers.Authorization).toMatch(/^\$\{arn:aws:bedrock-agentcore:.*apikeycredentialprovider\/X_TOKEN\}$/);
    expect(skipped).toHaveLength(0);
    expect(JSON.stringify(harness)).not.toContain("<redacted>");
  });

  it("skips stdio MCP with a reason and omits empty sections", () => {
    const { harness, skipped } = buildAgentcoreHarness(gem([mcp("local")]));
    expect(skipped).toContainEqual({ artifact: "local", type: "mcp_server", reason: expect.stringContaining("stdio") });
    expect(harness.tools).toBeUndefined();        // no mapped tools -> key omitted
    expect(harness.systemPrompt).toBeUndefined();  // no instructions -> key omitted
    expect(harness.skills).toBeUndefined();        // no skills -> key omitted
  });
  it("dedupes harness.skills by path when two names collapse to the same segment", () => {
    // "a b" and "a/b" both safePathSegment -> "a_b"
    const { harness } = buildAgentcoreHarness(gem([skill("a b"), skill("a/b")]));
    expect(harness.skills).toEqual([{ path: ".agents/skills/a_b" }]);
  });
});

describe("compatibility", () => {
  it("summarizes supported/skipped per target", () => {
    const c = compatibility(gem([skill("a"), hook()]));
    expect(c.claude).toEqual({ supported: 2, skipped: 0 });
    expect(c.codex).toEqual({ supported: 1, skipped: 1 });   // hook unsupported
    expect(c.hermes).toEqual({ supported: 1, skipped: 1 });
    expect(c.eve).toEqual({ supported: 1, skipped: 1 }); // skill ok, hook unsupported
    expect(Object.keys(TARGET_REGISTRY).sort()).toEqual(["agentcore", "agents", "claude", "codex", "eve", "flue", "hermes", "openai-sandbox"]);
  });
});

describe("agentcoreComposeProject", () => {
  it("emits harness.json, scaffold, Dockerfile COPY, and a SECRETS checklist", () => {
    const g = { ...gem([skill("scrape"), httpMcp("exa")]), requiredSecrets: [{ name: "X_TOKEN", artifact: "exa", location: "headers.Authorization" }] };
    const { files, skipped } = agentcoreComposeProject(g);
    // CLI harness.json format: model {provider, modelId}, system prompt in a sibling file (not inline).
    const harness = JSON.parse(files["app/p/harness.json"]);
    expect(harness.model).toEqual({ provider: "bedrock", modelId: "global.anthropic.claude-sonnet-4-6" });
    expect(harness.systemPrompt).toBeUndefined();
    expect(files["app/p/system-prompt.md"]).toBeDefined();
    const proj = JSON.parse(files["agentcore/agentcore.json"]);
    expect(proj.name).toBe("p");
    expect(proj.version).toBe(1);
    expect(proj.harnesses).toEqual([{ name: "p", path: "app/p" }]);
    expect(files["agentcore/aws-targets.json"]).toBe("[]\n");
    expect(files["Dockerfile"]).toContain("COPY .agents/skills/ .agents/skills/");
    expect(files["SECRETS.md"]).toContain("agentcore add credential");
    expect(files["SECRETS.md"]).toContain("X_TOKEN");
    expect(skipped).toHaveLength(0);
    expect(JSON.stringify(files)).not.toContain("<redacted>");
  });
});

describe("materialize agentcore", () => {
  it("renders skill files under .agents/skills, harness.json, and reports stdio MCP + hooks skipped", () => {
    const g = gem([skill("scrape", "---\nname: scrape\n---\n# body"), httpMcp("exa"), mcp("local"), instr("CLAUDE.md"), hook()]);
    const { files, skipped } = materialize(g, "agentcore");
    expect(files[".agents/skills/scrape/SKILL.md"]).toContain("# body");
    const harness = JSON.parse(files["app/p/harness.json"]);
    expect(harness.skills).toEqual([{ path: ".agents/skills/scrape" }]);
    expect((harness.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["exa"]); // http only
    const reasons = skipped.map((s) => `${s.artifact}:${s.reason}`);
    expect(reasons.some((r) => r.startsWith("local:") && /stdio/.test(r))).toBe(true);
    expect(reasons.some((r) => r.startsWith("PreToolUse · Bash:"))).toBe(true); // hook unsupported
    expect(JSON.stringify(files)).not.toContain("<redacted>");
  });
});
