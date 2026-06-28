# Console IA Redesign — Phase 3: Deploy stage, Library, active-Gem pin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the journey IA — promote **③ Deploy** to a real BUILD stage (Publish + run/ship the active Gem), move credentials to **⚙ Settings**, rename **Workspaces → Your Gems** in Library, absorb the standalone **Transfer** panel (Send → Materialize, Redeem → Library/Received), and add the **active-Gem pin** + **landing on Curate**.

**Architecture:** Reuse the existing components (`Publish.tsx`, `WorkspaceDeploy.tsx`) by relocating them into a new `panels/Deploy/` stage that reads the shared active-Gem store + the saved-workspaces list. The current `panels/Deploy/` (credentials) is renamed to Settings. No backend/API changes.

**Tech Stack:** React 19, TypeScript, vitest 4 + @testing-library/react. `@agentgem/console`.

## Global Constraints

- Work only in `packages/console`. No server/API changes.
- App stays green after every task: `pnpm -F @agentgem/console typecheck` + `pnpm -F @agentgem/console test`.
- Reuse existing warm-letterpress theme classes; no theme-token changes.
- The active-Gem store is `packages/console/src/activeGem.ts` (`useActiveGem`, `getKeys`, `getName`, …); `buildSelection` lives in `panels/Curate/selection.js`.
- Final BUILD group order: **Curate (10) · Materialize (20) · Deploy (30)**. LIBRARY: **Your Gems · Get Gems · Received**. Settings = footer group.
- Git author `Raymond Feng <raymond@ninemind.ai>`; commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Rename the credentials panel Deploy → Settings

The panel at `panels/Deploy/` is credentials + backend-readiness (already `group: "settings"`). Rename it to Settings and free the `#/deploy` route + "Deploy" title for the new stage in Task 2.

**Files:**
- Rename (git mv): `packages/console/src/panels/Deploy/` → `packages/console/src/panels/Settings/`
- Modify: `packages/console/src/panels/Settings/index.tsx`, `pages.tsx`, `pages.test.ts`

- [ ] **Step 1: git mv the dir**
```bash
cd packages/console/src/panels && git mv Deploy Settings
```
- [ ] **Step 2: Rename the component + page** in `Settings/index.tsx`: function `Deploy`→`Settings`; export `deployPage`→`settingsPage` with `id: "settings"`, `title: "Settings"`, `icon: "⚙"`, `order: 10`, `group: "settings"`, `route: "#/settings"`. Keep all credential/readiness logic unchanged.
- [ ] **Step 3: Rename its test** `git mv Settings/Deploy.test.tsx Settings/Settings.test.tsx` (if present); update `Deploy`→`Settings`, `#/deploy`→`#/settings`.
- [ ] **Step 4: pages.tsx** — import `settingsPage` (was `deployPage`); update the array entry.
- [ ] **Step 5: pages.test.ts** — the settings bucket id is now `["settings"]`; update the grouping assertion.
- [ ] **Step 6: Typecheck + test**: `pnpm -F @agentgem/console typecheck && pnpm -F @agentgem/console test` → green.
- [ ] **Step 7: Commit**
```bash
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -am "refactor(console): rename Deploy (credentials) panel → Settings (#/settings, ⚙)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Deploy stage ③ (Publish + run/ship the active Gem)

Create `panels/Deploy/` as a BUILD stage. Move `Publish.tsx` out of Materialize and `WorkspaceDeploy.tsx` out of Workspaces into it. Deploy operates on the active Gem (derive `selection = buildSelection(keys)`); for the web-app environments (eve/flue) that need a saved workspace, it nudges "Save to Library first" (Curate's save).

**Files:**
- Create: `packages/console/src/panels/Deploy/index.tsx`
- Move (git mv): `packages/console/src/panels/Materialize/{Publish.tsx,Publish.test.tsx}` → `packages/console/src/panels/Deploy/`
- Move (git mv): `packages/console/src/panels/Workspaces/{WorkspaceDeploy.tsx,WorkspaceDeploy.test.tsx}` → `packages/console/src/panels/Deploy/`
- Modify: `packages/console/src/panels/Materialize/index.tsx` (drop Publish), `pages.tsx`, `pages.test.ts`
- Test: `packages/console/src/panels/Deploy/Deploy.test.tsx`

**Interfaces:**
- Produces: `deployPage: ConsolePage` (id `deploy`, title `Deploy`, icon `▲`, order 30, group `build`, route `#/deploy`).
- `WorkspaceDeploy` consumes a `name` (workspace) — Deploy passes the active Gem's `name`.

