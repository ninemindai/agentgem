# AgentCore Target — Phase 1 (materialize) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agentcore` materialize target that renders a Gem into a runnable Amazon Bedrock AgentCore harness project (`app/<gem>/harness.json` + container-baked skills + scaffold), with stdio MCP and hooks skipped-and-reported and secrets emitted only as token-vault placeholders.

**Architecture:** One new `TargetSpec` in `TARGET_REGISTRY` (`src/gem/targets.ts`), following the eve pattern: a skill renderer emits skill files under `.agents/skills/<seg>/SKILL.md`, and a `compose(gem)` hook (which sees the whole gem) builds `harness.json` (systemPrompt ← instructions, `remote_mcp` tools ← http/sse MCP, path-skills ← skills) plus the project scaffold (`agentcore.json`, `aws-targets.json`, `Dockerfile`, `SECRETS.md`). Pure functions throughout; `materialize` already merges renderer + compose output and reports collisions.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest. No new runtime deps. Frontend is the single static `src/public/index.html`.

## Global Constraints

- ESM: every local import uses a `.js` suffix.
- Tests run via compiled dist: `npm run clean && npx tsc -b && npx vitest run`. Vitest runs compiled tests from `dist/`; a clean rebuild is required after edits.
- **Secret invariant:** no raw secret value may appear in any rendered file. MCP secret headers render only as `${arn:aws:bedrock-agentcore:REGION:ACCOUNT:token-vault/default/apikeycredentialprovider/<name>}` placeholders. Every secret-touching test asserts the rendered project does not contain a raw value.
- **Harness config shape (verbatim from the AWS docs):** `harness.json` keys are `systemPrompt` (`[{ "text": "…" }]`), `model` (`{ "bedrockModelConfig": { "modelId": "…" } }`), `tools` (`[{ "type": "remote_mcp", "name": "…", "config": { "remoteMcp": { "url": "…", "headers": { … } } } }]`), `skills` (`[{ "path": ".agents/skills/<seg>" }]`). Default model id: `global.anthropic.claude-sonnet-4-6`.
- **stdio MCP and hooks are unsupported** by the harness → skip-and-report (eve precedent). Only http/sse MCP (with a URL) maps to `remote_mcp`.
- Path segments via the existing `safePathSegment` helper (already in `targets.ts`).
- Follow the existing renderer style in `targets.ts` (the `eve`/`flue` renderers are the reference).

---

## File Structure

- **Modify** `src/gem/targets.ts` — add `TargetId` union member `"agentcore"`; add helpers `skillAgentcoreMd`, `agentcoreMcpTools`, `buildAgentcoreHarness`, the scaffold string consts, `agentcoreComposeProject`; add the registry entry.
- **Modify** `src/gem/__tests__/targets.test.ts` — add an `agentcore` describe block.
- **Modify** `src/public/index.html` — add `<option value="agentcore">AgentCore</option>` to the target `<select>`.

(`schemas.ts` needs no edit — `TargetIdSchema` derives from `Object.keys(TARGET_REGISTRY)`.)

---

## Task 1: harness.json builder

**Files:**
- Modify: `src/gem/targets.ts` (add helpers near the eve renderers, ~after line 96)
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `Gem`, `McpServerArtifact`, `SkillArtifact`, `InstructionsArtifact`, `SkippedArtifact`, `safePathSegment` (all already in `targets.ts`).
- Produces:
  - `agentcoreMcpTools(servers: McpServerArtifact[]): { tools: unknown[]; skipped: SkippedArtifact[] }` — http/sse → a `remote_mcp` tool object; stdio/url-less → skipped.
  - `buildAgentcoreHarness(gem: Gem): { harness: Record<string, unknown>; skipped: SkippedArtifact[] }` — assembles the `harness.json` object (model always; systemPrompt/tools/skills only when non-empty).

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/targets.test.ts` (the `gem`/`skill`/`mcp`/`httpMcp`/`instr` factories already exist at the top of the file):

```ts
import { buildAgentcoreHarness } from "../targets.js";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run targets`
Expected: FAIL — `buildAgentcoreHarness` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`, after the eve MCP renderer (around line 96), add:

```ts
// ── AgentCore harness renderers ──
const AGENTCORE_MODEL_ID = "global.anthropic.claude-sonnet-4-6";
// A token-vault placeholder for a secret header value. REGION/ACCOUNT are left as literal
// placeholders for the user to fill (SECRETS.md lists the `agentcore add credential` commands).
const agentcoreSecretRef = (name: string): string =>
  `\${arn:aws:bedrock-agentcore:REGION:ACCOUNT:token-vault/default/apikeycredentialprovider/${name}}`;

// http/sse MCP -> a remote_mcp tool. Secret header values become token-vault placeholders.
// stdio (and url-less http) servers are skipped: the harness is remote-URL only.
const agentcoreMcpTools = (servers: McpServerArtifact[]): { tools: unknown[]; skipped: SkippedArtifact[] } => {
  const tools: unknown[] = [];
  const skipped: SkippedArtifact[] = [];
  for (const s of servers) {
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (!/^https?:\/\//.test(url)) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `AgentCore remote_mcp requires an HTTP/SSE URL; ${s.transport} MCP unsupported` });
      continue;
    }
    const refs = s.secretRefs ?? [];
    const unsupportedSecret = refs.find((r) => !/^headers\./i.test(r.location));
    if (unsupportedSecret) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `AgentCore cannot map secret at ${unsupportedSecret.location}` });
      continue;
    }
    const headerEntries = refs
      .filter((r) => /^headers\./i.test(r.location))
      .map((r) => [r.location.slice("headers.".length), agentcoreSecretRef(r.name)] as const);
    const remoteMcp: Record<string, unknown> = { url };
    if (headerEntries.length) remoteMcp.headers = Object.fromEntries(headerEntries);
    tools.push({ type: "remote_mcp", name: s.name, config: { remoteMcp } });
  }
  return { tools, skipped };
};

// Assemble the harness.json object. model is always present; systemPrompt/tools/skills only when non-empty.
const buildAgentcoreHarness = (gem: Gem): { harness: Record<string, unknown>; skipped: SkippedArtifact[] } => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const mcp = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const { tools, skipped } = agentcoreMcpTools(mcp);
  const harness: Record<string, unknown> = { model: { bedrockModelConfig: { modelId: AGENTCORE_MODEL_ID } } };
  if (instr.length) harness.systemPrompt = [{ text: instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n") }];
  if (tools.length) harness.tools = tools;
  if (skills.length) harness.skills = skills.map((s) => ({ path: `.agents/skills/${safePathSegment(s.name)}` }));
  return { harness, skipped };
};
```

