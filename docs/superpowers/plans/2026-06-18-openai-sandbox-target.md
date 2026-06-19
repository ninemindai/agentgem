# OpenAI SandboxAgent Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `openai-sandbox` to `TARGET_REGISTRY` so `materialize(gem, "openai-sandbox")` renders an OpenAI Agents SDK SandboxAgent project: `<gemname>.agent.ts` (`new SandboxAgent({ instructions, capabilities, defaultManifest, mcpServers })`) + `skills/<n>/SKILL.md`.

**Architecture:** Reuse the existing `compose` hook (shipped with Flue) and `skillSkillMd`. A `sandboxComposeAgent(gem)` composer emits the single agent file; skill bodies are real files seeded via the Manifest. MCP servers are inline in the agent (`MCPServerStreamableHttp` / native `MCPServerStdio` — no proxy bridge). No `TargetSpec` model change, no schema change (registry-derived `TargetIdSchema`), one UI `<option>`.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest (tests from `dist/`). No new dependencies.

## Global Constraints

- **ESM `.js` import extensions** (NodeNext). Tests from `dist/`: `npm test` = `tsc -b && vitest run`; focused `npm test -- -t "<pattern>"`.
- **Pure renderers**: `targets.ts` writes nothing. **Do NOT use `mcpProxy.ts`** for this target (stdio MCP is native).
- **Reuse**: `skillSkillMd`, `safePathSegment`, `escapeTemplate` (added for Flue), `rendered`, the `compose` hook + `merge` — already in `targets.ts`.
- **Secret-safety**: no secret value in any file; http auth → `requestInit.headers.Authorization = process.env["<NAME>"]!`; stdio secrets → `env: { <NAME>: process.env["<NAME>"]! }` (names from `secretRefs` only). Assert in tests.
- **SDK facts (verified):** agent import `import { SandboxAgent, Manifest, localDir, shell, filesystem, skills } from "@openai/agents/sandbox";`; MCP classes `import { MCPServerStreamableHttp, MCPServerStdio } from "@openai/agents";`; `new SandboxAgent({ name, model:"gpt-5.5", instructions, capabilities:[shell(),filesystem(),skills()], defaultManifest: new Manifest({ entries }), mcpServers:[...] })`; skills seeded via `localDir({ from:"skills", readOnly:true })`.
- **Hooks unsupported** → skipped.

---

### Task 1: `openai-sandbox` target — agent file (skills + instructions)

