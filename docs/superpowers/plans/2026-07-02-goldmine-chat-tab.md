# Goldmine Chat Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A console tab that holds a read-mostly, goldmine-grounded conversation with a local coding agent driven over ACP, and can turn that conversation into a Gem draft in Curate.

**Architecture:** A long-lived ACP session per chat (single-user console ⇒ ~1 subprocess). The agent is grounded two ways (hybrid): a pre-injected goldmine *brief* in the opening prompt, plus a client-provisioned **stdio MCP server** (`agentgem-goldmine`) exposing read tools it can call for detail. A server-side session manager owns subprocess lifecycle and streams turns to the UI over SSE using the existing event vocabulary. "Draft a Gem" reuses the recommender's validate-against-inventory → `buildGem` pipeline.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥24, `@agentclientprotocol/sdk` v0.28.1, `@agentback/mcp` (stdio), `@agentback/rest` (JSON) + raw Express SSE, React console (`defineConsolePage`), vitest.

## Global Constraints

- **Node ≥ 24** (repo floor; `node:` builtins allowed). One line per rule below applies to every task.
- **ESM + NodeNext:** relative imports end in `.js`; import types from package entrypoints (`@agentgem/insight`, `@agentgem/capture`, `@agentgem/model`, `@agentgem/build`, `@agentgem/base`).
- **Tests run compiled dist:** vitest executes compiled tests from `dist/`. After any file move/rename, `rm -rf dist` before running tests. Build with the repo's usual `pnpm build` (tsc).
- **Console tests are NOT in CI:** `packages/console` vitest + typecheck run locally only — run them yourself before considering a UI task done.
- **Repo requires REBASE merge, branch up-to-date:** never create merge commits on the branch; linearize on `origin/main` before integrating.
- **Git identity:** commits authored `Raymond Feng <raymond@ninemind.ai>`; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Read-mostly invariant:** nothing in this feature writes user files or executes Gems. The goldmine MCP tools are pure reads of `~/.claude`; the draft handoff produces a *draft* for human review.
- **Slice-1 streaming is per-turn, not token-incremental (INTENTIONAL).** `ChatManager.sendMessage` buffers a turn's deltas and yields them after `prompt()` resolves; the whole answer appears when the turn completes. Tool chips + `phase`/`done` events still work. True token-by-token streaming (bridging the ACP `onUpdate` callback into an async channel that yields concurrently with the turn) is a deferred fast-follow — do NOT flag the buffered form as a defect.
- **Execution ordering:** run **Task 3 before Task 1** — Task 1's live-smoke depends on Task 3's `connectAcpAdapter`/`stdioMcpServer` changes. All other tasks follow plan order.

---

## File structure

- `src/goldmine/mcpServer.ts` — stdio MCP server + pure tool fns (`searchSessions`, `getArtifactDetail`); bin `agentgem-goldmine`.
- `packages/base/src/acpSession.ts` — extend `open()` to provision `mcpServers`; add `stdioMcpServer()` helper.
- `packages/base/src/agents.ts` — agent registry + `availableAgents()`.
- `packages/insight/src/goldmineContext.ts` — `buildGoldmineBrief()`.
- `packages/run/src/chatSession.ts` — `ChatManager` (open/send/close, idle sweep, LRU); `ChatEvent`.
- `src/goldmine/chatRoutes.ts` — raw Express SSE + JSON handlers, wired in `src/index.ts`.
- `src/goldmine/draftGem.ts` — `validateSelection()` + draft persistence.
- `packages/console/src/panels/Chat/index.tsx`, `chatStream.ts` — UI; registered in `packages/console/src/pages.tsx`.

---

### Task 1: Live-smoke gate — does the adapter honor a client stdio MCP server?

This gates the whole feature. SDK types confirm provisioning; the *adapter* honoring it is unverified. If this fails, STOP and revisit the spec (fall back to pre-inject-only).

**Files:**
- Create: `scripts/smoke/mcp-provision-smoke.mjs` (throwaway smoke; not shipped)
- Create: `scripts/smoke/echo-mcp.mjs` (a trivial stdio MCP server exposing one `echo` tool)

**Interfaces:**
- Produces: empirical answer — "adapter calls a client-provisioned stdio MCP tool: yes/no", recorded in the spec's live-validation section.

- [ ] **Step 1: Install a real adapter**

Run: `npm i -g @agentclientprotocol/claude-agent-acp` (or the package the repo pins; confirm `claude-agent-acp --version` resolves on PATH). Requires the user's Claude login to be present.

- [ ] **Step 2: Write a trivial echo stdio MCP server**

`scripts/smoke/echo-mcp.mjs` — an `@agentback/mcp` server with one tool:

```js
import { MCPApplication, mcpServer, tool } from "@agentback/mcp";
import { z } from "zod";

@mcpServer()
class EchoTools {
  @tool("echo", { input: z.object({ text: z.string() }), description: "Echo the input text back." })
  async echo({ text }) { return { echoed: text }; }
}
const app = new MCPApplication();
app.configure("servers.MCPServer").to({ name: "echo", version: "0.0.1" });
app.service(EchoTools);
await app.start(); // blocks on stdio
```

- [ ] **Step 3: Write the smoke that provisions it and asks the agent to call it**

`scripts/smoke/mcp-provision-smoke.mjs`:

```js
import { connectAcpAdapter, stdioMcpServer } from "@agentgem/base"; // stdioMcpServer added in Task 3
const conn = await connectAcpAdapter(
  { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] },
  { clientName: "smoke", permission: "allow" },
);
const server = stdioMcpServer("echo", process.execPath, ["scripts/smoke/echo-mcp.mjs"]);
const session = await conn.open(process.cwd(), { mcpServers: [server] });
const seen = [];
await session.prompt("Call the echo tool with text 'ping' and report the result.", (u) => seen.push(u));
console.log(JSON.stringify(seen.filter((u) => u?.sessionUpdate?.startsWith("tool_call")), null, 2));
conn.close();
```

- [ ] **Step 4: Run it and read the output**