Add `buildAgentcoreHarness` to the file's exports if helpers aren't already module-visible to tests — i.e. prefix the `const buildAgentcoreHarness` with `export`. (Do the same `export` on it only; the others stay private.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run targets`
Expected: PASS (both new tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(agentcore): harness.json builder (instructions/MCP/skills, secret placeholders)"
```

---

## Task 2: project scaffold + compose hook

**Files:**
- Modify: `src/gem/targets.ts` (add scaffold consts + `agentcoreComposeProject`, after Task 1's helpers)
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `buildAgentcoreHarness` (Task 1), `Gem`, `MaterializeResult`, `SecretRequirement`, `safePathSegment`.
- Produces: `agentcoreComposeProject(gem: Gem): MaterializeResult` — returns the full project file set (harness.json + scaffold) and the stdio/unsupported-MCP `skipped` list.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/targets.test.ts`:

```ts
import { agentcoreComposeProject } from "../targets.js";

describe("agentcoreComposeProject", () => {
  it("emits harness.json, scaffold, Dockerfile COPY, and a SECRETS checklist", () => {
    const g = { ...gem([skill("scrape"), httpMcp("exa")]), requiredSecrets: [{ name: "X_TOKEN", artifact: "exa", location: "headers.Authorization" }] };
    const { files, skipped } = agentcoreComposeProject(g);
    expect(JSON.parse(files["app/p/harness.json"]).model.bedrockModelConfig.modelId).toBe("global.anthropic.claude-sonnet-4-6");
    expect(files["agentcore/agentcore.json"]).toBeDefined();
    expect(files["agentcore/aws-targets.json"]).toBeDefined();
    expect(files["Dockerfile"]).toContain("COPY .agents/skills/ .agents/skills/");
    expect(files["SECRETS.md"]).toContain("agentcore add credential");
    expect(files["SECRETS.md"]).toContain("X_TOKEN");
    expect(skipped).toHaveLength(0);
    expect(JSON.stringify(files)).not.toContain("<redacted>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run targets`
Expected: FAIL — `agentcoreComposeProject` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`, after Task 1's helpers, add:

```ts
const AGENTCORE_DOCKERFILE = `# AgentCore harness custom image: bakes local skills onto the harness filesystem
# so the harness.json path-skills resolve. Build with: agentcore deploy --build Container
FROM public.ecr.aws/bedrock-agentcore/harness-base:latest
COPY .agents/skills/ .agents/skills/
`;
const agentcoreProjectJson = (gemName: string): string =>
  JSON.stringify({ version: "1.0", harnesses: [{ name: safePathSegment(gemName), path: `app/${safePathSegment(gemName)}` }] }, null, 2) + "\n";
const AGENTCORE_AWS_TARGETS = JSON.stringify({ account: "REPLACE_WITH_ACCOUNT_ID", region: "us-west-2" }, null, 2) + "\n";
const agentcoreSecretsMd = (secrets: SecretRequirement[]): string => {
  if (!secrets.length) return `# Secrets\n\nThis agent declares no secrets.\n`;
  const lines = secrets.map((s) => `- \`${s.name}\` (for ${s.artifact} at ${s.location}):\n  \`\`\`\n  agentcore add credential --type api-key --name ${s.name} --api-key <value>\n  \`\`\``);
  return `# Secrets\n\nRegister each credential in AgentCore Identity, then replace \`REGION\`/\`ACCOUNT\` in the \`\${arn:...}\` placeholders in \`app/<agent>/harness.json\`:\n\n${lines.join("\n")}\n`;
};

// Cross-cutting scaffold: harness.json (the agent config) plus the files needed to deploy it.
const agentcoreComposeProject = (gem: Gem): MaterializeResult => {
  const seg = safePathSegment(gem.name);
  const { harness, skipped } = buildAgentcoreHarness(gem);
  return {
    files: {
      [`app/${seg}/harness.json`]: JSON.stringify(harness, null, 2) + "\n",
      "agentcore/agentcore.json": agentcoreProjectJson(gem.name),
      "agentcore/aws-targets.json": AGENTCORE_AWS_TARGETS,
      "Dockerfile": AGENTCORE_DOCKERFILE,
      "SECRETS.md": agentcoreSecretsMd(gem.requiredSecrets),
    },
    skipped,
  };
};
```

Add `export` to `agentcoreComposeProject`. (`SecretRequirement` is already imported in `targets.ts` via `./types.js`; if not, add it to that import.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run targets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(agentcore): compose project scaffold (harness.json, Dockerfile, SECRETS.md)"
```

---

## Task 3: register the target + skill renderer + UI option

**Files:**
- Modify: `src/gem/targets.ts` (`TargetId` union; `skillAgentcoreMd`; registry entry)
- Modify: `src/public/index.html` (target `<select>`)
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `agentcoreComposeProject` (Task 2), `skillSkillMd` pattern (Task adds a sibling), `TARGET_REGISTRY`, `materialize`.
- Produces: a working `materialize(gem, "agentcore")`.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/targets.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run targets`
Expected: FAIL — `"agentcore"` is not a valid `TargetId` / registry key.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`:

1. Extend the `TargetId` union (line 13):

```ts
export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve" | "flue" | "openai-sandbox" | "agentcore";
```

2. Add the skill renderer near the other skill renderers (after `skillEveMd`):

```ts
// AgentCore path-skills live on the harness filesystem; emit each skill body under .agents/skills/<seg>/.
const skillAgentcoreMd = (a: SkillArtifact): FileTree => ({ [`.agents/skills/${safePathSegment(a.name)}/SKILL.md`]: a.content });
```

3. Add the registry entry to `TARGET_REGISTRY` (after the `openai-sandbox` line). Instructions/MCP fold into compose (empty renderers mark them handled, not skipped); hooks have no renderer so `materialize` auto-skips them:

```ts
  // AgentCore harness project (app/<gem>/harness.json + container-baked skills). Instructions/MCP
  // fold into the composed harness.json; stdio MCP is reported skipped by compose; hooks unsupported.
  agentcore: { id: "agentcore", label: "AgentCore", skill: skillAgentcoreMd, instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), compose: agentcoreComposeProject },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run targets`
Expected: PASS.

- [ ] **Step 5: Add the UI option**

In `src/public/index.html`, in the target `<select>` (search for `id="target"`), add after the `openai-sandbox` option:

```html
<option value="agentcore">AgentCore</option>
```

- [ ] **Step 6: Run the full suite + build**

Run: `npm run clean && npx tsc -b && npx vitest run && npm run build`
Expected: all tests PASS; build copies index.html.

- [ ] **Step 7: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts src/public/index.html
git commit -m "feat(agentcore): register materialize target + UI option"
```

---

## Self-Review

**1. Spec coverage (Phase 1 scope of `2026-06-20-agentcore-target-design.md`):**
- §3 Phase 1 target registration → Task 3. `compose` hook → Task 2. harness.json (systemPrompt/tools/skills) → Task 1. skill files under `.agents/skills/` → Task 3 (`skillAgentcoreMd`). Dockerfile container-bake → Task 2. agentcore.json/aws-targets.json/SECRETS.md → Task 2. stdio MCP + hooks skip-report → Tasks 1 & 3. Secret `${arn:…}` placeholders → Task 1. UI option → Task 3. §4 secret-safety test → every task asserts `not.toContain("<redacted>")` (and Task 1 asserts the header is a placeholder). Phases 2 (deploy runner) and 3 (publish backend) are out of scope for this plan.

**2. Placeholder scan:** No TBD/TODO. The literal strings `REGION`/`ACCOUNT`/`REPLACE_WITH_ACCOUNT_ID` are intentional *output* placeholders in generated files (documented in SECRETS.md), not plan placeholders. All code steps contain complete code.

**3. Type consistency:** `buildAgentcoreHarness(gem) → { harness, skipped }`, `agentcoreMcpTools(servers) → { tools, skipped }`, `agentcoreComposeProject(gem) → MaterializeResult` are used identically across tasks. `safePathSegment` (existing) used for every segment, so the skill file path (`skillAgentcoreMd`) and the harness `skills[].path` agree. Registry entry field names match `TargetSpec` (`id`/`label`/`skill`/`instructions`/`mcp`/`compose`). Default model id string identical in Task 1 impl and Task 2 test.

**Open item carried from the spec (§6):** the emitted `agentcore/agentcore.json` shape is a documented-minimal guess (the public docs detail `harness.json`, not the project wrapper). Before Phase 2's `agentcore deploy` runs against it, verify by running `agentcore create` once and reconciling. Phase 1 is independently valuable (renders + inspectable) regardless.
