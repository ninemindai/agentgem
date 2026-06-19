# Deploy Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Anthropic-specific publish path into a `DEPLOY_REGISTRY` of `DeployTarget { preview, ready, deploy }` (mirroring `TARGET_REGISTRY`), route the existing `/publish*` ops through it with an optional `target` (default `claude-managed`), and add `GET /api/deploy-targets`.

**Architecture:** A new `src/gem/deploy.ts` holds the interface + registry, reusing the existing pure render (`renderManagedAgent`) and network orchestration (`publishManagedAgentOnce`/`publishManagedAgent`/`anthropicPublishClient`) unchanged. The controller stops importing Anthropic specifics and consumes the registry by id. Single backend; Anthropic-typed preview/result shapes preserved (generic schema deferred to the Bedrock follow-up).

**Tech Stack:** TypeScript (ESM, NodeNext), Zod v4, `@agentback/*`, Vitest (tests from `dist/`). No new dependencies.

## Global Constraints

- **ESM `.js` import extensions** (NodeNext). Tests from `dist/`: `npm test` = `tsc -b && vitest run`; focused `npm test -- -t "<pattern>"`.
- **Reuse unchanged**: `renderManagedAgent` (`src/gem/publish.js`), `publishManagedAgent`/`publishManagedAgentOnce`/`anthropicPublishClient` + `PublishResult` (`src/publish.js`). Do NOT modify those files.
- **Backward compatible**: ops without `target` behave exactly as today (default `claude-managed`). Existing publish-preview/publish-ready tests must pass unchanged.
- **Trust boundary unchanged**: `ready()` reads `process.env`; `deploy()` reads the key server-side, never returns it, sends only the redacted payload.
- **Registry-derived enum**: `DeployTargetIdSchema = z.enum(deployTargetIds)` (like `TargetIdSchema = z.enum(Object.keys(TARGET_REGISTRY))`).
- No import cycle: `schemas.ts → deploy.ts → publish.ts → gem/publish.ts → types.ts` (none import `schemas.ts`).

---

### Task 1: `deploy.ts` — DeployTarget interface + registry

**Files:**
- Create: `src/gem/deploy.ts`
- Test: `src/gem/__tests__/deploy.test.ts`

**Interfaces:**
- Consumes: `Gem` (`./types.js`); `renderManagedAgent` + `ManagedAgentRender` (`./publish.js`); `publishManagedAgent`, `publishManagedAgentOnce`, `anthropicPublishClient`, `PublishResult` (`../publish.js`).
- Produces: `DeployTargetId`, `DeployTarget`, `DEPLOY_REGISTRY`, `deployTargetIds`, `deployTargetList()`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/deploy.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { DEPLOY_REGISTRY, deployTargetIds, deployTargetList } from "../deploy.js";
import { renderManagedAgent } from "../publish.js";
import type { Gem, PackArtifact } from "../types.js";

const gem = (artifacts: PackArtifact[]): Gem => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string): PackArtifact => ({ type: "skill", name: n, source: "standalone", content: "# body" });

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

