# AgentCore Target — Phase 3 (publish backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agentcore-managed` publish backend that creates a Bedrock AgentCore harness via the `CreateHarness` API, exposed through the existing `DEPLOY_REGISTRY` publish surface generalized to a `kind`-discriminated union.

**Architecture:** Generalize `DEPLOY_REGISTRY`'s `preview`/`deploy` to return `kind`-tagged unions (`managed-agent` | `agentcore-harness`); claude-managed keeps its behavior, now tagged. A new `src/gem/agentcorePublish.ts` builds the `CreateHarness` request (reusing Phase-1 systemPrompt/tools logic; skills skip-and-reported since the API takes git/s3 sources, not local files) and calls AWS via an **injected** control-plane client (real wraps `@aws-sdk/client-bedrock-agentcore-control`; tests use a fake — no live AWS). The `/api/publish*` endpoints already route via `DEPLOY_REGISTRY[target]`; their response schemas become discriminated unions. The UI "Managed Agents" tab gains a backend selector + branched rendering.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Vitest, supertest, Zod, `@aws-sdk/client-bedrock-agentcore-control` (new dep).

## Global Constraints

- ESM: every local import uses a `.js` suffix.
- Tests run via compiled dist: `npm run clean && npx tsc -b && npx vitest run`.
- **Never call real AWS in tests.** `deploy` takes an injected `AgentcoreControlClient`; tests pass a fake. The real client (wrapping the AWS SDK) is only constructed in the `DEPLOY_REGISTRY` entry's `deploy`, never in a test.
- **Secret invariant:** no raw secret in any preview/result/response. MCP secret headers render as `${arn:...}` token-vault placeholders (reuse Phase-1 `buildAgentcoreHarness`); `vaultSecrets` carries names only.
- **`CreateHarness` facts (verbatim from the API ref):** `executionRoleArn` (REQUIRED, pattern `arn:aws...:role/.+`) and `harnessName` (REQUIRED, pattern `[a-zA-Z][a-zA-Z0-9_]{0,39}`); optional `systemPrompt: [{text}]`, `tools: [{type,name,config}]`, `skills`, `model`, `clientToken` (idempotency, min 33 chars). Response: `harness: { arn, harnessId, harnessName, harnessVersion, status, failureReason? }`.
- **Execution role source:** `process.env.AGENTCORE_EXECUTION_ROLE_ARN`. `ready()` = AWS creds present (`(AWS_ACCESS_KEY_ID|AWS_PROFILE) && (AWS_REGION|AWS_DEFAULT_REGION)`) **and** a non-empty execution role ARN.
- **Skills on publish:** the API cannot upload local skill files. Skip every skill with reason `"AgentCore publish needs a git/s3 skill source; local skill not carried by the gem"`. (Materialize container-bakes them; publish cannot.)
- **harnessName:** sanitize `gem.name` to `[a-zA-Z][a-zA-Z0-9_]{0,39}` (drop invalid chars; ensure a leading letter; cap 40).
- Backend id is `agentcore-managed` (parallels `claude-managed`).
- Keep claude-managed behavior intact (existing publish tests must still pass, now carrying a `kind` field).

---

## File Structure

- **Modify** `src/gem/deploy.ts` — generalize `DeployTargetId`, `DeployPreview`, `DeployResult`, `DeployTarget`; tag claude-managed; add the `agentcore-managed` entry.
- **Create** `src/gem/agentcorePublish.ts` — `harnessNameFor`, `buildCreateHarnessRequest`, `AgentcoreControlClient` (interface) + `realAgentcoreControlClient`, `previewAgentcorePublish`, `deployAgentcorePublish`, `agentcorePublishReady`.
- **Create** `src/gem/__tests__/agentcorePublish.test.ts`.
- **Modify** `src/schemas.ts` — `PublishPreviewResponseSchema` + `PublishResultSchema` become `z.discriminatedUnion("kind", …)`.
- **Modify** `src/gem.controller.ts` — `publishPreview`/`publish` return the union as-is (drop the claude-specific transform; the registry returns wire-ready previews).
- **Modify** `src/__tests__/gem.controller.test.ts` — assert `kind` on existing claude-managed responses; add an agentcore-managed preview/ready test.
- **Modify** `package.json` — add `@aws-sdk/client-bedrock-agentcore-control`.
- **Modify** `src/public/index.html` — backend `<select>` in the Managed Agents preview + branch rendering.

