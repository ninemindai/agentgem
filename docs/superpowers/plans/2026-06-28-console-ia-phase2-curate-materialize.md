# Console IA Redesign — Phase 2: Curate + Materialize stages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Ledger monolith into two journey stages — **① Curate** (inventory + select + Analyze + checks + save) and **② Materialize** (build → Preview/export, target render, test-run) — both operating on the shared active-Gem store from Phase 1. Move Analyze in from Testbed (with a per-project one-click button) and remove the Testbed panel.

**Architecture:** The active-Gem store (`activeGem.ts`, keys + name) stays the source of truth. Curate writes the selection; Materialize *derives* `selection = buildSelection(keys)` and builds the gem on demand — the store does NOT gain a `gem` field (keeps it minimal). Shared pure modules (`data.ts`, `selection.ts`) live in `panels/Curate/`; Materialize imports them. The dir `panels/Ledger/` is renamed `panels/Curate/`; a new `panels/Materialize/` holds the back-half components.

**Tech Stack:** React 19, TypeScript, vitest 4 + @testing-library/react (jsdom). `@agentgem/console` workspace.

## Global Constraints

- Work only in `packages/console`. No server/API changes.
- The app stays green and usable after every task. Run `pnpm -F @agentgem/console typecheck` and `pnpm -F @agentgem/console test` from the worktree root.
- Reuse the existing warm-letterpress theme classes (`ledger-bar`, `ledger-item`, `ledger-build`, `ledger-sort`, `targets-select`, `ws-chip`, `targets-label`, etc.). Do NOT change the visual theme tokens.
- **Cards are not for the project list** (impeccable): the per-project Analyze list uses compact rows, NOT `ws-card` cards.
- Routes: Curate at `#/curate` (replaces `#/ledger`), Materialize at `#/materialize`. Both `group: "build"`; Curate `order: 10`, Materialize `order: 20`.
- The active-Gem store is `packages/console/src/activeGem.ts` — exports `useActiveGem()`, `setKeys`, `toggleKey`, `clearKeys`, `setName`, `resetGem`, `getKeys`, `getName`, `subscribe`. Do not change it.
- Git author `Raymond Feng <raymond@ninemind.ai>`; commit messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Materialize stage (extract the back half)

Create `panels/Materialize/` and move the build + Preview/Targets/Run/Publish + export logic out of the Ledger into it. Materialize derives the selection from the store and builds the gem on entry (or via a button). After this task, the Ledger panel is curate-only and a new Materialize panel renders at `#/materialize`.

**Files:**
- Create: `packages/console/src/panels/Materialize/index.tsx`
- Move (git mv): `packages/console/src/panels/Ledger/{Preview.tsx,Preview.test.tsx,Targets.tsx,Targets.test.tsx,Run.tsx,Run.test.tsx,runStream.ts,runStream.test.ts,Publish.tsx,Publish.test.tsx,exporters.ts,exporters.test.ts}` → `packages/console/src/panels/Materialize/`
- Modify: `packages/console/src/panels/Ledger/index.tsx` (remove the materialize half)
- Modify: `packages/console/src/pages.tsx`
- Modify: `packages/console/src/pages.test.ts`
- Test: `packages/console/src/panels/Materialize/Materialize.test.tsx`

**Interfaces:**
- Consumes: `useActiveGem` + `getKeys` (activeGem store); `buildSelection` from `../Ledger/selection.js` (Task 2 moves it to `../Curate/`); `buildGemRoute` from `../../api/routes.js`.
- Produces: `materializePage: ConsolePage` (id `materialize`, title `Materialize`, icon `▸`, order 20, group `build`, route `#/materialize`).

- [ ] **Step 1: Move the materialize-side files with git mv**

