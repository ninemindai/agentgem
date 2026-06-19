# Flue Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `flue` as a `TARGET_REGISTRY` entry so `materialize(gem, "flue")` renders a Flue project (`agents/<name>.ts` + `skills/<n>/SKILL.md` + `connections/<n>.ts` + stdio `proxies/<n>.mjs`), plus a small reusable `compose` hook on `TargetSpec` for the cross-cutting agent file.

**Architecture:** Three increments in `src/gem/targets.ts`: (1) a `compose?(gem)=>MaterializeResult` hook run after the per-type renderers, and a `flue` entry that emits the agent file via compose + reuses `skillSkillMd` for skill bodies; (2) `mcpFlueConnections` adding Flue MCP connection files (parallel to `mcpEveConnections`, reusing `mcpProxy.ts` for stdio); (3) one UI `<option>`. `TargetIdSchema` derives from registry keys, so schemas/workspaces/compatibility pick up `flue` automatically.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest (tests run from `dist/`). No new dependencies.

## Global Constraints

- **ESM `.js` import extensions** (NodeNext). Tests run from `dist/`: `npm test` = `tsc -b && vitest run`; focused `npm test -- -t "<pattern>"`.
- **Pure renderers**: `targets.ts` writes nothing; renderers return `FileTree`/`MaterializeResult`.
- **Reuse, don't duplicate**: `skillSkillMd`, `safePathSegment`, `rendered`, `stdioProxyRunner`, `PROXY_BASE_PORT`, `PROXY_HOST` already exist in `targets.ts`/`mcpProxy.ts`. The flue MCP renderer parallels the existing `mcpEveConnections`.
- **Secret-safety**: no rendered file may contain a secret value; auth reads `process.env["<NAME>"]` from `secretRefs` (names only). Assert in tests.
- **Flue conventions (verified):** agent file `agents/<name>.ts` default-exports `createAgent(() => ({ model, instructions, skills }))`; skills imported `import x from "../skills/<n>/SKILL.md" with { type: "skill" }`; MCP via `connectMcpServer(name, { url, transport, headers })` (remote http/sse only); model literal `"anthropic/claude-sonnet-4-6"`.
- **Hooks unsupported on flue** → skipped (like eve).

---

### Task 1: `compose` hook + Flue agent file (skills + instructions)

