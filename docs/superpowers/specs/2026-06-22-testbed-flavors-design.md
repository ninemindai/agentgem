# Testbed flavors (Claude / Codex / Hermes) — design

**Status:** approved (pre-implementation)
**Date:** 2026-06-22
**Topic:** Let a testbed be authored + test-driven against a chosen harness flavor — Claude Code (existing), Codex, or Hermes — instead of Claude-only.

Relates to: [[testbed-first-onramp]] (the testbed concept this extends), [[eve-target-fast-follow]] (the registry pattern), multi-source-introspection (the global readers reused here).

---

## 1. Problem & decision

The testbed-first on-ramp made a local `.claude/` project the canonical authoring/test-drive surface, but it is **Claude-Code-only**: `introspectProject`, `scaffoldTestbed`, and the test-drive command (`cd <root> && claude`) are all hardwired to the Claude layout. agentgem already knows *other* harnesses as **import sources** (`~/.claude`, `~/.agents`, `~/.codex`, `~/.hermes`) and as **materialize/deploy targets** (8 of them) — but the authoring surface in the middle has no flavor.

**Decision:** introduce **testbed flavors** — `claude`, `codex`, `hermes` — so you can author and test-drive in the harness you actually use, then package to the same neutral Gem and ship to any target.

### Locked decisions (from brainstorming)

1. **Flavor set:** `claude` (existing), `codex`, `hermes`.
2. **Selection:** *detect, else ask.* Auto-detect the flavor from on-disk markers when unambiguous; otherwise prompt and persist the choice per-testbed.
3. **Scope (phased):** ship the flavor abstraction + flavor-aware **introspect + scaffold + run-command** for all three; **defer** the import-INTO-non-Claude writers. The neutral Gem + all downstream targets are unchanged.

### What is unchanged
Flavors affect only the authoring/test-drive surface. Packaging is still `flavor.introspect(root)` → `buildGem` → archive (a neutral, redacted Gem), and `materialize`/publish consume that Gem regardless of which harness authored it. So a Codex or Hermes testbed can still be shipped to eve / flue / openai-sandbox / agentcore / claude-managed / etc.

---

## 2. Flavor model — `TESTBED_FLAVORS` registry

New `src/gem/testbedFlavors.ts`, a peer of `TARGET_REGISTRY`:

```ts
export type TestbedFlavorId = "claude" | "codex" | "hermes";

export interface TestbedFlavor {
  id: TestbedFlavorId;
  label: string;
  detect(root: string): boolean;                          // on-disk markers identify this flavor
  introspect(root: string): ProjectInventory;             // read the project in this flavor's layout
  scaffold(root: string, name: string): { created: string[] }; // minimal runnable skeleton (idempotent)
  runCommand: string;                                     // test-drive: `cd <root> && <runCommand>`
  importSupported: boolean;                               // claude=true; codex/hermes=false (deferred)
}

export const TESTBED_FLAVORS: Record<TestbedFlavorId, TestbedFlavor>;
export function detectFlavor(root: string): TestbedFlavorId | null; // null => caller must ask
```

Each flavor's concrete shape (read · scaffold · run):

| Flavor | detect markers | introspect reads | scaffold writes | runCommand | importSupported |
|---|---|---|---|---|---|
| **claude** | `.claude/` or `CLAUDE.md` | existing `introspectProject` (`.claude/skills`, `.mcp.json`, `.claude/settings.json` hooks, `CLAUDE.md`/`AGENTS.md`) | existing skeleton (`.claude/settings.json`, `.claude/skills/`, `CLAUDE.md`, `.gitignore`) | `claude` | **true** |
| **codex** | `.codex/` or `AGENTS.md` (and no `.claude/`) | `AGENTS.md` → instructions; `.codex/skills/<n>/SKILL.md` → skills; `.codex/config.toml` `[mcp_servers]` → MCP; `.codex/rules/*` → instructions *(project-level set is an OPEN ITEM — verify, §6)* | `AGENTS.md` stub + `.codex/skills/` + `.gitignore` | `codex` | false (deferred) |
| **hermes** | `.hermes/` | `.hermes/skills/<n>/{SKILL.md,DESCRIPTION.md}` → skills; `.hermes/SOUL.md` → instructions; hermes MCP config → MCP *(project-level set is an OPEN ITEM — verify, §6)* | `.hermes/skills/` + `SOUL.md` stub + `.gitignore` | `hermes` | false (deferred) |

The **claude** entry delegates to the existing `introspectProject` / `scaffoldTestbed` so its behavior is byte-identical to today (regression-safe). Codex/Hermes reuse the shared readers already in `introspect.ts` (`readSkillsDir`, `serversToArtifacts`, `hooksFromConfig`, the rules/SOUL readers) at project scope.

---

