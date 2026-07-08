# Miniapp → MCP Apps Serve-Time Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit each stored miniapp as a standards-compliant MCP Apps UI resource (`ui://` + `text/html;profile=mcp-app`) plus a launcher tool, carrying AgentGem-specific fields in a namespaced `io.agentgem/game` extension — with zero change to how miniapps are stored or run.

**Architecture:** A pure minting module in `packages/play` converts a miniapp (`{name, html, meta}`) into an `{ resource, tool }` pair shaped exactly like the MCP Apps spec (modelcontextprotocol/ext-apps, accepted MVP `2026-01-26`). A thin REST route (`GET /api/play/mcp-app`) reads a miniapp via the existing `readMiniapp` and returns the minted pair. Nothing about the gem archive, registry, or the `Runner` sandbox changes — this is a serve-time adapter over the format that already exists.

**Tech Stack:** TypeScript (ESM, `type: module`), `@agentback/openapi` decorator routes, Zod schemas, Vitest (runs compiled `dist/`).

## Global Constraints

- **Node floor `>=24`** (repo-wide).
- **Tests run against compiled `dist/`.** Vitest `include` is `dist/**/__tests__/**/*.test.js`; you MUST `tsc -b` before running. If results look stale after a rename, `pnpm clean && pnpm build` (removes `dist` + `*.tsbuildinfo`).
- **Library code lives in `packages/play/src/`** (published as `@agentgem/play`); **tests live at repo root** under `src/play/__tests__/*.test.ts` (unit) and `src/__tests__/*.test.ts` (controller), importing from `@agentgem/play` / `../play.controller.js`.
- **Copyright header** on every new source file, verbatim:
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **MCP Apps constants (copy exactly):** resource MIME `text/html;profile=mcp-app`; URI scheme `ui://agentgem/<name>`; launcher tool name `play_<name>`; extension meta key `io.agentgem/game`; launcher `visibility` is `["app"]` (host-launched, model not in the loop — AgentGem has no LLM at runtime).
- **Scope:** Phase 1 only (produce standards-shaped resources). The client host runtime — `Runner.tsx` JSON-RPC `ui/*` router, the double-iframe sandbox proxy, and the data-capability MCP tools — is Phases 2–3 and belongs in a separate plan (different subsystem: the console client).

---

### Task 1: MCP Apps minting module

Pure, I/O-free functions that turn a stored miniapp into a spec-shaped `{ resource, tool }` pair. This is the whole conceptual core of the phase; it is fully unit-testable without a server, filesystem, or browser.

**Files:**
- Create: `packages/play/src/mcpApp.ts`
- Modify: `packages/play/src/index.ts` (add one export line)
- Test: `src/play/__tests__/mcpApp.test.ts`

**Interfaces:**
- Consumes: `MiniappMeta` from `./miniapps.js` (`{ title, genre, createdFrom, engineVersion, needs? }`); `GameCapability` from `@agentgem/model`.
- Produces:
  - `MCP_APP_MIME: string` = `"text/html;profile=mcp-app"`
  - `uiUri(name: string): string` → `ui://agentgem/<name>`
  - `mcpResourceFor(app: { name: string; html: string; meta: MiniappMeta }): McpUiResource`
  - `mcpToolFor(app: { name: string; meta: MiniappMeta }): McpUiTool`
  - `mcpAppFor(app: { name: string; html: string; meta: MiniappMeta }): McpApp` where `McpApp = { resource: McpUiResource; tool: McpUiTool }`
  - exported interfaces `McpUiCsp`, `AgentGemGameMeta`, `McpUiResource`, `McpUiTool`, `McpApp`

- [ ] **Step 1: Write the module with real types and stubbed bodies**