**Files:**
- Modify: `src/gem/targets.ts`
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: existing `Gem`, `SkillArtifact`, `InstructionsArtifact`, `skillSkillMd`, `safePathSegment`, `rendered`, `materialize`, `compatibility`.
- Produces: `compose?: (gem: Gem) => MaterializeResult` on `TargetSpec`; `TargetId` gains `"flue"`; `flueComposeAgent(gem)`; a `flue` registry entry (skill + empty-instructions + compose; **no mcp yet — added in Task 2**).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/gem/__tests__/targets.test.ts
describe("flue target (agent file + skills)", () => {
  it("emits agents/<gemname>.ts importing skills + folding instructions; hooks skipped", () => {
    const p: Gem = { name: "my gem", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [
      skill("review", "# Review\nLook `here` and ${there}."),
      instr("soul", "be kind"),
      hook(),
    ] };
    const r = materialize(p, "flue");
    // skill body reuses the shared SKILL.md convention
    expect(r.files["skills/review/SKILL.md"]).toContain("# Review");
    // the composed agent file
    const agent = r.files["agents/my_gem.ts"];
    expect(agent).toContain('import { createAgent');
    expect(agent).toContain('import skill0 from "../skills/review/SKILL.md" with { type: "skill" }');
    expect(agent).toContain("skills: [skill0]");
    expect(agent).toContain("be kind");                 // instructions folded in
    expect(agent).toContain('model: "anthropic/claude-sonnet-4-6"');
    // template escaping: backtick and ${ must be escaped so the file is valid TS
    expect(agent).toContain("\\`here\\`");
    expect(agent).toContain("\\${there}");
    // instructions are NOT reported skipped (they're composed, not dropped)
    expect(r.skipped.find((s) => s.type === "instructions")).toBeUndefined();
    // hooks unsupported -> skipped
    expect(r.skipped.map((s) => s.type)).toContain("hook");
  });

  it("compatibility includes a flue entry", () => {
    const p: Gem = { name: "p", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [skill("a")] };
    expect(compatibility(p).flue).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "flue target"`
Expected: FAIL — `materialize(p, "flue")` errors (`"flue"` not a `TargetId` / not in registry).

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`:

(a) Extend the `TargetId` union and `TargetSpec`:

```ts
export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve" | "flue";
```
```ts
interface TargetSpec {
  id: TargetId;
  label: string;
  skill?: (a: SkillArtifact) => FileTree;
  mcp?: (servers: McpServerArtifact[]) => MaterializeResult;
  instructions?: (all: InstructionsArtifact[]) => FileTree;
  hook?: (hooks: HookArtifact[]) => FileTree;
  compose?: (gem: Gem) => MaterializeResult; // cross-cutting file(s) that see the whole gem (runs last)
}
```

(b) Add the Flue agent-file composer (near the other renderers, after the eve helpers):

```ts
// Flue: a single agents/<gemname>.ts registers the agent. It imports each skill (reusing the shared
// skills/<n>/SKILL.md bodies), folds instruction artifacts into the `instructions` string, and lists
// the skills. MCP connection files are emitted separately (mcpFlueConnections) and wired by the operator.
function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
const flueComposeAgent = (gem: Gem): MaterializeResult => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const imports = skills.map((s, i) => `import skill${i} from "../skills/${safePathSegment(s.name)}/SKILL.md" with { type: "skill" };`).join("\n");
  const instructions = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");
  const list = skills.map((_, i) => `skill${i}`).join(", ");
  const file =
`import { createAgent, type AgentRouteHandler } from "@flue/runtime";
${imports}${imports ? "\n" : ""}
export const route: AgentRouteHandler = async (_c, next) => next();

const instructions = \`${escapeTemplate(instructions)}\`;

export default createAgent(() => ({
  model: "anthropic/claude-sonnet-4-6",
  instructions,
  skills: [${list}],
}));
`;
  return rendered({ [`agents/${safePathSegment(gem.name)}.ts`]: file });
};
```

(c) Register `flue` in `TARGET_REGISTRY` (after `eve`):

```ts
  // Flue project layout. Skills reuse SKILL.md; instructions fold into the composed agent file (no
  // standalone file -> the empty instructions renderer marks them handled, not skipped). MCP added in Task 2.
  flue:   { id: "flue",   label: "Flue",   skill: skillSkillMd,        instructions: () => ({}), compose: flueComposeAgent },
```

(d) In `materialize()`, run `compose` after the hooks block, before `return`:

```ts
  if (spec.compose) {
    const result = spec.compose(gem);
    merge(result.files, "(composed agent)", "instructions"); // collisions reported; agent file derives from instructions+skills
    skipped.push(...result.skipped);
  }

  return { files, skipped };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "flue target"` then `npm test -- -t "materialize"` (ensure existing targets unaffected — compose is undefined for them).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(targets): compose hook + Flue agent file (skills + instructions)"
```

---

### Task 2: Flue MCP connections (http/sse + stdio proxy)

**Files:**
- Modify: `src/gem/targets.ts`
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `McpServerArtifact`, `stdioProxyRunner`, `PROXY_BASE_PORT`, `PROXY_HOST`, `safePathSegment`; the `flue` registry entry (Task 1).
- Produces: `mcpFlueConnections(servers)` and `mcp: mcpFlueConnections` added to the `flue` registry entry. http/sse → `connections/<n>.ts`; stdio → `proxies/<n>.mjs` + `connections/<n>.ts` at the localhost proxy URL.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/gem/__tests__/targets.test.ts
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
```

(Reuse the existing `skill`/`mcp`/`httpMcp` helpers at the top of `targets.test.ts`. `httpMcp` already sets a `secretRefs: [{ name: "X_TOKEN", location: "headers.Authorization" }]`; if its config secret value isn't literally `"secret-value"`, adjust the negative assertion to the actual placeholder used by the helper, or drop that line — the redaction is already covered elsewhere. Keep the env-name assertion.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "flue MCP"`
Expected: FAIL — `connections/ctx.ts` undefined (flue has no `mcp` renderer yet; the http server is skipped).

- [ ] **Step 3: Write minimal implementation**

In `src/gem/targets.ts`, add the Flue connection renderer (after `flueComposeAgent`):

```ts
// One TS factory per MCP server. http/sse -> a direct remote connection (auth reads the secret from an
// env var name, never a value). stdio -> a localhost connection plus a generated proxy runner under
// proxies/ that bridges the stdio server to HTTP (same mechanism as Eve).
const flueConnection = (server: McpServerArtifact, url: string): string => {
  const refs = server.secretRefs ?? [];
  const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
  const headerEntries: (readonly [string, string])[] = [
    ...(authorization ? [["Authorization", authorization.name] as const] : []),
    ...refs.filter((r) => /^headers\./i.test(r.location) && r !== authorization)
          .map((r) => [r.location.slice("headers.".length), r.name] as const),
  ];
  const transport = server.transport === "sse" ? `,\n  transport: "sse"` : "";
  const headers = headerEntries.length
    ? `,\n  headers: { ${headerEntries.map(([h, env]) => `${JSON.stringify(h)}: process.env[${JSON.stringify(env)}]!`).join(", ")} }`
    : "";
  return `import { connectMcpServer } from "@flue/runtime";\n\nexport default () => connectMcpServer(${JSON.stringify(server.name)}, {\n  url: ${JSON.stringify(url)}${transport}${headers},\n});\n`;
};

const mcpFlueConnections = (servers: McpServerArtifact[]): MaterializeResult => {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  let port = PROXY_BASE_PORT;
  for (const s of servers) {
    const seg = safePathSegment(s.name);
    const connectionPath = `connections/${seg}.ts`;
    if (connectionPath in files) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `path collision with an earlier mcp_server at ${connectionPath}` });
      continue;
    }
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (/^https?:\/\//.test(url)) {
      const unsupportedSecret = (s.secretRefs ?? []).find((r) => !/^headers\./i.test(r.location));
      if (unsupportedSecret) {
        skipped.push({ artifact: s.name, type: "mcp_server", reason: `Flue cannot map secret at ${unsupportedSecret.location}` });
        continue;
      }
      files[connectionPath] = flueConnection(s, url);
    } else if (s.transport === "stdio" && typeof s.config.command === "string") {
      const p = port++;
      const args = Array.isArray(s.config.args) ? s.config.args.filter((a): a is string => typeof a === "string") : [];
      // localhost proxy connection carries no auth headers (the proxy injects the secrets into the stdio process)
      files[connectionPath] = flueConnection({ ...s, secretRefs: undefined }, `http://${PROXY_HOST}:${p}/mcp`);
      files[`proxies/${seg}.mjs`] = stdioProxyRunner(s.name, s.config.command, args, (s.secretRefs ?? []).map((r) => r.name), p);
    } else {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `${s.transport} MCP has no usable URL or stdio command` });
    }
  }
  return { files, skipped };
};
```

Then add `mcp: mcpFlueConnections` to the `flue` registry entry:

```ts
  flue:   { id: "flue",   label: "Flue",   skill: skillSkillMd,        instructions: () => ({}), mcp: mcpFlueConnections, compose: flueComposeAgent },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "flue MCP"` then `npm test` (full suite — confirm no regression to the controller/workspace tests, which now see `flue` in `compatibility`).
Expected: PASS. (Note: `MaterializeResponseSchema`/workspace `compatibility` records use `z.record(TargetIdSchema, …)`, so the new `flue` key validates automatically.)

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(targets): Flue MCP connections (http/sse + stdio proxy bridge)"
```