## 3. Detection & selection (detect-else-ask)

- `detectFlavor(root)`: return the flavor whose markers match. If **exactly one** matches → that flavor. If **none or several** → return `null` (UI asks).
- Selection is **persisted per-testbed** client-side: `localStorage["agentgem.testbed"]` (path, existing) + `localStorage["agentgem.testbedFlavor"]` (id). The header chip shows the active flavor.
- On open/create: call detect; if `null`, show a 3-way flavor picker; store the result. Scaffolding a *new* testbed always uses an explicit flavor (the create flow chooses it).

---

## 4. Backend changes

- **New** `src/gem/testbedFlavors.ts` — the registry, `detectFlavor`, and the codex/hermes `introspect`/`scaffold` implementations (claude delegates to existing functions).
- **Refactor** (no behavior change for claude): `scaffoldTestbed(root, name)` → `scaffoldTestbed(root, name, flavor = "claude")` dispatching to the flavor; the controller passes the flavor.
- **Endpoints:**
  - `GET /api/testbed/detect?root=` → `{ flavor: TestbedFlavorId | null }`.
  - `POST /api/testbed/scaffold` body gains `flavor: TestbedFlavorId` (defaults `"claude"` for back-compat).
  - **Flavor-aware testbed inventory:** the UI currently reads the testbed via `GET /api/inventory?projects=[root]` (which uses the claude-shaped `introspectProject`). Add a `flavor` to that read path so the server uses `TESTBED_FLAVORS[flavor].introspect(root)` for the active testbed. (Cleanest: a dedicated `GET /api/testbed/inventory?root=&flavor=` returning a single `ProjectInventory`; the global Import modal keeps using `/api/inventory`.)
- **Packaging unchanged:** `/api/gem`, `/api/materialize`, `/api/archive`, `/api/workspaces` already take `projects` + project-namespaced `selection`. The only change is that the project inventory feeding them now comes from the flavor's `introspect`. (Implementation note: `introspectAll`/`resolveProject` may need to introspect the active testbed via its flavor rather than the hardcoded `introspectProject` — verify the seam.)

Schemas: add `TestbedFlavorIdSchema = z.enum([...keys])`; extend the scaffold request + add the detect/inventory responses.

---

## 5. UI changes

- **Create/open flow:** run `/api/testbed/detect`; if `null`, show a flavor picker (Claude / Codex / Hermes); persist. Show the flavor on the header chip.
- **Test-drive card:** command = `cd <root> && ${flavor.runCommand}` (`claude` / `codex` / `hermes`).
- **Left inventory:** loaded via the flavor-aware testbed inventory read.
- **Import from machine:** enabled only when the active flavor's `importSupported` is true (claude). For codex/hermes, the button is disabled with a note: *"Import into Codex/Hermes testbeds isn't supported yet — hand-edit the project, then it'll be picked up."* Introspect / hand-edit / package / test-drive all still work for non-Claude flavors.

---

## 6. Open items (verify, don't invent)

Like the `agentcore.json` schema item, the **project-level** conventions for Codex and Hermes must be confirmed against the real tools before finalizing those flavor entries:
- **Codex:** does it read project-scoped skills (`.codex/skills`?), project MCP (`.codex/config.toml`? or only `~/.codex`?), and what is the exact launch command/flags? agentgem knows the *global* codex shape (`~/.codex` skills/rules/config.toml) — confirm the project-level subset.
- **Hermes:** project-scoped skills dir + instructions file (`SOUL.md`? project-level?) + MCP config location + launch command.

The registry abstraction, detection/selection, claude refactor, run-command wiring, and UI are solid regardless; the codex/hermes `introspect`/`scaffold` read-sets are the parts to verify during implementation (run each tool once, like `agentcore create`).

## 7. Testing

- Per-flavor unit tests (tmp dirs): `detect` (markers), `introspect` (reads the flavor layout into a `ProjectInventory`), `scaffold` (emits the skeleton, idempotent).
- `detectFlavor` precedence: single-match → flavor; none/multi → `null`.
- **Claude regression:** the claude flavor's introspect/scaffold are identical to the pre-refactor `introspectProject`/`scaffoldTestbed` outputs.
- **Round-trip:** packaging a codex and a hermes testbed (`flavor.introspect` → `buildGem`) yields a valid neutral Gem with the expected artifacts and redacted secrets.
- Controller tests: `/api/testbed/detect`, scaffold-with-flavor, flavor-aware testbed inventory.

## 8. Out of scope

- **Import-INTO-codex/hermes** writers (the `importArtifacts` inverse for those layouts) — deferred follow-up.
- Non-{claude,codex,hermes} flavors (e.g. an `agents` flavor) — additive later.
- Changing the neutral Gem, archive, or any materialize/deploy target.
- Multiple simultaneously-active testbeds.