- [ ] **Step 1: Move the components**
```bash
cd packages/console/src/panels
git mv Materialize/Publish.tsx Deploy/Publish.tsx; git mv Materialize/Publish.test.tsx Deploy/Publish.test.tsx
git mv Workspaces/WorkspaceDeploy.tsx Deploy/WorkspaceDeploy.tsx; git mv Workspaces/WorkspaceDeploy.test.tsx Deploy/WorkspaceDeploy.test.tsx
```
Fix cross-dir imports the moves break: any `../Curate/...` import stays valid; `Publish.tsx`/`WorkspaceDeploy.tsx` that imported `./selection.js` or `../Curate/...` repoint as needed (typecheck will list them — fix each).

- [ ] **Step 2: Write the failing Deploy test**

`packages/console/src/panels/Deploy/Deploy.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Deploy } from "./index.js";
import { setKeys, resetGem } from "../../activeGem.js";

afterEach(() => { cleanup(); resetGem(); });
const res = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as unknown as Response;

describe("Deploy", () => {
  it("nudges to Curate when nothing is selected", () => {
    render(<Deploy apiBase="" />);
    expect(screen.getByText(/curate some artifacts first/i)).toBeTruthy();
  });

  it("renders Publish + workspace-deploy when a Gem is active", async () => {
    setKeys(new Set(["skills::pdf"]));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/publish-ready")) return res({ ready: false });
      if (u.includes("/api/run-ready")) return res({ local: true, vercel: false, cloudflare: false });
      return res({});
    }));
    render(<Deploy apiBase="" />);
    expect(await screen.findByText(/Publish/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`Cannot find module './index.js'`).

- [ ] **Step 4: Write `panels/Deploy/index.tsx`**
```tsx
import { defineConsolePage } from "../../registry.js";
import { useActiveGem } from "../../activeGem.js";
import { buildSelection } from "../Curate/selection.js";
import { Publish } from "./Publish.js";
import { WorkspaceDeploy } from "./WorkspaceDeploy.js";

export function Deploy({ apiBase }: { apiBase: string }) {
  const { keys, name } = useActiveGem();
  if (keys.size === 0) {
    return <p className="ledger-empty">Curate some artifacts first — <a href="#/curate">go to Curate →</a></p>;
  }
  const sel = buildSelection(keys);
  const gemName = name.trim() || "gem";
  return (
    <div className="deploy-stage">
      <Publish apiBase={apiBase} selection={sel} name={gemName} />
      <WorkspaceDeploy apiBase={apiBase} name={gemName} />
    </div>
  );
}

export const deployPage = defineConsolePage({
  id: "deploy",
  title: "Deploy",
  icon: "▲",
  order: 30,
  group: "build",
  route: "#/deploy",
  component: ({ apiBase }) => <Deploy apiBase={apiBase} />,
});
```
*(Confirm `WorkspaceDeploy`'s prop shape — it currently takes a workspace `name`; if it requires the workspace to be saved first, render its existing "save first" affordance, or gate behind a check. Match its current props exactly.)*

- [ ] **Step 5: Remove Publish from Materialize** — delete the `Publish` import + `<Publish .../>` line from `panels/Materialize/index.tsx`. Move any Publish-specific assertion out of `Materialize.test.tsx` if present.

- [ ] **Step 6: Register Deploy; update pages** — `pages.tsx`: import `deployPage` from `./panels/Deploy/index.js`, add to the array. `pages.test.ts`: build bucket becomes `["curate","materialize","deploy"]`.

- [ ] **Step 7: Typecheck + full suite + build** → green; `pnpm build` OK.

- [ ] **Step 8: Commit**
```bash
git add -A packages/console
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): Deploy stage — Publish + run/ship the active Gem (③)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Workspaces → "Your Gems"

Rename the Workspaces panel to "Your Gems" (Library). WorkspaceDeploy already moved to Deploy (Task 2); Your Gems keeps the saved-gems list (open/render/delete).

**Files:**
- Modify: `packages/console/src/panels/Workspaces/index.tsx` (title/id) — keep the dir name `Workspaces/`
- Modify: `pages.tsx`, `pages.test.ts`

