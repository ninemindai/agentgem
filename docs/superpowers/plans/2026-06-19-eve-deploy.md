# Eve runnable project (Phases 1–2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agentgem's `eve` target emit a *runnable* vercel/eve project from a gem: skills that pass eve's frontmatter schema, MCP connections (URL-only), and a full project scaffold (`package.json`, `tsconfig.json`, `agent/agent.ts`, `agent/channels/eve.ts`, ignore files).

**Architecture:** Three focused edits to the single file `src/gem/targets.ts` (+ its test): (1) normalize eve skill frontmatter, (2) make eve MCP URL-only (stdio → skipped, drop the proxy bridge), (3) add an eve `compose` hook that emits the project scaffold. All pure functions; no runtime/CLI work (that's Phase 3, a separate spec).

**Tech Stack:** TypeScript, pnpm, vitest. Targets render an in-memory `FileTree`; `materialize(gem, "eve")` composes per-artifact renderers + a `compose` hook.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-19-eve-deploy-design.md`. This plan implements **Phases 1 and 2 only**; Phase 3 (deploy orchestration + UI) is a later sub-spec.
- **Clean build before testing:** vitest runs the **compiled** tests from `dist/` and `tsc -b` is incremental — always `rm -rf dist *.tsbuildinfo && pnpm test`. The current suite is **129 tests / 18 files**; expect the count to rise as tests are added.
- **macOS BSD sed ignores `\b`** — not relevant here (no sed), noted for parity with the repo's other plans.
- **eve dep pins (verbatim, from `eve init` on eve 0.11.7):** `eve ^0.11.7`, `ai 7.0.0-beta.178`, `zod 4.4.3`, `@vercel/connect 0.2.2`; `engines.node: "24.x"`.
- **agent.ts model (verbatim):** `anthropic/claude-sonnet-4.6`.
- **stdio MCP is unsupported on eve** — eve connections require an HTTP/SSE URL. stdio servers go to `skipped`; do **not** emit `agent/proxies/`.
- Only the `eve` target changes. `flue` keeps its own `mcpFlueConnections` + proxy bridge (it still imports `stdioProxyRunner`/`PROXY_BASE_PORT`/`PROXY_HOST` — leave that import).

---

### Task 1: Normalize eve skill frontmatter

eve's authored-skill schema allows only `description` / `metadata` / `license`. `skillEveMd` currently emits the source `SKILL.md` verbatim, so skills carrying `preamble-tier`, `allowed-tools`, numeric `metadata.priority`, etc. are rejected (118/199 in the spike). Re-emit only a `description` (from `SkillArtifact.description`) above the original body; if there's no description, emit the body alone (eve derives the hint from the first body line).

**Files:**
- Modify: `src/gem/targets.ts` (add `stripYamlFrontmatter`, rewrite `skillEveMd` at line 41)
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `SkillArtifact` (`{ type, name, source, content, description? }`), `safePathSegment`.
- Produces: `skillEveMd(a: SkillArtifact) => FileTree` — `{ "agent/skills/<seg>.md": <normalized> }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/gem/__tests__/targets.test.ts` inside `describe("materialize", ...)`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- targets`
Expected: FAIL — the messy skill currently renders verbatim (still contains `preamble-tier`).

- [ ] **Step 3: Implement the helper + new `skillEveMd`**

In `src/gem/targets.ts`, replace the single-line `skillEveMd` (line 41) with:

```typescript
// Strip a leading YAML frontmatter block ("---\n … \n---\n") if present; return the body.
function stripYamlFrontmatter(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return m ? content.slice(m[0].length) : content;
}
// Eve authored-skill shape allows only description/metadata/license. Re-emit a clean description
// (from the artifact) over the original body; omit frontmatter entirely when there's no description
// (eve falls back to the first body line). JSON.stringify yields a safe double-quoted YAML scalar.
const skillEveMd = (a: SkillArtifact): FileTree => {
  const body = stripYamlFrontmatter(a.content);
  const desc = a.description?.trim();
  const out = desc ? `---\ndescription: ${JSON.stringify(desc)}\n---\n${body}` : body;
  return { [`agent/skills/${safePathSegment(a.name)}.md`]: out };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- targets`
Expected: PASS. The existing `eve: ... ` test at line 47 still passes (its `skill("review")` has no frontmatter and no description → body `"# body"` unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "fix(eve): normalize skill frontmatter to eve's description-only shape"
```

---

### Task 2: Make eve MCP URL-only (stdio → skipped, drop proxy bridge)

eve connections require an HTTP/SSE URL. Remove the stdio→localhost-proxy branch from `mcpEveConnections`: http/sse servers still become a connection file; everything else (stdio, or http with no URL) goes to `skipped`. No `agent/proxies/` output.

**Files:**
- Modify: `src/gem/targets.ts` (`mcpEveConnections`, lines 59–88)
- Test: `src/gem/__tests__/targets.test.ts` (update the two eve MCP tests)

**Interfaces:**
- Consumes: `McpServerArtifact`, `eveConnection`, `safePathSegment`.
- Produces: `mcpEveConnections(servers) => MaterializeResult` — only `agent/connections/<seg>.ts` files; stdio/url-less servers in `skipped` with reason `eve connections require an HTTP/SSE URL; <transport> MCP unsupported`.

- [ ] **Step 1: Update the failing tests**

Replace the `it("eve: skills/instructions + http connection + stdio proxy runner; hooks skipped", …)` test (lines 46–64) with:

```typescript
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
```

In the `it("eve sanitizes file paths and reports invalid or colliding MCP artifacts", …)` test, change the `missing` reason matcher (line 75) from:

```typescript
    expect(r.skipped.find((s) => s.artifact === "missing")?.reason).toMatch(/no usable URL/);
```
to:
```typescript
    expect(r.skipped.find((s) => s.artifact === "missing")?.reason).toMatch(/HTTP\/SSE URL/);
```

(The `compatibility(...).eve` assertion on the next line stays `{ supported: 1, skipped: 2 }` — unchanged.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- targets`
Expected: FAIL — current code emits `agent/connections/local.ts` + `agent/proxies/local.mjs` and the old `no usable URL` reason.

- [ ] **Step 3: Implement the URL-only renderer**

Replace `mcpEveConnections` (lines 59–88) with:

```typescript
// Eve MCP connections: one TS file per http/sse server (auth reads the secret from an env var name,
// never a value). eve connections are URL-only, so stdio (and url-less http) servers are skipped.
const mcpEveConnections = (servers: McpServerArtifact[]): MaterializeResult => {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  for (const s of servers) {
    const segment = safePathSegment(s.name);
    const connectionPath = `agent/connections/${segment}.ts`;
    if (connectionPath in files) {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `path collision with an earlier mcp_server at ${connectionPath}` });
      continue;
    }
    const url = typeof s.config.url === "string" ? s.config.url : "";
    if (/^https?:\/\//.test(url)) {
      const unsupportedSecret = (s.secretRefs ?? []).find((r) => !/^headers\./i.test(r.location));
      if (unsupportedSecret) {
        skipped.push({ artifact: s.name, type: "mcp_server", reason: `Eve cannot map secret at ${unsupportedSecret.location}` });
        continue;
      }
      files[connectionPath] = eveConnection(s, url);
    } else {
      skipped.push({ artifact: s.name, type: "mcp_server", reason: `eve connections require an HTTP/SSE URL; ${s.transport} MCP unsupported` });
    }
  }
  return { files, skipped };
};
```

Leave the `import { stdioProxyRunner, PROXY_BASE_PORT, PROXY_HOST } from "./mcpProxy.js";` line — `mcpFlueConnections` still uses it. Update the comment block above the function accordingly (the old comment describes the proxy bridge that no longer applies to eve).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- targets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(eve): URL-only MCP connections; stdio servers skipped (no proxy bridge)"
```

---

### Task 3: Emit a runnable eve project scaffold (compose hook)

agentgem currently emits only the `agent/` source. Add an eve `compose` hook that also emits `package.json`, `tsconfig.json`, `agent/agent.ts`, `agent/channels/eve.ts`, `.gitignore`, `.vercelignore` — the files `eve init` provides — so the rendered output is a runnable project.

**Files:**
- Modify: `src/gem/targets.ts` (add `eveComposeProject` + template constants; wire `compose` into the `eve` `TargetSpec` entry, line 268)
- Test: `src/gem/__tests__/targets.test.ts`

**Interfaces:**
- Consumes: `Gem` (`{ name, … }`), `safePathSegment`, `rendered`, `MaterializeResult`.
- Produces: `eveComposeProject(gem) => MaterializeResult`; `TARGET_REGISTRY.eve.compose === eveComposeProject`.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/targets.test.ts`:

```typescript
  it("eve: compose emits a runnable project scaffold", () => {
    const r = materialize(gem([skill("review")]), "eve");
    const pkg = JSON.parse(r.files["package.json"]);
    expect(pkg.name).toBe("p");                       // from gem name "p"
    expect(pkg.engines.node).toBe("24.x");
    expect(pkg.dependencies.eve).toBe("^0.11.7");
    expect(pkg.dependencies.ai).toBe("7.0.0-beta.178");
    expect(pkg.scripts.start).toBe("eve start");
    expect(r.files["agent/agent.ts"]).toContain('model: "anthropic/claude-sonnet-4.6"');
    expect(r.files["agent/agent.ts"]).toContain('defineAgent');
    expect(r.files["agent/channels/eve.ts"]).toContain("eveChannel");
    expect(r.files["tsconfig.json"]).toContain('"moduleResolution": "NodeNext"');
    expect(r.files[".gitignore"]).toContain(".eve");
    expect(r.files[".vercelignore"]).toContain("node_modules");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- targets`
Expected: FAIL — `r.files["package.json"]` is undefined (no compose on eve yet).

- [ ] **Step 3: Implement the scaffold compose + wire it in**

In `src/gem/targets.ts`, add these constants and the compose function just above the `TARGET_REGISTRY` declaration (after `sandboxComposeAgent`, before line 261):

```typescript
// ── Eve runnable-project scaffold (templates pinned to eve 0.11.x, from `eve init`) ──
const EVE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["agent/**/*.ts", "evals/**/*.ts", ".eve/**/*.d.ts"]
}
`;
const EVE_AGENT_TS = `import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});
`;
const EVE_CHANNEL_TS = `import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Open on localhost for \`eve dev\` and the REPL; ignored in production.
    localDev(),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
});
`;
const EVE_GITIGNORE = `node_modules
.env*
.eve
.vercel
.workflow-data
.next
.output
.nitro
dist
.DS_Store
*.tsbuildinfo
`;
const EVE_VERCELIGNORE = `node_modules
.env*
.eve
.workflow-data
.next
.output
.nitro
dist
`;
const evePackageJson = (gemName: string): string =>
  JSON.stringify({
    name: safePathSegment(gemName).toLowerCase(),
    version: "0.0.0",
    type: "module",
    imports: { "#*": "./agent/*", "#evals/*": "./evals/*" },
    scripts: { build: "eve build", dev: "eve dev", start: "eve start", typecheck: "tsgo" },
    dependencies: { "@vercel/connect": "0.2.2", ai: "7.0.0-beta.178", eve: "^0.11.7", zod: "4.4.3" },
    devDependencies: { "@types/node": "24.x", "@typescript/native-preview": "7.0.0-dev.20260523.1" },
    overrides: { ai: "7.0.0-beta.178" },
    resolutions: { ai: "7.0.0-beta.178" },
    engines: { node: "24.x" },
  }, null, 2) + "\n";

// Cross-cutting scaffold: the files `eve init` provides so the rendered agent/ source is runnable.
const eveComposeProject = (gem: Gem): MaterializeResult => rendered({
  "package.json": evePackageJson(gem.name),
  "tsconfig.json": EVE_TSCONFIG,
  "agent/agent.ts": EVE_AGENT_TS,
  "agent/channels/eve.ts": EVE_CHANNEL_TS,
  ".gitignore": EVE_GITIGNORE,
  ".vercelignore": EVE_VERCELIGNORE,
});
```

Then change the `eve` entry in `TARGET_REGISTRY` (line 268) to add the compose hook:

```typescript
  eve:    { id: "eve",    label: "Eve",    skill: skillEveMd,         instructions: concatInstructions("agent/instructions.md"), mcp: mcpEveConnections, compose: eveComposeProject },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `rm -rf dist *.tsbuildinfo && pnpm test -- targets`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `rm -rf dist *.tsbuildinfo && pnpm test`
Expected: PASS (all files; the new eve tests included).

- [ ] **Step 6: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.test.ts
git commit -m "feat(eve): emit runnable project scaffold (package.json, tsconfig, agent.ts, channel)"
```

---

### Task 4: End-to-end verification against the eve toolchain

Unit tests prove the renderer; this proves the rendered output actually runs on real eve. Manual, no commit.

**Files:** none (uses the running agentgem server + a scratch eve project).

- [ ] **Step 1: Re-render the gem workspace to eve**

The agentgem server reads `eve` from `TARGET_REGISTRY`; rebuild and re-render so the workspace reflects the new renderer:

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
rm -rf dist *.tsbuildinfo && pnpm build
node dist/index.js &   # or restart the existing server
sleep 2
curl -s -X POST http://127.0.0.1:4317/api/workspace/render -H 'content-type: application/json' -d '{"name":"gem","target":"eve"}' -o /dev/null -w "render: %{http_code}\n"
```

- [ ] **Step 2: Build a fresh eve project from the re-rendered output**

```bash
cd /tmp && rm -rf eve-verify
mkdir eve-verify && cp -R ~/.agentgem/workspaces/gem/.targets/eve/* /tmp/eve-verify/
cd /tmp/eve-verify && npm install
```

Expected: install succeeds (node 24 satisfied; deps resolve).

- [ ] **Step 3: Confirm eve accepts the project**

```bash
cd /tmp/eve-verify
ANTHROPIC_API_KEY=$(grep -m1 ANTHROPIC_API_KEY ~/Projects/ninemind/agentgem/.env | cut -d= -f2) npx eve info < /dev/null 2>&1 | sed -n '1,20p'
```

Expected: `Compile  succeeded` (or `0 errors`), and `Skills  199 skills` (all skills now valid — up from 81). If any `skill-frontmatter-invalid` diagnostics remain, capture `.eve/discovery/diagnostics.json` and fix the renderer.

- [ ] **Step 4: Confirm a production build compiles**

```bash
cd /tmp/eve-verify && npx eve build 2>&1 | tail -15
```

Expected: build succeeds (writes `.output`). This validates `agent.ts`, `channels/eve.ts`, and the connection files compile under eve.

---

## Self-Review

**Spec coverage (Phases 1–2):**
- Phase 1 skill-frontmatter normalization → Task 1. ✓
- Phase 2 stdio→skipped, drop proxies → Task 2. ✓
- Phase 2 runnable scaffold (package.json/tsconfig/agent.ts/channels/ignores), model sonnet-4.6, node 24, dep pins → Task 3. ✓
- eve-toolchain verification (199 skills, `eve build`) → Task 4. ✓
- Phase 3 (deploy orchestration + UI) → intentionally **out of scope** for this plan (separate sub-spec). ✓

**Placeholder scan:** none — every code/test step shows complete content; commands have expected output.

**Type consistency:** `skillEveMd`, `stripYamlFrontmatter`, `mcpEveConnections`, `eveComposeProject`, `evePackageJson` signatures match their call sites; `eveComposeProject` returns `MaterializeResult` via `rendered(...)`; wired as `TARGET_REGISTRY.eve.compose`. Model string `anthropic/claude-sonnet-4.6` and dep pins match the Global Constraints verbatim.