---

## Task 1: Generalize the deploy registry to a kind-union

**Files:**
- Modify: `src/gem/deploy.ts`, `src/gem/publish.ts` (re-export shapes if needed), `src/schemas.ts`, `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Produces:
  - `type DeployTargetId = "claude-managed" | "agentcore-managed"`
  - `type DeployPreview = ({ kind: "managed-agent"; payload; skillsToRegister: string[]; skipped; vaultSecrets }) | ({ kind: "agentcore-harness"; request; skipped; vaultSecrets })`
  - `type DeployResult = ({ kind: "managed-agent" } & PublishResult) | ({ kind: "agentcore-harness"; harnessArn; harnessId; harnessName; harnessVersion; status; skipped; vaultSecrets })`
  - `DeployTarget.preview(gem): DeployPreview` (wire-ready); `deploy(gem, requestId): Promise<DeployResult>`.
  - This task adds ONLY the `claude-managed` (`kind:"managed-agent"`) variant; `agentcore-managed` is added in Task 3.

- [ ] **Step 1: Write the failing test (claude-managed now carries kind)**

In `src/__tests__/gem.controller.test.ts`, update the existing publish-preview assertion block to also assert the discriminant, and add a result-kind check. Add to the existing `describe("deploy registry ops")`:

```ts
it("publish-preview is tagged kind=managed-agent", async () => {
  const r = await client.post("/api/publish-preview")
    .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "pub" }).expect(200);
  expect(r.body.kind).toBe("managed-agent");
  expect(r.body.payload.name).toBe("pub");           // existing managed-agent fields still present
  expect(Array.isArray(r.body.skillsToRegister)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run gem.controller`
Expected: FAIL — `r.body.kind` is undefined.

- [ ] **Step 3: Generalize the types + tag claude-managed**

In `src/gem/deploy.ts`, replace the type + registry:

```ts
import type { Gem, SecretRequirement } from "./types.js";
import { renderManagedAgent } from "./publish.js";
import type { ManagedAgentRender, ManagedAgentPayload, SkippedArtifact } from "./publish.js";
import { publishManagedAgent, publishManagedAgentOnce, anthropicPublishClient } from "../publish.js";
import type { PublishResult } from "../publish.js";

export type DeployTargetId = "claude-managed" | "agentcore-managed";

export type DeployPreview =
  | { kind: "managed-agent"; payload: ManagedAgentPayload; skillsToRegister: string[]; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] }
  | { kind: "agentcore-harness"; request: Record<string, unknown>; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] };

export type DeployResult =
  | ({ kind: "managed-agent" } & PublishResult)
  | { kind: "agentcore-harness"; harnessArn: string; harnessId: string; harnessName: string; harnessVersion: string; status: string; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] };

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  preview(gem: Gem): DeployPreview;   // wire-ready, pure, offline
  ready(): boolean;
  deploy(gem: Gem, requestId: string): Promise<DeployResult>;
}

const managedAgentPreview = (gem: Gem): DeployPreview => {
  const r: ManagedAgentRender = renderManagedAgent(gem);
  return { kind: "managed-agent", payload: r.payload, skillsToRegister: r.skillsToRegister.map((s) => s.name), skipped: r.skipped, vaultSecrets: r.vaultSecrets };
};