Run: `pnpm build && node scripts/smoke/mcp-provision-smoke.mjs`
Expected (PASS): the printed updates include a `tool_call` whose title references `echo`, and the agent's message includes `ping`.
If NO `tool_call` for `echo` appears: the adapter ignores client MCP servers → **STOP**, record the failure in the spec, and pivot the plan to pre-inject-only (drop Tasks 2–3's MCP wiring; keep the brief).

- [ ] **Step 5: Record the result**

Edit the spec's "Live-validation risks" → PRIMARY RISK bullet to state the confirmed outcome (date + adapter version). Commit:

```bash
git add docs/superpowers/specs/2026-07-02-goldmine-chat-tab-design.md scripts/smoke
git commit -m "test(chat): live-smoke confirms adapter honors client stdio MCP server"
```

---

### Task 2: Goldmine read tools (pure functions)

TDD the two tool bodies as pure functions over injected data, independent of MCP/stdio.

**Files:**
- Create: `src/goldmine/tools.ts`
- Test: `src/goldmine/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `SessionStat` (`@agentgem/insight`), `ConfigInventory`/`ProjectInventory` (`@agentgem/model`).
- Produces:
  - `searchSessions(sessions: SessionStat[], query: string, limit: number): SessionMatch[]`
  - `getArtifactDetail(global: ConfigInventory, project: ProjectInventory | null, type: string, name: string): ArtifactDetail | null`
  - `interface SessionMatch { sessionId: string; project: string; agent: string; model: string; gitBranch: string; startMs: number; msgs: number }`
  - `interface ArtifactDetail { type: string; name: string; root: string | null; description: string; path?: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { searchSessions, getArtifactDetail } from "../tools.js";

const S = (o: Partial<any>) => ({ agent: "claude", sessionId: "s1", project: "/p/web", model: "opus", gitBranch: "main", startMs: 10, endMs: 20, msgs: 4, tokensIn: 0, tokensOut: 0, tokensCache: 0, ...o });

describe("searchSessions", () => {
  it("matches on project substring, newest first, honors limit", () => {
    const rows = [S({ sessionId: "a", project: "/p/web", startMs: 1 }), S({ sessionId: "b", project: "/p/api", startMs: 2 }), S({ sessionId: "c", project: "/p/webhook", startMs: 3 })];
    const out = searchSessions(rows, "web", 10);
    expect(out.map((m) => m.sessionId)).toEqual(["c", "a"]); // web + webhook, newest first
  });
  it("empty query returns newest N", () => {
    const rows = [S({ sessionId: "a", startMs: 1 }), S({ sessionId: "b", startMs: 2 })];
    expect(searchSessions(rows, "", 1).map((m) => m.sessionId)).toEqual(["b"]);
  });
});

describe("getArtifactDetail", () => {
  const global = { skills: [{ name: "brainstorm", description: "ideas", path: "/g/brainstorm" }], mcpServers: [], instructions: [], hooks: [] } as any;
  const project = { root: "/p/web", name: "web", skills: [{ name: "deploy", description: "ship it", path: "/p/web/deploy" }], mcpServers: [], instructions: [], hooks: [] } as any;
  it("prefers project scope, returns detail", () => {
    expect(getArtifactDetail(global, project, "skill", "deploy")).toMatchObject({ name: "deploy", root: "/p/web", description: "ship it" });
  });
  it("falls back to global (root null)", () => {
    expect(getArtifactDetail(global, project, "skill", "brainstorm")).toMatchObject({ name: "brainstorm", root: null });
  });
  it("returns null for unknown", () => {
    expect(getArtifactDetail(global, project, "skill", "nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/tools.test.js`
Expected: FAIL ("searchSessions is not a function").

- [ ] **Step 3: Implement**

```ts
// src/goldmine/tools.ts
import type { SessionStat } from "@agentgem/insight";
import type { ConfigInventory, ProjectInventory } from "@agentgem/model";

export interface SessionMatch { sessionId: string; project: string; agent: string; model: string; gitBranch: string; startMs: number; msgs: number }
export interface ArtifactDetail { type: string; name: string; root: string | null; description: string; path?: string }

export function searchSessions(sessions: SessionStat[], query: string, limit: number): SessionMatch[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? sessions.filter((s) => `${s.project} ${s.model} ${s.gitBranch}`.toLowerCase().includes(q))
    : sessions.slice();
  return matched
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, limit)
    .map((s) => ({ sessionId: s.sessionId, project: s.project, agent: s.agent, model: s.model, gitBranch: s.gitBranch, startMs: s.startMs, msgs: s.msgs }));
}

type Bucket = { name: string; description?: string; path?: string };
const KEY: Record<string, keyof ProjectInventory & keyof ConfigInventory> = {
  skill: "skills", mcp_server: "mcpServers", hook: "hooks", instructions: "instructions",
} as any;

export function getArtifactDetail(global: ConfigInventory, project: ProjectInventory | null, type: string, name: string): ArtifactDetail | null {
  const key = KEY[type]; if (!key) return null;
  const find = (list: Bucket[] | undefined, root: string | null) => {
    const hit = (list ?? []).find((a) => a.name === name);
    return hit ? { type, name: hit.name, root, description: hit.description ?? "", path: hit.path } : null;
  };
  return find(project?.[key] as Bucket[] | undefined, project?.root ?? null) ?? find(global[key] as Bucket[] | undefined, null);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/tools.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/tools.ts src/goldmine/__tests__/tools.test.ts
git commit -m "feat(chat): goldmine read-tool bodies (searchSessions, getArtifactDetail)"
```

---

### Task 3: `stdioMcpServer()` helper + provision `mcpServers` through the ACP seam

The `connectAcpAdapter` body is validated by the live smoke (Task 1); here we add the small pure helper (unit-testable) and thread an optional `mcpServers` param through `open()`.

**Files:**
- Modify: `packages/base/src/acpSession.ts`
- Test: `packages/base/src/__tests__/stdioMcpServer.test.ts`

**Interfaces:**
- Produces:
  - `stdioMcpServer(name: string, command: string, args: string[], env?: Record<string,string>): McpServer` (SDK `McpServerStdio` shape)
  - `RawAcpConnection.open(cwd: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>` (extended)
  - re-export `type McpServer` from `@agentclientprotocol/sdk` schema.

- [ ] **Step 1: Write the failing test (pure helper)**

```ts
import { describe, it, expect } from "vitest";
import { stdioMcpServer } from "../acpSession.js";

describe("stdioMcpServer", () => {
  it("builds an McpServerStdio with env as name/value pairs", () => {
    expect(stdioMcpServer("goldmine", "/usr/bin/node", ["srv.js"], { ROOT: "/p" })).toEqual({
      name: "goldmine", command: "/usr/bin/node", args: ["srv.js"], env: [{ name: "ROOT", value: "/p" }],
    });
  });
  it("defaults env to empty array", () => {
    expect(stdioMcpServer("x", "node", []).env).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/base/src/__tests__/stdioMcpServer.test.js`
Expected: FAIL ("stdioMcpServer is not a function").

- [ ] **Step 3: Implement the helper + thread `mcpServers`**

In `packages/base/src/acpSession.ts`, add near the top:

```ts
import type { McpServer } from "@agentclientprotocol/sdk";
export type { McpServer } from "@agentclientprotocol/sdk";

export function stdioMcpServer(name: string, command: string, args: string[], env: Record<string, string> = {}): McpServer {
  return { name, command, args, env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })) } as McpServer;
}
```

Change the `open` signature and `buildSession` call:

```ts
async open(cwd: string, opts?: { mcpServers?: McpServer[] }) {
  try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
  let builder: any = agentCtx.buildSession(cwd);
  for (const s of opts?.mcpServers ?? []) builder = builder.withMcpServer(s);
  const session: any = await builder.start();
  // ...unchanged...
}
```

Update the `RawAcpConnection.open` interface signature to `open(cwd: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/base/src/__tests__/stdioMcpServer.test.js`
Expected: PASS. Also run existing base tests: `npx vitest run dist/base` — expect green (the `open` param is optional, callers unaffected).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts packages/base/src/__tests__/stdioMcpServer.test.ts
git commit -m "feat(chat): stdioMcpServer helper + provision mcpServers through connectAcpAdapter.open"
```

---

### Task 4: Ship the goldmine MCP server binary

Wrap Task 2's pure fns in an `@agentback/mcp` stdio server, mirroring `src/distill/mcpServer.ts`, and register the `agentgem-goldmine` bin. Validated by a focused live check.

**Files:**
- Create: `src/goldmine/mcpServer.ts`
- Modify: `package.json` (`bin` map)
- Test: `src/goldmine/__tests__/mcpServer.wiring.test.ts` (asserts tool registration metadata; no stdio)

**Interfaces:**
- Consumes: `searchSessions`, `getArtifactDetail` (Task 2); `scanSessionsCached(nowMs, dirs?, refresh?)`, `introspectConfig()`, `introspectProject(root)`.
- Produces: `class GoldmineTools` with tools `search_sessions`, `get_artifact_detail`; `main()` starting stdio; bin `agentgem-goldmine → dist/goldmine/mcpServer.js`.

- [ ] **Step 1: Write the failing wiring test**

```ts
import { describe, it, expect } from "vitest";
import { GoldmineTools } from "../mcpServer.js";
// @agentback/mcp attaches tool metadata to the prototype; assert both tools exist.
import { getMcpTools } from "@agentback/mcp"; // metadata reader (confirm exact export name in @agentback/mcp)

describe("GoldmineTools", () => {
  it("registers search_sessions and get_artifact_detail", () => {
    const names = getMcpTools(GoldmineTools).map((t: any) => t.name);
    expect(names.sort()).toEqual(["get_artifact_detail", "search_sessions"]);
  });
});
```

> If `@agentback/mcp` exposes no public metadata reader, replace this with a test that constructs `new GoldmineTools()` and calls the tool methods directly against a temp `HOME` fixture, asserting shapes. Either way, do not spawn stdio in unit tests.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/mcpServer.wiring.test.js`
Expected: FAIL ("Cannot find module ../mcpServer.js").

- [ ] **Step 3: Implement the server**

```ts
// src/goldmine/mcpServer.ts
import { MCPApplication, mcpServer, tool } from "@agentback/mcp";
import { z } from "zod";
import { scanSessionsCached } from "@agentgem/insight";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { searchSessions, getArtifactDetail } from "./tools.js";

const SearchInput = z.object({ query: z.string().default(""), limit: z.number().int().min(1).max(50).default(10) });
const DetailInput = z.object({ type: z.enum(["skill", "mcp_server", "hook", "instructions"]), name: z.string(), root: z.string().optional() });

@mcpServer()
export class GoldmineTools {
  @tool("search_sessions", { input: SearchInput, description: "Search the user's past coding sessions by project/model/branch. Returns newest matches." })
  async searchSessionsTool({ query, limit }: z.infer<typeof SearchInput>) {
    const sessions = await scanSessionsCached(Date.now());
    return { matches: searchSessions(sessions, query, limit) };
  }

  @tool("get_artifact_detail", { input: DetailInput, description: "Return detail about one installed artifact (skill/mcp_server/hook/instructions)." })
  async getArtifactDetailTool({ type, name, root }: z.infer<typeof DetailInput>) {
    const global = introspectConfig();
    const project = root ? introspectProject(root) : null;
    const detail = getArtifactDetail(global, project, type, name);
    return { detail };
  }
}

export async function main(): Promise<void> {
  const app = new MCPApplication();
  app.configure("servers.MCPServer").to({ name: "agentgem-goldmine", version: "0.1.0" });
  app.service(GoldmineTools);
  await app.start();
}

// Run as stdio when invoked directly (bin).
if (import.meta.url === `file://${process.argv[1]}`) { void main(); }
```

Add to `package.json` `bin`: `"agentgem-goldmine": "dist/goldmine/mcpServer.js"`.

- [ ] **Step 4: Run to verify it passes + a live stdio check**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/mcpServer.wiring.test.js` → PASS.
Live check (real stdio, lists tools):
Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/goldmine/mcpServer.js`
Expected: a JSON-RPC response listing `search_sessions` and `get_artifact_detail`.

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/mcpServer.ts src/goldmine/__tests__/mcpServer.wiring.test.ts package.json
git commit -m "feat(chat): agentgem-goldmine stdio MCP server exposing read tools"
```

---

### Task 5: Goldmine context assembler (the pre-inject brief)

**Files:**
- Create: `packages/insight/src/goldmineContext.ts`
- Test: `packages/insight/src/__tests__/goldmineContext.test.ts`
- Modify: `packages/insight/src/index.ts` (export)

**Interfaces:**
- Consumes: `Scorecard`, `ConfigInventory`, `ArtifactUsage` (all typed inputs — the assembler is a pure composer; callers fetch the data).
- Produces: `buildGoldmineBrief(input: GoldmineBriefInput): string` where
  `interface GoldmineBriefInput { scorecard: Pick<Scorecard,"breadth"|"battleTested"|"portable"|"gaps">; topArtifacts: { type: string; name: string; invocations: number }[]; skillCount: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildGoldmineBrief } from "../goldmineContext.js";

describe("buildGoldmineBrief", () => {
  it("produces a compact brief with headline + top artifacts", () => {
    const brief = buildGoldmineBrief({
      scorecard: { breadth: 12, battleTested: 5, portable: 3, gaps: ["playwright"] },
      topArtifacts: [{ type: "skill", name: "brainstorm", invocations: 9 }, { type: "mcp_server", name: "github", invocations: 4 }],
      skillCount: 20,
    });
    expect(brief).toContain("breadth 12");
    expect(brief).toContain("brainstorm");
    expect(brief).toContain("github");
    expect(brief).toContain("playwright"); // gap surfaced
    expect(brief.length).toBeLessThan(2000); // stays compact
  });
  it("handles an empty goldmine without throwing", () => {
    expect(buildGoldmineBrief({ scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] }, topArtifacts: [], skillCount: 0 })).toContain("breadth 0");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/insight/src/__tests__/goldmineContext.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/insight/src/goldmineContext.ts
import type { Scorecard } from "../../../src/gem/scorecard.js"; // if Scorecard isn't exported from a package, inline the Pick shape instead
export interface GoldmineBriefInput {
  scorecard: Pick<Scorecard, "breadth" | "battleTested" | "portable" | "gaps">;
  topArtifacts: { type: string; name: string; invocations: number }[];
  skillCount: number;
}

export function buildGoldmineBrief(input: GoldmineBriefInput): string {
  const { scorecard: s, topArtifacts, skillCount } = input;
  const lines = [
    `You are grounded in the user's local "goldmine" of coding sessions and installed artifacts. Use it to answer questions and, when asked, help distill a reusable Gem. You have read tools (search_sessions, get_artifact_detail) — call them for detail beyond this summary.`,
    ``,
    `GOLDMINE SUMMARY (facts):`,
    `- Scorecard: breadth ${s.breadth}, battle-tested ${s.battleTested}, portable ${s.portable}.`,
    `- Installed skills: ${skillCount}.`,
    topArtifacts.length ? `- Most-used artifacts: ${topArtifacts.map((a) => `${a.name} (${a.type}, ${a.invocations}×)`).join(", ")}.` : `- No artifact usage recorded yet.`,
    s.gaps.length ? `- Gaps (used but not installed): ${s.gaps.join(", ")}.` : `- No gaps detected.`,
  ];
  return lines.join("\n");
}
```

> If `Scorecard` is not exported from a package entrypoint (subagent notes it lives in root `src/gem/scorecard.ts`), replace the import with an inline structural type in `GoldmineBriefInput` — the assembler only needs the four fields. Keep it dependency-light.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/insight/src/__tests__/goldmineContext.test.js` → PASS. Export `buildGoldmineBrief` from `packages/insight/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/goldmineContext.ts packages/insight/src/__tests__/goldmineContext.test.ts packages/insight/src/index.ts
git commit -m "feat(chat): goldmine context assembler (pre-inject brief)"
```

---

### Task 6: Agent registry + availability probe

**Files:**
- Create: `packages/base/src/agents.ts`
- Test: `packages/base/src/__tests__/agents.test.ts`
- Modify: `packages/base/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `const AGENTS: AgentDescriptor[]` (Claude Code + Codex)
  - `interface AgentAvailability { id: string; name: string; available: boolean }`
  - `availableAgents(onPath?: (bin: string) => boolean): AgentAvailability[]` (probe injectable for tests; default probes PATH)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { AGENTS, availableAgents } from "../agents.js";

describe("availableAgents", () => {
  it("marks agents present/absent via the probe", () => {
    const out = availableAgents((bin) => bin === "claude-agent-acp");
    const claude = out.find((a) => a.id === "claude-code");
    const codex = out.find((a) => a.id === "codex");
    expect(claude?.available).toBe(true);
    expect(codex?.available).toBe(false);
  });
  it("registry includes claude and codex", () => {
    expect(AGENTS.map((a) => a.id).sort()).toEqual(["claude-code", "codex"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/base/src/__tests__/agents.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/base/src/agents.ts
import { execFileSync } from "node:child_process";
import type { AgentDescriptor } from "./acpSession.js";

export const AGENTS: AgentDescriptor[] = [
  { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"] },
  { id: "codex", name: "Codex", command: ["codex-acp"] },
];

export interface AgentAvailability { id: string; name: string; available: boolean }

function onPathDefault(bin: string): boolean {
  try { execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }); return true; }
  catch { return false; }
}

export function availableAgents(onPath: (bin: string) => boolean = onPathDefault): AgentAvailability[] {
  return AGENTS.map((a) => ({ id: a.id, name: a.name, available: onPath(a.command[0]) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/base/src/__tests__/agents.test.js` → PASS. Export both from `packages/base/src/index.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/agents.ts packages/base/src/__tests__/agents.test.ts packages/base/src/index.ts
git commit -m "feat(chat): agent registry + PATH availability probe"
```

---

### Task 7: Chat session manager (long-lived session, multi-turn, lifecycle)

The core. Uses a `connectFn` seam (mirroring recommender/runner) so tests inject a fake agent — no subprocess. Provisions the goldmine MCP descriptor and injects the brief on the first turn.

**Files:**
- Create: `packages/run/src/chatSession.ts`
- Test: `packages/run/src/__tests__/chatSession.test.ts`
- Modify: `packages/run/src/index.ts` (export)

**Interfaces:**
- Consumes: `connectAcpAdapter`/`stdioMcpServer` (`@agentgem/base`), `applyUpdate`/`ToolInvocation`/`RunResult` (from `acpRun.ts` — reuse the reducer), an injected `ChatConnectFn`.
- Produces:
  - `type ChatEvent = { type: "phase"; phase: string } | { type: "delta"; text: string } | { type: "tool"; tool: ToolInvocation } | { type: "done"; result: RunResult } | { type: "failed"; error: string }`
  - `interface ChatSessionHandle { setMode(m: string): Promise<void>; prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void): Promise<RunResult>; dispose(): void }`
  - `interface ChatCtx { open(cwd: string, opts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> }`
  - `type ChatConnectFn = (descriptor: AgentDescriptor) => Promise<{ ctx: ChatCtx; close: () => void }>`
  - `class ChatManager` with:
    - `openChat(input: { agentId: string; brief: string; mcpServers?: unknown[] }): Promise<string>` (returns `chatId`)
    - `sendMessage(chatId: string, message: string): AsyncGenerator<ChatEvent>`
    - `closeChat(chatId: string): void`
    - constructor opts `{ connectFn: ChatConnectFn; now?: () => number; idleMs?: number; maxLive?: number }`
    - `sweepIdle(): void`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { ChatManager } from "../chatSession.js";

// Fake agent: one connect → one session; records prompts; emits a scripted update stream.
function fakeConnect(script: (prompt: string) => any[]) {
  let connects = 0; const prompts: string[] = [];
  const fn = async () => {
    connects++;
    const ctx = { open: async () => ({
      setMode: async () => {},
      prompt: async (text: string, onDelta?: (c: string) => void, onTool?: (t: any) => void) => {
        prompts.push(text);
        for (const u of script(text)) {
          if (u.sessionUpdate === "agent_message_chunk") onDelta?.(u.content.text);
          if (u.sessionUpdate === "tool_call") onTool?.({ toolCallId: u.toolCallId, title: u.title, status: u.status });
        }
        return { text: script(text).filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join(""), toolCalls: [] };
      },
      dispose: () => {},
    }) };
    return { ctx, close: () => {} };
  };
  return { fn, stats: () => ({ connects, prompts }) };
}

describe("ChatManager", () => {
  it("multi-turn reuses one session (connect once) and streams events", async () => {
    const fake = fakeConnect((p) => p.includes("hi")
      ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }]
      : [{ sessionUpdate: "tool_call", toolCallId: "t1", title: "search_sessions", status: "completed" },
         { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found 3" } }]);
    const mgr = new ChatManager({ connectFn: fake.fn as any });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "BRIEF" });

    const ev1: any[] = []; for await (const e of mgr.sendMessage(id, "hi")) ev1.push(e);
    expect(ev1.find((e) => e.type === "delta")?.text).toBe("hello");
    expect(ev1.at(-1).type).toBe("done");

    const ev2: any[] = []; for await (const e of mgr.sendMessage(id, "search")) ev2.push(e);
    expect(ev2.find((e) => e.type === "tool")?.tool.title).toBe("search_sessions");

    expect(fake.stats().connects).toBe(1);                 // one long-lived session
    expect(fake.stats().prompts[0]).toContain("BRIEF");    // brief injected on first turn
    expect(fake.stats().prompts[1]).not.toContain("BRIEF"); // not re-injected after
  });

  it("emits failed (never throws) when the agent errors", async () => {
    const badConnect = async () => ({ ctx: { open: async () => ({ setMode: async () => {}, prompt: async () => { throw new Error("boom"); }, dispose: () => {} }) }, close: () => {} });
    const mgr = new ChatManager({ connectFn: badConnect as any });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const evs: any[] = []; for await (const e of mgr.sendMessage(id, "x")) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "failed", error: "boom" });
  });

  it("sweepIdle tears down sessions past idleMs", async () => {
    let t = 1000; const fake = fakeConnect(() => [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }]);
    const mgr = new ChatManager({ connectFn: fake.fn as any, now: () => t, idleMs: 100 });
    const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    for await (const _ of mgr.sendMessage(id, "hi")) { /* drain */ }
    t = 2000; mgr.sweepIdle();
    const evs: any[] = []; for await (const e of mgr.sendMessage(id, "again")) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "failed" }); // chatId gone after sweep
  });

  it("LRU-evicts beyond maxLive", async () => {
    const fake = fakeConnect(() => []);
    const mgr = new ChatManager({ connectFn: fake.fn as any, maxLive: 1 });
    const a = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const b = await mgr.openChat({ agentId: "claude-code", brief: "B" });
    const evs: any[] = []; for await (const e of mgr.sendMessage(a, "x")) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ type: "failed" }); // 'a' evicted when 'b' opened
    expect(b).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/run/src/__tests__/chatSession.test.js`
Expected: FAIL ("ChatManager is not a constructor").

- [ ] **Step 3: Implement**

```ts
// packages/run/src/chatSession.ts
import type { AgentDescriptor } from "@agentgem/base";
import { applyUpdate, createAccumulator, type ToolInvocation, type RunResult } from "./acpRun.js";

export type ChatEvent =
  | { type: "phase"; phase: string } | { type: "delta"; text: string }
  | { type: "tool"; tool: ToolInvocation } | { type: "done"; result: RunResult }
  | { type: "failed"; error: string };

export interface ChatSessionHandle {
  setMode(m: string): Promise<void>;
  prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void): Promise<RunResult>;
  dispose(): void;
}
export interface ChatCtx { open(cwd: string, opts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> }
export type ChatConnectFn = (descriptor: AgentDescriptor) => Promise<{ ctx: ChatCtx; close: () => void }>;

interface LiveChat { agentId: string; brief: string | null; conn: { ctx: ChatCtx; close: () => void }; handle: ChatSessionHandle; lastMs: number }

let counter = 0;
export class ChatManager {
  private live = new Map<string, LiveChat>();
  private connectFn: ChatConnectFn;
  private now: () => number;
  private idleMs: number;
  private maxLive: number;
  constructor(opts: { connectFn: ChatConnectFn; now?: () => number; idleMs?: number; maxLive?: number }) {
    this.connectFn = opts.connectFn; this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 15 * 60_000; this.maxLive = opts.maxLive ?? 3;
  }

  async openChat(input: { agentId: string; brief: string; mcpServers?: unknown[]; descriptor?: AgentDescriptor; cwd?: string }): Promise<string> {
    while (this.live.size >= this.maxLive) this.evictLru();
    const descriptor = input.descriptor ?? { id: input.agentId, name: input.agentId, command: [input.agentId] };
    const conn = await this.connectFn(descriptor);
    const handle = await conn.ctx.open(input.cwd ?? process.cwd(), { mcpServers: input.mcpServers });
    const chatId = `chat_${++counter}`;
    this.live.set(chatId, { agentId: input.agentId, brief: input.brief, conn, handle, lastMs: this.now() });
    return chatId;
  }

  async *sendMessage(chatId: string, message: string): AsyncGenerator<ChatEvent> {
    const chat = this.live.get(chatId);
    if (!chat) { yield { type: "failed", error: `unknown chat ${chatId}` }; return; }
    chat.lastMs = this.now();
    const prompt = chat.brief ? `${chat.brief}\n\n---\nUser: ${message}` : message;
    chat.brief = null; // inject the brief once
    yield { type: "phase", phase: "running" };
    const queue: ChatEvent[] = [];
    try {
      const result = await chat.handle.prompt(
        prompt,
        (text) => queue.push({ type: "delta", text }),
        (tool) => queue.push({ type: "tool", tool }),
      );
      // NOTE: for real streaming, replace the queue with an async channel; kept simple here — drain then done.
      for (const e of queue) yield e;
      chat.lastMs = this.now();
      yield { type: "done", result };
    } catch (err) {
      yield { type: "failed", error: (err as Error).message };
    }
  }

  closeChat(chatId: string): void {
    const chat = this.live.get(chatId); if (!chat) return;
    try { chat.handle.dispose(); } catch { /* ignore */ }
    try { chat.conn.close(); } catch { /* ignore */ }
    this.live.delete(chatId);
  }

  sweepIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, c] of this.live) if (c.lastMs < cutoff) this.closeChat(id);
  }

  private evictLru(): void {
    let oldest: string | null = null; let oldestMs = Infinity;
    for (const [id, c] of this.live) if (c.lastMs < oldestMs) { oldestMs = c.lastMs; oldest = id; }
    if (oldest) this.closeChat(oldest);
  }
}
```

> Streaming note: the test drains after completion, which the queue-then-yield form satisfies. For true incremental SSE (deltas reaching the client mid-turn), Task 8 wires `onDelta`/`onToolCall` callbacks *directly* to the SSE `res.write` instead of buffering — the manager exposes those callbacks through `sendMessage`. Keep the reducer (`applyUpdate`) as the single fold if you refactor.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/run/src/__tests__/chatSession.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/chatSession.ts packages/run/src/__tests__/chatSession.test.ts packages/run/src/index.ts
git commit -m "feat(chat): ChatManager — long-lived session, multi-turn, idle sweep, LRU"
```

