# agentgem — Deploy Registry: generalize publish.ts into a DeployTarget registry (Design)

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Refactor the Anthropic-specific publish path into a `DEPLOY_REGISTRY` of `DeployTarget { preview, ready, deploy }`, mirroring `TARGET_REGISTRY`. Decouples the controller from a single backend and makes "add a deploy backend" a one-entry change. **Structural only** — the single real backend (`claude-managed`) keeps its existing Anthropic-typed preview/result shapes; the *generic* payload/result schema is deliberately deferred until a 2nd backend (Bedrock) exists, so the abstraction is validated by a real second case rather than guessed.

---

## 0. Motivation

`materialize` is registry-driven (`TARGET_REGISTRY`); `publish` is not. The controller reaches directly into Anthropic specifics — `renderManagedAgent`, `publishManagedAgent`, `anthropicPublishClient`, and an inline `ANTHROPIC_API_KEY` gate — across three ops (`/publish-preview`, `/publish-ready`, `/publish`). That coupling is the thing standing between "we support Claude Managed Agents" and "we support N deploy backends." Extracting a `DeployTarget` registry now (a) removes backend specifics from the controller, (b) makes the readiness gate per-target, and (c) turns the gated Bedrock backend into a registry add when its API lands.

**Honest YAGNI boundary (recorded):** with only `claude-managed` real and Bedrock gated, this is a *structural* refactor, not a generic-schema generalization. A common `DeployPreview`/`DeployResult` schema would be speculative without a 2nd backend to shape it; this spec keeps the Anthropic-typed shapes and defers the union to the Bedrock follow-up.

## 1. Design decisions (locked)

1. **`DeployTarget` interface + `DEPLOY_REGISTRY`** in a new `src/gem/deploy.ts`, mirroring `TARGET_REGISTRY`. One entry: `claude-managed`.
2. **Three operations per target**, matching the existing controller surface: `preview(gem)` (pure offline render), `ready()` (server configured for this backend), `deploy(gem, requestId)` (gated network deploy with idempotency).
3. **Reuse the existing pure/network code unchanged.** `preview` = `renderManagedAgent` (`src/gem/publish.ts`); `deploy` wraps `publishManagedAgentOnce` + `publishManagedAgent` + `anthropicPublishClient` (`src/publish.ts`). No behavior change to those functions.
4. **Keep the `/publish*` routes** (backward compat — no UI churn). They route through the registry and gain an **optional** `target` (default `claude-managed`). `DeployTargetIdSchema = z.enum(Object.keys(DEPLOY_REGISTRY))` (registry-derived, like `TargetIdSchema`).
5. **Add `GET /api/deploy-targets`** — list `{ id, label, ready }` so the registry is discoverable (the UI can later offer a backend picker).
6. **Defer the generic schema.** `preview`/`deploy` keep the Anthropic-typed return shapes (`ManagedAgentRender` / `PublishResult`); the response schemas (`PublishPreviewResponseSchema`, `PublishResultSchema`) are unchanged. When Bedrock lands, these become target-discriminated unions — that's the Bedrock follow-up's job.
7. **Idempotency fingerprint becomes gem-based.** `deploy` computes the dedup fingerprint from `JSON.stringify(gem)` (the logical content) rather than the raw request body — same-gem redeploys dedupe correctly; a behavior refinement, not a regression.
8. **Secret/gating boundary unchanged.** `ready()` reads `process.env`; `deploy()` reads the key server-side, never returns it, sends only the redacted payload. Identical trust boundary to today.

## 2. The interface (`src/gem/deploy.ts`, new)