Create `packages/play/src/mcpApp.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Serve-time adapter: mint a stored miniapp as an MCP Apps UI resource + launcher tool.
// Spec: modelcontextprotocol/ext-apps, accepted MVP 2026-01-26 (extension id io.modelcontextprotocol/ui).
// Pure + I/O-free — the caller supplies the already-loaded miniapp.
import type { GameCapability } from "@agentgem/model";
import type { MiniappMeta } from "./miniapps.js";

export const MCP_APP_MIME = "text/html;profile=mcp-app";

export interface McpUiCsp {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}

// AgentGem's namespaced extension block — the _meta key MCP Apps reserves for producer extensions,
// exactly as ChatGPT layers "openai/*". Carries provenance + the capability declaration a host reads.
export interface AgentGemGameMeta {
  genre: MiniappMeta["genre"];
  engineVersion: string;
  createdFrom: MiniappMeta["createdFrom"];
  needs?: GameCapability[];
  offline: boolean; // fast-path marker: calls no tools, pure sealed content
}

export interface McpUiResource {
  uri: string;
  mimeType: string;
  text: string;
  _meta: {
    ui: { csp: McpUiCsp; permissions: Record<string, never> };
    "io.agentgem/game": AgentGemGameMeta;
  };
}

export interface McpUiTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never> };
  _meta: { ui: { resourceUri: string; visibility: ("model" | "app")[] } };
}

export interface McpApp { resource: McpUiResource; tool: McpUiTool }

// Every current capability is host-brokered over postMessage (a tools/call), never a network fetch from
// the sealed frame — so the CSP stays fully sealed regardless of `needs`. This constant is the single
// seam a future network-declaring capability would widen.
const SEALED_CSP: McpUiCsp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };

export function uiUri(name: string): string { return `ui://agentgem/${name}`; }

export function mcpResourceFor(app: { name: string; html: string; meta: MiniappMeta }): McpUiResource {
  return { uri: "", mimeType: "", text: "", _meta: { ui: { csp: SEALED_CSP, permissions: {} }, "io.agentgem/game": { genre: app.meta.genre, engineVersion: "", createdFrom: app.meta.createdFrom, offline: false } } };
}

export function mcpToolFor(app: { name: string; meta: MiniappMeta }): McpUiTool {
  return { name: "", description: "", inputSchema: { type: "object", properties: {} }, _meta: { ui: { resourceUri: "", visibility: [] } } };
}

export function mcpAppFor(app: { name: string; html: string; meta: MiniappMeta }): McpApp {
  return { resource: mcpResourceFor(app), tool: mcpToolFor({ name: app.name, meta: app.meta }) };
}
```

Add to `packages/play/src/index.ts` (after the `miniapps.js` export on line 8):

```ts
export { MCP_APP_MIME, uiUri, mcpResourceFor, mcpToolFor, mcpAppFor, type McpUiCsp, type AgentGemGameMeta, type McpUiResource, type McpUiTool, type McpApp } from "./mcpApp.js";
```

- [ ] **Step 2: Write the failing test**

Create `src/play/__tests__/mcpApp.test.ts`:

```ts
// src/play/__tests__/mcpApp.test.ts
import { describe, it, expect } from "vitest";
import { mcpAppFor, mcpResourceFor, uiUri, MCP_APP_MIME } from "@agentgem/play";
import type { MiniappMeta } from "@agentgem/play";

const offlineMeta: MiniappMeta = {
  title: "The Great Auth Bug Hunt", genre: "project-fun",
  createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "3",
};
const dataMeta: MiniappMeta = {
  title: "Replay Duel", genre: "replay",
  createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "x" },
  engineVersion: "3", needs: ["session-data"],
};

