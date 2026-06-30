# GEM_TYPES Extension Point + Cuts (Gem Contributions #3) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — third subsystem of [Gem Contributions vision](2026-06-30-gem-contributions-vision-design.md)

## Goal

Give every gem a **cut** — an author-set intent label (`setup | kit | skill | integration | guide | playbook`) with a signature gemstone color — stored additively on the registry. Built on an **AgentBack DI extension point (`GEM_TYPES`)** so the cut vocabulary is extensible (built-ins ship registered; plugins can register more). At publish, the cut defaults from a `derive(gem)` classifier and the author may override. Backend only; the faceted browse UI that *renders* color + rating is subsystem #5.

## Context (ground-truth)

- The registry's discovery block is `RegistryItemDiscovery` (`packages/distribute/src/registry.ts:13`) — `description?, tags?, author?, artifactKinds?, updatedAt?`. **No `type`/`cut` field yet.** Built at publish by `buildDiscovery(gem, scope, opts)` (line 203); set into the index by `updateIndex`/`publishGem`.
- Publish inputs: `RegistryPublishInput` (`src/gem.tools.ts:25`, the `registry_publish` MCP tool) and `RegistryPublishRequestSchema` (`src/schemas.ts:744`, `POST /api/registry/publish`). Both currently carry `{workspace, scope, name?, version, dependencies?, description?, tags?}` and call `publishGem({... description, tags})`.
- **Derive signal:** a `SkillArtifact.source === "distilled-draft"` marks a session-distilled skill (`packages/capture/src/draftStage.ts:35`), and `source` **survives** the archive round-trip (`packages/archive/src/archive.ts:102,176`) — so a published gem still carries it. `GemArtifact` kinds: `skill | mcp_server | instructions | hook | channel`. (Caveat: distilled **lessons** are `instructions` with no `source`, so a lessons-only Playbook isn't auto-detectable — author override covers it.)
- **Pattern precedent:** the repo's pluggable specs (`TARGET_REGISTRY`, `packages/model/src/targets.ts:855`) are plain object maps; there is **zero** app-level AgentBack extension-point usage. This subsystem deliberately establishes the first DI extension point (user decision) — see Risks.
- `@agentgem/distribute` is a **pure** package (no DI container). So `derive` runs in the app layer (controller/tool, which has the DI context); only the resulting `type` **string** crosses into `distribute`.
- The marketplace consumes `RegistryGem` via `mapIndexToGems` (`src/gem/publicCatalog.ts:16`) — where #5 will read `type`.

## The DI extension point

**Name:** `export const GEM_TYPES = "agentgem.gemTypes";`

**Spec (plain data + a pure predicate):**
```ts
export interface GemTypeSpec {
  id: string;          // the stored cut, e.g. "playbook"
  label: string;       // "Playbook"
  gemstone: string;    // "Pearl"  (the color is the marketplace's concern; carried for #5)
  order: number;       // derive precedence — lowest wins among matches
  matches(gem: Gem): boolean;  // pure; does this gem fit this cut?
}
```

**Registry service** (`@extensionPoint(GEM_TYPES)`), injecting all registered specs:
```ts
@extensionPoint(GEM_TYPES)
export class GemTypeRegistry {
  constructor(@extensions.list(GEM_TYPES) private specs: GemTypeSpec[]) {}
  all(): GemTypeSpec[] { return [...this.specs].sort((a, b) => a.order - b.order); }
  byId(id: string): GemTypeSpec | undefined { return this.specs.find((s) => s.id === id); }
  // Default classifier: the lowest-order spec whose matches() is true. "kit" (order 99,
  // matches:()=>true) is the guaranteed fallback, so derive never returns undefined.
  derive(gem: Gem): string { return this.all().find((s) => s.matches(gem))!.id; }
}
```

**Registration:** a `GemTypesComponent` binds each built-in spec as a **constant-value extension** and binds `GemTypeRegistry`. Grounded against `@agentback/core@0.5.2`: `addExtension(ctx, name, ctor)` only accepts a *class* `Constructor`, but `extensionFor(...names)` returns a `BindingTemplate` that applies to ANY binding — so a plain-object spec registers via `Binding.bind(key).to(spec).apply(extensionFor(GEM_TYPES))` (in the component's `bindings[]`), and `@extensions.list(GEM_TYPES)` resolves the array of spec objects. The app registers the component at startup (`app.component(GemTypesComponent)`). A plugin contributes a cut the same way (a constant binding tagged `extensionFor(GEM_TYPES)`) — the extensibility payoff.

**The pure core is testable without DI:** the matchers + the precedence pick are a pure function `deriveCut(specs, gem)`; `GemTypeRegistry.derive` is a thin DI wrapper over it. Tests exercise `deriveCut` directly with the built-in specs array; one DI acceptance test confirms the extension point resolves the registered specs.

## Built-in cuts (precedence order; lowest `order` wins)

| order | id | gemstone | matches(gem) — v1 heuristic |
|---|---|---|---|
| 10 | playbook | Pearl | any artifact is a skill with `source === "distilled-draft"` (session-distilled wins) |
| 20 | setup | Opal | ≥3 distinct artifact kinds (a broad whole-config snapshot) |
| 30 | integration | Sapphire | has an `mcp_server` artifact |
| 40 | guide | Topaz | every artifact is `instructions` |
| 50 | skill | Emerald | every artifact is `skill` |
| 99 | kit | Amethyst | always true (the curated-mix fallback) |

`derive` is a **default** — the author can override at publish, so the heuristic need not be perfect. Known ambiguous boundary: a broad **setup** that includes an MCP could read as `setup` (≥3 kinds) before `integration` — intentional (breadth = setup intent); the override is the escape hatch. Refine with real publish data later.

## Storage + publish threading

- **`RegistryItemDiscovery`** (`registry.ts:13`): add `type?: string`.
- **`buildDiscovery`** (`registry.ts:203`): add `type?` to its `opts`; `if (opts.type) d.type = opts.type;`. (Pure — `distribute` never derives; it stores the string it's handed.)
- **`publishGem`** args + `updateIndex`: thread `type?` from `buildDiscovery`'s opts (no behavior change beyond carrying the field).
- **Publish inputs:** add optional `type?: string` to `RegistryPublishInput` (tool) and `RegistryPublishRequestSchema` (REST).
- **The two publish handlers** (`src/gem.tools.ts:135`, `src/gem.controller.ts:780`) — the only places with the DI context — compute and validate the cut:
  ```ts
  const registry = /* resolved GemTypeRegistry from the app context */;
  const type = input.type ?? registry.derive(gem);
  if (!registry.byId(type)) throw new InvalidInputError(`unknown gem type '${type}'`); // DYNAMIC validation against registered cuts
  return publishGem({ ..., type });
  ```
  This is the extension point's keystone: the `type` is validated against *currently-registered* cuts, not a hardcoded `z.enum` — so a plugin-contributed cut is accepted without touching this code.
- **`mapIndexToGems`/`RegistryGem`** (`publicCatalog.ts`): add `type: item.discovery?.type` so #5 can read it. (`SearchHit`/`searchIndex` can gain a `type` filter dimension later — out of scope here.)

## Testing

- **`deriveCut` (pure, no DI):** a distilled-skill gem → `playbook`; a 3-kind gem → `setup`; an mcp gem → `integration`; instructions-only → `guide`; skills-only → `skill`; a mixed 2-kind gem → `kit`; precedence: a distilled gem that also has an mcp → `playbook` (order wins).
- **`GemTypeRegistry` (DI):** an acceptance test that registers the built-in component and asserts `all()` returns the 6 cuts sorted by order, `byId("playbook")` resolves, `derive(gem)` matches `deriveCut`, and an `addExtension`-contributed test cut appears in `all()` + validates at publish.
- **`buildDiscovery`:** `opts.type` lands on `discovery.type`; absent → no `type` key (additive, older readers ignore it).
- **Publish handlers:** `type` defaults from `derive` when omitted; an explicit valid `type` overrides; an unknown `type` → 400; the published index entry carries `discovery.type`. (Extend `src/gem/__tests__/registryPublish.test.ts`.)
- **`mapIndexToGems`:** surfaces `type` on `RegistryGem`.
- Gates: `pnpm test` (compiled dist) incl. the new derive/registry/publish tests.

## Out of scope

- Rendering cut color + rating in the marketplace (#5) — this only stores `type`.
- The `searchIndex` cut filter (a one-field follow-up).
- Re-classifying already-published gems (immutability — a re-publish at a new version picks up the cut).
- Backfilling `type` onto the live `@ninemind/brainstorming-kit` entry (a separate one-off re-publish).

## Risks

- **First-of-its-kind DI in a registry-shaped codebase.** Every other pluggable spec here is a plain map; this introduces the only AgentBack DI extension point. Justified by dynamic publish-time validation against registered cuts (a plain enum can't do that), and contained: DI lives only in the app layer (the registry service + the two publish handlers); `@agentgem/distribute` stays pure; the matcher logic is a pure, DI-free function. If the DI ceremony proves heavier than its worth, the same `GemTypeSpec`/`deriveCut` core drops into a plain `GEM_TYPE_REGISTRY` map with no change to the cuts or storage — the extension point is the only swappable part.
- **derive imperfection:** the setup/integration boundary is heuristic; the author override + later data-driven tuning are the mitigations. A lessons-only Playbook (instructions, no `source`) isn't auto-detected — override covers it.
- **Hot files:** `registry.ts`, `gem.controller.ts`, `gem.tools.ts`, `schemas.ts` — concurrent sessions are active; branch off latest `origin/main`, keep diffs additive, integrate promptly.