describe("deploy registry", () => {
  it("exposes claude-managed", () => {
    expect(deployTargetIds).toContain("claude-managed");
    expect(DEPLOY_REGISTRY["claude-managed"].label).toBe("Claude Managed Agents");
  });

  it("preview equals renderManagedAgent", () => {
    const p = gem([skill("review")]);
    expect(DEPLOY_REGISTRY["claude-managed"].preview(p)).toEqual(renderManagedAgent(p));
  });

  it("ready reflects ANTHROPIC_API_KEY; deployTargetList carries it", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(DEPLOY_REGISTRY["claude-managed"].ready()).toBe(false);
    expect(deployTargetList()).toEqual([{ id: "claude-managed", label: "Claude Managed Agents", ready: false }]);
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(DEPLOY_REGISTRY["claude-managed"].ready()).toBe(true);
  });

  it("deploy throws (no network) when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(DEPLOY_REGISTRY["claude-managed"].deploy(gem([skill("a")]), "req-12345678")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "deploy registry"`
Expected: FAIL — `Cannot find module '../deploy.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/deploy.ts
// Deploy backends as a registry (mirrors TARGET_REGISTRY for materialize). Each DeployTarget renders
// a Gem offline (preview), reports whether the server is configured for it (ready), and performs the
// gated network deploy (deploy). Reuses the existing pure render + network orchestration unchanged.
import type { Gem } from "./types.js";
import { renderManagedAgent } from "./publish.js";
import type { ManagedAgentRender } from "./publish.js";
import { publishManagedAgent, publishManagedAgentOnce, anthropicPublishClient } from "../publish.js";
import type { PublishResult } from "../publish.js";

export type DeployTargetId = "claude-managed";

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  preview(gem: Gem): ManagedAgentRender;                          // pure, offline
  ready(): boolean;                                                 // server configured for this backend
  deploy(gem: Gem, requestId: string): Promise<PublishResult>;   // gated; throws if not ready
}

export const DEPLOY_REGISTRY: Record<DeployTargetId, DeployTarget> = {
  "claude-managed": {
    id: "claude-managed",
    label: "Claude Managed Agents",
    preview: (gem) => renderManagedAgent(gem),
    ready: () => !!process.env.ANTHROPIC_API_KEY,
    deploy: (gem, requestId) => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server — cannot deploy to Claude Managed Agents.");
      return publishManagedAgentOnce(requestId, JSON.stringify(gem), () => publishManagedAgent(gem, anthropicPublishClient(key)));
    },
  },
};

export const deployTargetIds = Object.keys(DEPLOY_REGISTRY) as [DeployTargetId, ...DeployTargetId[]];

export function deployTargetList(): { id: DeployTargetId; label: string; ready: boolean }[] {
  return deployTargetIds.map((id) => ({ id, label: DEPLOY_REGISTRY[id].label, ready: DEPLOY_REGISTRY[id].ready() }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "deploy registry"`
Expected: PASS (no network — the deploy-throws case never reaches the client).

- [ ] **Step 5: Commit**

```bash
git add src/gem/deploy.ts src/gem/__tests__/deploy.test.ts
git commit -m "feat(deploy): DeployTarget registry wrapping the managed-agents path"
```

---

### Task 2: Deploy schemas + optional `target`

**Files:**
- Modify: `src/schemas.ts`
- Test: `src/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: `deployTargetIds` from `./gem/deploy.js`; existing `PublishPreviewRequestSchema`, `PublishRequestSchema`.
- Produces: `DeployTargetIdSchema`, `DeployReadyQuerySchema`, `DeployTargetsResponseSchema`; optional `target` added to `PublishPreviewRequestSchema` (so `PublishRequestSchema` inherits it via `.extend`).

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/schemas.test.ts
import { DeployTargetIdSchema, DeployReadyQuerySchema, DeployTargetsResponseSchema, PublishPreviewRequestSchema } from "../schemas.js";

describe("deploy schemas", () => {
  it("validates the deploy target id and rejects unknown", () => {
    expect(DeployTargetIdSchema.safeParse("claude-managed").success).toBe(true);
    expect(DeployTargetIdSchema.safeParse("nope").success).toBe(false);
  });
  it("publish-preview accepts an optional target; ready query + targets response validate", () => {
    expect(PublishPreviewRequestSchema.safeParse({ selection: { all: true } }).success).toBe(true);
    expect(PublishPreviewRequestSchema.safeParse({ selection: { all: true }, target: "claude-managed" }).success).toBe(true);
    expect(DeployReadyQuerySchema.safeParse({}).success).toBe(true);
    expect(DeployReadyQuerySchema.safeParse({ target: "claude-managed" }).success).toBe(true);
    expect(DeployTargetsResponseSchema.safeParse({ targets: [{ id: "claude-managed", label: "Claude Managed Agents", ready: false }] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "deploy schemas"`
Expected: FAIL — `DeployTargetIdSchema` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/schemas.ts`:

(a) Add the import near the top (with the other registry imports):
```ts
import { deployTargetIds } from "./gem/deploy.js";
```

(b) Define the deploy schemas (place just above the `// ── Managed Agents publish ──` block):
```ts
export const DeployTargetIdSchema = z.enum(deployTargetIds);
export const DeployReadyQuerySchema = z.object({ target: DeployTargetIdSchema.optional() });
export const DeployTargetsResponseSchema = z.object({
  targets: z.array(z.object({ id: DeployTargetIdSchema, label: z.string(), ready: z.boolean() })),
});
```

(c) Add the optional `target` to `PublishPreviewRequestSchema` (the `PublishRequestSchema` extends it, so it inherits the field):
```ts
export const PublishPreviewRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  target: DeployTargetIdSchema.optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "deploy schemas"` then `npm test -- -t "schemas"` (existing schema tests unaffected — `target` is optional).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(schemas): deploy target id + targets/ready schemas; optional target on publish"
```

---

### Task 3: Route the controller through the registry + `GET /api/deploy-targets`

**Files:**
- Modify: `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `DEPLOY_REGISTRY`, `deployTargetList`, `DeployTargetId` (`./gem/deploy.js`); `DeployTargetsResponseSchema`, `DeployReadyQuerySchema` (Task 2); existing `buildPack`/`resolveDirs`/`introspectAll`.
- Produces: publish-preview/publish-ready/publish route through the registry by `target` (default `claude-managed`); new `GET /api/deploy-targets`. The direct Anthropic imports are removed.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/gem.controller.test.ts
describe("deploy registry ops", () => {
  it("GET /api/deploy-targets lists claude-managed with a boolean ready", async () => {
    const r = await client.get("/api/deploy-targets").expect(200);
    expect(r.body.targets.map((t: { id: string }) => t.id)).toEqual(["claude-managed"]);
    expect(typeof r.body.targets[0].ready).toBe("boolean");
  });

  it("publish-preview routes through the registry (target optional, identical payload)", async () => {
    const base = { dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "pub" };
    const a = await client.post("/api/publish-preview").send(base).expect(200);
    const b = await client.post("/api/publish-preview").send({ ...base, target: "claude-managed" }).expect(200);
    expect(a.body.payload.name).toBe("pub");
    expect(a.body).toEqual(b.body);
    expect(JSON.stringify(a.body)).not.toContain("ghp_secret");
  });

  it("POST /api/publish without ANTHROPIC_API_KEY returns 500 (gated via the registry)", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await client.post("/api/publish").send({ dir, selection: { skills: ["review"] }, requestId: "req-12345678" }).expect(500);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "deploy registry ops"`
Expected: FAIL — `/api/deploy-targets` 404.

- [ ] **Step 3: Update the controller**

In `src/gem.controller.ts`:

(a) Replace the publish imports. Remove:
```ts
import { renderManagedAgent } from "./gem/publish.js";
import { publishManagedAgent, publishManagedAgentOnce, anthropicPublishClient } from "./publish.js";
```
Add:
```ts
import { DEPLOY_REGISTRY, deployTargetList } from "./gem/deploy.js";
import type { DeployTargetId } from "./gem/deploy.js";
```
Add to the `./schemas.js` import list: `DeployTargetsResponseSchema, DeployReadyQuerySchema` (and ensure `PublishPreviewRequestSchema`, `PublishRequestSchema`, `PublishPreviewResponseSchema`, `PublishReadyResponseSchema`, `PublishResultSchema` remain).

(b) Replace the three publish methods and add the list op:
```ts
  @get("/deploy-targets", { query: PickQuerySchema, response: DeployTargetsResponseSchema })
  async deployTargets(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof DeployTargetsResponseSchema>> {
    return { targets: deployTargetList() };
  }

  // Offline render of the deploy payload + skip/secret/skill lists. No network.
  @post("/publish-preview", { body: PublishPreviewRequestSchema, response: PublishPreviewResponseSchema })
  async publishPreview(input: { body: z.infer<typeof PublishPreviewRequestSchema> }): Promise<z.infer<typeof PublishPreviewResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildPack(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    const r = DEPLOY_REGISTRY[target].preview(gem);
    return { payload: r.payload, skillsToRegister: r.skillsToRegister.map((s) => s.name), skipped: r.skipped, vaultSecrets: r.vaultSecrets };
  }

  // Whether the server is configured for the deploy backend (the UI gates on this). Boolean only.
  @get("/publish-ready", { query: DeployReadyQuerySchema, response: PublishReadyResponseSchema })
  async publishReady(input: { query: z.infer<typeof DeployReadyQuerySchema> }): Promise<z.infer<typeof PublishReadyResponseSchema>> {
    const target = (input.query.target ?? "claude-managed") as DeployTargetId;
    return { ready: DEPLOY_REGISTRY[target].ready() };
  }

  // OUTWARD-FACING: gated network deploy through the selected backend. The key is read server-side
  // (inside the registry's deploy) and never returned; only the redacted gem payload is sent.
  @post("/publish", { body: PublishRequestSchema, response: PublishResultSchema })
  async publish(input: { body: z.infer<typeof PublishRequestSchema> }): Promise<z.infer<typeof PublishResultSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildPack(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    return DEPLOY_REGISTRY[target].deploy(gem, input.body.requestId);
  }
```

(Leave the other controller methods untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "deploy registry ops"` then `npm test` (full suite — the existing publish-preview / publish-ready tests still pass unchanged; `publish.network.test.ts` is unaffected since `publishManagedAgent*` are reused verbatim).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): route publish ops through DEPLOY_REGISTRY; add GET /api/deploy-targets"
```

---

## Self-Review

**Spec coverage:**
- §1.1 DeployTarget + registry → Task 1 ✓
- §1.2 three ops (preview/ready/deploy) → Task 1 ✓
- §1.3 reuse pure+network code unchanged → Task 1 (imports renderManagedAgent + publishManagedAgent* verbatim; `src/publish.ts`/`src/gem/publish.ts` untouched) ✓
- §1.4 keep /publish* routes + optional target + registry-derived enum → Tasks 2,3 ✓
- §1.5 GET /api/deploy-targets → Task 3 ✓
- §1.6 generic schema deferred (Anthropic shapes kept) → Tasks 2,3 (preview/result schemas unchanged) ✓
- §1.7 gem-based idempotency fingerprint → Task 1 (`JSON.stringify(gem)`) ✓
- §1.8 trust boundary unchanged → Task 1 (`ready()` reads env; `deploy()` reads key server-side) ✓
- §3 controller table → Task 3 ✓
- §6 testing → Tasks 1–3 (unit + controller; network test unaffected) ✓

**Placeholder scan:** No TBD/TODO; complete code in every code step; commands + expected output in run steps. ✓

**Type consistency:** `DeployTargetId`/`DeployTarget`/`DEPLOY_REGISTRY`/`deployTargetIds`/`deployTargetList` defined in Task 1 and used consistently in Tasks 2–3; `DeployTargetIdSchema = z.enum(deployTargetIds)` keeps the schema in lockstep with the registry; the controller's `(input.body.target ?? "claude-managed") as DeployTargetId` matches the registry keys; removed imports (`renderManagedAgent`, `publishManagedAgent*`, `anthropicPublishClient`) are fully replaced by registry calls. No cycle (`schemas.ts → deploy.ts → publish.ts → gem/publish.ts → types.ts`). ✓
