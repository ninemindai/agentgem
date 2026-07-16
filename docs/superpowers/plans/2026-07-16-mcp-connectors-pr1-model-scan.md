# MCP Connectors PR-1: Model + Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data model, wire schemas, canonical error envelope, and save-time scan for miniapp MCP connectors (`mcpNeeds`) — the foundation PR-2 (server), PR-3 (console), and PR-4 (marketplace + demo) build on.

**Architecture:** `GameArtifact` gains a declared-authoritative `mcpNeeds: {server, tools[]}[]` manifest (spec D10: the scan auto-fills literals and warns, never prunes, never errors — runtime manifest enforcement in PR-2 is the security boundary). The MCP error-code union and payload derivation live once in `@agentgem/model` (spec 4A) so PR-2/PR-3 import instead of copying. `saveMiniapp` merges declared ∪ derived and surfaces `mcpWarnings`.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), Zod wire schemas in `src/schemas.ts`, vitest run over compiled `dist/`.

**Spec:** `docs/superpowers/specs/2026-07-16-miniapp-mcp-connectors-design.md` (§1, §2, and the 4A/D10 review resolutions).

## Global Constraints

- Node >= 24; pnpm. Root test command: `pnpm test` (= `tsc -b && vitest run`).
- Root vitest runs **compiled** tests only: `dist/**/__tests__/**/*.test.js`. A single test file runs as `tsc -b && pnpm exec vitest run dist/<path>.test.js` — passing a `src/*.ts` path silently matches nothing.
- Every new source file starts with the two-line header: `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT`.
- ESM imports inside packages use explicit `.js` suffixes (`from "./capabilityScan.js"`).
- Wire enums/schemas are additive-only (gem-archive contract); ONE exported schema backs every echo of a shape (the #446 lesson).
- Comments explain *why* and constraints, matching the dense house style of the touched files.
- **CRITICAL regression rule:** existing `needs` behavior (deriveNeeds / reconcileNeeds / hasDynamicToolCall / saveMiniapp gating) must be byte-for-byte unchanged for miniapps that don't use `agentgemApp.mcp`. All existing tests must pass untouched.

---

### Task 1: `McpNeed` model type + wire schemas

**Files:**
- Modify: `packages/model/src/types.ts` (after the `GameCapability` union, ~line 74; and inside `GameArtifact`, ~line 92)
- Modify: `src/schemas.ts` (after `GameCapabilityEnum`, ~line 105; `GameArtifactSchema` ~line 126; play schemas ~lines 1021–1102)
- Test: `src/__tests__/mcpNeedsSchema.test.ts` (new)

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: `interface McpNeed { server: string; tools: string[] }` and `GameArtifact.mcpNeeds?: McpNeed[]` from `@agentgem/model`; `McpNeedSchema`, `McpNeedsSchema` (= `z.array(McpNeedSchema).optional()`), `PlaySaveResponseSchema.mcpWarnings: z.array(z.string()).default([])` from `src/schemas.ts`. Tasks 3–5 and PR-2/PR-3 rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mcpNeedsSchema.test.ts`:

```typescript
// src/__tests__/mcpNeedsSchema.test.ts
import { describe, it, expect } from "vitest";
import type { McpNeed } from "@agentgem/model";
import type { z } from "zod";
import { McpNeedSchema, McpNeedsSchema, GameArtifactSchema, PlaySaveRequestSchema, PlaySaveResponseSchema, PlayMiniappSchema, MiniappListSchema } from "../schemas.js";

// Compile-time lockstep pin: the wire schema and the model type must be assignable both ways.
// If either side drifts, this file stops compiling — the drift guard for a STRUCTURED shape,
// where the enum-style value-list guard doesn't apply.
const _wireToModel: McpNeed = {} as z.infer<typeof McpNeedSchema>;
const _modelToWire: z.infer<typeof McpNeedSchema> = {} as McpNeed;
void _wireToModel; void _modelToWire;

const NEED = { server: "github", tools: ["list_pull_requests", "list_commits"] };

describe("McpNeedSchema", () => {
  it("accepts a server with its tool list", () => {
    expect(McpNeedSchema.parse(NEED)).toEqual(NEED);
  });

  it("rejects an empty server name and empty tool names", () => {
    expect(() => McpNeedSchema.parse({ server: "", tools: ["a"] })).toThrow();
    expect(() => McpNeedSchema.parse({ server: "github", tools: [""] })).toThrow();
  });

  it("is optional everywhere it travels (absent stays absent)", () => {
    expect(McpNeedsSchema.parse(undefined)).toBeUndefined();
  });
});

describe("mcpNeeds on the wire", () => {
  const createdFrom = { kind: "blank" as const, title: "t" };

  it("rides GameArtifactSchema", () => {
    const a = GameArtifactSchema.parse({
      type: "game", name: "g", title: "G", genre: "project-fun", html: "<canvas></canvas>",
      createdFrom, engineVersion: "1", mcpNeeds: [NEED],
    });
    expect(a.mcpNeeds).toEqual([NEED]);
  });

  it("rides the save request meta and the miniapp read meta", () => {
    const req = PlaySaveRequestSchema.parse({
      name: "g", html: "<x/>",
      meta: { title: "G", genre: "project-fun", createdFrom, mcpNeeds: [NEED] },
    });
    expect(req.meta.mcpNeeds).toEqual([NEED]);
    const read = PlayMiniappSchema.parse({
      name: "g", html: "<x/>",
      meta: { title: "G", genre: "project-fun", createdFrom, engineVersion: "1", mcpNeeds: [NEED] },
    });
    expect(read.meta.mcpNeeds).toEqual([NEED]);
    const list = MiniappListSchema.parse({ miniapps: [{ name: "g", title: "G", genre: "project-fun", mcpNeeds: [NEED] }] });
    expect(list.miniapps[0].mcpNeeds).toEqual([NEED]);
  });

  it("save response surfaces mcpWarnings, defaulting to []", () => {
    const res = PlaySaveResponseSchema.parse({ name: "g", commit: null, prunedNeeds: [] });
    expect(res.mcpWarnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /path/to/worktree && tsc -b 2>&1 | head -20`
Expected: compile errors — `McpNeedSchema` is not exported from `../schemas.js`, `McpNeed` not exported from `@agentgem/model`.

- [ ] **Step 3: Add the model type**

In `packages/model/src/types.ts`, immediately after `export type GameCapability = ToolCapability | ActionCapability;` (line 74):

```typescript
// A connector requirement: `server` names an installed mcp_server gem (McpServerArtifact.name);
// `tools` are the upstream tool names the miniapp may call on it. DECLARED-AUTHORITATIVE: the
// save-time scan auto-fills literal calls it can see and warns on usage it cannot resolve, but it
// never prunes a declaration and never blocks a save — runtime manifest enforcement (the
// /api/play/mcp/call route) is the security boundary, not this list's derivation. Contrast
// `needs`, where the literal-string shim contract makes the static scan total and pruning safe.
export interface McpNeed {
  server: string;
  tools: string[];
}
```

In `GameArtifact` (line 92), after the `needs?` field:

```typescript
  needs?: GameCapability[]; // declared, read-only; host decides. Absent = pure snapshot.
  mcpNeeds?: McpNeed[];     // declared-authoritative connector manifest — see McpNeed above.
```

Confirm `packages/model/src/index.ts` re-exports `types.js` (it does — no change needed unless types are enumerated individually; if enumerated, add `McpNeed`).

- [ ] **Step 4: Add the wire schemas**

In `src/schemas.ts`, after `GameCapabilityEnum` (line 105):

```typescript
// McpNeed (packages/model types.ts) as a wire schema. ONE exported schema backs every echo of
// mcpNeeds — save meta, artifact, list, read — the #446 lesson: an inline copy in any consumer
// drifts silently. Kept in lockstep with the model type by the compile-time pin in
// __tests__/mcpNeedsSchema.test.ts. Additive-only, like every gem-archive shape.
export const McpNeedSchema = z.object({
  server: z.string().min(1),
  tools: z.array(z.string().min(1)),
});
export const McpNeedsSchema = z.array(McpNeedSchema).optional();
```

Then thread it through (exact edits):
- `GameArtifactSchema`: after `needs: z.array(GameCapabilityEnum).optional(),` add `mcpNeeds: McpNeedsSchema,`
- `PlaySaveRequestSchema.meta`: after `needs: ...optional(),` add `mcpNeeds: McpNeedsSchema,`
- `PlaySaveResponseSchema`: after `prunedNeeds: ...default([]),` add:
  ```typescript
  // Advisory scan output (never blocking): non-literal connector calls the static scan cannot
  // verify, or mcp usage with no declaration. The Studio surfaces these like prunedNeeds.
  mcpWarnings: z.array(z.string()).default([]),
  ```
- `MiniappListSchema` item: after `needs: PlayNeedsSchema` add `, mcpNeeds: McpNeedsSchema`
- `PlayMiniappSchema.meta` and `PlayInspectorSchema.meta`: after `needs: PlayNeedsSchema` add `, mcpNeeds: McpNeedsSchema`
- `PlayMcpAppSchema` `"ai.agentgem/game"` object: after `needs: PlayNeedsSchema,` add `mcpNeeds: McpNeedsSchema,`

- [ ] **Step 5: Run test to verify it passes**

Run: `tsc -b && pnpm exec vitest run dist/__tests__/mcpNeedsSchema.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/model/src/types.ts src/schemas.ts src/__tests__/mcpNeedsSchema.test.ts
git commit -m "feat(model): McpNeed type + mcpNeeds wire schemas (declared-authoritative connector manifest)"
```

---

### Task 2: Canonical MCP envelope in `@agentgem/model`

**Files:**
- Create: `packages/model/src/mcpEnvelope.ts`
- Modify: `packages/model/src/index.ts` (add one export line)
- Test: `src/__tests__/mcpEnvelope.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `MCP_ERROR_CODES: readonly string[]`, `type McpErrorCode`, `interface McpContentBlock`, `interface McpCallResult { content: McpContentBlock[]; structuredContent?: unknown; payload?: unknown }`, `derivePayload(result): unknown` — PR-2's route computes `payload` with this; PR-3's shim/console mirrors are drift-pinned against `MCP_ERROR_CODES`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mcpEnvelope.test.ts`:

```typescript
// src/__tests__/mcpEnvelope.test.ts
import { describe, it, expect } from "vitest";
import { MCP_ERROR_CODES, derivePayload } from "@agentgem/model";
import type { McpErrorCode } from "@agentgem/model";

// Compile-time pin: the union type and the value list are the same set.
const _pin: McpErrorCode = MCP_ERROR_CODES[0];
void _pin;

describe("MCP_ERROR_CODES", () => {
  it("carries the full mirrored-contract union (additive-only)", () => {
    // v1 emits a subset (server_not_connected/server_unavailable/not_in_manifest/tool_error/
    // bad_request); the union is the FULL claude-contract set so consumers can branch on codes
    // that arrive later without a wire change.
    for (const c of ["server_not_connected", "server_unavailable", "not_in_manifest", "tool_error", "bad_request", "not_granted", "capability_disabled"]) {
      expect(MCP_ERROR_CODES).toContain(c);
    }
  });
});

describe("derivePayload", () => {
  it("prefers structuredContent when present", () => {
    expect(derivePayload({ content: [{ type: "text", text: "[1]" }], structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it("parses the first text block as JSON when it parses", () => {
    expect(derivePayload({ content: [{ type: "text", text: '{"n":428}' }] })).toEqual({ n: 428 });
  });

  it("falls back to the verbatim text when it is not JSON", () => {
    expect(derivePayload({ content: [{ type: "text", text: "plain words" }] })).toBe("plain words");
  });

  it("returns undefined when there is no text block", () => {
    expect(derivePayload({ content: [{ type: "image", data: "x", mimeType: "image/png" }] })).toBeUndefined();
    expect(derivePayload({ content: [] })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b 2>&1 | head -10`
Expected: compile error — `MCP_ERROR_CODES` not exported from `@agentgem/model`.

- [ ] **Step 3: Write the implementation**

Create `packages/model/src/mcpEnvelope.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The MCP connector call envelope, canonical for every layer (spec 4A). The server route derives
// `payload` ONCE with derivePayload(); the console router and the in-html shim mirror the error
// codes and are pinned to THIS list by drift tests — four hand-kept copies of a wire contract is
// the #446 drift class, on the security-relevant path.
//
// The code union is the FULL mirrored window.claude.mcp contract set, not just what v1 emits:
// consumers branch on `code`, and a later server version emitting a new code must not require a
// lockstep client change. Additive-only.

export const MCP_ERROR_CODES = [
  "needs_reauth",
  "server_not_connected",
  "selection_required",
  "server_not_found",
  "server_unavailable",
  "not_in_manifest",
  "blocked_by_policy",
  "approval_required",
  "tool_error",
  "bad_request",
  "cancelled",
  "rate_limited",
  "upstream_error",
  "not_granted",
  "capability_disabled",
  "capability_removed",
  "transform_error",
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

export interface McpCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  payload?: unknown;
}

// `payload` is the JSON answer most connectors return: structuredContent when present, else the
// first text block parsed as JSON when it parses, else that text verbatim, else undefined. One
// implementation — the shim passes the server-derived value through, never re-derives.
export function derivePayload(result: Pick<McpCallResult, "content" | "structuredContent">): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string");
  if (!text) return undefined;
  try { return JSON.parse(text.text); } catch { return text.text; }
}
```

In `packages/model/src/index.ts`, beside the existing exports add:

```typescript
export * from "./mcpEnvelope.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `tsc -b && pnpm exec vitest run dist/__tests__/mcpEnvelope.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/mcpEnvelope.ts packages/model/src/index.ts src/__tests__/mcpEnvelope.test.ts
git commit -m "feat(model): canonical MCP envelope — MCP_ERROR_CODES union + derivePayload (spec 4A)"
```

---

### Task 3: capabilityScan MCP pass (derive, merge, warn — never prune, never block)

**Files:**
- Modify: `packages/play/src/capabilityScan.ts`
- Modify: `packages/play/src/index.ts` (export the three new functions)
- Test: `src/play/__tests__/mcpScan.test.ts` (new)

**Interfaces:**
- Consumes: `McpNeed` from Task 1; existing `scannableCode`/`codeSkeleton` in the same file.
- Produces: `deriveMcpNeeds(html: string): McpNeed[]`, `mergeMcpNeeds(declared: McpNeed[] | undefined, derived: McpNeed[]): McpNeed[]`, `mcpUsageWarnings(html: string, declared: McpNeed[] | undefined): string[]` — Task 4's save path calls all three. Also modifies `DYNAMIC_CALL` so `mcp.callTool(variable)` no longer hard-errors saves (D10), while the host-tool `callTool(variable)` error is unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/mcpScan.test.ts`:

```typescript
// src/play/__tests__/mcpScan.test.ts
import { describe, it, expect } from "vitest";
import { deriveMcpNeeds, mergeMcpNeeds, mcpUsageWarnings, hasDynamicToolCall } from "@agentgem/play";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const code = (js: string) => `<script>${js}</script>`;

describe("deriveMcpNeeds", () => {
  it("collects literal callTool/watchTool pairs, deduped and sorted", () => {
    const js = `
      window.agentgemApp.mcp.callTool("github", "list_pull_requests", {});
      window.agentgemApp.mcp.watchTool("github", "list_commits", null, () => {});
      window.agentgemApp.mcp.callTool("github", "list_pull_requests");
      window.agentgemApp.mcp.callTool("notes", "search");
    `;
    expect(deriveMcpNeeds(page(code(js)))).toEqual([
      { server: "github", tools: ["list_commits", "list_pull_requests"] },
      { server: "notes", tools: ["search"] },
    ]);
  });

  it("sees nothing in wrapper calls (declared-authoritative covers them)", () => {
    const js = `const call = (s, t) => window.agentgemApp.mcp.callTool(s, t); call("github", "list_commits");`;
    expect(deriveMcpNeeds(page(code(js)))).toEqual([]);
  });

  it("ignores pairs inside comments and inert JSON blobs", () => {
    const blob = `<script id="d" type="application/json">{"note":"agentgemApp.mcp.callTool(\\"x\\", \\"y\\")"}</script>`;
    const commented = code(`// window.agentgemApp.mcp.callTool("x", "y")\nconst a = 1;`);
    expect(deriveMcpNeeds(page(blob + commented))).toEqual([]);
  });
});

describe("mergeMcpNeeds", () => {
  it("unions declared and derived per server, never dropping a declaration", () => {
    expect(mergeMcpNeeds(
      [{ server: "github", tools: ["search_pull_requests"] }],
      [{ server: "github", tools: ["list_commits"] }, { server: "notes", tools: ["search"] }],
    )).toEqual([
      { server: "github", tools: ["list_commits", "search_pull_requests"] },
      { server: "notes", tools: ["search"] },
    ]);
  });

  it("treats undefined declared as empty", () => {
    expect(mergeMcpNeeds(undefined, [])).toEqual([]);
  });
});

describe("mcpUsageWarnings", () => {
  it("warns (never throws) on a non-literal connector call", () => {
    const js = `const t = pick(); window.agentgemApp.mcp.callTool("github", t);`;
    const w = mcpUsageWarnings(page(code(js)), [{ server: "github", tools: ["list_commits"] }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("non-literal");
  });

  it("warns when mcp is referenced but nothing is declared or derivable", () => {
    const js = `if (window.agentgemApp && window.agentgemApp.mcp) boot(window.agentgemApp.mcp);`;
    const w = mcpUsageWarnings(page(code(js)), undefined);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("mcpNeeds");
  });

  it("stays silent for literal-only usage with a matching declaration", () => {
    const js = `window.agentgemApp.mcp.callTool("github", "list_commits");`;
    expect(mcpUsageWarnings(page(code(js)), [{ server: "github", tools: ["list_commits"] }])).toEqual([]);
  });

  it("ignores mcp mentions inside strings/comments (codeSkeleton)", () => {
    const js = `const help = "call agentgemApp.mcp.callTool(server, tool) to fetch"; // agentgemApp.mcp.callTool(a, b)`;
    expect(mcpUsageWarnings(page(code(js)), undefined)).toEqual([]);
  });
});

describe("hasDynamicToolCall after the mcp carve-out", () => {
  it("still errors host-tool variable calls", () => {
    expect(hasDynamicToolCall(page(code(`const t = x(); agentgemApp.callTool(t);`)))).toBe(true);
  });

  it("no longer fires on mcp wrapper calls — those are D10 warnings, not errors", () => {
    expect(hasDynamicToolCall(page(code(`const call = (s, t) => window.agentgemApp.mcp.callTool(s, t);`)))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b 2>&1 | head -10`
Expected: compile error — `deriveMcpNeeds` not exported from `@agentgem/play`.

- [ ] **Step 3: Write the implementation**

In `packages/play/src/capabilityScan.ts`:

Change the import (line 16-17) to include `McpNeed`:

```typescript
import type { GameCapability, McpNeed } from "@agentgem/model";
```

Change `DYNAMIC_CALL` (line 91) — the mcp namespace has a different policy (D10: warn, never block), so the host-tool hard-error must not fire on `mcp.callTool(variable)`:

```typescript
// `callTool(` followed by an identifier start — a variable, not a literal. The shim's own
// `callTool: function (name, args)` is a DEFINITION, not a call, so the `(` never follows the name.
// The `(?<!mcp\s*\.\s*)` carve-out: `agentgemApp.mcp.callTool(server, tool)` is the CONNECTOR
// surface, where declarations are authoritative and non-literal calls are a save-time WARNING
// (mcpUsageWarnings), never this hard error — runtime manifest enforcement is that path's boundary.
const DYNAMIC_CALL = /(?<!mcp\s*\.\s*)\bcallTool\s*\(\s*[A-Za-z_$]/;
```

Refactor `codeSkeleton` (lines 65-87) into a shared walker so comment-stripping is available WITH string contents kept — `deriveMcpNeeds` must read the literals `codeSkeleton` empties, but must not derive from commented-out calls. Replace the existing `function codeSkeleton` body with:

```typescript
// Shared walker behind codeSkeleton() and stripComments(): drops // and /* */ comments; string
// and template literals are either EMPTIED to bare quotes (keepStrings=false — the skeleton, for
// "is this argument an identifier?" questions) or copied through (keepStrings=true — for reading
// literal arguments while still ignoring commented-out code). Same best-effort caveats as before:
// no regex-literal or `${}` modeling; errors only DROP text, never invent it.
function walkCode(code: string, keepStrings: boolean): string {
  let out = "";
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {         // string: keep quotes; body per keepStrings
      out += c;
      for (i++; i < code.length; ) {
        if (code[i] === "\\") { if (keepStrings) out += code[i] + (code[i + 1] ?? ""); i += 2; continue; }
        const ch = code[i++];
        if (ch === c) { out += c; break; }
        if (keepStrings) out += ch;
      }
      continue;
    }
    if (c === "/" && code[i + 1] === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (c === "/" && code[i + 1] === "*") {
      for (i += 2; i < code.length && !(code[i] === "*" && code[i + 1] === "/"); i++);
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function codeSkeleton(code: string): string { return walkCode(code, false); }
function stripComments(code: string): string { return walkCode(code, true); }
```

(Keep the original doc comment above `codeSkeleton` — it still holds; move the transform detail into the walker comment as shown.)

Append at the end of the file:

```typescript
// ---- MCP connectors (spec §2, D10: declared-authoritative) ----
//
// Unlike `needs`, the mcp scan is ASSISTIVE ONLY. It auto-fills manifest entries from literal
// calls it can see and warns about usage it cannot resolve — but a declaration is never pruned
// and a save is never blocked on scan blindness. Rationale: wrappers, constants, and dynamic tool
// selection are legitimate app structure (a ported claude.ai artifact wraps every call), and the
// server-side manifest check on /api/play/mcp/call is the real security boundary. Pruning what a
// regex cannot see would break those apps at runtime with not_in_manifest.
//
// KNOWN GAP (accepted, same family as the agentgemApp alias gap above): `const m = agentgemApp.mcp;
// m.callTool(...)` derives nothing and dodges the warning regexes. The declaration still covers it.
//
// A literal pair inside a quoted STRING ("see agentgemApp.mcp.callTool(\"x\", \"y\")") still
// derives a phantom entry — stripComments keeps string bodies by design. A phantom entry only
// widens the consent card the viewer reads; it grants nothing the app never calls. deriveNeeds()
// accepts the same trade for bare tool names.

const MCP_LITERAL_CALL = /\bagentgemApp\s*\.\s*mcp\s*\.\s*(?:callTool|watchTool)\s*\(\s*(["'`])((?:(?!\1).)+)\1\s*,\s*(["'`])((?:(?!\3).)+)\3/g;

export function deriveMcpNeeds(html: string): McpNeed[] {
  const code = stripComments(scannableCode(html));   // comments never author a manifest entry
  const map = new Map<string, Set<string>>();
  for (const m of code.matchAll(MCP_LITERAL_CALL)) {
    const server = m[2];
    const tool = m[4];
    if (!map.has(server)) map.set(server, new Set());
    map.get(server)!.add(tool);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, tools]) => ({ server, tools: [...tools].sort() }));
}

export function mergeMcpNeeds(declared: McpNeed[] | undefined, derived: McpNeed[]): McpNeed[] {
  const map = new Map<string, Set<string>>();
  for (const list of [declared ?? [], derived]) {
    for (const n of list) {
      if (!map.has(n.server)) map.set(n.server, new Set());
      for (const t of n.tools) map.get(n.server)!.add(t);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, tools]) => ({ server, tools: [...tools].sort() }));
}

// A connector call where EITHER argument is non-literal — the scan cannot verify it against the
// manifest. Evaluated on the SKELETON, where every literal is emptied to bare quotes: a literal
// arg therefore starts with a quote character, so "starts with anything else" = dynamic. Two
// alternatives: dynamic first arg (`callTool(t` / `callTool(pick()`), or emptied-literal first
// arg then a dynamic second (`callTool("", t`). Warning copy names the runtime failure so the
// author (usually the Studio agent) can self-repair by declaring.
const MCP_DYNAMIC_CALL = /\bmcp\s*\.\s*(?:callTool|watchTool)\s*\((?:\s*(?!["'`])[^)\s]|\s*(["'`])\1\s*,\s*(?!["'`])[^)\s])/;
const MCP_ANY_USE = /\bagentgemApp\s*\.\s*mcp\b/;

export function mcpUsageWarnings(html: string, declared: McpNeed[] | undefined): string[] {
  const skeleton = codeSkeleton(scannableCode(html));
  const warnings: string[] = [];
  if (MCP_DYNAMIC_CALL.test(skeleton)) {
    warnings.push(
      'connector call with a non-literal server/tool argument — the static scan cannot verify it; ensure every (server, tool) pair it can reach is declared in meta.json "mcpNeeds", or the call fails at runtime with not_in_manifest',
    );
  }
  if (MCP_ANY_USE.test(skeleton) && !declared?.length && deriveMcpNeeds(html).length === 0) {
    warnings.push(
      'miniapp references agentgemApp.mcp but declares no "mcpNeeds" — every connector call will fail at runtime with not_in_manifest',
    );
  }
  return warnings;
}
```

In `packages/play/src/index.ts`, find the line exporting from `./capabilityScan.js` and add the three names (keep existing exports):

```typescript
export { deriveNeeds, reconcileNeeds, hasDynamicToolCall, deriveMcpNeeds, mergeMcpNeeds, mcpUsageWarnings } from "./capabilityScan.js";
```

(If the file uses `export *`, no change is needed — check first.)

- [ ] **Step 4: Run the new tests AND the existing scan tests**

Run: `tsc -b && pnpm exec vitest run dist/play/__tests__/mcpScan.test.js dist/play/__tests__/capabilityScan.test.js dist/play/__tests__/capabilityScan.methods.test.js`
Expected: ALL PASS — the two pre-existing files unchanged and green is the D10 regression evidence for the `DYNAMIC_CALL` edit.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/capabilityScan.ts packages/play/src/index.ts src/play/__tests__/mcpScan.test.ts
git commit -m "feat(play): assistive MCP scan — deriveMcpNeeds/mergeMcpNeeds/mcpUsageWarnings; mcp carve-out on the dynamic-call error (D10)"
```

---

### Task 4: `saveMiniapp` integration — merge, warn, gate the shim, carry to the gem

**Files:**
- Modify: `packages/play/src/miniapps.ts` (imports line 18; `MiniappMeta`/`SaveMiniappResult` lines 20-24; `writeGameGem` line 85-95; `saveMiniapp` lines 97-160)
- Test: `src/play/__tests__/miniappsMcp.test.ts` (new)

**Interfaces:**
- Consumes: `deriveMcpNeeds`, `mergeMcpNeeds`, `mcpUsageWarnings` (Task 3); `McpNeed` (Task 1).
- Produces: `MiniappMeta.mcpNeeds?: McpNeed[]`; `SaveMiniappResult.mcpWarnings: string[]` — the controller (Task 5) returns this straight through; PR-2's manifest check reads the SAVED `meta.json` `mcpNeeds`.

- [ ] **Step 1: Write the failing test**

Look at `src/play/__tests__/miniapps.test.ts` first and reuse its temp-`AGENTGEM_HOME` setup pattern (mkdtemp + env + cleanup). Create `src/play/__tests__/miniappsMcp.test.ts`:

```typescript
// src/play/__tests__/miniappsMcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp, miniappsRoot } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };
// References window.agentgemApp so ensureClientShim injects transport; a <canvas> for the gate.
const mcpHtml = (js: string) => `<!doctype html><html><body><canvas></canvas><script>${js}</script></body></html>`;

describe("saveMiniapp with mcpNeeds", () => {
  it("auto-fills literal connector calls into the stored manifest", async () => {
    const html = mcpHtml(`window.agentgemApp && window.agentgemApp.mcp.callTool("github", "list_pull_requests");`);
    const res = await saveMiniapp({ name: "pulse", html, meta });
    expect(res.mcpWarnings).toEqual([]);
    expect(readMiniapp("pulse").meta.mcpNeeds).toEqual([{ server: "github", tools: ["list_pull_requests"] }]);
  });

  it("NEVER prunes a declaration the scan cannot see (wrapper calls) — warns instead (D10)", async () => {
    const html = mcpHtml(`const call = (s, t) => window.agentgemApp.mcp.callTool(s, t); call("github", pick());`);
    const declared = [{ server: "github", tools: ["list_pull_requests", "list_commits"] }];
    const res = await saveMiniapp({ name: "wrapped", html, meta: { ...meta, mcpNeeds: declared } });
    expect(res.mcpWarnings).toHaveLength(1);
    expect(res.mcpWarnings[0]).toContain("non-literal");
    expect(readMiniapp("wrapped").meta.mcpNeeds).toEqual(declared);
  });

  it("unions declared and derived", async () => {
    const html = mcpHtml(`window.agentgemApp.mcp.callTool("github", "list_commits");`);
    const res = await saveMiniapp({
      name: "union", html,
      meta: { ...meta, mcpNeeds: [{ server: "github", tools: ["search_pull_requests"] }] },
    });
    expect(res.mcpWarnings).toEqual([]);
    expect(readMiniapp("union").meta.mcpNeeds).toEqual([{ server: "github", tools: ["list_commits", "search_pull_requests"] }]);
  });

  it("carries mcpNeeds into the dual-written game gem", async () => {
    const html = mcpHtml(`window.agentgemApp.mcp.callTool("github", "list_commits");`);
    await saveMiniapp({ name: "gemmed", html, meta });
    // The gem workspace holds the archive; gem.json carries the artifact with mcpNeeds.
    const wdir = join(home, "workspaces", "gemmed");
    const gem = JSON.parse(readFileSync(join(wdir, "gem.json"), "utf8"));
    expect(gem.artifacts[0].mcpNeeds).toEqual([{ server: "github", tools: ["list_commits"] }]);
  });

  it("rejects mcpNeeds on a bundle that never references window.agentgemApp (cannot reach the host)", async () => {
    const html = `<!doctype html><html><body><canvas></canvas><script>const x = 1;</script></body></html>`;
    await expect(saveMiniapp({ name: "mute", html, meta: { ...meta, mcpNeeds: [{ server: "github", tools: ["list_commits"] }] } }))
      .rejects.toThrow(/cannot reach the host/);
  });

  it("CRITICAL regression: a plain miniapp with no mcp usage behaves exactly as before", async () => {
    const html = `<!doctype html><html><body><canvas></canvas><script>window.agentgemApp && window.agentgemApp.callTool("agentgem_get_inventory");</script></body></html>`;
    const res = await saveMiniapp({ name: "plain", html, meta: { ...meta, needs: ["local-project-access"] } });
    expect(res.prunedNeeds).toEqual([]);
    expect(res.mcpWarnings).toEqual([]);
    const read = readMiniapp("plain");
    expect(read.meta.needs).toEqual(["local-project-access"]);
    expect(read.meta.mcpNeeds).toBeUndefined();
  });
});
```

NOTE for the implementer: if the `gem.json` path in the fourth test doesn't match (check `workspaceDir()` in `@agentgem/base` for the actual layout), adjust the path in the test to the real one — the assertion (artifact carries `mcpNeeds`) is what matters. If `assertPortable` or `gameGate` rejects these fixtures, mirror whatever fixture shape `src/play/__tests__/miniapps.test.ts` uses and keep the mcp additions.

- [ ] **Step 2: Run test to verify it fails**

Run: `tsc -b 2>&1 | head -10`
Expected: compile error — `mcpNeeds` not on `MiniappMeta` / `mcpWarnings` not on `SaveMiniappResult`.

- [ ] **Step 3: Write the implementation**

In `packages/play/src/miniapps.ts`:

Imports (lines 9-10, 18):

```typescript
import type { Gem, GameArtifact, GameGenre, GameSource, GameCapability, McpNeed } from "@agentgem/model";
import { reconcileNeeds, deriveNeeds, hasDynamicToolCall, deriveMcpNeeds, mergeMcpNeeds, mcpUsageWarnings } from "./capabilityScan.js";
```

Types (lines 20-24):

```typescript
export interface MiniappMeta {
  title: string; genre: GameGenre; createdFrom: GameSource; engineVersion: string; needs?: GameCapability[];
  mcpNeeds?: McpNeed[];   // declared-authoritative (D10) — merged with derived literals at save, never pruned
}
export interface SaveMiniappInput { name: string; html: string; meta: MiniappMeta }
export interface SaveMiniappResult { name: string; commit: string | null; prunedNeeds: GameCapability[]; mcpWarnings: string[] }
```

`writeGameGem` (line 86-90) — carry the manifest into the artifact:

```typescript
  const artifact: GameArtifact = {
    type: "game", name, title: meta.title, genre: meta.genre,
    html, createdFrom: meta.createdFrom, engineVersion: meta.engineVersion,
    ...(meta.needs ? { needs: meta.needs } : {}),
    ...(meta.mcpNeeds ? { mcpNeeds: meta.mcpNeeds } : {}),
  };
```

`saveMiniapp` — after the `rec.missing` throw block (line 135) and the `meta` assembly (lines 136-137), replace lines 136-137 with:

```typescript
  const meta: MiniappMeta = { ...input.meta };
  if (rec.needs.length) meta.needs = rec.needs; else delete meta.needs;

  // MCP connectors are the OTHER reconciliation policy (spec D10): declared-authoritative. The
  // scan auto-fills literal calls (a convenience, mirroring how a claude.ai artifact's manifest is
  // authored), warnings surface what it cannot verify, and nothing is ever pruned or blocked —
  // the /api/play/mcp/call manifest check is the boundary that actually holds.
  const mcpNeeds = mergeMcpNeeds(input.meta.mcpNeeds, deriveMcpNeeds(html));
  const mcpWarnings = mcpUsageWarnings(html, input.meta.mcpNeeds);
  if (mcpNeeds.length) meta.mcpNeeds = mcpNeeds; else delete meta.mcpNeeds;
```

Widen the mute-bundle check (line 145) — a connector app with no bridge is just as unreachable:

```typescript
  if ((meta.needs?.length || meta.mcpNeeds?.length) && !html.includes(MCP_CLIENT_MARKER)) {
    const declared = [...(meta.needs ?? []), ...(meta.mcpNeeds ?? []).map((n) => `mcp:${n.server}`)];
    throw new Error(`miniapp declares capabilities (${declared.join(", ")}) but never references window.agentgemApp — it cannot reach the host`);
  }
```

And the return (line 159):

```typescript
  return { name: safe, commit, prunedNeeds: rec.pruned, mcpWarnings };
```

- [ ] **Step 4: Run the new tests AND the full play suite**

Run: `tsc -b && pnpm exec vitest run dist/play/__tests__/`
Expected: ALL PASS — `miniapps.test.ts`, `migrate.test.ts`, `portability.test.ts` unchanged and green is the regression evidence that non-mcp saves are untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/miniapps.ts src/play/__tests__/miniappsMcp.test.ts
git commit -m "feat(play): saveMiniapp mcpNeeds — declared ∪ derived, advisory mcpWarnings, shim gate widened, gem carry-through"
```

---

### Task 5: Save route passthrough + route-level test

**Files:**
- Modify: `src/play.controller.ts` only if the `save` handler maps fields explicitly (read it first — if it returns `saveMiniapp(...)`'s result directly, the Task-1 response schema addition already exposes `mcpWarnings` and NO controller change is needed)
- Test: `src/__tests__/playSaveMcp.test.ts` (new)

**Interfaces:**
- Consumes: `PlayController.save` (existing), Task 1 schemas, Task 4 save behavior.
- Produces: the wire-level guarantee PR-3's console client codes against: `POST /play/save` with `meta.mcpNeeds` persists them; the response carries `mcpWarnings`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/playSaveMcp.test.ts` (same harness as `src/__tests__/playMcpRoute.test.ts`):

```typescript
// src/__tests__/playSaveMcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };

describe("POST /api/play/save with mcpNeeds", () => {
  it("persists the declared manifest and reports scan warnings through the route", async () => {
    const ctrl = new PlayController();
    const html = `<!doctype html><body><canvas></canvas><script>const c = (s, t) => window.agentgemApp.mcp.callTool(s, t); c("github", pick());</script></body>`;
    const declared = [{ server: "github", tools: ["list_pull_requests"] }];
    const saved = await ctrl.save({ body: { name: "pulse", html, meta: { ...meta, mcpNeeds: declared } } });
    expect(saved.mcpWarnings).toHaveLength(1);
    const read = await ctrl.miniapp({ query: { name: "pulse" } });
    expect(read.meta.mcpNeeds).toEqual(declared);
  });

  it("stays absent end-to-end for a plain miniapp (regression)", async () => {
    const ctrl = new PlayController();
    const saved = await ctrl.save({ body: { name: "plain", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    expect(saved.mcpWarnings).toEqual([]);
    const read = await ctrl.miniapp({ query: { name: "plain" } });
    expect(read.meta.mcpNeeds).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes)**

Run: `tsc -b && pnpm exec vitest run dist/__tests__/playSaveMcp.test.js`
Expected: PASS **if** `save()` forwards the body and returns the result unmodified (Tasks 1+4 did the work). If it FAILS with a type or missing-field error, the controller maps fields explicitly — extend its mapping with `mcpNeeds` on the way in and `mcpWarnings` on the way out, mirroring how `needs`/`prunedNeeds` flow, then re-run to PASS.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/playSaveMcp.test.ts src/play.controller.ts
git commit -m "feat(play): mcpNeeds through the save route — persisted manifest + mcpWarnings on the wire"
```

(Omit `src/play.controller.ts` from the add if Step 2 needed no change.)

---

### Task 6: Full-suite regression sweep

**Files:** none new — verification only.

- [ ] **Step 1: Full root suite**

Run: `pnpm test`
Expected: green, including the pre-existing `capabilityScan.test.ts`, `capabilityScan.methods.test.ts`, `miniapps.test.ts`, `playRoutes.test.ts`, `schemas.test.ts` — the CRITICAL regression pin from the spec.

- [ ] **Step 2: Check the wire-enum drift guard still passes**

Run: `pnpm exec vitest run dist/__tests__/schemas.test.js`
Expected: PASS — `GameCapabilityEnum` untouched (mcpNeeds is a separate structured field, not a new enum value).

- [ ] **Step 3: Commit any stragglers and push the branch**

```bash
git status --short   # expect clean
git push -u origin HEAD
```

Open the PR (`gh pr create`) titled `feat(model+play): mcpNeeds — declared-authoritative MCP connector manifest (PR-1 of 4)`, body linking the spec, then `gh run watch <run-id> --exit-status` before merge per repo policy.

---

## Out of scope for PR-1 (subsequent plans)

- **PR-2 (server):** `src/play/mcpConnectors.ts` (single-flight, env allowlist, timeouts), `/api/play/mcp/call` + `/api/play/mcp/servers`, error mapping onto `MCP_ERROR_CODES`, fake stdio/http fixtures — planned after PR-1 merges.
- **PR-3 (console):** consent card + hash-pinned grants, `mcp/*` router, watch registry (coalescing, readOnlyHint gate, hidden-pause), shim `agentgemApp.mcp`, drift pins against `MCP_ERROR_CODES`.
- **PR-4:** marketplace chip (4a, parallelizable after PR-1) + Repo Pulse demo & verify-skill E2E (4b).