describe("mcpResourceFor", () => {
  it("mints a spec-shaped ui:// resource carrying the html verbatim", () => {
    const r = mcpResourceFor({ name: "auth-hunt", html: "<!doctype html><body>hi</body>", meta: offlineMeta });
    expect(r.uri).toBe(uiUri("auth-hunt"));
    expect(r.uri).toBe("ui://agentgem/auth-hunt");
    expect(r.mimeType).toBe(MCP_APP_MIME);
    expect(r.text).toBe("<!doctype html><body>hi</body>");
    expect(r._meta["io.agentgem/game"]).toMatchObject({ genre: "project-fun", engineVersion: "3", offline: true });
    expect(r._meta["io.agentgem/game"].needs).toBeUndefined();
  });

  it("stays fully sealed (empty CSP) even when the miniapp declares a capability", () => {
    const r = mcpResourceFor({ name: "replay", html: "<body></body>", meta: dataMeta });
    expect(r._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    expect(r._meta.ui.permissions).toEqual({});
    expect(r._meta["io.agentgem/game"].offline).toBe(false);
    expect(r._meta["io.agentgem/game"].needs).toEqual(["session-data"]);
  });
});

describe("mcpAppFor", () => {
  it("mints an app-visibility launcher tool bound to the resource uri", () => {
    const { tool, resource } = mcpAppFor({ name: "replay", html: "<body></body>", meta: dataMeta });
    expect(tool.name).toBe("play_replay");
    expect(tool.description).toContain("Replay Duel");
    expect(tool._meta.ui.resourceUri).toBe(resource.uri);
    expect(tool._meta.ui.visibility).toEqual(["app"]);
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
  });
});
```

- [ ] **Step 3: Build and run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/mcpApp.test.js`
Expected: FAIL — assertions on `uri`, `mimeType`, `text`, `offline`, `needs`, `tool.name`, `visibility` all mismatch (the stubs return empty strings / `offline: false` / `visibility: []`).

- [ ] **Step 4: Implement the real bodies**

Replace the three functions in `packages/play/src/mcpApp.ts` with:

```ts
export function mcpResourceFor(app: { name: string; html: string; meta: MiniappMeta }): McpUiResource {
  const needs = app.meta.needs;
  return {
    uri: uiUri(app.name),
    mimeType: MCP_APP_MIME,
    text: app.html,
    _meta: {
      ui: { csp: SEALED_CSP, permissions: {} },
      "io.agentgem/game": {
        genre: app.meta.genre,
        engineVersion: app.meta.engineVersion,
        createdFrom: app.meta.createdFrom,
        ...(needs && needs.length ? { needs } : {}),
        offline: !needs || needs.length === 0,
      },
    },
  };
}

export function mcpToolFor(app: { name: string; meta: MiniappMeta }): McpUiTool {
  return {
    name: `play_${app.name}`,
    description: `Launch the "${app.meta.title}" miniapp`,
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: uiUri(app.name), visibility: ["app"] } },
  };
}

export function mcpAppFor(app: { name: string; html: string; meta: MiniappMeta }): McpApp {
  return { resource: mcpResourceFor(app), tool: mcpToolFor({ name: app.name, meta: app.meta }) };
}
```

- [ ] **Step 5: Build and run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/play/__tests__/mcpApp.test.js`
Expected: PASS (5 assertions across 3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/mcpApp.ts packages/play/src/index.ts src/play/__tests__/mcpApp.test.ts
git commit -m "feat(play): mint miniapps as MCP Apps ui:// resource + launcher tool"
```

---

### Task 2: `GET /api/play/mcp-app` route

Expose the minted pair over HTTP, mirroring the existing `GET /api/play/miniapp` route exactly (same query schema, same `readMiniapp` load, same 404-on-missing behavior).

**Files:**
- Modify: `src/schemas.ts` (add `PlayMcpAppSchema` after `PlayNeedsSchema`, ~line 913)
- Modify: `src/play.controller.ts` (add import + one route method)
- Test: `src/__tests__/playMcpRoute.test.ts`

**Interfaces:**
- Consumes: `mcpAppFor`, `readMiniapp` from `@agentgem/play`; existing `PlayMiniappQuerySchema` (`{ name: string }`), `GameArtifactSchema`, `PlayNeedsSchema` from `./schemas.js`.
- Produces: route `GET /api/play/mcp-app?name=<slug>` returning `z.infer<typeof PlayMcpAppSchema>` = `{ resource, tool }`.

- [ ] **Step 1: Add the response schema**

In `src/schemas.ts`, immediately after the `PlayNeedsSchema` line (~913), add:

```ts
const EmptyObjectSchema = z.object({});
export const PlayMcpAppSchema = z.object({
  resource: z.object({
    uri: z.string(),
    mimeType: z.string(),
    text: z.string(),
    _meta: z.object({
      ui: z.object({
        csp: z.object({
          connectDomains: z.array(z.string()),
          resourceDomains: z.array(z.string()),
          frameDomains: z.array(z.string()),
          baseUriDomains: z.array(z.string()),
        }),
        permissions: EmptyObjectSchema,
      }),
      "io.agentgem/game": z.object({
        genre: z.string(),
        engineVersion: z.string(),
        createdFrom: GameArtifactSchema.shape.createdFrom,
        needs: PlayNeedsSchema,
        offline: z.boolean(),
      }),
    }),
  }),
  tool: z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.object({ type: z.literal("object"), properties: EmptyObjectSchema }),
    _meta: z.object({ ui: z.object({ resourceUri: z.string(), visibility: z.array(z.enum(["model", "app"])) }) }),
  }),
});
```

- [ ] **Step 2: Write the failing controller test**

Create `src/__tests__/playMcpRoute.test.ts`:

```ts
// src/__tests__/playMcpRoute.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };
const html = "<!doctype html><body><canvas></canvas></body>";

describe("GET /api/play/mcp-app", () => {
  it("returns a spec-shaped resource + launcher tool for a saved miniapp", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "g1", html, meta } });
    const out = await ctrl.mcpApp({ query: { name: "g1" } });
    expect(out.resource.uri).toBe("ui://agentgem/g1");
    expect(out.resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(out.resource.text).toBe(html);
    expect(out.resource._meta["io.agentgem/game"].offline).toBe(true);
    expect(out.tool.name).toBe("play_g1");
    expect(out.tool._meta.ui.visibility).toEqual(["app"]);
  });

  it("404s for an unknown miniapp", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.mcpApp({ query: { name: "nope" } })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Build and run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/playMcpRoute.test.js`
Expected: FAIL — `tsc -b` errors that `mcpApp` does not exist on `PlayController` (this is the red).

- [ ] **Step 4: Add the route**

In `src/play.controller.ts`, add `mcpAppFor` to the `@agentgem/play` import (line 6) and `PlayMcpAppSchema` to the `./schemas.js` import (lines 9–14). Then add this method inside the class, after the `miniapp` method (after line 75):

```ts
  // Serve-time MCP Apps adapter: the same stored miniapp, re-shaped as a ui:// resource + launcher tool.
  // No behavior change to storage or the sealed runtime — this is a producer-side view over readMiniapp.
  @get("/play/mcp-app", { query: PlayMiniappQuerySchema, response: PlayMcpAppSchema })
  async mcpApp(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlayMcpAppSchema>> {
    try {
      return mcpAppFor(readMiniapp(input.query.name));
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
  }
```

- [ ] **Step 5: Build and run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/playMcpRoute.test.js`
Expected: PASS (both tests).

- [ ] **Step 6: Run the full Play suite to check for regressions**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/play dist/__tests__/playRoutes.test.js dist/__tests__/playMcpRoute.test.js`
Expected: PASS — no existing Play unit or route test regressed.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/play.controller.ts src/__tests__/playMcpRoute.test.ts
git commit -m "feat(play): serve GET /api/play/mcp-app (MCP Apps resource + tool)"
```

---

## What this deliberately does NOT do (next plan)

Phase 1 makes AgentGem a *producer* of standards-shaped resources. It does not yet make the console a compliant *host* or wire interaction. Those are the next plan (separate subsystem — `packages/console`):

- **Reshape `Runner.tsx` into a compliant host:** the `ui/initialize` handshake, the double-iframe sandbox proxy, and a JSON-RPC `ui/*` router replacing the private `agentgem:request/feed` messages.
- **Data capabilities as MCP tools** (`visibility:["app"]`): `agentgem_get_session_data`, `agentgem_get_inventory`, a subscribe tool + host→UI `ui/notifications/*` for `live-session-events`, and the privileged `agentgem_invoke_agent`. Each thin-wraps an existing route and rides the spec-mandated per-call consent (your current `consent.ts` UX).
- **Outward interop test:** render a self-contained miniapp inside an external MCP-Apps host and confirm host-local capabilities degrade by negotiation.
- **(Optional) AG-UI** on the Studio authoring stream.
