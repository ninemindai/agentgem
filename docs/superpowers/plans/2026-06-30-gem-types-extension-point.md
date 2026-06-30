# GEM_TYPES Extension Point + Cuts (Gem Contributions #3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every gem a `type` (cut) — author-set or `derive`-defaulted — stored on the registry, governed by an AgentBack DI extension point so the cut vocabulary is extensible.

**Architecture:** A pure core (`GemTypeSpec` + `BUILTIN_CUTS` + `deriveCut`) in `@agentgem/model`. A DI extension point in the app layer (`@extensionPoint(GEM_TYPES)` `GemTypeRegistry` resolving `@extensions.list()`, a `GemTypesComponent` registering the 6 built-in cuts as constant extensions, and a `defaultGemTypeRegistry` for the non-DI/test path). `@agentgem/distribute` stays pure — it only stores a `type` string. The publish handlers (container-resolved, so constructor `@inject` fires) compute `type = input.type ?? registry.derive(gem)`, validate it against registered cuts, and thread it to `publishGem`.

**Tech Stack:** TypeScript ESM (`.js` relative imports), Zod, `@agentback/core` (DI: `injectable`/`inject`/`extensionPoint`/`extensions`/`extensionFor`, `Binding`), `@agentback/openapi` REST, vitest. Spec: `docs/superpowers/specs/2026-06-30-gem-types-extension-point-design.md`.

## Global Constraints

- **Base branch:** `feat/gem-types`, already cut from `origin/main` (`89bd08d`). Do not re-cut.
- **Git identity:** commits authored `Raymond Feng <raymond@ninemind.ai>`; end every message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly (`git add`); verify `git show --stat HEAD`.
- **ESM:** relative imports use `.js`; package imports extensionless. New `@agentgem/model` exports flow through `packages/model/src/index.ts` (add `export * from "./gemTypes.js";`).
- **Tests run from compiled `dist/`:** `pnpm exec tsc -b` before `pnpm exec vitest run dist/...`. New tests live in `src/gem/__tests__/`.
- **First DI extension point in the repo** (deliberate — see spec Risks). The pure matcher logic (`deriveCut`) is DI-free and carries the test weight; one DI acceptance test proves the extension point resolves.
- **Cut ids (exact):** `playbook, setup, integration, guide, skill, kit`. Gemstones: Pearl, Opal, Sapphire, Topaz, Emerald, Amethyst. Derive precedence (lowest `order` wins): playbook 10, setup 20, integration 30, guide 40, skill 50, kit 99.
- **`distribute` stays pure** — never imports DI or derives; it stores the `type` string it's handed.
- **Surgical / hot files:** `registry.ts`, `gem.controller.ts`, `gem.tools.ts`, `schemas.ts` are concurrently active — additive diffs only, no reformatting.

---

### Task 1: Pure core — `GemTypeSpec`, `BUILTIN_CUTS`, `deriveCut` (`@agentgem/model`)

**Files:**
- Create: `packages/model/src/gemTypes.ts`
- Modify: `packages/model/src/index.ts` (add `export * from "./gemTypes.js";`)
- Test: `src/gem/__tests__/gemTypes.test.ts` (create)

**Interfaces:**
- Consumes: `Gem`, `GemArtifact` (`./types.js`).
- Produces:
  - `interface GemTypeSpec { id: string; label: string; gemstone: string; order: number; matches(gem: Gem): boolean }`
  - `const BUILTIN_CUTS: GemTypeSpec[]` (the 6 cuts)
  - `function deriveCut(specs: GemTypeSpec[], gem: Gem): string` — the lowest-`order` spec whose `matches` is true (kit is the guaranteed fallback).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/gemTypes.test.ts`:

```ts
// src/gem/__tests__/gemTypes.test.ts
import { describe, it, expect } from "vitest";
import { BUILTIN_CUTS, deriveCut } from "@agentgem/model";
import type { Gem, GemArtifact } from "@agentgem/model";

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "g", createdFrom: "t", artifacts, checks: [], requiredSecrets: [] });
const skill = (name: string, source = "standalone"): GemArtifact => ({ type: "skill", name, source, content: "x" });
const mcp = (name: string): GemArtifact => ({ type: "mcp_server", name, transport: "stdio", config: {} });
const instr = (name: string): GemArtifact => ({ type: "instructions", name, content: "x" });
const hook = (name: string): GemArtifact => ({ type: "hook", name, event: "PreToolUse", config: {} });

