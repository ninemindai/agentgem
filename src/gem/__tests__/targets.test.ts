// src/gem/__tests__/targets.test.ts
import { describe, it, expect } from "vitest";
import { materialize, compatibility, TARGET_REGISTRY, buildAgentcoreHarness, agentcoreComposeProject, a2aAgentCard } from "../targets.js";
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

  it("eve: keeps Eve-allowed frontmatter (description/metadata/license) verbatim, strips the rest", () => {
    const messy: SkillArtifact = {
      type: "skill", name: "gst", source: "standalone", description: "Use for QA",
      content: "---\nname: gst\npreamble-tier: 1\nversion: 1.1.0\nallowed-tools:\n  - Bash\nmetadata:\n  priority: 1\nlicense: MIT\n---\n# Body\n\nDo the thing.\n",
    };
    const out = materialize(gem([messy]), "eve").files["agent/skills/gst.md"];
    // Eve-allowed keys preserved verbatim (metadata block + license were dropped before)
    expect(out).toContain("metadata:\n  priority: 1");
    expect(out).toContain("license: MIT");
    // disallowed keys stripped
    expect(out).not.toContain("preamble-tier");
    expect(out).not.toContain("allowed-tools");
    expect(out).not.toContain("version:");
    expect(out).not.toMatch(/^name:/m);
    expect(out.endsWith("---\n# Body\n\nDo the thing.\n")).toBe(true);
  });

  it("eve: preserves an existing description verbatim — no double-quoting", () => {
    const s: SkillArtifact = {
      type: "skill", name: "browse", source: "standalone",
      description: "Fast headless browser for QA testing and site dogfooding. (gstack)",
      content: "---\nname: browse\nversion: 1.1.0\ndescription: Fast headless browser for QA testing and site dogfooding. (gstack)\nallowed-tools:\n  - Bash\n---\n# Browse\n",
    };
    const out = materialize(gem([s]), "eve").files["agent/skills/browse.md"];
    expect(out).toContain("description: Fast headless browser for QA testing and site dogfooding. (gstack)");
    expect(out).not.toContain('\\"');      // not double-quoted/escaped
    expect(out).not.toContain("allowed-tools");
  });

  it("eve: preserves a multi-line block-scalar description", () => {
    const s: SkillArtifact = {
      type: "skill", name: "human-edit", source: "standalone", description: "Remove signs of AI writing.",
      content: "---\nname: human-edit\ndescription: |\n  Remove signs of AI-generated writing from text.\n  Use when editing or revising.\nallowed-tools:\n  - Read\n---\n# Human Edit\n",
    };
    const out = materialize(gem([s]), "eve").files["agent/skills/human-edit.md"];
    expect(out).toContain("description: |\n  Remove signs of AI-generated writing from text.\n  Use when editing or revising.");
    expect(out).not.toContain("allowed-tools");
  });

  it("eve: injects description from the artifact when the frontmatter has none", () => {
    const s: SkillArtifact = {
      type: "skill", name: "n", source: "standalone", description: "Use for QA",
      content: "---\nname: n\nallowed-tools:\n  - Bash\n---\n# Body\n",
    };
    const out = materialize(gem([s]), "eve").files["agent/skills/n.md"];
    expect(out).toContain('description: "Use for QA"');
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
    expect(pkg.dependencies.eve).toBe("^0.15.0");
    expect(pkg.dependencies.microsandbox).toBe("^0.5.0");
    expect(pkg.dependencies.ai).toBe("7.0.2");
    expect(pkg.scripts.start).toBe("eve start");
    expect(r.files["agent/agent.ts"]).toContain('model: "anthropic/claude-sonnet-4.6"');
    expect(r.files["agent/agent.ts"]).toContain('defineAgent');
    expect(r.files["agent/channels/eve.ts"]).toContain("eveChannel");
    expect(r.files["tsconfig.json"]).toContain('"moduleResolution": "NodeNext"');
    expect(r.files[".gitignore"]).toContain(".eve");
    expect(r.files[".vercelignore"]).toContain("node_modules");
  });

  it("eve channel auth: default is placeholder; opts.eveAuth='public' uses none()", () => {
    const def = materialize(gem([skill("review")]), "eve").files["agent/channels/eve.ts"];
    expect(def).toContain("placeholderAuth()");
    const pub = materialize(gem([skill("review")]), "eve", { eveAuth: "public" }).files["agent/channels/eve.ts"];
    expect(pub).toContain("none()");
    expect(pub).not.toContain("placeholderAuth");        // public chain drops the placeholder entirely
  });

  it("emits a default agent/instructions.md when the gem has no instructions (eve build requires it)", () => {
    const r = materialize(gem([skill("review")]), "eve");
    expect(r.files["agent/instructions.md"]).toBeTruthy();
    expect(r.files["agent/instructions.md"]).toContain("No instructions were included");
  });

  it("uses the gem's own instructions (no default, no collision) when present", () => {
    const r = materialize(gem([skill("review"), instr("X", "do this")]), "eve");
    expect(r.files["agent/instructions.md"]).toContain("do this");
    expect(r.files["agent/instructions.md"]).not.toContain("No instructions were included");
    expect(r.skipped.find((s) => s.type === "instructions")).toBeUndefined(); // not dropped via collision
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
    expect(Object.keys(TARGET_REGISTRY).sort()).toEqual(["a2a", "agentcore", "agents", "claude", "codex", "eve", "flue", "hermes", "openai-sandbox"]);
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

describe("materialize a2a (Agent Card primitive)", () => {
  it("emits exactly agent-card.json with no runtime files", () => {
    const r = materialize(gem([skill("review"), instr("CLAUDE.md")]), "a2a");
    expect(Object.keys(r.files)).toEqual(["agent-card.json"]);
    expect(r.files["src/server.ts"]).toBeUndefined();
    expect(r.files["package.json"]).toBeUndefined();
    expect(r.files["SECRETS.md"]).toBeUndefined();
  });

  it("derives a valid card: one skill entry per gem skill, description from first instruction line, streaming false", () => {
    const r = materialize(gem([skill("review"), skill("scrape"), instr("CLAUDE.md", "# Heading\n\nReview and scrape things.")]), "a2a");
    const card = JSON.parse(r.files["agent-card.json"]);
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.name).toBe("p");
    expect(card.description).toBe("Review and scrape things.");
    expect(card.capabilities.streaming).toBe(false);
    expect(card.skills.map((s: { name: string }) => s.name)).toEqual(["review", "scrape"]);
    expect(card.skills.every((s: { tags: string[] }) => s.tags.includes("skill"))).toBe(true);
  });

  it("synthesizes a chat skill when the gem has no skills (A2A requires >=1)", () => {
    const r = materialize(gem([instr("CLAUDE.md")]), "a2a");
    const card = JSON.parse(r.files["agent-card.json"]);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("chat");
  });

  it("card-only honestly reports MCP and hooks as skipped (a Card models neither)", () => {
    const r = materialize(gem([skill("review"), mcp("local"), httpMcp("linear"), hook()]), "a2a");
    expect(Object.keys(r.files)).toEqual(["agent-card.json"]);
    // skills are represented (card skills[]); MCP + hooks are not expressible by a Card.
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server", "mcp_server"]);
    expect(r.skipped.find((s) => s.type === "mcp_server")?.reason).toMatch(/Agent Card/);
  });

  it("compatibility scores a2a card-only: skills supported, MCP + hooks skipped", () => {
    const c = compatibility(gem([skill("review"), mcp("local"), hook()]));
    expect(c.a2a).toEqual({ supported: 1, skipped: 2 });
  });

  it("a2aAgentCard is pure, emits no secret values, and carries no localhost url", () => {
    const card = a2aAgentCard(gem([skill("review"), httpMcp("linear")]));
    expect(JSON.stringify(card)).not.toContain("<redacted>");
    expect(String(card.url)).not.toContain("localhost"); // a published card must not point at the consumer's machine
  });

  it("a2aFirstLine: keeps a prose line starting with '#' (only ATX headings are skipped) and bounds length", () => {
    const hashtag = materialize(gem([instr("CLAUDE.md", "#launch is live now")]), "a2a");
    expect(JSON.parse(hashtag.files["agent-card.json"]).description).toBe("#launch is live now");
    const long = "word ".repeat(80).trim();
    const bounded = materialize(gem([instr("CLAUDE.md", long)]), "a2a");
    const desc = JSON.parse(bounded.files["agent-card.json"]).description as string;
    expect(desc.length).toBeLessThanOrEqual(201);
    expect(desc.endsWith("…")).toBe(true);
  });
});

describe("materialize a2a server mode ({ a2aServer: true })", () => {
  const sseMcp = (n: string): McpServerArtifact => ({ type: "mcp_server", name: n, transport: "sse", config: { url: "https://mcp.x/sse" } });
  const badSecretHttp: McpServerArtifact = { type: "mcp_server", name: "weird", transport: "http", config: { url: "https://mcp.x/mcp" }, secretRefs: [{ name: "K", location: "query.token" }] };

  it("adds src/server.ts, package.json, SECRETS.md alongside the card", () => {
    const r = materialize(gem([skill("review"), instr("CLAUDE.md")]), "a2a", { a2aServer: true });
    expect(r.files["agent-card.json"]).toBeTruthy();
    expect(r.files["src/server.ts"]).toContain('from "ai"');
    expect(r.files["src/server.ts"]).toContain("stepCountIs(");
    expect(r.files["package.json"]).toContain("@a2a-js/sdk");
    expect(r.files["SECRETS.md"]).toContain("Model access");
  });

  it("skill-only gem: no MCP imports, tools = {}, skill body folded into SYSTEM", () => {
    const r = materialize(gem([skill("review", "# Review\n\nDo a careful review."), instr("g", "be terse")]), "a2a", { a2aServer: true });
    const s = r.files["src/server.ts"];
    expect(s).toContain("streamText");
    expect(s).not.toContain("createMCPClient");
    expect(s).not.toContain("Experimental_StdioMCPTransport");
    expect(s).toContain("const tools = {}");
    expect(s).toContain("Do a careful review.");
    expect(s).toContain("be terse");
  });

  it("stdio MCP is supported: createMCPClient + stdio transport imported, not skipped", () => {
    const r = materialize(gem([mcp("local")]), "a2a", { a2aServer: true });
    const s = r.files["src/server.ts"];
    expect(s).toContain('from "@ai-sdk/mcp"');
    expect(s).toContain("Experimental_StdioMCPTransport");
    expect(s).toContain('command: "npx"');
    expect(r.skipped.find((x) => x.artifact === "local")).toBeUndefined();
  });

  it("http -> type http with header secret as env NAME; sse -> type sse; no secret values", () => {
    const r = materialize(gem([httpMcp("linear"), sseMcp("docs")]), "a2a", { a2aServer: true });
    const s = r.files["src/server.ts"];
    expect(s).toContain('type: "http"');
    expect(s).toContain('process.env["X_TOKEN"]');
    expect(s).toContain('type: "sse"');
    expect(s).not.toContain("Experimental_StdioMCPTransport");
    expect(JSON.stringify(r.files)).not.toContain("<redacted>");
  });

  it("hooks skipped; http MCP with a non-header secret skipped", () => {
    const r = materialize(gem([badSecretHttp, hook()]), "a2a", { a2aServer: true });
    expect(r.skipped.find((x) => x.type === "hook")?.reason).toMatch(/no hook concept/);
    expect(r.skipped.find((x) => x.artifact === "weird")?.reason).toMatch(/cannot map secret/);
  });

  it("SECRETS.md lists env-var names and the gateway key, with no agentcore/arn strings", () => {
    const g: Gem = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [{ name: "X_TOKEN", artifact: "linear", location: "headers.Authorization" }], artifacts: [httpMcp("linear")] };
    const md = materialize(g, "a2a", { a2aServer: true }).files["SECRETS.md"];
    expect(md).toContain("X_TOKEN");
    expect(md).toContain("AI_GATEWAY_API_KEY");
    expect(md).not.toMatch(/agentcore|arn:/);
  });

  it("card-only mode (no opts) emits just the card; MCP + hooks reported skipped", () => {
    const r = materialize(gem([skill("review"), mcp("local"), hook()]), "a2a");
    expect(Object.keys(r.files)).toEqual(["agent-card.json"]);
    expect(r.skipped.map((s) => s.type).sort()).toEqual(["hook", "mcp_server"]);
  });

  it("empty user text is guarded (no streamText call on a text-less message)", () => {
    const s = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["src/server.ts"];
    expect(s).toContain("if (!text"); // guard before the model call
  });

  it("empty model output does not emit an orphaned terminal artifact", () => {
    const s = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["src/server.ts"];
    expect(s).toContain("if (started)"); // terminal lastChunk artifact only when something streamed
  });

  it("server streams: streamText + artifact-update + task lifecycle, served card advertises streaming, cancel wired", () => {
    const s = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["src/server.ts"];
    expect(s).toContain("streamText");
    expect(s).toContain("textStream");
    expect(s).toContain('kind: "artifact-update"');
    expect(s).toContain('state: "working"');
    expect(s).toContain('state: "completed"');
    expect(s).toContain("streaming: true"); // the *served* card overrides the static primitive
    expect(s).toContain("abortSignal");
    expect(s).toContain(".abort()"); // cancelTask aborts the in-flight stream
  });

  it("the static Agent Card primitive still advertises streaming:false (no server promise)", () => {
    const card = JSON.parse(materialize(gem([skill("review")]), "a2a").files["agent-card.json"]);
    expect(card.capabilities.streaming).toBe(false);
  });

  it("server exposes REST (HTTP+JSON) alongside JSON-RPC", () => {
    const s = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["src/server.ts"];
    expect(s).toContain("restHandler");
    expect(s).toContain('"/a2a/rest"');
    expect(s).toContain('transport: "HTTP+JSON"');
  });

  it("server enables push notifications (store + sender + card capability)", () => {
    const s = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["src/server.ts"];
    expect(s).toContain("InMemoryPushNotificationStore");
    expect(s).toContain("DefaultPushNotificationSender");
    expect(s).toContain("pushNotifications: true");
  });

  it("server supports optional bearer auth gated by A2A_API_KEY (discovery stays open)", () => {
    const s = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["src/server.ts"];
    expect(s).toContain("A2A_API_KEY");
    expect(s).toContain("401");
    expect(s).toContain('scheme: "bearer"');
    expect(s).toContain('app.use("/a2a"'); // gate invocation routes, not the .well-known card
    const md = materialize(gem([skill("review")]), "a2a", { a2aServer: true }).files["SECRETS.md"];
    expect(md).toContain("A2A_API_KEY");
  });
});