- [ ] **Step 1:** In `Workspaces/index.tsx`, change the page export: `id: "your-gems"`, `title: "Your Gems"`, `route: "#/your-gems"`, `group: "library"`, keep order. Keep the component name `Workspaces` (internal) or rename to `YourGems` — update the test accordingly. Ensure `WorkspaceDeploy` is no longer imported here (moved in Task 2); if the list rendered an inline deploy, replace with an "Open in Deploy →" link (`#/deploy`) that loads the workspace into the active Gem (set name/selection) — only if the route already supports it; otherwise leave a simple Render/Delete list.
- [ ] **Step 2:** `pages.tsx` import/rename; `pages.test.ts` library bucket id `your-gems`.
- [ ] **Step 3:** Typecheck + test → green.
- [ ] **Step 4:** Commit `feat(console): rename Workspaces → Your Gems (Library)`.

---

### Task 4: Absorb the Transfer panel (Send → Materialize, Redeem → Received)

Remove the standalone Transfer panel. Its **Send** (share-via-ticket) becomes an export action in **Materialize**; its **Redeem / Redeem-privately** become a **Received** entry in Library.

**Files:**
- Move (git mv): `packages/console/src/panels/Transfer/decrypt.ts` (+ test) → wherever Received consumes it (e.g. `panels/Received/`)
- Create: `packages/console/src/panels/Received/index.tsx` (the redeem flows, id `received`, title `Received`, group `library`, route `#/received`)
- Modify: `panels/Materialize/index.tsx` — add a "Share via transfer" export action calling `transferSendRoute` with the active selection
- Delete: `packages/console/src/panels/Transfer/index.tsx` (the standalone panel) after its flows are relocated
- Modify: `pages.tsx`, `pages.test.ts`

- [ ] **Step 1:** Create `panels/Received/index.tsx` from the Transfer panel's redeem + redeem-privately sections (reuse `decrypt.ts`, `transferReceiveRoute`/`transferCiphertextRoute`). Register `receivedPage` (library).
- [ ] **Step 2:** Add a "Share via transfer" button to Materialize's export row → `transferSendRoute.call(client, { body: buildSelectionBody(sel, name) })` → show the `agentgem://…` ticket to copy. (Mirror the Transfer panel's send logic.)
- [ ] **Step 3:** `git rm packages/console/src/panels/Transfer/index.tsx` (+ its test). Move `decrypt.ts`/`decrypt.test.ts` to `panels/Received/`.
- [ ] **Step 4:** `pages.tsx` — remove `transferPage`, add `receivedPage`. `pages.test.ts` — library bucket `["your-gems","get-gems","received"]`.
- [ ] **Step 5:** Typecheck + full suite + build → green. Confirm the private-redeem still works (the decrypt parity).
- [ ] **Step 6:** Commit `feat(console): absorb Transfer — Send→Materialize export, Redeem→Library/Received`.

---

### Task 5: Active-Gem switcher + land on Your Gems

Pin the active Gem atop the sidebar AS A SWITCHER (click → Your Gems + ＋ New Gem), and land first-time/no-active-gem on Your Gems (the picker). Opening a gem from Your Gems sets the active Gem (name + selection); the BUILD stages then operate on it.

**Files:**
- Modify: `packages/console/src/shell/Shell.tsx`, `packages/console/src/shell/theme.css`
- Modify: `packages/console/src/main.tsx` (initial hash / landing)
- Modify: `packages/console/src/panels/Workspaces/index.tsx` ("Open" sets the active Gem)
- Modify: `packages/console/src/activeGem.ts` (add `loadGem(name, keys)` if a single setter is cleaner)
- Test: extend `packages/console/src/shell/Shell.test.tsx`