```bash
cd packages/console/src/panels
mkdir -p Materialize
for f in Preview Targets Run Publish; do git mv Ledger/$f.tsx Materialize/$f.tsx; git mv Ledger/$f.test.tsx Materialize/$f.test.tsx; done
git mv Ledger/runStream.ts Materialize/runStream.ts; git mv Ledger/runStream.test.ts Materialize/runStream.test.ts
git mv Ledger/exporters.ts Materialize/exporters.ts; git mv Ledger/exporters.test.ts Materialize/exporters.test.ts
```
These files import siblings with relative `./` paths (e.g. `Targets.tsx` imports `./ContentView.js`, `Run.tsx` imports `./runStream.js`/`./selection.js`). After the move, fix the cross-dir imports in Step 2.

- [ ] **Step 2: Fix imports in the moved files**

In the moved files, repoint imports that now cross directories back to `../Ledger/` (Curate-side files that did NOT move — `selection.ts`, `ContentView.tsx`, `data.ts`):
- `Materialize/Targets.tsx`: `import { ContentView } from "./ContentView.js"` → `from "../Ledger/ContentView.js"`; `import type { GemSelection } from "./selection.js"` → `from "../Ledger/selection.js"`.
- `Materialize/Run.tsx`: `import { ... } from "./selection.js"` → `from "../Ledger/selection.js"`; `./runStream.js` stays (moved together).
- `Materialize/Publish.tsx`: `import type { GemSelection } from "./selection.js"` → `from "../Ledger/selection.js"`.
- `Materialize/Preview.tsx`: imports `type { Gem }` from `../../api/routes.js` — unchanged.
- Their `.test.tsx` files import `./Preview.js` etc. (siblings, moved together) — unchanged.

Run `pnpm -F @agentgem/console typecheck` and fix any remaining unresolved relative imports the same way (cross-dir → `../Ledger/<file>.js`).

- [ ] **Step 3: Write the failing Materialize test**