---

### Task 8: REST + SSE endpoints, wired to a real connectFn

Add the raw Express handlers alongside the other streams in `src/index.ts`, plus the real `chatConnectFn` that provisions the goldmine MCP server.

**Files:**
- Create: `src/goldmine/chatRoutes.ts`
- Modify: `src/index.ts` (register handlers; construct one `ChatManager` + start an idle-sweep interval)
- Test: `src/goldmine/__tests__/chatRoutes.integration.ts`

**Interfaces:**
- Consumes: `ChatManager`, `availableAgents`, `AGENTS`, `stdioMcpServer`, `buildGoldmineBrief`, plus goldmine data fns (`collectScorecard`, `introspectConfig`, `scanWorkflow`).
- Produces: `registerChatRoutes(app, deps)`; `chatConnectFn` (real, wraps `connectAcpAdapter` with `permission:"allow"` for read-only tool calls — confirmed acceptable by Task 1's read-tool permission check).

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { registerChatRoutes } from "../chatRoutes.js";
import { ChatManager } from "@agentgem/run";

function testDeps() {
  const fake = async () => ({ ctx: { open: async () => ({ setMode: async () => {}, prompt: async (_t: string, onDelta?: any) => { onDelta?.("hi there"); return { text: "hi there", toolCalls: [] }; }, dispose: () => {} }) }, close: () => {} });
  const mgr = new ChatManager({ connectFn: fake as any });
  return { manager: mgr, buildBrief: async () => "BRIEF", goldmineMcp: () => [], listAgents: () => [{ id: "claude-code", name: "Claude Code", available: true }] };
}

describe("chat routes", () => {
  it("GET /api/agents returns availability", async () => {
    const app = express(); registerChatRoutes(app, testDeps());
    const res = await request(app).get("/api/agents");
    expect(res.body.agents[0]).toMatchObject({ id: "claude-code", available: true });
  });
  it("POST /api/chat then SSE stream yields delta + done", async () => {
    const app = express(); app.use(express.json()); registerChatRoutes(app, testDeps());
    const created = await request(app).post("/api/chat").send({ agentId: "claude-code" });
    const chatId = created.body.chatId; expect(chatId).toBeTruthy();
    const res = await request(app).get(`/api/chat/stream?chatId=${chatId}&message=hi`);
    expect(res.text).toContain("hi there");   // delta frame
    expect(res.text).toContain("event: done");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/chatRoutes.integration.js`
Expected: FAIL ("Cannot find module ../chatRoutes.js"). (Add `supertest` as a devDependency if absent.)

- [ ] **Step 3: Implement the routes**

```ts
// src/goldmine/chatRoutes.ts
import type { Express } from "express";
import type { ChatManager } from "@agentgem/run";
import type { AgentAvailability } from "@agentgem/base";

export interface ChatRouteDeps {
  manager: ChatManager;
  listAgents: () => AgentAvailability[];
  buildBrief: () => Promise<string>;
  goldmineMcp: () => unknown[];
}

export function registerChatRoutes(app: Express, deps: ChatRouteDeps): void {
  app.get("/api/agents", (_req, res) => res.json({ agents: deps.listAgents() }));

  app.post("/api/chat", async (req, res) => {
    try {
      const agentId = String(req.body?.agentId ?? "");
      if (!agentId) return res.status(400).json({ error: "agentId required" });
      const brief = await deps.buildBrief();
      const chatId = await deps.manager.openChat({ agentId, brief, mcpServers: deps.goldmineMcp() });
      res.json({ chatId });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  app.get("/api/chat/stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    const chatId = String(req.query.chatId ?? ""); const message = String(req.query.message ?? "");
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      for await (const ev of deps.manager.sendMessage(chatId, message)) send(ev.type, ev);
    } catch (e) { send("failed", { error: (e as Error).message }); }
    res.end();
  });

  app.delete("/api/chat/:chatId", (req, res) => { deps.manager.closeChat(req.params.chatId); res.json({ ok: true }); });
}
```

In `src/index.ts`: construct a single `ChatManager` with the real `chatConnectFn`, build `goldmineMcp()` via `stdioMcpServer("agentgem-goldmine", process.execPath, [<resolved dist/goldmine/mcpServer.js>])`, `buildBrief()` by fetching scorecard/inventory/usage then `buildGoldmineBrief(...)`, `listAgents()` = `availableAgents()`, then `registerChatRoutes(expressApp, deps)`. Start `setInterval(() => manager.sweepIdle(), 60_000).unref()`.

```ts
// real connectFn (src/index.ts or src/goldmine/chatConnect.ts)
import { connectAcpAdapter } from "@agentgem/base";
import { applyUpdate, createAccumulator } from "@agentgem/run";
export const chatConnectFn = async (descriptor) => {
  const raw = await connectAcpAdapter(descriptor, { clientName: "agentgem-chat", permission: "allow" });
  const ctx = { async open(cwd, opts) {
    const s = await raw.open(cwd, { mcpServers: opts?.mcpServers as any });
    return { setMode: (m) => s.setMode(m),
      async prompt(text, onDelta, onTool) { const acc = createAccumulator(); await s.prompt(text, (u) => applyUpdate(acc, (u ?? {}) as any, { onDelta, onToolCall: onTool })); return acc; },
      dispose: () => s.dispose() };
  } };
  return { ctx, close: raw.close };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/chatRoutes.integration.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/chatRoutes.ts src/goldmine/__tests__/chatRoutes.integration.ts src/index.ts package.json
git commit -m "feat(chat): REST + SSE chat endpoints wired to ChatManager + goldmine MCP"
```

---

### Task 9: Draft-a-Gem handoff (validate against inventory → buildGem → Curate draft)

Reuses the recommender's authoritative-inventory pattern: ask the live session for a selection JSON, validate names against `introspectConfig()`, `buildGem`, persist as a Curate draft.

**Files:**
- Create: `src/goldmine/draftGem.ts`
- Test: `src/goldmine/__tests__/draftGem.test.ts`
- Modify: `src/goldmine/chatRoutes.ts` (add `POST /api/chat/:chatId/draft-gem`)

**Interfaces:**
- Consumes: `ConfigInventory` (`introspectConfig`), `GemSelection` (`@agentgem/build`), `buildGem(inventory, selection)`.
- Produces:
  - `validateSelection(raw: unknown, inv: ConfigInventory): GemSelection` (drops names absent from inventory; returns `{}` when nothing valid)
  - `draftGemFromChat(deps, chatId): Promise<{ draftId: string; gem: Gem } | { error: string }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { validateSelection } from "../draftGem.js";

const inv = { skills: [{ name: "brainstorm" }], mcpServers: [{ name: "github" }], instructions: [], hooks: [], projects: [] } as any;

describe("validateSelection", () => {
  it("keeps known names, drops hallucinated", () => {
    const sel = validateSelection({ skills: ["brainstorm", "ghost"], mcpServers: ["github"] }, inv);
    expect(sel).toEqual({ skills: ["brainstorm"], mcpServers: ["github"] });
  });
  it("returns {} when nothing valid", () => {
    expect(validateSelection({ skills: ["nope"] }, inv)).toEqual({});
  });
  it("ignores malformed input", () => {
    expect(validateSelection("garbage", inv)).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/draftGem.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/goldmine/draftGem.ts
import type { ConfigInventory } from "@agentgem/model";
import type { GemSelection } from "@agentgem/build";

export function validateSelection(raw: unknown, inv: ConfigInventory): GemSelection {
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch { return {}; } }
  if (!obj || typeof obj !== "object") return {};
  const known = (list: { name: string }[], names: unknown): string[] =>
    Array.isArray(names) ? names.filter((n) => typeof n === "string" && list.some((a) => a.name === n)) as string[] : [];
  const sel: Exclude<GemSelection, { all: true }> = {};
  const skills = known(inv.skills, obj.skills); if (skills.length) sel.skills = skills;
  const mcp = known(inv.mcpServers, obj.mcpServers); if (mcp.length) sel.mcpServers = mcp;
  const hooks = known(inv.hooks, obj.hooks); if (hooks.length) sel.hooks = hooks;
  return sel;
}
```

`draftGemFromChat` (wire into the route): prompt the live session with a strict "return ONLY JSON `{skills,mcpServers,hooks}` of installed artifacts to bundle" instruction, `validateSelection(text, introspectConfig())`, `buildGem(inv, selection)`, persist the resulting `Gem` under a draft id the Curate panel reads (reuse Curate's existing draft store — confirm its create/list function during implementation), return `{ draftId, gem }`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/draftGem.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/draftGem.ts src/goldmine/__tests__/draftGem.test.ts src/goldmine/chatRoutes.ts
git commit -m "feat(chat): draft-a-Gem handoff — validate vs inventory, buildGem, Curate draft"
```

---

### Task 10: Chat panel UI + registration

**Files:**
- Create: `packages/console/src/panels/Chat/index.tsx`, `packages/console/src/panels/Chat/chatStream.ts`
- Modify: `packages/console/src/pages.tsx` (register the page)
- Test: `packages/console/src/panels/Chat/__tests__/chatStream.test.ts`

**Interfaces:**
- Consumes: `EventSource` on `/api/chat/stream` (mirror the existing `openXxxStream` clients); `GET /api/agents`; `POST /api/chat`; `POST /api/chat/:id/draft-gem`.
- Produces: `openChatStream(chatId, message, handlers): () => void` (returns an unsubscribe); a `Chat` React page registered via `defineConsolePage`.

- [ ] **Step 1: Write the failing stream-client test**

```ts
import { describe, it, expect, vi } from "vitest";
import { openChatStream } from "../chatStream.js";

class FakeES { onmessage: any; listeners: Record<string, any> = {}; url: string;
  constructor(url: string) { this.url = url; FakeES.last = this; }
  addEventListener(ev: string, fn: any) { this.listeners[ev] = fn; }
  emit(ev: string, data: any) { this.listeners[ev]?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; } closed = false; static last: FakeES;
}

describe("openChatStream", () => {
  it("routes named events to handlers and can unsubscribe", () => {
    (globalThis as any).EventSource = FakeES;
    const onDelta = vi.fn(); const onDone = vi.fn();
    const stop = openChatStream("chat_1", "hi", { onDelta, onTool: vi.fn(), onDone, onFailed: vi.fn() });
    FakeES.last.emit("delta", { type: "delta", text: "yo" });
    FakeES.last.emit("done", { type: "done", result: { text: "yo", toolCalls: [] } });
    expect(onDelta).toHaveBeenCalledWith("yo");
    expect(onDone).toHaveBeenCalled();
    stop(); expect(FakeES.last.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (in `packages/console`): `npx vitest run src/panels/Chat/__tests__/chatStream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the stream client + panel**

```ts
// packages/console/src/panels/Chat/chatStream.ts
export interface ChatStreamHandlers {
  onDelta: (text: string) => void; onTool: (tool: { toolCallId: string; title: string; status?: string }) => void;
  onDone: (result: { text: string; toolCalls: unknown[] }) => void; onFailed: (error: string) => void;
}
export function openChatStream(chatId: string, message: string, h: ChatStreamHandlers): () => void {
  const es = new EventSource(`/api/chat/stream?chatId=${encodeURIComponent(chatId)}&message=${encodeURIComponent(message)}`);
  es.addEventListener("delta", (e: MessageEvent) => h.onDelta(JSON.parse(e.data).text));
  es.addEventListener("tool", (e: MessageEvent) => h.onTool(JSON.parse(e.data).tool));
  es.addEventListener("done", (e: MessageEvent) => { h.onDone(JSON.parse(e.data).result); es.close(); });
  es.addEventListener("failed", (e: MessageEvent) => { h.onFailed(JSON.parse(e.data).error); es.close(); });
  return () => es.close();
}
```

Panel (`index.tsx`): on mount `GET /api/agents` → render a `<select>` of available agents (disabled options greyed for `available:false`); a message list; an input that (first send) `POST /api/chat {agentId}` to get `chatId`, then `openChatStream` per turn accumulating deltas into the current assistant message and appending `tool` chips; a "Draft a Gem" button → `POST /api/chat/:id/draft-gem` → on success route to Curate with the returned `draftId`. Follow the visual patterns of an existing panel (e.g. Insights) for layout/styling. Register in `pages.tsx` via `defineConsolePage({ id: "chat", title: "Chat", route: "chat", group: "build", component: Chat })` (match the existing `ConsolePage` shape).

- [ ] **Step 4: Run to verify it passes + typecheck + manual**

Run (in `packages/console`): `npx vitest run src/panels/Chat/__tests__/chatStream.test.ts` → PASS. Then `npx tsc --noEmit` (console is not in CI — run locally). Manually: start the app, open the Chat tab, confirm the picker lists agents and a turn streams.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Chat packages/console/src/pages.tsx
git commit -m "feat(chat): Chat console panel — agent picker, streaming turns, draft-a-Gem"
```

---

### Task 11: End-to-end live validation + docs close-out

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-goldmine-chat-tab-design.md` (tick live-validation items)

- [ ] **Step 1: Run the full app against a real agent**

Start the app; open the Chat tab; pick Claude Code; ask "Which of my projects has the most reusable skills?" Confirm: (a) a grounded answer referencing real projects, (b) at least one `search_sessions`/`get_artifact_detail` tool chip appears (proves the MCP path end-to-end), (c) "Draft a Gem" produces a Curate draft.

- [ ] **Step 2: Verify graceful degradation**

Temporarily point the goldmine MCP bin at a nonexistent path; confirm the chat still answers from the pre-injected brief (no crash) — the degradation the spec promises.

- [ ] **Step 3: Run the whole backend suite**

Run: `rm -rf dist && pnpm build && pnpm test`
Expected: green (note: real-FS scan tests can flake under full-suite concurrency — re-run any such failure in isolation before blaming this change).

- [ ] **Step 4: Update the spec + commit**

Tick the "Live-validation risks" items with outcomes (dates, adapter version). Commit:

```bash
git add docs/superpowers/specs/2026-07-02-goldmine-chat-tab-design.md
git commit -m "docs(chat): close out live-validation — end-to-end goldmine chat confirmed"
```

---

## Self-review

**Spec coverage:** hybrid data access → Tasks 4 (MCP server) + 5 (brief) + 8 (both wired); long-lived session → Task 7; agent picker/registry → Tasks 6 + 10; MCP provisioning → Task 3; draft-a-Gem → Task 9; lifecycle (idle/LRU/failed) → Task 7; endpoints → Task 8; UI → Task 10; primary adapter risk → Task 1 gate + Task 11 close-out; credential isolation → inherited from `connectAcpAdapter` (unchanged). Covered.

**Placeholder scan:** two intentional "confirm during implementation" pointers remain and are bounded, not vague: (a) the `@agentback/mcp` metadata-reader export name in Task 4 (with a concrete fallback test given), (b) Curate's draft-store create/list function in Task 9 (the produced object — a `Gem` — is fully specified; only the persistence call is to be located). Both are lookups, not undefined behavior. No "TBD/add error handling/write tests for the above" placeholders.

**Type consistency:** `ChatEvent`, `ChatSessionHandle`, `ChatCtx`, `ChatConnectFn`, `ChatManager` methods (`openChat`/`sendMessage`/`closeChat`/`sweepIdle`) are consistent across Tasks 7–10; `ToolInvocation`/`RunResult`/`applyUpdate` reused from `acpRun.ts` verbatim; `stdioMcpServer`/`McpServer` consistent across Tasks 3, 8; `GemSelection`/`ConfigInventory`/`buildGem` used per the confirmed signatures.