**Files:**
- Modify: `src/gem/targets.ts`
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `Gem`, `SkillArtifact`, `InstructionsArtifact`, `skillSkillMd`, `safePathSegment`, `escapeTemplate`, `rendered`, the `compose` hook.
- Produces: `TargetId` gains `"openai-sandbox"`; `sandboxComposeAgent(gem)`; a registry entry `{ skill: skillSkillMd, instructions: () => ({}), compose: sandboxComposeAgent }` (**no `mcp` renderer yet → MCP servers are skip-reported in Task 1; Task 2 adds inline MCP**).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/gem/__tests__/targets.test.ts
describe("openai-sandbox target (agent file + skills)", () => {
  it("emits <gemname>.agent.ts (SandboxAgent + manifest + capabilities) and skill files; hooks + mcp skipped in v1-step1", () => {
    const p: Gem = { name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind"),
      hook(),
    ] };
    const r = materialize(p, "openai-sandbox");
    expect(r.files["skills/review/SKILL.md"]).toContain("# Review");
    const agent = r.files["my_gem.agent.ts"];
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

  it("no-skills gem -> capabilities without skills() and an empty manifest", () => {
    const p: Gem = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [instr("i", "hi")] };
    const agent = materialize(p, "openai-sandbox").files["p.agent.ts"];
    expect(agent).toContain("capabilities: [shell(), filesystem()]");
    expect(agent).not.toContain("skills()");
    expect(agent).toContain("new Manifest({ entries: {} })");
  });

  it("compatibility includes an openai-sandbox entry", () => {
    expect(compatibility({ name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] })["openai-sandbox"]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "openai-sandbox target"`
Expected: FAIL — `"openai-sandbox"` is not a `TargetId` / not in the registry.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`:

(a) Extend `TargetId`:
```ts
export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve" | "flue" | "openai-sandbox";
```

(b) Add the composer (after the Flue helpers; reuses `escapeTemplate`, `safePathSegment`, `rendered`):
```ts
// OpenAI Agents SDK SandboxAgent: one <gemname>.agent.ts composes everything. Skill bodies are real
// files (skillSkillMd) seeded read-only via the Manifest; instructions fold into the `instructions`
// string; MCP servers are added inline in Task 2. No proxy bridge (the SDK has native stdio MCP).
const sandboxComposeAgent = (gem: Gem): MaterializeResult => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const instructions = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");
  const hasSkills = skills.length > 0;
  const sandboxImport = hasSkills
    ? `import { SandboxAgent, Manifest, localDir, shell, filesystem, skills } from "@openai/agents/sandbox";`
    : `import { SandboxAgent, Manifest, shell, filesystem } from "@openai/agents/sandbox";`;
  const capabilities = hasSkills ? "[shell(), filesystem(), skills()]" : "[shell(), filesystem()]";
  const manifestEntries = hasSkills ? `{ skills: localDir({ from: "skills", readOnly: true }) }` : "{}";
  const file =
`${sandboxImport}

export const agent = new SandboxAgent({
  name: ${JSON.stringify(gem.name)},
  model: "gpt-5.5",
  instructions: \`${escapeTemplate(instructions)}\`,
  capabilities: ${capabilities},
  defaultManifest: new Manifest({ entries: ${manifestEntries} }),
});
`;
  return rendered({ [`${safePathSegment(gem.name)}.agent.ts`]: file });
};
```

(c) Register `openai-sandbox` (after `flue`):
```ts
  // OpenAI Agents SDK SandboxAgent (single <gemname>.agent.ts). Skills reuse SKILL.md (seeded via the
  // Manifest); instructions fold into the agent file. MCP is added inline in Task 2 (mcp renderer + compose).
  "openai-sandbox": { id: "openai-sandbox", label: "OpenAI Sandbox", skill: skillSkillMd, instructions: () => ({}), compose: sandboxComposeAgent },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "openai-sandbox target"` then `npm test -- -t "materialize"` (existing targets unaffected).
Expected: PASS (mcp servers, if any, are skip-reported since no `mcp` renderer yet — the test packs have none).

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(targets): OpenAI SandboxAgent target — agent file (skills + instructions)"
```

---

### Task 2: Inline MCP servers (native stdio + streamable-http)

**Files:**
- Modify: `src/gem/targets.ts`
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `McpServerArtifact`; `sandboxComposeAgent` (Task 1).
- Produces: MCP rendering inside `sandboxComposeAgent` (inline `mcpServers: [...]` + conditional `@openai/agents` import) via a `sandboxMcpServer(s)` helper; and `mcp: () => ({ files: {}, skipped: [] })` added to the registry entry so MCP servers are handled-by-compose (not skip-reported by the per-type path).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/gem/__tests__/targets.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "openai-sandbox MCP"`
Expected: FAIL — the agent file has no `mcpServers`; the http server is skip-reported (no `mcp` handling yet).

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`, add the per-server renderer (before `sandboxComposeAgent`):
```ts
type SandboxServer = { code: string; cls: "MCPServerStreamableHttp" | "MCPServerStdio" } | { skip: string };
const sandboxMcpServer = (s: McpServerArtifact): SandboxServer => {
  const url = typeof s.config.url === "string" ? s.config.url : "";
  if (/^https?:\/\//.test(url)) {
    const refs = s.secretRefs ?? [];
    const unsupported = refs.find((r) => !/^headers\./i.test(r.location));
    if (unsupported) return { skip: `OpenAI sandbox cannot map secret at ${unsupported.location}` };
    const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
    const headerEntries: (readonly [string, string])[] = [
      ...(authorization ? [["Authorization", authorization.name] as const] : []),
      ...refs.filter((r) => /^headers\./i.test(r.location) && r !== authorization).map((r) => [r.location.slice("headers.".length), r.name] as const),
    ];
    const requestInit = headerEntries.length
      ? `, requestInit: { headers: { ${headerEntries.map(([h, e]) => `${JSON.stringify(h)}: process.env[${JSON.stringify(e)}]!`).join(", ")} } }`
      : "";
    return { code: `  new MCPServerStreamableHttp({ name: ${JSON.stringify(s.name)}, url: ${JSON.stringify(url)}${requestInit} }),`, cls: "MCPServerStreamableHttp" };
  }
  if (s.transport === "stdio" && typeof s.config.command === "string") {
    const args = Array.isArray(s.config.args) ? s.config.args.filter((a): a is string => typeof a === "string") : [];
    const envNames = (s.secretRefs ?? []).map((r) => r.name);
    const argsStr = args.length ? `, args: ${JSON.stringify(args)}` : "";
    const envStr = envNames.length ? `, env: { ${envNames.map((n) => `${JSON.stringify(n)}: process.env[${JSON.stringify(n)}]!`).join(", ")} }` : "";
    return { code: `  new MCPServerStdio({ name: ${JSON.stringify(s.name)}, command: ${JSON.stringify(s.config.command)}${argsStr}${envStr} }),`, cls: "MCPServerStdio" };
  }
  return { skip: `${s.transport} MCP has no usable URL or stdio command` };
};
```

Update `sandboxComposeAgent` to render MCP. Add near the top of the function (after `instructions`):
```ts
  const mcps = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const skipped: SkippedArtifact[] = [];
  const serverCodes: string[] = [];
  const usedClasses = new Set<string>();
  for (const s of mcps) {
    const res = sandboxMcpServer(s);
    if ("skip" in res) { skipped.push({ artifact: s.name, type: "mcp_server", reason: res.skip }); continue; }
    serverCodes.push(res.code);
    usedClasses.add(res.cls);
  }
  const mcpImport = usedClasses.size ? `import { ${[...usedClasses].sort().join(", ")} } from "@openai/agents";\n` : "";
  const mcpServers = serverCodes.length ? `\n  mcpServers: [\n${serverCodes.join("\n")}\n  ],` : "";
```
Then change the `sandboxImport` line in the template to be preceded by `mcpImport`, add `${mcpServers}` into the `SandboxAgent` object (after `defaultManifest: …,`), and return `{ files: { … }, skipped }` instead of `rendered(...)`:
```ts
  const file =
`${sandboxImport}
${mcpImport}
export const agent = new SandboxAgent({
  name: ${JSON.stringify(gem.name)},
  model: "gpt-5.5",
  instructions: \`${escapeTemplate(instructions)}\`,
  capabilities: ${capabilities},
  defaultManifest: new Manifest({ entries: ${manifestEntries} }),${mcpServers}
});
`;
  return { files: { [`${safePathSegment(gem.name)}.agent.ts`]: file }, skipped };
```
(When `mcpImport` is empty the line is just a blank line after the sandbox import — acceptable. If you prefer no blank line, conditionally join; keep it simple and valid.)

Add `mcp` to the registry entry so servers are no longer skip-reported by the per-type path:
```ts
  "openai-sandbox": { id: "openai-sandbox", label: "OpenAI Sandbox", skill: skillSkillMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: sandboxComposeAgent },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "openai-sandbox"` then `npm test` (full suite — `openai-sandbox` now appears in `compatibility`/workspace records; `z.record(TargetIdSchema,…)` validates it).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(targets): OpenAI SandboxAgent inline MCP (native stdio + streamable-http)"
```

---

### Task 3: UI — add OpenAI Sandbox to the materialize target select

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: the `openai-sandbox` target (Tasks 1–2). Workspace per-target tabs are dynamic (from `compatibility`) → pick it up automatically; only the Materialize `<select>` is static.

One-line UI change; verify by driving the running app.

- [ ] **Step 1: Add the option**

In `src/public/index.html`, in `<select id="target" …>`, add after the `flue` option:
```html
<option value="openai-sandbox">OpenAI Sandbox</option>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Drive the running app (manual verification)**

```bash
SRC=$(mktemp -d); export AGENTGEM_HOME=$(mktemp -d)
mkdir -p "$SRC/skills/review"; printf '%s\n' '---' 'name: review' 'description: Review' '---' '# Review' > "$SRC/skills/review/SKILL.md"
printf '%s' '{"mcpServers":{"gh":{"command":"npx","args":["-y","gh-mcp"],"env":{"GH_TOKEN":"ghp_x"}}}}' > "$SRC/.mcp.json"
PORT=4321 node dist/index.js &  SRV=$!
sleep 1
curl -s localhost:4321/api/materialize -H 'content-type: application/json' -d "{\"dir\":\"$SRC\",\"selection\":{\"skills\":[\"review\"],\"mcpServers\":[\"gh\"]},\"target\":\"openai-sandbox\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("files:",sorted(d["files"]));print("skipped:",d["skipped"]);
import re;a=d["files"].get([k for k in d["files"] if k.endswith(".agent.ts")][0]);print("has MCPServerStdio:", "MCPServerStdio" in a);print("no proxy file:", not any(k.startswith("proxies/") for k in d["files"]));print("no secret value:", "ghp_x" not in json.dumps(d))'
curl -s localhost:4321/api/workspaces -H 'content-type: application/json' -d "{\"dir\":\"$SRC\",\"name\":\"sbx\",\"selection\":{\"skills\":[\"review\"]}}" >/dev/null
curl -s localhost:4321/api/workspace/render -H 'content-type: application/json' -d '{"name":"sbx","target":"openai-sandbox"}' \
  | python3 -c 'import sys,json;print("rendered:",sorted(json.load(sys.stdin)["files"]))'
kill $SRV; rm -rf "$SRC" "$AGENTGEM_HOME"; unset AGENTGEM_HOME
```

Expected: materialize lists `<name>.agent.ts` + `skills/review/SKILL.md`; the agent file uses `MCPServerStdio`; no `proxies/` file; no `ghp_x` value; workspace render lists the agent file + skill under `.targets/openai-sandbox/`.

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): add OpenAI Sandbox to the materialize target selector"
```

---

## Self-Review

**Spec coverage:**
- §2.1 reuse compose + skillSkillMd → Tasks 1–2 ✓
- §2.2 instructions+mcp fold into agent file (empty renderers) → Task 1 (`instructions: () => ({})`) + Task 2 (`mcp: () => ({files:{},skipped:[]})` + inline render) ✓
- §2.3 native stdio (no proxy) → Task 2 (`MCPServerStdio`; test asserts no `proxies/`) ✓
- §2.4 skills via Manifest localDir → Task 1 ✓
- §2.5 hooks skipped → Task 1 test ✓
- §2.6 secret-safe (env names only) → Task 2 (`process.env[...]`; test asserts no value) ✓
- §3 support matrix → Tasks 1–2 ✓
- §4 composer (conditional imports, no-skills case, escaping, skip rules) → Tasks 1–2 ✓
- §5 no schema change; one UI option → Task 3 ✓
- §7 testing → Tasks 1–2 unit + Task 3 drive ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; commands + expected output in run steps. ✓

**Type consistency:** `sandboxComposeAgent`/`sandboxMcpServer`/`SandboxServer` defined in Tasks 1–2 and referenced consistently; `TargetId` union includes `"openai-sandbox"` so `compatibility`/`TargetIdSchema`/workspace records resolve it; the registry entry's `mcp`/`compose`/`instructions` field names match `TargetSpec`; the UI `<option value="openai-sandbox">` matches the registry id and the workspace tab key. ✓