export const DEPLOY_REGISTRY: Record<DeployTargetId, DeployTarget> = {
  "claude-managed": {
    id: "claude-managed",
    label: "Claude Managed Agents",
    preview: managedAgentPreview,
    ready: () => !!process.env.ANTHROPIC_API_KEY,
    deploy: async (gem, requestId) => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server — cannot deploy to Claude Managed Agents.");
      const r = await publishManagedAgentOnce(requestId, JSON.stringify(gem), () => publishManagedAgent(gem, anthropicPublishClient(key)));
      return { kind: "managed-agent", ...r };
    },
  },
  // "agentcore-managed" added in Task 3.
} as Record<DeployTargetId, DeployTarget>;
```

(`SkippedArtifact`/`ManagedAgentPayload` are exported from `src/gem/publish.ts` — confirm and add `export` if either isn't already exported.)

- [ ] **Step 4: Union the response schemas**

In `src/schemas.ts`, replace `PublishPreviewResponseSchema` and `PublishResultSchema`:

```ts
const ManagedAgentPreviewSchema = z.object({
  kind: z.literal("managed-agent"),
  payload: ManagedAgentPayloadSchema,
  skillsToRegister: z.array(z.string()),
  skipped: z.array(SkippedArtifactSchema),
  vaultSecrets: z.array(SecretRequirementSchema),
});
const AgentcorePreviewSchema = z.object({
  kind: z.literal("agentcore-harness"),
  request: z.record(z.string(), z.unknown()),
  skipped: z.array(SkippedArtifactSchema),
  vaultSecrets: z.array(SecretRequirementSchema),
});
export const PublishPreviewResponseSchema = z.discriminatedUnion("kind", [ManagedAgentPreviewSchema, AgentcorePreviewSchema]);

const ManagedAgentResultSchema = z.object({
  kind: z.literal("managed-agent"),
  agentId: z.string(), environmentId: z.string(), version: z.string(),
  registeredSkills: z.array(z.object({ name: z.string(), skillId: z.string(), version: z.string() })),
  skipped: z.array(SkippedArtifactSchema), vaultSecrets: z.array(SecretRequirementSchema),
});
const AgentcoreResultSchema = z.object({
  kind: z.literal("agentcore-harness"),
  harnessArn: z.string(), harnessId: z.string(), harnessName: z.string(), harnessVersion: z.string(), status: z.string(),
  skipped: z.array(SkippedArtifactSchema), vaultSecrets: z.array(SecretRequirementSchema),
});
export const PublishResultSchema = z.discriminatedUnion("kind", [ManagedAgentResultSchema, AgentcoreResultSchema]);
```

- [ ] **Step 5: Simplify the controller to return the union**

In `src/gem.controller.ts`, change `publishPreview` and `publish` to return the registry output directly (the registry now produces wire-ready shapes):

```ts
  @post("/publish-preview", { body: PublishPreviewRequestSchema, response: PublishPreviewResponseSchema })
  async publishPreview(input: { body: z.infer<typeof PublishPreviewRequestSchema> }): Promise<z.infer<typeof PublishPreviewResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    return DEPLOY_REGISTRY[target].preview(gem);
  }
```

(The `publish` method already returns `DEPLOY_REGISTRY[target].deploy(...)`; with the union types it now returns `DeployResult` — no body change needed beyond the response schema. Confirm its return type compiles against the union.)

- [ ] **Step 6: Run tests + full suite**

Run: `npm run clean && npx vitest run gem.controller` then `npx vitest run`
Expected: PASS — existing claude-managed publish tests still pass (now with `kind`), plus the new kind assertion.

- [ ] **Step 7: Commit**

```bash
git add src/gem/deploy.ts src/gem/publish.ts src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "refactor(deploy): kind-discriminated DeployPreview/DeployResult union (claude-managed tagged)"
```

---

## Task 2: agentcore publish module

**Files:**
- Create: `src/gem/agentcorePublish.ts`
- Modify: `package.json` (add the AWS SDK dep)
- Test: `src/gem/__tests__/agentcorePublish.test.ts`

**Interfaces:**
- Consumes: `buildAgentcoreHarness` (Phase 1, exported from `./targets.js`), `safePathSegment`, `Gem`, `SkippedArtifact`, `SecretRequirement`.
- Produces:
  - `harnessNameFor(gem: Gem): string`
  - `buildCreateHarnessRequest(gem: Gem, opts: { executionRoleArn: string }): { request: Record<string, unknown>; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] }`
  - `interface AgentcoreControlClient { createHarness(req: Record<string, unknown>): Promise<{ arn: string; harnessId: string; harnessName: string; harnessVersion: string; status: string; failureReason?: string }> }`
  - `realAgentcoreControlClient(): AgentcoreControlClient`
  - `agentcorePublishReady(): boolean`
  - `previewAgentcorePublish(gem: Gem): DeployPreview` (kind `agentcore-harness`)
  - `deployAgentcorePublish(gem: Gem, requestId: string, client?: AgentcoreControlClient): Promise<DeployResult>`

- [ ] **Step 1: Add the AWS SDK dependency**

In `package.json` `dependencies`, add: `"@aws-sdk/client-bedrock-agentcore-control": "^3.700.0"`. Then `npm install` (or `pnpm install`) to update the lockfile. (If the exact version is unavailable, use the latest `3.x` the registry offers.)

- [ ] **Step 2: Write the failing test**

Create `src/gem/__tests__/agentcorePublish.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import type { Gem } from "../types.js";
import {
  harnessNameFor, buildCreateHarnessRequest, agentcorePublishReady,
  previewAgentcorePublish, deployAgentcorePublish, type AgentcoreControlClient,
} from "../agentcorePublish.js";