const d = (g: Gem) => deriveCut(BUILTIN_CUTS, g);

describe("deriveCut", () => {
  it("playbook — a session-distilled skill (source distilled-draft) wins over everything", () => {
    expect(d(gem([skill("s", "distilled-draft"), mcp("m")]))).toBe("playbook"); // also has mcp, but playbook is order 10
  });
  it("setup — ≥3 distinct artifact kinds", () => {
    expect(d(gem([skill("s"), instr("i"), hook("h")]))).toBe("setup");
  });
  it("integration — has an mcp_server (and <3 kinds)", () => {
    expect(d(gem([mcp("m"), instr("i")]))).toBe("integration");
  });
  it("guide — only instructions", () => {
    expect(d(gem([instr("a"), instr("b")]))).toBe("guide");
  });
  it("skill — only skills (non-distilled)", () => {
    expect(d(gem([skill("a"), skill("b")]))).toBe("skill");
  });
  it("kit — a mixed 2-kind bundle (the fallback)", () => {
    expect(d(gem([skill("a"), instr("b")]))).toBe("kit");
  });
  it("kit — an empty gem falls back", () => {
    expect(d(gem([]))).toBe("kit");
  });
});

describe("BUILTIN_CUTS", () => {
  it("has the 6 cuts with stable ids, gemstones, and ascending order", () => {
    expect(BUILTIN_CUTS.map((c) => c.id)).toEqual(["playbook", "setup", "integration", "guide", "skill", "kit"]);
    expect(BUILTIN_CUTS.find((c) => c.id === "playbook")!.gemstone).toBe("Pearl");
    expect(BUILTIN_CUTS.find((c) => c.id === "kit")!.gemstone).toBe("Amethyst");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemTypes.test.js`
Expected: FAIL — `BUILTIN_CUTS`/`deriveCut` not exported.

- [ ] **Step 3: Implement `gemTypes.ts`**

Create `packages/model/src/gemTypes.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/gemTypes.ts
//
// A gem's "cut": an author-set intent label with a signature gemstone. Pure data +
// a default classifier. The DI extension point (GemTypeRegistry) lives in the app
// layer and resolves a set of these specs; this module has no DI dependency so the
// classifier stays trivially testable and @agentgem/model stays pure.
import type { Gem } from "./types.js";

export interface GemTypeSpec {
  id: string;          // the stored cut, e.g. "playbook"
  label: string;       // "Playbook"
  gemstone: string;    // "Pearl" — the color is the marketplace's concern (subsystem #5)
  order: number;       // derive precedence — lowest matching wins
  matches(gem: Gem): boolean;
}

const kindsOf = (gem: Gem) => new Set(gem.artifacts.map((a) => a.type));

// Order matters: a session-distilled gem is a Playbook even if it also has an MCP;
// breadth (≥3 kinds) reads as a whole-config Setup before the mcp→Integration rule.
// `kit` is the guaranteed fallback (matches everything).
export const BUILTIN_CUTS: GemTypeSpec[] = [
  { id: "playbook", label: "Playbook", gemstone: "Pearl", order: 10,
    matches: (g) => g.artifacts.some((a) => a.type === "skill" && a.source === "distilled-draft") },
  { id: "setup", label: "Setup", gemstone: "Opal", order: 20,
    matches: (g) => kindsOf(g).size >= 3 },
  { id: "integration", label: "Integration", gemstone: "Sapphire", order: 30,
    matches: (g) => kindsOf(g).has("mcp_server") },
  { id: "guide", label: "Guide", gemstone: "Topaz", order: 40,
    matches: (g) => g.artifacts.length > 0 && g.artifacts.every((a) => a.type === "instructions") },
  { id: "skill", label: "Skill", gemstone: "Emerald", order: 50,
    matches: (g) => g.artifacts.length > 0 && g.artifacts.every((a) => a.type === "skill") },
  { id: "kit", label: "Kit", gemstone: "Amethyst", order: 99, matches: () => true },
];

// The default classifier: the lowest-order spec whose matches() is true. With `kit`
// (matches:()=>true) present, this never returns undefined.
export function deriveCut(specs: GemTypeSpec[], gem: Gem): string {
  return [...specs].sort((a, b) => a.order - b.order).find((s) => s.matches(gem))!.id;
}
```

Add to `packages/model/src/index.ts` (with the other `export *` lines):

```ts
export * from "./gemTypes.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemTypes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/gemTypes.ts packages/model/src/index.ts src/gem/__tests__/gemTypes.test.ts
git commit -m "feat(model): GemTypeSpec + BUILTIN_CUTS + deriveCut (pure cut classifier)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: DI extension point — `GemTypeRegistry` + `GemTypesComponent` (app layer)

**Files:**
- Create: `src/gem/gemTypeRegistry.ts`
- Modify: `src/index.ts` (add `app.component(GemTypesComponent);`)
- Test: `src/gem/__tests__/gemTypeRegistry.test.ts` (create)

**Interfaces:**
- Consumes: `GemTypeSpec`, `BUILTIN_CUTS`, `deriveCut` (`@agentgem/model`); `Gem` (`@agentgem/model`); `injectable`, `extensionPoint`, `extensions`, `extensionFor`, `Binding`, `Component` (`@agentback/core`).
- Produces:
  - `const GEM_TYPES = "agentgem.gemTypes"`
  - `class GemTypeRegistry` — `all(): GemTypeSpec[]`, `byId(id): GemTypeSpec | undefined`, `derive(gem: Gem): string`.
  - `class GemTypesComponent` (registers built-in cuts + the registry).
  - `const defaultGemTypeRegistry = new GemTypeRegistry(BUILTIN_CUTS)` — the non-DI fallback the handlers default to.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/gemTypeRegistry.test.ts`. Test the registry's behavior directly (constructed with a specs array — the same value `@extensions.list()` would inject) plus a wired-container acceptance test:

```ts
// src/gem/__tests__/gemTypeRegistry.test.ts
import { describe, it, expect } from "vitest";
import { Context } from "@agentback/core";
import { BUILTIN_CUTS, type Gem, type GemArtifact, type GemTypeSpec } from "@agentgem/model";
import { GEM_TYPES, GemTypeRegistry, GemTypesComponent, defaultGemTypeRegistry } from "../gemTypeRegistry.js";

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "g", createdFrom: "t", artifacts, checks: [], requiredSecrets: [] });

describe("GemTypeRegistry (direct)", () => {
  const r = new GemTypeRegistry(BUILTIN_CUTS);
  it("all() returns cuts sorted by order; byId resolves; derive matches deriveCut", () => {
    expect(r.all().map((c) => c.id)).toEqual(["playbook", "setup", "integration", "guide", "skill", "kit"]);
    expect(r.byId("playbook")?.gemstone).toBe("Pearl");
    expect(r.byId("nope")).toBeUndefined();
    expect(r.derive(gem([{ type: "mcp_server", name: "m", transport: "stdio", config: {} }]))).toBe("integration");
  });
  it("defaultGemTypeRegistry carries the built-ins", () => {
    expect(defaultGemTypeRegistry.all().length).toBe(6);
  });
});

describe("GEM_TYPES extension point (wired container)", () => {
  it("resolves the built-in cuts AND a plugin-contributed cut via the container", async () => {
    const ctx = new Context("test");
    const comp = new GemTypesComponent();
    for (const b of comp.bindings ?? []) ctx.add(b);
    for (const s of comp.services ?? []) ctx.service(s as never);
    // a plugin contributes a cut the same way — a constant binding tagged for GEM_TYPES
    const pluginCut: GemTypeSpec = { id: "starter", label: "Starter", gemstone: "Garnet", order: 25, matches: () => false };
    const { Binding } = await import("@agentback/core");
    const { extensionFor } = await import("@agentback/core");
    ctx.add(Binding.bind("gemTypes.cut.starter").to(pluginCut).apply(extensionFor(GEM_TYPES)));
    const registry = await ctx.get<GemTypeRegistry>("services.GemTypeRegistry");
    expect(registry.byId("starter")?.label).toBe("Starter");
    expect(registry.all().map((c) => c.id)).toContain("playbook");
  });
});
```

*Note:* the exact `ctx.service(...)` / binding-key for `GemTypeRegistry` (`"services.GemTypeRegistry"`) and how a `Component`'s `services`/`bindings` are added to a `Context` should mirror the framework's own component-mounting (check `@agentback/core`'s `Application.component` / `mountComponent` in dist, and how `app.service()` keys a service binding). Adjust the container-wiring lines to the real API if they differ — the *assertions* (built-ins + a plugin cut both resolve through the registry) are the contract.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemTypeRegistry.test.js`
Expected: FAIL — `gemTypeRegistry.js` does not exist.

- [ ] **Step 3: Implement `gemTypeRegistry.ts`**

Create `src/gem/gemTypeRegistry.ts`. Mirror `MCPComponent`'s `this.bindings = [Binding.bind(KEY).to(value)]` pattern (the closest precedent), adding `.apply(extensionFor(GEM_TYPES))` to tag each cut as an extension:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/gemTypeRegistry.ts
//
// The GEM_TYPES DI extension point: the cut vocabulary (built-ins + any plugin-
// contributed cuts) resolved through the container. The pure spec data + classifier
// live in @agentgem/model; this is the DI wiring. The publish handlers inject the
// registry to derive + validate a gem's cut at publish; non-DI callers (tests) use
// defaultGemTypeRegistry. First app-level extension point in the repo (see spec).
import { injectable, extensionPoint, extensions, extensionFor, Binding, type Component } from "@agentback/core";
import { BUILTIN_CUTS, deriveCut, type GemTypeSpec } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

export const GEM_TYPES = "agentgem.gemTypes";

@extensionPoint(GEM_TYPES)
export class GemTypeRegistry {
  constructor(@extensions.list(GEM_TYPES) private specs: GemTypeSpec[]) {}
  all(): GemTypeSpec[] { return [...this.specs].sort((a, b) => a.order - b.order); }
  byId(id: string): GemTypeSpec | undefined { return this.specs.find((s) => s.id === id); }
  derive(gem: Gem): string { return deriveCut(this.specs, gem); }
}

// Register the built-in cuts as constant-value extensions + the registry service.
// A plugin contributes a cut the same way: a constant binding tagged extensionFor(GEM_TYPES).
@injectable()
export class GemTypesComponent implements Component {
  bindings = BUILTIN_CUTS.map((spec) =>
    Binding.bind(`gemTypes.cut.${spec.id}`).to(spec).apply(extensionFor(GEM_TYPES)));
  services = [GemTypeRegistry];
}

// The non-DI fallback for callers that aren't container-resolved (tests; defensive
// default in the publish handlers). Built directly from the built-ins.
export const defaultGemTypeRegistry = new GemTypeRegistry(BUILTIN_CUTS);
```

Add to `src/index.ts` right after `app.component(MCPComponent);` (line ~66):

```ts
  app.component(GemTypesComponent);
```
(import `GemTypesComponent` from `./gem/gemTypeRegistry.js` at the top.)

**Verify before running:** confirm `@agentback/core` exports `injectable`, `extensionPoint`, `extensions`, `extensionFor`, `Binding`, `Component`, `Context` (it re-exports `@agentback/context`). If `Component` is a type-only export, use `import type { Component }`. If `extensions.list` requires a different call form, match `@agentback/core`'s `extension-point.d.ts` (`extensions.list(GEM_TYPES)`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemTypeRegistry.test.js`
Expected: PASS. If the container-wiring lines need API adjustment (Step 1 note), fix them until the two resolution assertions pass; do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add src/gem/gemTypeRegistry.ts src/index.ts src/gem/__tests__/gemTypeRegistry.test.ts
git commit -m "feat(gem): GEM_TYPES DI extension point + GemTypeRegistry + component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: store `type` on the registry discovery block (`@agentgem/distribute`, pure)

**Files:**
- Modify: `packages/distribute/src/registry.ts` (`RegistryItemDiscovery`, `buildDiscovery`, `publishGem`)
- Test: `src/gem/__tests__/registryPublish.test.ts` (extend the existing discovery assertion)

**Interfaces:**
- Consumes: nothing new (pure string threading).
- Produces: `RegistryItemDiscovery.type?: string`; `buildDiscovery`'s `opts` gains `type?: string`; `publishGem`'s args gain `type?: string` (passed into `buildDiscovery`).

- [ ] **Step 1: Write the failing test**

Read `src/gem/__tests__/registryPublish.test.ts` and find the test that publishes a gem and asserts `discovery` via `toMatchObject`. Add a `type` to the publish call and assert it lands. Append a focused test (or extend the existing one) — exact shape depends on the file's helpers; the assertion to add:

```ts
  it("stores the gem type (cut) on the discovery block when supplied", async () => {
    // mirror the existing publish-a-gem setup in this file (index, publisher, gem)
    const res = await publishGem({ /* ...existing args... */, type: "integration" });
    // re-read the index entry the test already inspects:
    const disc = nextIndex.items[res.ref].discovery; // however the existing test reaches the discovery
    expect(disc?.type).toBe("integration");
  });
```

*Note:* match the existing test's mechanics (how it builds `publishGem` args + reads the resulting index — some tests capture the `putCommit` files, others call `updateIndex`). Reuse that exact harness; only add `type` to the input and assert it on the output discovery.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`
Expected: FAIL — `type` is not accepted / not stored.

- [ ] **Step 3: Implement**

In `packages/distribute/src/registry.ts`:

Add `type?` to `RegistryItemDiscovery` (line ~13):
```ts
export interface RegistryItemDiscovery {
  description?: string;
  tags?: string[];
  author?: string;
  artifactKinds?: string[];
  updatedAt?: string;
  type?: string;        // the gem's cut (setup/kit/skill/integration/guide/playbook + plugin cuts)
}
```

Extend `buildDiscovery` (line ~203) — add `type?` to opts and set it:
```ts
export function buildDiscovery(
  gem: Gem, scope: string, opts: { description?: string; tags?: string[]; updatedAt?: string; type?: string } = {},
): RegistryItemDiscovery {
  // ...unchanged body...
  if (opts.type) d.type = opts.type;     // add this before `return d;`
  return d;
}
```

Thread through `publishGem` (line ~236): add `type?: string` to its args object, and pass it into the `buildDiscovery(...)` call inside `publishGem` (find the `buildDiscovery(args.gem, args.scope, { description: ..., tags: ..., updatedAt: ... })` call and add `type: args.type`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`
Expected: PASS (new + existing discovery assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/distribute/src/registry.ts src/gem/__tests__/registryPublish.test.ts
git commit -m "feat(distribute): store gem type (cut) on the registry discovery block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: publish handlers derive/validate `type`; surface it on `RegistryGem`

**Files:**
- Modify: `src/schemas.ts` (`RegistryPublishRequestSchema` gains `type?`)
- Modify: `src/gem.tools.ts` (`RegistryPublishInput` gains `type?`; inject registry; derive/validate/pass)
- Modify: `src/gem.controller.ts` (inject registry into `GemController`; derive/validate/pass in `registryPublish`)
- Modify: `src/gem/publicCatalog.ts` (`RegistryGem.type` + `mapIndexToGems`)
- Test: `src/gem/__tests__/registryPublishType.test.ts` (create) + extend `publicCatalog` test if one exists

**Interfaces:**
- Consumes: `GemTypeRegistry`, `defaultGemTypeRegistry` (Task 2); `inject` (`@agentback/core`); `InvalidInputError` (already used in the controller); existing `publishGem` (now accepts `type`, Task 3).
- Produces: both publish inputs accept `type?`; the handlers compute `type = input.type ?? registry.derive(gem)`, validate via `registry.byId`, pass to `publishGem`; `RegistryGem.type?: string` + populated by `mapIndexToGems`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/registryPublishType.test.ts`. Drive the controller's `registryPublish` (zero-arg `new GemController()` → uses `defaultGemTypeRegistry`). The publish needs a configured registry source + a workspace; mirror how `src/gem/__tests__/registryPublish.test.ts` or the controller test sets up the registry source + workspace (env `AGENTGEM_REGISTRY_REPO` + `GITHUB_TOKEN` or an injected source — follow the existing controller publish test's harness). Assertions:

```ts
// src/gem/__tests__/registryPublishType.test.ts
import { describe, it, expect } from "vitest";
import { mapIndexToGems } from "../publicCatalog.js";
import type { RegistryIndex } from "@agentgem/distribute";

describe("mapIndexToGems — type", () => {
  it("surfaces discovery.type as RegistryGem.type", () => {
    const index: RegistryIndex = { formatVersion: 1, items: {
      "@a/x": { latest: "1.0.0", versions: { "1.0.0": { path: "p", gemDigest: "sha256:d", dependencies: [] } },
        discovery: { author: "a", artifactKinds: ["mcp_server"], type: "integration" } },
    } };
    expect(mapIndexToGems(index)[0].type).toBe("integration");
  });
});
```

Plus a handler-level test asserting derive-default + unknown-type-400. If the publish handler can't be unit-driven without a live GitHub publisher, assert the validation seam directly instead: that `defaultGemTypeRegistry.derive(gem)` + `byId` is what the handler uses (extract the `resolvePublishType(registry, input.type, gem)` helper below and unit-test IT):

```ts
import { defaultGemTypeRegistry } from "../gemTypeRegistry.js";
import { resolvePublishType } from "../gemTypeRegistry.js"; // small pure helper (Step 3)

it("defaults the type from derive when omitted, and rejects an unknown type", () => {
  const g = { name: "g", createdFrom: "t", artifacts: [{ type: "mcp_server", name: "m", transport: "stdio", config: {} }], checks: [], requiredSecrets: [] } as never;
  expect(resolvePublishType(defaultGemTypeRegistry, undefined, g)).toBe("integration");
  expect(resolvePublishType(defaultGemTypeRegistry, "skill", g)).toBe("skill"); // valid override
  expect(() => resolvePublishType(defaultGemTypeRegistry, "bogus", g)).toThrow(/unknown gem type/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublishType.test.js`
Expected: FAIL — `RegistryGem.type` / `resolvePublishType` not present.

- [ ] **Step 3: Implement**

Add a small pure helper to `src/gem/gemTypeRegistry.ts` (keeps the derive+validate logic testable + shared by both handlers):
```ts
import { InvalidInputError } from "@agentgem/model";  // add to the existing model import
// ... after the registry class ...
export function resolvePublishType(registry: GemTypeRegistry, supplied: string | undefined, gem: Gem): string {
  const type = supplied ?? registry.derive(gem);
  if (!registry.byId(type)) throw new InvalidInputError(`unknown gem type '${type}'`);
  return type;
}
```
*(Confirm `InvalidInputError` is exported from `@agentgem/model` — it's used in `gem.controller.ts`; match that import source.)*

`src/schemas.ts` — add to `RegistryPublishRequestSchema` (line ~744):
```ts
  type: z.string().optional(),
```

`src/gem.tools.ts` — add `type` to `RegistryPublishInput` (line 25): `type: z.string().optional()`. Give `GemTools` a constructor injecting the registry (container-resolved service; default for non-DI), import `inject` + the registry:
```ts
import { inject } from "@agentback/core";
import { GemTypeRegistry, defaultGemTypeRegistry, resolvePublishType } from "./gem/gemTypeRegistry.js";
// in the class:
constructor(@inject(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry) {}
```
In `registryPublish` (line 135), after `const gem = readGemArchive(...)`:
```ts
    const type = resolvePublishType(this.gemTypes, input.type, gem);
    return publishGem({ ...existing args..., type });
```

`src/gem.controller.ts` — `GemController` currently has no constructor. Add one (all-defaulted, so `new GemController()` in tests still works):
```ts
import { inject } from "@agentback/core";
import { GemTypeRegistry, defaultGemTypeRegistry, resolvePublishType } from "./gem/gemTypeRegistry.js";
// first member of the class:
constructor(@inject(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry) {}
```
In `registryPublish` (line ~780), after `const gem = readGemArchive(...)`:
```ts
    const type = resolvePublishType(this.gemTypes, input.body.type, gem);
    return publishGem({ ...existing args..., type });
```

`src/gem/publicCatalog.ts` — add `type?: string` to `RegistryGem` (line ~6) and `type: item.discovery?.type,` to `mapIndexToGems` (after `artifactKinds`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublishType.test.js dist/__tests__/gem.controller.test.js`
Expected: PASS — the new type tests + the existing controller suite (confirms the added constructor didn't break `new GemController()`).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/gem.tools.ts src/gem.controller.ts src/gem/gemTypeRegistry.ts src/gem/publicCatalog.ts src/gem/__tests__/registryPublishType.test.ts
git commit -m "feat(api): derive + validate gem type at publish; surface on RegistryGem

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- `pnpm exec tsc -b` clean.
- Feature tests pass: `pnpm exec vitest run dist/gem/__tests__/gemTypes.test.js dist/gem/__tests__/gemTypeRegistry.test.js dist/gem/__tests__/registryPublish.test.js dist/gem/__tests__/registryPublishType.test.js`.
- Full root suite (`pnpm build` first, then `pnpm test`) — green except the known real-FS scan flakes; confirm `gem.controller.test.js` (the `new GemController()` path) is unbroken by the added constructor.

## The result this delivers

Every published gem carries a `type` (cut): defaulted by `derive(gem)` (Playbook for session-distilled, Integration for MCP, …) and author-overridable, **validated dynamically against the registered cut vocabulary** (built-ins + any plugin-contributed cut) via the `GEM_TYPES` DI extension point. `@agentgem/distribute` stays pure (stores a string); `RegistryGem.type` is ready for the subsystem-#5 marketplace to render as a gemstone color. Adding a new cut = registering one more `GemTypeSpec` extension — no core change.