`packages/console/src/panels/Materialize/Materialize.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Materialize } from "./index.js";
import { setKeys, resetGem } from "../../activeGem.js";

afterEach(() => { cleanup(); resetGem(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Materialize", () => {
  it("nudges to Curate when nothing is selected", () => {
    render(<Materialize apiBase="" />);
    expect(screen.getByText(/curate some artifacts first/i)).toBeTruthy();
  });

  it("builds the gem from the active selection and shows the preview", async () => {
    setKeys(new Set(["skills::pdf"]));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/publish-ready")) return res({ ready: false }); // Publish fetches this on mount
      if (u.includes("/api/gem"))
        return res({ name: "gem", createdFrom: "/x", artifacts: [{ type: "skill", name: "pdf" }], checks: [], requiredSecrets: [] });
      throw new Error("unexpected " + u);
    }));
    render(<Materialize apiBase="" />);
    fireEvent.click(screen.getByText("Build Gem"));
    expect(await screen.findByText("1 artifacts")).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run it — expect FAIL (module not found)**

Run: `pnpm -F @agentgem/console test Materialize`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 5: Write `panels/Materialize/index.tsx`**

```tsx
import { useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { buildGemRoute, archiveRoute, makeClient, type Gem } from "../../api/routes.js";
import { buildSelection } from "../Ledger/selection.js";
import { useActiveGem } from "../../activeGem.js";
import { base64ToBytes, downloadBlob, copyText } from "./exporters.js";
import { Preview } from "./Preview.js";
import { Targets } from "./Targets.js";
import { Run } from "./Run.js";
import { Publish } from "./Publish.js";

export function Materialize({ apiBase }: { apiBase: string }) {
  const { keys, name } = useActiveGem();
  const [gem, setGem] = useState<Gem | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sel = buildSelection(keys);

  if (keys.size === 0) {
    return (
      <p className="ledger-empty">
        Curate some artifacts first — <a href="#/curate">go to Curate →</a>
      </p>
    );
  }

  const build = async () => {
    setBuilding(true);
    setError(null);
    try {
      const g = await buildGemRoute.call(makeClient(apiBase), { body: { selection: sel, name: name.trim() || "gem" } });
      setGem(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  const copyJson = () => { if (gem) void copyText(JSON.stringify(gem, null, 2)); };
  const downloadJson = () => { if (gem) downloadBlob(`${gem.name}.json`, "application/json", JSON.stringify(gem, null, 2)); };
  const downloadGem = async () => {
    if (!gem) return;
    const { tarGz } = await archiveRoute.call(makeClient(apiBase), { body: { selection: sel, name: gem.name, tar: true } });
    if (tarGz) downloadBlob(`${gem.name}.gem`, "application/gzip", base64ToBytes(tarGz));
  };

  return (
    <div className="materialize">
      <div className="ledger-selbar">
        <strong className="ledger-selcount">{keys.size} selected</strong>
        <button type="button" className="ledger-build" disabled={building} onClick={build}>
          {building ? "Building…" : "Build Gem"}
        </button>
        {error && <span className="ledger-error">{error}</span>}
      </div>
      {gem && <Preview gem={gem} onDownloadGem={downloadGem} onDownloadJson={downloadJson} onCopyJson={copyJson} />}
      <Targets apiBase={apiBase} selection={sel} name={name.trim() || "gem"} />
      <Run apiBase={apiBase} selection={sel} name={name.trim() || "gem"} />
      <Publish apiBase={apiBase} selection={sel} name={name.trim() || "gem"} />
    </div>
  );
}

export const materializePage = defineConsolePage({
  id: "materialize",
  title: "Materialize",
  icon: "▸",
  order: 20,
  group: "build",
  route: "#/materialize",
  component: ({ apiBase }) => <Materialize apiBase={apiBase} />,
});
```

- [ ] **Step 6: Strip the materialize half out of `panels/Ledger/index.tsx`**

Remove from `Ledger/index.tsx`: the imports of `base64ToBytes, downloadBlob, copyText` (line 8), `Preview` (9), `Targets` (10), `Run` (11), `Publish` (14), and `archiveRoute, buildGemRoute` from the routes import (line 3). Remove the state `gem, builtSel, building, buildError` (lines 21–24). Remove the functions `build` (79–94), `copyJson/downloadJson/downloadGem` (142–149). Remove the JSX: the "Build Gem" button block inside the selbar (lines 194–199) and the `{gem && ...}` Preview/Targets/Run/Publish block (238–243). Keep everything else (inventory, select, checks, save, the list).

Add a "Materialize →" link to the selection bar where the Build Gem button was:
```tsx
        <a className="ledger-build" href="#/materialize" style={{ textDecoration: "none" }}>Materialize →</a>
```

- [ ] **Step 7: Register both pages, drop nothing yet**

In `packages/console/src/pages.tsx`, add the import and array entry for `materializePage` (keep `ledgerPage` for now — renamed in Task 2):
```tsx
import { materializePage } from "./panels/Materialize/index.js";
// …existing imports…
export const pages: ConsolePage[] = [testbedPage, ledgerPage, materializePage, workspacesPage, getGemsPage, deployPage, transferPage];
```

- [ ] **Step 8: Update `pages.test.ts`**

The build bucket now has testbed, ledger, materialize. Update the grouping assertion:
```ts
expect(g.build.map((p) => p.id)).toEqual(["testbed", "ledger", "materialize"]);
```

- [ ] **Step 9: Run Materialize tests + full suite + typecheck**

Run: `pnpm -F @agentgem/console typecheck && pnpm -F @agentgem/console test`
Expected: green. The moved Preview/Targets/Run/Publish/exporters tests run from their new dir; the new Materialize test passes; the Ledger tests still pass (they no longer assert build/preview — if any Ledger test asserted "Build Gem" / preview, move that assertion into Materialize.test.tsx).

- [ ] **Step 10: Commit**

```bash
git add packages/console/src/panels/Materialize packages/console/src/panels/Ledger/index.tsx packages/console/src/pages.tsx packages/console/src/pages.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): Materialize stage — build/preview/target/run extracted from Ledger

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Rename Ledger → Curate

Rename the `panels/Ledger/` directory to `panels/Curate/`, rename the page to Curate (`#/curate`), and repoint the cross-dir imports Materialize made to `../Ledger/`. Also drop the now-orphaned "Import to testbed" block (a Testbed-era action the IA removes).

**Files:**
- Rename (git mv): `packages/console/src/panels/Ledger/` → `packages/console/src/panels/Curate/`
- Modify: `packages/console/src/panels/Curate/index.tsx` (rename component + page; drop import-to-testbed)
- Modify: `packages/console/src/panels/Materialize/{index.tsx,Targets.tsx,Run.tsx,Publish.tsx}` (`../Ledger/` → `../Curate/`)
- Modify: `packages/console/src/pages.tsx`, `packages/console/src/pages.test.ts`

**Interfaces:**
- Produces: `curatePage: ConsolePage` (id `curate`, title `Curate`, icon `◆`, order 10, group `build`, route `#/curate`).

- [ ] **Step 1: Rename the directory**

```bash
cd packages/console/src/panels
git mv Ledger Curate
```
Relative imports *within* the dir (`./data.js`, `./selection.js`, `./ContentView.js`) keep working.

- [ ] **Step 2: Repoint Materialize's cross-dir imports**

In `panels/Materialize/{index.tsx,Targets.tsx,Run.tsx,Publish.tsx}`, change every `from "../Ledger/<x>.js"` to `from "../Curate/<x>.js"`.

- [ ] **Step 3: Rename the component + page in `Curate/index.tsx`**

- Rename the function `Ledger` → `Curate`, and the export `ledgerPage` → `curatePage` with:
  ```tsx
  export const curatePage = defineConsolePage({
    id: "curate",
    title: "Curate",
    icon: "◆",
    order: 10,
    group: "build",
    route: "#/curate",
    component: ({ apiBase }) => <Curate apiBase={apiBase} />,
  });
  ```
- Delete the "Import to testbed" JSX block (the `{selected.size > 0 && (<div className="ledger-selbar"> … Import to testbed … </div>)}`), its state (`importRoot`, `importNote`), the `importToTestbed` function, and the `testbedImportRoute` import. This removes the last Testbed-era action from Curate.

- [ ] **Step 4: Update `Curate/Ledger.test.tsx`**

Rename the file `git mv Curate/Ledger.test.tsx Curate/Curate.test.tsx`. Update its import `import { Ledger } from "./index.js"` → `import { Curate } from "./index.js"` and every `<Ledger ` → `<Curate `. Delete any test case that asserted the removed "Import to testbed" behavior (the "imports the selection into a testbed" test) — that flow no longer exists in Curate.

- [ ] **Step 5: Update `pages.tsx` + `pages.test.ts`**

In `pages.tsx`: `import { curatePage } from "./panels/Curate/index.js"` (replacing the ledgerPage import), and in the array replace `ledgerPage` → `curatePage`. In `pages.test.ts`, the build bucket is now `["testbed", "curate", "materialize"]` (curate order 10).
```ts
expect(g.build.map((p) => p.id)).toEqual(["testbed", "curate", "materialize"]);
```

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm -F @agentgem/console typecheck && pnpm -F @agentgem/console test`
Expected: green. If anything still imports `panels/Ledger/...`, repoint it to `panels/Curate/...`.

- [ ] **Step 7: Commit**

```bash
git add -A packages/console/src
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "refactor(console): rename Ledger stage → Curate (#/curate); drop import-to-testbed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Move Analyze into Curate (per-project, one click); remove Testbed

Bring the session-analysis flow from the Testbed panel into Curate as a compact, collapsible "Analyze a project's history" list — each discovered project is a row with a one-click **Analyze →** button that streams and pre-checks the recommended artifacts into the active-Gem store. Remove the Testbed panel entirely; the cross-panel `recommendation.ts` hand-off is no longer needed (analyze writes the store directly, same page).

**Files:**
- Move (git mv): `packages/console/src/panels/Testbed/analyzeStream.ts` + `analyzeStream.test.ts` → `packages/console/src/panels/Curate/`
- Create: `packages/console/src/panels/Curate/Analyze.tsx` + `packages/console/src/panels/Curate/Analyze.test.tsx`
- Modify: `packages/console/src/panels/Curate/index.tsx` (render `<Analyze>`; consume its pre-check into the store)
- Modify: `packages/console/src/api/routes.ts` (keep `testbedRecentsRoute`/`testbedProjectsRoute`; they stay — only the panel is removed)
- Delete: `packages/console/src/panels/Testbed/` (whole dir)
- Modify: `packages/console/src/pages.tsx`, `packages/console/src/pages.test.ts`
- Modify: `packages/console/src/panels/Curate/index.tsx` — remove the `takeRecommendedSelection` mount effect (Analyze now sets the store directly)
- (Leave `packages/console/src/recommendation.ts` in place only if still imported; otherwise delete it.)

**Interfaces:**
- Consumes: `openAnalyzeStream`, `type AnalyzeCandidate` (moved `analyzeStream.ts`); `testbedRecentsRoute`, `testbedProjectsRoute` (routes); `includeToKeys` from `./selection.js`; `setKeys`, `getKeys` from `../../activeGem.js`.
- Produces: `Analyze({ apiBase, onPick })` where `onPick(keys: string[])` hands recommended selection keys to Curate.

- [ ] **Step 1: Move the analyze stream module**

```bash
cd packages/console/src/panels
git mv Testbed/analyzeStream.ts Curate/analyzeStream.ts
git mv Testbed/analyzeStream.test.ts Curate/analyzeStream.test.ts
```
Its imports are self-contained (no Testbed-relative paths) — verify with typecheck after.

- [ ] **Step 2: Write the failing Analyze test**

`packages/console/src/panels/Curate/Analyze.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Analyze } from "./Analyze.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}

describe("Analyze", () => {
  it("lists discovered projects and analyzes one in place, handing keys to onPick", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/testbed/recents")) return res({ recents: [] });
      if (u.includes("/api/testbed/projects"))
        return res({ projects: [{ path: "/home/me/proj", flavor: "claude", lastUsed: null, exists: true }] });
      throw new Error("unexpected " + u);
    }));
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const picked: string[][] = [];
    render(<Analyze apiBase="" onPick={(k) => picked.push(k)} />);

    // open the disclosure, then click the project's Analyze
    fireEvent.click(await screen.findByText(/analyze a project/i));
    fireEvent.click(await screen.findByText("Analyze →"));
    FakeES.last!.emit("done", { cached: false, candidates: [
      { name: "Spec Loop", description: "", confidence: "high", include: [{ type: "skill", name: "brainstorming" }] },
    ] });
    fireEvent.click(await screen.findByText(/Use this selection/));
    expect(picked).toEqual([["skills::brainstorming"]]);
  });
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `pnpm -F @agentgem/console test Analyze`
Expected: FAIL — `Cannot find module './Analyze.js'`.

- [ ] **Step 4: Write `Curate/Analyze.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient, type RecentEntry, type ProjectCandidate } from "../../api/routes.js";
import { openAnalyzeStream, type AnalyzeCandidate } from "./analyzeStream.js";
import { includeToKeys } from "./selection.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

/** "Analyze a project's history": a compact disclosure of discovered projects;
 *  each row analyzes that project in one click and hands recommended keys to onPick. */
export function Analyze({ apiBase, onPick }: { apiBase: string; onPick: (keys: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [candidates, setCandidates] = useState<AnalyzeCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open || projects) return;
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [open, apiBase, projects]);
  useEffect(() => () => closeRef.current?.(), []);

  const analyze = (path: string) => {
    closeRef.current?.();
    setActivePath(path); setPhase(""); setCandidates([]); setError(null);
    closeRef.current = openAnalyzeStream(apiBase, path, false, (e) => {
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "done") { setPhase("done"); setCandidates(e.candidates); }
      else if (e.type === "failed") { setError(e.message); }
    });
  };

  // Merge recents + discovered projects into one de-duped, compact list.
  const rows = (() => {
    const seen = new Set<string>();
    const out: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); out.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); out.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    return out.slice(0, 40);
  })();

  return (
    <section className="analyze">
      <button type="button" className="analyze-disclosure" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Analyze a project’s history
      </button>
      {open && (
        <div className="analyze-body">
          {!projects && !recents ? <p className="ledger-loading">Loading…</p>
            : rows.length === 0 ? <p className="ledger-empty">No projects with session history found.</p>
            : (
              <ul className="analyze-list">
                {rows.map((r) => (
                  <li className="analyze-row" key={r.path}>
                    <span className="analyze-name">{r.label}</span>
                    <span className="ws-chip">{r.flavor}</span>
                    <button type="button" className="ledger-view" onClick={() => analyze(r.path)}>Analyze →</button>
                  </li>
                ))}
              </ul>
            )}
          {activePath && (
            <div className="run-out">
              <div className="run-status">
                {phase && <span className={"run-badge " + (phase === "done" ? "run-done" : "run-running")}>{phase}</span>}
                <span className="run-phase">{short(activePath)}</span>
              </div>
              {error && <p className="ledger-error">{error}</p>}
              {candidates.map((c) => (
                <div className="analyze-candidate" key={c.name}>
                  <strong>{c.name}</strong> <span className="ws-chip">{c.confidence}</span>{" "}
                  <span className="targets-label">{c.include.length} artifacts</span>{" "}
                  <button type="button" className="ledger-build" onClick={() => onPick(includeToKeys(c.include))}>Use this selection →</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run the Analyze test — expect PASS**

Run: `pnpm -F @agentgem/console test Analyze`
Expected: PASS.

- [ ] **Step 6: Render `<Analyze>` in Curate; remove the recommendation mount-effect**

In `panels/Curate/index.tsx`:
- Import: `import { Analyze } from "./Analyze.js";`
- Remove the `takeRecommendedSelection` import (line 6) and its mount `useEffect` (lines 52–60).
- Render `<Analyze>` just above the inventory list (after the selection bar), wiring its pick into the store + revealing all:
  ```tsx
  <Analyze apiBase={apiBase} onPick={(picked) => { setKeys(new Set(picked)); setView((v) => ({ ...v, usedOnly: false })); }} />
  ```
  (`setKeys` is already imported from `../../activeGem.js`.)

- [ ] **Step 7: Add Analyze CSS (compact rows, not cards)**

Append to `packages/console/src/shell/theme.css`:
```css
.analyze { margin: 0 0 16px; }
.analyze-disclosure { background: none; border: 0; padding: 4px 0; color: var(--ink-soft);
  font: 600 13px/1 var(--font-ui); cursor: pointer; }
.analyze-disclosure:hover { color: var(--accent); }
.analyze-body { margin-top: 8px; }
.analyze-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.analyze-row { display: flex; align-items: center; gap: 10px; padding: 5px 10px;
  border: 1px solid var(--line-soft); border-radius: 7px; background: var(--raised); }
.analyze-name { flex: 1; font: 12px/1.4 var(--font-mono); color: var(--ink-soft); word-break: break-all; }
.analyze-candidate { margin-top: 8px; }
```

- [ ] **Step 8: Remove the Testbed panel + registration**

```bash
git rm -r packages/console/src/panels/Testbed
```
In `pages.tsx`: remove the `testbedPage` import and its array entry. The array becomes:
```tsx
export const pages: ConsolePage[] = [curatePage, materializePage, workspacesPage, getGemsPage, deployPage, transferPage];
```
In `pages.test.ts`, the build bucket is now `["curate", "materialize"]`:
```ts
expect(g.build.map((p) => p.id)).toEqual(["curate", "materialize"]);
```

- [ ] **Step 9: Delete `recommendation.ts` if now unused**

Run `grep -rn "recommendation" packages/console/src`. If nothing imports it (Testbed was the only writer, Curate's reader is removed), `git rm packages/console/src/recommendation.ts`. If something still references it, leave it.

- [ ] **Step 10: Typecheck + full suite + build**

Run: `pnpm -F @agentgem/console typecheck && pnpm -F @agentgem/console test && pnpm build`
Expected: all green; `dist/public/console/index.html` present. No remaining imports of `panels/Testbed/...`.

- [ ] **Step 11: Commit**

```bash
git add -A packages/console
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): per-project Analyze in Curate; remove Testbed panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Global / Project scope picker in Curate

Add a scope dropdown to Curate that governs which inventory the hand-pick list shows: **Global** (default, today's behavior) or a specific **Project** (its `.claude/` artifacts, fetched with `?projects=<root>`). The project options come from the discovered-projects list.

**Files:**
- Modify: `packages/console/src/api/routes.ts` (give `inventoryRoute` an optional `projects` query)
- Modify: `packages/console/src/panels/Curate/index.tsx` (scope state + dropdown; refetch on scope change)
- Test: extend `packages/console/src/panels/Curate/Curate.test.tsx`

**Interfaces:**
- Consumes: `testbedProjectsRoute` (already imported via Analyze, but Curate needs the project list for the dropdown too — fetch once in Curate or lift from Analyze; fetch in Curate is simplest).

- [ ] **Step 1: Add the `projects` query to the inventory route**

In `packages/console/src/api/routes.ts`, change:
```ts
export const inventoryRoute = defineRoute("GET", "/api/inventory", { response: InventorySchema });
```
to:
```ts
export const inventoryRoute = defineRoute("GET", "/api/inventory", {
  query: z.object({ projects: z.string().optional() }),
  response: InventorySchema,
});
```
(The server's `@get("/inventory", { query: DirQuerySchema })` already accepts `projects` — a JSON-encoded string array of roots — so this is client-side only.)

- [ ] **Step 2: Write the failing scope test**

Add to `packages/console/src/panels/Curate/Curate.test.tsx`:
```tsx
it("refetches inventory scoped to a project when the scope changes", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url); calls.push(u);
    if (u.includes("/api/inventory")) return ({ ok: true, status: 200, text: async () => JSON.stringify(
      u.includes("projects=") ? { skills: [{ name: "proj-skill" }], mcpServers: [], instructions: [], hooks: [] }
                              : { skills: [{ name: "global-skill" }], mcpServers: [], instructions: [], hooks: [] }) }) as unknown as Response;
    if (u.includes("/api/usage")) return ({ ok: true, status: 200, text: async () => JSON.stringify({ artifacts: [] }) }) as unknown as Response;
    if (u.includes("/api/testbed/projects")) return ({ ok: true, status: 200, text: async () => JSON.stringify({ projects: [{ path: "/home/me/proj", flavor: "claude", lastUsed: null, exists: true }] }) }) as unknown as Response;
    return ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response;
  }));
  render(<Curate apiBase="" />);
  expect(await screen.findByText("global-skill")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("scope"), { target: { value: "/home/me/proj" } });
  expect(await screen.findByText("proj-skill")).toBeTruthy();
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `pnpm -F @agentgem/console test Curate -t "scoped to a project"`
Expected: FAIL — no scope control / inventory not refetched.

- [ ] **Step 4: Implement the scope picker in Curate**

In `panels/Curate/index.tsx`:
- Add state: `const [scope, setScope] = useState<string>("");` (empty = Global) and `const [projects, setProjects] = useState<{path:string;flavor:string}[]>([]);`.
- Fetch projects once for the dropdown (in the existing mount effect or a new one):
  ```tsx
  useEffect(() => {
    testbedProjectsRoute.call(makeClient(apiBase)).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, [apiBase]);
  ```
  (import `testbedProjectsRoute` from `../../api/routes.js`.)
- Change the inventory load effect to depend on `scope` and pass it:
  ```tsx
  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      try {
        const inv = await inventoryRoute.call(client, { query: scope ? { projects: JSON.stringify([scope]) } : {} });
        let usage: Usage = { artifacts: [] };
        try { usage = await usageRoute.call(client, { query: { scope: "global" } }); } catch { /* optional */ }
        if (alive) setGroups(mergeUsage(groupInventory(inv), usage));
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { alive = false; };
  }, [apiBase, scope]);
  ```
- Add the dropdown to the top bar (the `ledger-bar`), right-aligned:
  ```tsx
  <select className="targets-select" aria-label="scope" value={scope} onChange={(e) => setScope(e.target.value)} style={{ marginLeft: "auto" }}>
    <option value="">Global</option>
    {projects.map((p) => <option key={p.path} value={p.path}>{p.path.split("/").slice(-2).join("/")}</option>)}
  </select>
  ```

- [ ] **Step 5: Run the scope test — expect PASS**

Run: `pnpm -F @agentgem/console test Curate -t "scoped to a project"`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck + build + browser smoke**

Run: `pnpm -F @agentgem/console typecheck && pnpm -F @agentgem/console test && pnpm build`
Then run the server and verify: `#/curate` shows the scope dropdown + the "Analyze a project's history" disclosure with per-project "Analyze →"; `#/materialize` builds and previews; switching scope reloads the inventory.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Curate/index.tsx packages/console/src/panels/Curate/Curate.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): Curate scope picker — Global / Project inventory

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `pnpm -F @agentgem/console typecheck` clean; `pnpm -F @agentgem/console test` green; `pnpm build` OK.
- [ ] Sidebar BUILD group shows **Curate · Materialize** (Testbed gone); Library + Deploy unchanged.
- [ ] Curate: scope dropdown (Global/Project), per-project Analyze disclosure (compact rows), inventory select, checks, save; "Materialize →" carries the active Gem.
- [ ] Materialize: empty-state nudge when nothing selected; Build → Preview/export, Targets, Run, Publish all work off the store's selection.
- [ ] No remaining references to `panels/Testbed`, `panels/Ledger`, or (if deleted) `recommendation.ts`.

## Carry-forward (deferred Phase-1 Minors + Phase-3)

- Phase-1 Minors still open (fix opportunistically or in Phase 3): Shell double-sort; inert `.console-group-label:first-of-type`; empty `console-footer` border guard; workspace-name↔gem-name seam.
- **Publish** currently rides along in Materialize (Task 1) — Phase 3 moves it into the dedicated **Deploy** stage alongside WorkspaceDeploy, renames Workspaces → Your Gems, folds Transfer Send→Materialize / Redeem→Received, and adds the active-Gem pin + landing-on-Curate.

## Self-review (spec coverage)

- Spec "3 stages, Discover ambient" → Curate (① with scope+analyze) + Materialize (②); Deploy is Phase 3.
- Spec "Testbed removed; Curate Global/Project scope picker" → Task 4 + Task 3 (Testbed deletion).
- Spec + user feedback "per-project Analyze button; recents/projects as a dropdown/compact list" → Task 3 (`Analyze.tsx`, merged recents+projects, per-row Analyze →).
- Spec "Materialize = target render + export + test-run on the active Gem" → Task 1.
- Spec "active Gem carries across stages" → Materialize derives selection from the Phase-1 store (no new store field).