const gem = (over: Partial<Gem> = {}): Gem => ({
  name: "research agent!", createdFrom: "/d",
  artifacts: [
    { type: "skill", name: "scrape", source: "standalone", content: "# body" },
    { type: "mcp_server", name: "exa", transport: "http", config: { url: "https://mcp.x/sse" }, secretRefs: [{ name: "X_TOKEN", location: "headers.Authorization" }] },
    { type: "instructions", name: "CLAUDE.md", content: "be terse" },
  ],
  checks: [], requiredSecrets: [{ name: "X_TOKEN", artifact: "exa", location: "headers.Authorization" }], ...over,
});
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe("agentcore publish helpers", () => {
  it("harnessNameFor sanitizes to the CreateHarness pattern", () => {
    expect(harnessNameFor(gem())).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
  });
  it("buildCreateHarnessRequest sets required fields, maps tools, skips local skills, no raw secret", () => {
    const { request, skipped, vaultSecrets } = buildCreateHarnessRequest(gem(), { executionRoleArn: "arn:aws:iam::123456789012:role/HarnessRole" });
    expect(request.executionRoleArn).toBe("arn:aws:iam::123456789012:role/HarnessRole");
    expect(request.harnessName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(request.systemPrompt).toEqual([{ text: expect.stringContaining("be terse") }]);
    expect((request.tools as Array<{ name: string }>)[0].name).toBe("exa");
    expect(request.skills).toBeUndefined();                                  // local skills not carried
    expect(skipped.some((s) => s.artifact === "scrape" && /git\/s3/.test(s.reason))).toBe(true);
    expect(vaultSecrets).toContainEqual({ name: "X_TOKEN", artifact: "exa", location: "headers.Authorization" });
    expect(JSON.stringify(request)).not.toContain("<redacted>");
  });
  it("agentcorePublishReady requires creds AND an execution role arn", () => {
    delete process.env.AWS_PROFILE; delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AGENTCORE_EXECUTION_ROLE_ARN;
    expect(agentcorePublishReady()).toBe(false);
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    expect(agentcorePublishReady()).toBe(false);                            // role still missing
    process.env.AGENTCORE_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/HarnessRole";
    expect(agentcorePublishReady()).toBe(true);
  });
});

describe("deployAgentcorePublish", () => {
  it("throws without an execution role", async () => {
    delete process.env.AGENTCORE_EXECUTION_ROLE_ARN;
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    await expect(deployAgentcorePublish(gem(), "req-abcdefghijklmnopqrstuvwxyz123456", { createHarness: async () => { throw new Error("should not be called"); } })).rejects.toThrow(/execution role/i);
  });
  it("calls the injected client and returns a kind=agentcore-harness result", async () => {
    process.env.AGENTCORE_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/HarnessRole";
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    let seen: Record<string, unknown> | null = null;
    const fake: AgentcoreControlClient = { createHarness: async (req) => { seen = req; return { arn: "arn:aws:bedrock-agentcore:us-west-2:123:harness/Researchagent-Ab12", harnessId: "Researchagent-Ab12", harnessName: "Researchagent", harnessVersion: "1", status: "READY" }; } };
    const res = await deployAgentcorePublish(gem(), "req-abcdefghijklmnopqrstuvwxyz123456", fake);
    expect(seen!.harnessName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(res.kind).toBe("agentcore-harness");
    if (res.kind === "agentcore-harness") { expect(res.harnessArn).toContain("harness/"); expect(res.status).toBe("READY"); }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run agentcorePublish`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `src/gem/agentcorePublish.ts`:

```ts
// src/gem/agentcorePublish.ts
// Publish a gem as a Bedrock AgentCore harness via CreateHarness. The control-plane client is injected
// so the network call is unit-testable with a fake (no live AWS). Skills are skip-and-reported: the API
// takes git/s3 sources, not the local skill files a gem carries.
import type { Gem, SecretRequirement } from "./types.js";
import { buildAgentcoreHarness, safePathSegment } from "./targets.js";
import type { SkippedArtifact } from "./publish.js";
import type { DeployPreview, DeployResult } from "./deploy.js";

export interface AgentcoreControlClient {
  createHarness(req: Record<string, unknown>): Promise<{ arn: string; harnessId: string; harnessName: string; harnessVersion: string; status: string; failureReason?: string }>;
}

// CreateHarness harnessName pattern: [a-zA-Z][a-zA-Z0-9_]{0,39}
export function harnessNameFor(gem: Gem): string {
  let n = (gem.name || "agent").replace(/[^a-zA-Z0-9_]/g, "");
  if (!/^[a-zA-Z]/.test(n)) n = "a" + n;
  return n.slice(0, 40) || "agent";
}

export function buildCreateHarnessRequest(gem: Gem, opts: { executionRoleArn: string }): { request: Record<string, unknown>; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] } {
  const { harness, skipped } = buildAgentcoreHarness(gem); // systemPrompt + tools + (path) skills + model
  const skills = gem.artifacts.filter((a) => a.type === "skill");
  for (const s of skills) skipped.push({ artifact: s.name, type: "skill", reason: "AgentCore publish needs a git/s3 skill source; local skill not carried by the gem" });
  const request: Record<string, unknown> = {
    harnessName: harnessNameFor(gem),
    executionRoleArn: opts.executionRoleArn,
    model: harness.model,
  };
  if (harness.systemPrompt) request.systemPrompt = harness.systemPrompt;
  if (harness.tools) request.tools = harness.tools;
  // NOTE: harness.skills (local path-skills) are intentionally NOT forwarded — publish can't upload files.
  return { request, skipped, vaultSecrets: gem.requiredSecrets };
}

export function agentcorePublishReady(): boolean {
  const hasId = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  const hasRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  return hasId && hasRegion && !!process.env.AGENTCORE_EXECUTION_ROLE_ARN;
}

export function realAgentcoreControlClient(): AgentcoreControlClient {
  return {
    async createHarness(req) {
      // Lazy import so the SDK isn't loaded unless a real publish runs.
      const { BedrockAgentCoreControlClient, CreateHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore-control");
      const client = new BedrockAgentCoreControlClient({});
      const out = await client.send(new CreateHarnessCommand(req as never));
      const h = (out as { harness?: Record<string, unknown> }).harness ?? {};
      return {
        arn: String(h.arn ?? ""), harnessId: String(h.harnessId ?? ""), harnessName: String(h.harnessName ?? ""),
        harnessVersion: String(h.harnessVersion ?? ""), status: String(h.status ?? ""), failureReason: h.failureReason as string | undefined,
      };
    },
  };
}

export function previewAgentcorePublish(gem: Gem): DeployPreview {
  const roleArn = process.env.AGENTCORE_EXECUTION_ROLE_ARN || "arn:aws:iam::ACCOUNT:role/REPLACE_WITH_HARNESS_ROLE";
  const { request, skipped, vaultSecrets } = buildCreateHarnessRequest(gem, { executionRoleArn: roleArn });
  return { kind: "agentcore-harness", request, skipped, vaultSecrets };
}

export async function deployAgentcorePublish(gem: Gem, _requestId: string, client: AgentcoreControlClient = realAgentcoreControlClient()): Promise<DeployResult> {
  const roleArn = process.env.AGENTCORE_EXECUTION_ROLE_ARN;
  if (!roleArn) throw new Error("AGENTCORE_EXECUTION_ROLE_ARN is not set — cannot create an AgentCore harness (execution role required).");
  const { request, skipped, vaultSecrets } = buildCreateHarnessRequest(gem, { executionRoleArn: roleArn });
  const h = await client.createHarness(request);
  return { kind: "agentcore-harness", harnessArn: h.arn, harnessId: h.harnessId, harnessName: h.harnessName, harnessVersion: h.harnessVersion, status: h.status, skipped, vaultSecrets };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run clean && npx vitest run agentcorePublish`
Expected: PASS (helpers + deploy with fake client).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/gem/agentcorePublish.ts src/gem/__tests__/agentcorePublish.test.ts
git commit -m "feat(agentcore): publish module — CreateHarness request builder + injected control client"
```

---

## Task 3: Register the agentcore-managed backend

**Files:**
- Modify: `src/gem/deploy.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `previewAgentcorePublish`, `deployAgentcorePublish`, `agentcorePublishReady` from `./agentcorePublish.js`.
- Produces: the `agentcore-managed` `DeployTarget` registered in `DEPLOY_REGISTRY`, routed by the existing `/api/publish*` and `/api/deploy-targets` endpoints.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gem.controller.test.ts`:

```ts
describe("agentcore-managed deploy backend", () => {
  it("deploy-targets lists agentcore-managed with a boolean ready", async () => {
    const r = await client.get("/api/deploy-targets").expect(200);
    const ac = r.body.targets.find((t: { id: string }) => t.id === "agentcore-managed");
    expect(ac).toBeTruthy();
    expect(typeof ac.ready).toBe("boolean");
  });
  it("publish-preview target=agentcore-managed renders a CreateHarness request, skips local skills, no secret", async () => {
    const r = await client.post("/api/publish-preview")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "pub", target: "agentcore-managed" }).expect(200);
    expect(r.body.kind).toBe("agentcore-harness");
    expect(r.body.request.harnessName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(r.body.skipped.some((s: { artifact: string }) => s.artifact === "review")).toBe(true); // local skill skipped
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run gem.controller`
Expected: FAIL — `agentcore-managed` not in the registry.

- [ ] **Step 3: Add the registry entry**

In `src/gem/deploy.ts`, add the import and the entry (replace the `} as Record<...>` placeholder close from Task 1 with the real entry):

```ts
import { previewAgentcorePublish, deployAgentcorePublish, agentcorePublishReady } from "./agentcorePublish.js";
```

```ts
  "agentcore-managed": {
    id: "agentcore-managed",
    label: "AgentCore Harness",
    preview: previewAgentcorePublish,
    ready: agentcorePublishReady,
    deploy: (gem, requestId) => deployAgentcorePublish(gem, requestId),
  },
```

(Remove the `as Record<DeployTargetId, DeployTarget>` cast once both keys are present.)

- [ ] **Step 4: Run tests + full suite**

Run: `npm run clean && npx vitest run gem.controller` then `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/deploy.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(agentcore): register agentcore-managed publish backend in DEPLOY_REGISTRY"
```

---

## Task 4: UI — backend selector + branched publish rendering

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: `GET /api/deploy-targets` (lists both backends), `POST /api/publish-preview` / `/api/publish` with a `target`, `GET /api/publish-ready?target=`.

- [ ] **Step 1: Add a backend selector + branch the preview render**

In `src/public/index.html`, in `renderPublish` (search for `function renderPublish`), (a) fetch `/api/deploy-targets` once and render a `<select id="deployTarget">` at the top of the managed preview; (b) send `target: deployTarget.value` in the publish-preview/publish/publish-ready fetches; (c) branch on `r.kind`:

```js
// inside renderPublish, after fetching r = publish-preview (now pass the selected target):
if (r.kind === "agentcore-harness") {
  let h = `<div class="psummary"><div class="phead"><strong>${esc(r.request.harnessName)}</strong> <span class="d">· AgentCore Harness</span></div>`;
  h += `<div class="pgroup"><h3>CreateHarness request</h3><pre class="json">${esc(JSON.stringify(r.request, null, 2))}</pre></div>`;
  h += sect("Skipped", r.skipped.map(s => row(s.artifact, s.reason)));
  h += sect("Add to a vault after publish", r.vaultSecrets.map(s => row(s.name, `${s.artifact} · ${s.location}`)));
  const ready = await (await fetch(`/api/publish-ready?target=agentcore-managed`)).json();
  h += `<div class="pgroup"><button id="publishBtn" ${ready.ready ? "" : "disabled"}>${ready.ready ? "Create AgentCore Harness" : "Publish (set AWS creds + AGENTCORE_EXECUTION_ROLE_ARN)"}</button> <span class="d" id="publishStatus"></span></div>`;
  h += `<p class="note">Creates a Bedrock AgentCore harness via CreateHarness. Local skills are skipped (the API takes git/s3 skill sources); MCP secret headers reference AgentCore Identity token-vault ARNs. Secrets are never sent.</p></div>`;
  el.innerHTML = h; return;
}
// else: existing managed-agent rendering (now reads r.payload as before).
```

Wire the `#deployTarget` change to re-run `renderPublish`, and the existing `doPublish` to send `target: document.getElementById("deployTarget")?.value || "claude-managed"`.

- [ ] **Step 2: Build + manual verify**

```bash
npm run build && PORT=4327 node dist/index.js &
```
```bash
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4327/"); wait_for_load(); time.sleep(1.2)
print("deploy-targets:", js("(async()=>JSON.stringify((await (await fetch('/api/deploy-targets')).json()).targets.map(t=>t.id)))()"))
PY
```
Expected: `deploy-targets` lists `["claude-managed","agentcore-managed"]`. Then in the UI, switch the Managed-Agents preview backend to AgentCore and confirm the CreateHarness request renders with the publish button disabled+tooltipped when AWS creds/role are unset. Stop the server when done.

- [ ] **Step 3: Unit suite + commit**

Run: `npm run clean && npx tsc -b && npx vitest run` then `npm run build`.

```bash
git add src/public/index.html
git commit -m "feat(ui): AgentCore publish backend selector + CreateHarness preview"
```

---

## Self-Review

**1. Spec coverage (spec §3 Phase 3):** DEPLOY_REGISTRY `agentcore` entry → Task 3. `preview` (pure CreateHarness payload) → Task 2. `ready()` (AWS creds + execution role) → Task 2. `deploy` via CreateHarness → Task 2 (injected client). Skills git/s3-only asymmetry (skip local + report) → Task 2. The deferred generic `DeployPreview`/`DeployResult` union → Task 1. UI → Task 4. Secret-safety asserted in Tasks 2–3.

**2. Placeholder scan:** No TBD/TODO. `ACCOUNT`/`REPLACE_WITH_HARNESS_ROLE` in `previewAgentcorePublish` are intentional output placeholders shown only when no real role env is set (the preview is informational; deploy hard-requires the real env). All code steps have complete code.

**3. Type consistency:** `DeployPreview`/`DeployResult` unions (Task 1) are imported and produced identically by `agentcorePublish.ts` (Task 2) and consumed by the controller (Task 1) + registry (Task 3); `kind` literals `"managed-agent"`/`"agentcore-harness"` match across deploy.ts, schemas.ts, agentcorePublish.ts, and the UI branch. `AgentcoreControlClient.createHarness` shape identical between the fake (tests), `realAgentcoreControlClient`, and `deployAgentcorePublish`. `harnessName` pattern identical in `harnessNameFor`, the tests, and the schema-less request.

**Open items / risk (carried):** real `CreateHarness` is only exercised against live AWS (tests use the fake client) — same documented limitation as Phase 2. The `@aws-sdk/client-bedrock-agentcore-control` version may need adjusting to whatever the registry actually publishes. `executionRoleArn` must be a role the caller's account owns — surfaced via `ready()` + the disabled-button tooltip.