- [ ] **Step 1:** Active-Gem switcher in `Shell.tsx`: a button atop the BUILD group showing the active gem (name, or "New Gem · N artifacts"). Clicking it navigates to Your Gems (`#/your-gems`) — the picker. (Import `useActiveGem`.) A full dropdown is optional; the minimum is the pinned label + click-through to the picker.
- [ ] **Step 2:** Landing: on load, if `window.location.hash` is empty, route to `#/your-gems` when there are saved gems (the picker) else `#/curate` with a fresh New Gem. (Simplest: always land on `#/your-gems`; its empty-state offers "＋ New Gem" → `#/curate`.)
- [ ] **Step 3:** "Open" in Your Gems (`Workspaces/index.tsx`) sets the active Gem — `setName(ws.name)` + `setKeys(...)` from the workspace's selection — then `window.location.hash = "#/curate"`. (If the saved workspace doesn't persist the original selection, Open at minimum sets the name + navigates; note the limitation.)
- [ ] **Step 4:** "＋ New Gem" control (in Your Gems and/or the switcher) calls `resetGem()` then `#/curate`.
- [ ] **Step 5:** Add `.console-activegem` CSS (small, muted, seal accent; hover affordance since it's clickable).
- [ ] **Step 6:** Shell test: active gem set → switcher shows its name; none → "New Gem"; empty hash → lands on Your Gems (or Curate when no saved gems).
- [ ] **Step 7:** Typecheck + full suite + build → green.
- [ ] **Step 8:** Commit `feat(console): active-Gem switcher + land on Your Gems; Open sets the active Gem`.

---

### Task 6: Curate Compose-tab polish (clear search, eye icon, sortable columns)

Three Compose-tab refinements from testing. Keep the grouped, collapsible sections; turn each section's rows into a column-aligned table with sortable headers and the action at the end.

**Files:**
- Modify: `packages/console/src/panels/Curate/index.tsx`, `packages/console/src/panels/Curate/data.ts` (per-section sort), `packages/console/src/shell/theme.css`
- Test: extend `packages/console/src/panels/Curate/Curate.test.tsx` + `data.test.ts`

- [ ] **Step 1 (clear search):** Wrap the search input in a relative container; when `view.query` is non-empty, render an `×` icon button (`aria-label="clear search"`) that sets `query: ""`. Reuse a small button styled `.ledger-search-clear`.
- [ ] **Step 2 (eye icon):** Replace the row action text `"view"/"hide"` with an eye / eye-off inline SVG (`aria-label={expanded ? "hide" : "view"}`), keep the `.ledger-view` class + toggle behavior. Move this action to the END of the row (after the count), so columns align: `[☐] name · source · uses · last-used · [eye]`.
- [ ] **Step 3 (per-section sortable columns):** Give each `LedgerGroup` its own sort. Add per-section sort state keyed by group (`Record<groupKey, {sort, dir}>`, default `{sort:"uses",dir:"desc"}`). Render a column-header row inside each section (Name · Uses · Last used) where clicking a header sets that section's sort (toggle dir on re-click); apply per-section sort in `applyView` (or a new `sortGroup(items, sort, dir)` in `data.ts`). Drop the global `Uses`/`Last used` buttons from the top bar (search + Used-only remain). Keep collapse. (Sections ARE the "type"; no per-section type sort.)
- [ ] **Step 4:** Tests — `data.test.ts`: a `sortGroup` unit covering name/uses/last asc+desc. `Curate.test.tsx`: clear-× empties the query; clicking a section's "Name" header reorders that section; the eye toggle still reveals content.
- [ ] **Step 5:** Typecheck + full suite + build → green; browser-verify column alignment + per-section sort.
- [ ] **Step 6:** Commit `feat(console): Curate Compose polish — clear search, eye icon, per-section sortable columns`.

---

## Final verification
- [ ] Sidebar: BUILD = **Curate · Materialize · Deploy**; LIBRARY = **Your Gems · Get Gems · Received**; footer **⚙ Settings**. Active-Gem pin atop BUILD; app lands on Curate.
- [ ] Deploy: empty-state nudge; Publish + run/ship work off the active Gem.
- [ ] Materialize: Export gains "Share via transfer" (ticket); Received redeems.
- [ ] No remaining refs to `panels/Transfer`, the old `deployPage` (credentials), or `Workspaces` title.
- [ ] `pnpm -F @agentgem/console typecheck` clean; tests green; `pnpm build` OK.

## Self-review (spec coverage)
- Spec "③ Deploy stage; Settings is config not a stage" → Task 1 (Settings) + Task 2 (Deploy).
- Spec "Workspaces → Your Gems" → Task 3.
- Spec "Transfer: Send→Materialize/Export, Redeem→Library/Received" → Task 4.
- Spec "active-Gem pin; land on Curate" → Task 5.
- Carry-forward Minors (Phase 1/2) remain optional polish; the gem-name↔workspace-name seam is touched by Task 2 (Deploy uses `activeGem.name || "gem"`) — confirm Curate's save names the workspace consistently.
