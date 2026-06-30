# Console Publish Panel (#5-publish, console half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Publish" panel in the local console — pick a saved workspace + scope/version → publish to the registry via `POST /api/registry/publish`.

**Architecture:** Add a console `registryPublishRoute` (mirrors the server schema); a `Publish` panel that ready-gates on `registryReadyRoute`, lists workspaces from `workspacesRoute`, and submits the form; register it in `pages.tsx` (group `library`). `type` is omitted → the server derives the cut. Local/trusted (no session → no attribution; that's subsystem B).

**Tech Stack:** React 19, `@agentback/client` (`defineRoute`/`makeClient`), vitest + jsdom (`.toBeTruthy()`/`.toBeNull()`, NO jest-dom; `vi.stubGlobal("fetch", ...)`). Spec: `docs/superpowers/specs/2026-06-30-console-publish-panel-design.md`.

## Global Constraints

- **Base branch:** `feat/console-publish`, already cut from `origin/main`. Do not re-cut.
- **Git identity:** `Raymond Feng <raymond@ninemind.ai>`; end every message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show --stat HEAD`.
- **Console ESM:** match the package's existing import style (the panels use `.js` relative imports e.g. `from "./Publish.js"`, `from "../../api/routes.js"`).
- **Commands (verbatim):** `pnpm --filter @agentgem/console test`, `pnpm --filter @agentgem/console typecheck`, `pnpm --filter @agentgem/console build`.
- **Test style:** vitest + jsdom; `.toBeTruthy()`/`.toBeNull()`; mirror `packages/console/src/panels/Deploy/Publish.test.tsx` (the `res(body)` fetch-stub helper, `vi.stubGlobal("fetch", ...)`).
- **`type` is OMITTED** from the publish body (server derives the cut; the console does NOT import `@agentgem/model`).
- **Surgical/additive** — `pages.tsx` (one import + one array entry), `routes.ts` (one route def), `pages.test.ts` (insert `"publish"` into the two expected arrays). No reformatting.

---

### Task 1: `registryPublishRoute` + the Publish panel

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `registryPublishRoute`)
- Create: `packages/console/src/panels/Publish/index.tsx` (the `RegistryPublish` form + `publishPage`)
- Test: `packages/console/src/panels/Publish/index.test.tsx` (create)

**Interfaces:**
- Consumes: `defineRoute`, `makeClient` (`../../api/routes.js` / `@agentback/client`); `registryReadyRoute`, `workspacesRoute` (existing in routes.ts); `defineConsolePage` (`../../registry.js` or `../../contract.js` — match how sibling panels import it).
- Produces: `registryPublishRoute`; `export function RegistryPublish({ apiBase })`; `export const publishPage`.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Publish/index.test.tsx` (mirror `Deploy/Publish.test.tsx`'s stub style):
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { RegistryPublish } from "./index";

afterEach(cleanup);
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const ws = [{ name: "my-gem", gemName: "my-gem", version: "1.0.0", artifactCounts: { skill: 1, mcp_server: 0, instructions: 0, hook: 0 }, artifacts: [], modifiedMs: 0, checks: 0, renderedTargets: [] }];

describe("RegistryPublish", () => {
  it("shows a 'not configured' message when the registry is not ready", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/registry/ready")) return res({ ready: false });
      if (String(url).includes("/api/workspaces")) return res({ workspaces: [] });
      throw new Error(`unexpected ${url}`);
    }));
    render(<RegistryPublish apiBase="" />);
    expect(await screen.findByText(/not configured/i)).toBeTruthy();
  });

  it("publishes a selected workspace and shows the published ref", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); calls.push(u);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/workspaces")) return res({ workspaces: ws });
      if (u.includes("/api/registry/publish")) return res({ ref: "@me/my-gem", version: "1.0.0", gemDigest: "sha256:d", commit: "abc", path: "items/me/my-gem/1.0.0" });
      throw new Error(`unexpected ${u}`);
    }));
    render(<RegistryPublish apiBase="" />);
    await screen.findByRole("option", { name: "my-gem" });          // workspaces loaded
    fireEvent.change(screen.getByLabelText(/workspace/i), { target: { value: "my-gem" } });
    fireEvent.change(screen.getByLabelText(/scope/i), { target: { value: "me" } });
    fireEvent.click(screen.getByRole("button", { name: /publish/i }));
    await waitFor(() => expect(calls.some((u) => u.includes("/api/registry/publish"))).toBe(true));
    expect(await screen.findByText(/@me\/my-gem/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/console test -- Publish/index`
Expected: FAIL — module doesn't exist / `registryPublishRoute` undefined.

- [ ] **Step 3: Implement**

`packages/console/src/api/routes.ts` — add after `registryInstallRoute` (mirror the server `RegistryPublishRequestSchema`/`ResponseSchema`; reuse the file's `z` import + `defineRoute`):
```ts
export const registryPublishRoute = defineRoute("POST", "/api/registry/publish", {
  body: z.object({
    workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(),
    dependencies: z.array(z.string()).optional(), description: z.string().optional(),
    tags: z.array(z.string()).optional(), type: z.string().optional(),
  }),
  response: z.object({ ref: z.string(), version: z.string(), gemDigest: z.string(), commit: z.string(), path: z.string() }),
});
```

Create `packages/console/src/panels/Publish/index.tsx`. Read `panels/Deploy/index.tsx` + `Deploy/Publish.tsx` first and MATCH: how it imports `defineConsolePage`, `makeClient`, the routes; the CSS classes (`ledger-bar`, `ledger-error`, `ws-note`, etc.); and the `Loading` component. Structure:
```tsx
import { useEffect, useState } from "react";
import { makeClient, registryReadyRoute, workspacesRoute, registryPublishRoute } from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js"; // match the sibling panels' actual import source
// + the Loading component import the other panels use

type Result = { ref: string; version: string; path: string };

export function RegistryPublish({ apiBase }: { apiBase: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [workspaces, setWorkspaces] = useState<{ name: string }[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [scope, setScope] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let alive = true;
    registryReadyRoute.call(makeClient(apiBase)).then((r) => { if (alive) setReady(r.ready); }).catch(() => { if (alive) setReady(false); });
    workspacesRoute.call(makeClient(apiBase)).then((r) => { if (alive) setWorkspaces(r.workspaces); }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase]);

  const publish = () => {
    setBusy(true); setError(null); setResult(null);
    registryPublishRoute.call(makeClient(apiBase), { body: {
      workspace: workspace.trim(), scope: scope.trim(), name: name.trim() || undefined, version: version.trim(),
      tags: tags.trim() ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      description: description.trim() || undefined,
    } })
      .then((r) => setResult(r))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (ready === null) return <p className="ws-note">Loading…</p>;
  if (!ready) return <p className="ws-note">Registry not configured — set AGENTGEM_REGISTRY_REPO + GITHUB_TOKEN on the server.</p>;

  return (
    <div className="publish-registry">
      <label>Workspace <select aria-label="workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
        <option value="">Select a workspace…</option>
        {workspaces.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
      </select></label>
      <label>Scope <input aria-label="scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="your-github-login-or-org" /></label>
      <label>Name <input aria-label="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="(optional — defaults from the gem)" /></label>
      <label>Version <input aria-label="version" value={version} onChange={(e) => setVersion(e.target.value)} /></label>
      <label>Tags <input aria-label="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated" /></label>
      <label>Description <input aria-label="description" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <button type="button" onClick={publish} disabled={busy || !workspace || !scope || !version}>{busy ? "Publishing…" : "Publish"}</button>
      {error && <p className="ledger-error">{error}</p>}
      {result && <p className="ws-note">Published {result.ref}@{result.version} → {result.path} ✓</p>}
    </div>
  );
}

export const publishPage = defineConsolePage({
  id: "publish", title: "Publish", icon: "⇧", order: 25, group: "library",
  route: "#/publish", component: ({ apiBase }) => <RegistryPublish apiBase={apiBase} />,
});
```
*(Match `defineConsolePage`'s real import source + the `Loading`/CSS conventions to the sibling panels. If `defineConsolePage` isn't exported from `../../registry.js`, find where the other panels import it.)*

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `pnpm --filter @agentgem/console test -- Publish/index && pnpm --filter @agentgem/console typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Publish/index.tsx packages/console/src/panels/Publish/index.test.tsx
git commit -m "feat(console): registry Publish panel + registryPublishRoute

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: register the panel in the nav

**Files:**
- Modify: `packages/console/src/pages.tsx` (import + array entry)
- Modify: `packages/console/src/pages.test.ts` (insert `"publish"` into the two expected arrays)

**Interfaces:**
- Consumes: `publishPage` (Task 1).

- [ ] **Step 1: Update the failing test first**

In `packages/console/src/pages.test.ts`, insert `"publish"` into BOTH expected arrays at the position matching `order: 25` (it sorts between `your-gems` (order 20) and `get-gems` (order 30)):
- the global `sortedPages` id array: `...,"your-gems","publish","get-gems",...`
- the `groupedPages` `library` array: `["your-gems","publish","get-gems","received"]`

(Read the file first to confirm the exact current arrays + that `your-gems`=order 20 / `get-gems`=order 30 so `publish`=25 lands between them. If the orders differ, set `publishPage.order` to land it between your-gems and get-gems and update the arrays to match.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/console test -- pages`
Expected: FAIL — `pages` doesn't yet contain `publish` (test expects it, registry doesn't have it).

- [ ] **Step 3: Implement**

In `packages/console/src/pages.tsx`: add `import { publishPage } from "./panels/Publish/index.js";` and insert `publishPage` into the `pages` array right after `workspacesPage`.

- [ ] **Step 4: Run to verify it passes + full gates**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck && pnpm --filter @agentgem/console build`
Expected: whole console suite PASS (incl. pages.test + the Publish panel test) + typecheck + build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/pages.tsx packages/console/src/pages.test.ts
git commit -m "feat(console): register the Publish panel in the library nav group

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- `pnpm --filter @agentgem/console test` (whole suite green), `typecheck`, `build` all clean.

## The result this delivers

The local console gets a **Publish** panel (library group): pick a built workspace, enter scope/version, publish to the registry — no more hand-run publish scripts. `type` is server-derived; ready-gated when the registry isn't configured. The session-attributed **marketplace upload-publish** is subsystem B.