---

### Task 3: UI — add Flue to the materialize target select

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: the `flue` target (Tasks 1–2). The workspace per-target tabs are already dynamic (built from `compatibility` keys), so they pick up Flue automatically; only the Materialize-preview `<select>` is static.

This is a one-line UI change with no unit-test harness; verify by driving the running app.

- [ ] **Step 1: Add the option**

In `src/public/index.html`, find the materialize target select (`<select id="target" …>`) and add a Flue option alongside the others:

```html
<option value="flue">Flue</option>
```

(Place it after the `eve` option to match the registry order.)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean (`tsc -b` + index.html copied to `dist/public`).

- [ ] **Step 3: Drive the running app (manual verification)**

```bash
SRC=$(mktemp -d); export AGENTGEM_HOME=$(mktemp -d)
mkdir -p "$SRC/skills/review"; printf '%s\n' '---' 'name: review' 'description: Review' '---' '# Review' > "$SRC/skills/review/SKILL.md"
printf '%s' '{"mcpServers":{"ctx":{"url":"https://mcp.x/sse"}}}' > "$SRC/.mcp.json"
PORT=4320 node dist/index.js &  SRV=$!
sleep 1
# materialize flue directly (the select drives this same call)
curl -s localhost:4320/api/materialize -H 'content-type: application/json' -d "{\"dir\":\"$SRC\",\"selection\":{\"skills\":[\"review\"],\"mcpServers\":[\"ctx\"]},\"target\":\"flue\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("target:",d["target"]);print("files:",sorted(d["files"]));print("skipped:",d["skipped"])'
# workspace flue tab path: create + render flue
curl -s localhost:4320/api/workspaces -H 'content-type: application/json' -d "{\"dir\":\"$SRC\",\"name\":\"fluedemo\",\"selection\":{\"skills\":[\"review\"]}}" >/dev/null
curl -s localhost:4320/api/workspace/render -H 'content-type: application/json' -d '{"name":"fluedemo","target":"flue"}' \
  | python3 -c 'import sys,json;print("rendered flue files:",sorted(json.load(sys.stdin)["files"]))'
kill $SRV; rm -rf "$SRC" "$AGENTGEM_HOME"; unset AGENTGEM_HOME
```