```ts
import type { Gem } from "./types.js";
import { renderManagedAgent } from "./publish.js";
import type { ManagedAgentRender } from "./publish.js";
import { publishManagedAgent, publishManagedAgentOnce, anthropicPublishClient } from "../publish.js";
import type { PublishResult } from "../publish.js";

export type DeployTargetId = "claude-managed";

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  preview(gem: Gem): ManagedAgentRender;                 // pure, offline (no network/secret)
  ready(): boolean;                                        // server configured for this backend
  deploy(gem: Gem, requestId: string): Promise<PublishResult>; // gated; throws if not ready
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

No cycle: `deploy.ts` imports `src/publish.ts` (which imports `src/gem/publish.ts`); nothing imports `deploy.ts` back.

## 3. Controller — registry-driven, backward compatible (`src/gem.controller.ts`)

| Op | REST | Change |
|----|------|--------|
| publish-preview | `POST /api/publish-preview` | add optional `target`; `DEPLOY_REGISTRY[target ?? "claude-managed"].preview(gem)` |
| publish-ready | `GET /api/publish-ready` | add optional `target` (query); `{ ready: DEPLOY_REGISTRY[target ?? "claude-managed"].ready() }` |
| publish | `POST /api/publish` | add optional `target`; drop the inline key check + Anthropic imports → `DEPLOY_REGISTRY[target ?? "claude-managed"].deploy(gem, requestId)` |
| deploy-targets *(new)* | `GET /api/deploy-targets` | `{ targets: deployTargetList() }` |

The controller loses its direct imports of `renderManagedAgent`, `publishManagedAgent`, `publishManagedAgentOnce`, `anthropicPublishClient` (moved behind the registry); it imports `DEPLOY_REGISTRY`, `deployTargetList`, `DeployTargetId`. Existing callers that omit `target` are unaffected (default `claude-managed`).

**Schemas (`src/schemas.ts`):** `DeployTargetIdSchema = z.enum(deployTargetIds)`; add optional `target: DeployTargetIdSchema.optional()` to `PublishPreviewRequestSchema`, `PublishRequestSchema`, and the publish-ready query (`PickQuerySchema` → a small `DeployReadyQuerySchema { target? }`); `DeployTargetsResponseSchema = z.object({ targets: z.array(z.object({ id: DeployTargetIdSchema, label: z.string(), ready: z.boolean() })) })`. Response shapes for preview/result unchanged.

## 4. UI (optional, minimal)

No required UI change (the single backend works as today). Optionally: the existing "Managed Agents" preview mode can call `GET /api/deploy-targets` and, if >1 target, render a backend `<select>` — deferred until a 2nd target exists. v1 ships headless registry + ops.

## 5. Module changes

- `src/gem/deploy.ts` *(new)* — `DeployTargetId`, `DeployTarget`, `DEPLOY_REGISTRY`, `deployTargetIds`, `deployTargetList`.
- `src/schemas.ts` — `DeployTargetIdSchema`, `DeployTargetsResponseSchema`, `DeployReadyQuerySchema`; optional `target` on publish-preview/publish request schemas.
- `src/gem.controller.ts` — publish ops route through `DEPLOY_REGISTRY`; new `GET /api/deploy-targets`; Anthropic imports removed.
- `src/publish.ts`, `src/gem/publish.ts` — **unchanged** (reused as-is).

## 6. Testing

- **`src/gem/__tests__/deploy.test.ts` (new, unit):**
  - `DEPLOY_REGISTRY["claude-managed"].preview(gem)` equals `renderManagedAgent(gem)` (same payload/skills/skipped).
  - `ready()` reflects `ANTHROPIC_API_KEY` (set/unset in `process.env` around the assertion).
  - `deployTargetList()` returns one entry `{ id:"claude-managed", label, ready }`.
  - `deploy(gem, id)` throws when `ANTHROPIC_API_KEY` is unset (no network).
- **Controller (`@agentback/testing`):**
  - `GET /api/deploy-targets` → one target with a boolean `ready`.
  - `POST /api/publish-preview` (no `target`, and `target:"claude-managed"`) → identical Anthropic payload; no secret value.
  - `POST /api/publish` without a key → 500 (gate via the registry); `GET /api/publish-ready` → boolean.
  - The existing publish-preview / publish-ready tests still pass unchanged (backward compat).
- **`src/__tests__/publish.network.test.ts`** — unchanged; `publishManagedAgent`/`publishManagedAgentOnce` are reused verbatim, so the mocked-client orchestration + rollback tests still hold.

## 7. Out of scope (named follow-ups)

- **Generic `DeployPreview`/`DeployResult` union schema** — when backend #2 exists; the abstraction's shape should be informed by a real 2nd case.
- **AWS Bedrock managed-agents (OpenAI/AgentCore) backend** — gated on AWS shipping the API (limited preview, no payload/SDK). When it lands: a `DEPLOY_REGISTRY["bedrock"]` entry + the union schema.
- **Local-write / file-target deployers** (write a materialized project to a folder, push to eve-cloud/Flue) — redundant with workspace `.targets/` + archive `outDir` today; revisit if a cloud push target appears.
- **UI backend picker** — until >1 target.

## 8. Platform fit

This makes the *publish* side symmetric with *materialize*: a registry the controller consumes by id, with rendering pure and deploying gated. It ships no speculative generality — one real backend, its existing shapes preserved — but converts the Anthropic-specific publish path into a seam where the gated Bedrock backend (and any future deploy target) is a single registry entry plus, at that point, a discriminated-union schema. Small now (one module + a thin op + a `target` param), with the abstraction cost paid once against the working case.
