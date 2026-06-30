# Console Publish Panel (Gem Contributions #5-publish, console half) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — subsystem A of the "handle the remaining items" set (console publish panel → marketplace upload-publish → rating telemetry)

## Goal

Give the local desktop console a **"Publish" panel** — a form to publish a saved workspace gem to the registry via the existing `POST /api/registry/publish`. Fills the documented gap (publishing currently has no UI — only the MCP tool / raw REST; the first live gem was published by a hand-run script). Local/trusted path: no session, so no `publishedBy` attribution (that's the marketplace-upload half, subsystem B). The console is the surface that *has* the built workspaces + the configured `GITHUB_TOKEN`.

## Context (ground-truth)

- **Panel registration:** `defineConsolePage({ id, title, icon?, order, group?, route, component })` (`packages/console/src/contract.ts`), each panel exports an `xPage`, added to the `ConsolePage[]` array in `packages/console/src/pages.tsx`. Groups: `observe | build | library | settings`.
- **Template:** `packages/console/src/panels/Deploy/Publish.tsx` — the closest flow (lists workspaces, ready-gates on a route, form inputs, busy/error/result states). `GetGems/index.tsx` shows the registry-ready gating pattern (`registryReadyRoute` → "not configured" message).
- **Routes** (`packages/console/src/api/routes.ts`, `defineRoute`): `registryReadyRoute` (`GET /api/registry/ready` → `{ ready }`) and `workspacesRoute` (`GET /api/workspaces` → `{ workspaces: WorkspaceSummary[] }`) already exist. **`registryPublishRoute` does NOT exist — add it**, mirroring the server's `RegistryPublishRequestSchema` (`{ workspace, scope, name?, version, dependencies?, description?, tags?, type? }`) + `RegistryPublishResponseSchema` (`{ ref, version, gemDigest, commit, path }`).
- **Cut (`type`):** the console does **not** import `@agentgem/model`, so it does not have `BUILTIN_CUTS`. **Omit `type`** in the form → the server's `resolvePublishType` derives the cut from the gem shape (`gem.controller.ts`). (A cut dropdown is a later nicety; deriving is correct + zero-duplication.)
- **Test pattern:** `packages/console/src/panels/Deploy/Publish.test.tsx` — vitest + jsdom, `vi.stubGlobal("fetch", ...)` returning `{ ok, status, text }`, ready-gate + publish-success + not-ready cases.

## Decisions (settled)

- **Local/trusted, no session** — the console talks to the local loopback server; no `publishedBy` (that's subsystem B's hosted upload path). The publish goes out with the server's `GITHUB_TOKEN`.
- **Workspace dropdown** sourced from `workspacesRoute` (publish what you've built), not a free-text field.
- **`type` omitted** → server derives the cut. No `@agentgem/model` import in the console.
- **Ready-gated** — if `AGENTGEM_REGISTRY_REPO`/`GITHUB_TOKEN` aren't configured, show a "configure the registry" message instead of the form (mirrors GetGems).
- **Group `library`, order 25** — between Your Gems (Workspaces, 20) and Get Gems (30): the download↔upload symmetry.

## Components (files)

- **`packages/console/src/api/routes.ts`** — add `registryPublishRoute = defineRoute("POST", "/api/registry/publish", { body: <mirror RegistryPublishRequestSchema>, response: <mirror RegistryPublishResponseSchema> })`.
- **`packages/console/src/panels/Publish/index.tsx`** (new) — `publishPage = defineConsolePage({ id:"publish", title:"Publish", icon:"⇧", order:25, group:"library", route:"#/publish", component })` + the `RegistryPublish({ apiBase })` form component:
  - on mount: `registryReadyRoute` → `ready`; `workspacesRoute` → the workspace list.
  - `ready === null` → Loading; `!ready` → "Registry not configured — set AGENTGEM_REGISTRY_REPO + GITHUB_TOKEN."
  - form: workspace `<select>` (from workspaces), `scope`, `name` (optional), `version` (default "1.0.0"), `tags` (csv → array), `description` (optional). Publish disabled until `workspace && scope && version`.
  - submit → `registryPublishRoute.call(...)` → `result` shows "Published `{ref}@{version}` → `{path}`"; `error` shows the message; `busy` disables.
- **`packages/console/src/pages.tsx`** — import `publishPage` + add it to the `pages` array (after `workspacesPage`).
- **`packages/console/src/panels/Publish/index.test.tsx`** (new) — mirror `Deploy/Publish.test.tsx`.

(Reuse existing console CSS classes — `ledger-bar`/`ledger-error`/`ws-note`/`obs-*` — no new design system; the impeccable console styling already covers form rows. A minimal new class only if needed.)

## Testing

- **Ready-gate:** `registry/ready` → `{ ready: false }` → renders the "not configured" message, no form.
- **Publish happy path:** `registry/ready` → `{ ready: true }`, `workspaces` → one workspace; select it + fill scope/version; click Publish; `registry/publish` stub → `{ ref:"@me/x", version:"1.0.0", ... }` → asserts the success line shows `@me/x`.
- **Error path:** `registry/publish` → non-ok / throws → asserts the error message renders + the form is re-enabled.
- **Disabled-until-valid:** Publish button disabled with no workspace/scope.
- Gates: `pnpm --filter @agentgem/console test | typecheck | build`.

## Out of scope

- Session/attribution (`publishedBy`) — the marketplace **upload-publish** path (subsystem B) carries the session; the local console is trusted.
- A cut (`type`) dropdown — server derives it; a dropdown is a later nicety.
- Scope-ownership enforcement (#4b, deferred).
- Building/exporting a gem — the panel publishes an already-saved **workspace** (built via Curate/Materialize).

## Risks

- **No registry configured locally** — the common case for a fresh user; the ready-gate handles it with a clear message (not a broken form).
- **Immutability** — re-publishing the same `@scope/name@version` with identical content is a no-op; changed content at the same version throws (the server's immutability guard). The error path surfaces the server message verbatim, so the user sees "already published and immutable" → bump the version.
- **Hot file** — `pages.tsx` + `routes.ts` are concurrently active; additive diffs (one import + one array entry; one route def).