Expected: materialize lists `agents/<name>.ts`, `skills/review/SKILL.md`, `connections/ctx.ts`; workspace render lists `agents/fluedemo.ts` + `skills/review/SKILL.md` under `.targets/flue/`. (At gstack verify time, load `/`, choose target **Flue** in the Materialize preview, and confirm the file tree.)

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): add Flue to the materialize target selector"
```

---

## Self-Review

**Spec coverage:**
- §2.1 reuse SKILL.md → Task 1 `skill: skillSkillMd` ✓
- §2.2 compose hook → Task 1 (`TargetSpec.compose` + materialize merge) ✓
- §2.3 instructions fold into agent file (empty renderer, not skipped) → Task 1 (`instructions: () => ({})` + composer; test asserts not-skipped) ✓
- §2.4 MCP mirrors Eve (http/sse + stdio proxy) → Task 2 ✓
- §2.5 hooks skipped → Task 1 test ✓
- §2.7 secret-safe (env names only) → Task 2 (`process.env["<NAME>"]`; test asserts no value) ✓
- §3 support matrix → Tasks 1–2 ✓
- §4 compose hook signature/merge → Task 1 ✓
- §5 renderers (agent file, connections, escaping) → Tasks 1–2 (escapeTemplate tested) ✓
- §6 no schema change; one UI option → Task 3 ✓
- §8 testing → Tasks 1–2 unit + Task 3 drive ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; run steps have commands + expected output. ✓

**Type consistency:** `flueComposeAgent`/`mcpFlueConnections`/`flueConnection`/`escapeTemplate` defined in Tasks 1–2 and referenced consistently; `compose` field name matches between `TargetSpec`, the registry entry, and `materialize()`; `TargetId` union includes `"flue"` so `compatibility`/`TargetIdSchema`/workspace records resolve it. The `merge(result.files, "(composed agent)", "instructions")` call reuses the existing `merge` helper signature. ✓
