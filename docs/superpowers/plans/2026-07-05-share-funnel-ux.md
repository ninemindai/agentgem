# Share-funnel UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give console share surfaces a 1-click "Share link" (inline gem card) beside a deliberate "Publish" (Explore catalog), plus prefill and an upgrade nudge, so sharing to app.agentgem.ai takes fewer steps.

**Architecture:** Extract the light-mint state machine that today lives inline in `Mine/Scorecard.tsx` into one reusable `<QuickShareButton>` under a new `panels/_shared/`. The three indirect surfaces (Observe, TranscriptViewer, Dreaming) render it beside their existing "→ Curate" publish path; the Curate publish form gains prefill + visible labels. No backend changes — the light path reuses the existing `createGemShareRoute` (`kind:"gem"`).

**Tech Stack:** React 18 + TypeScript, vitest + @testing-library/react (jsdom), existing `defineRoute` typed client.

## Global Constraints

- Scope is `packages/console/` only. No backend/route/schema changes.
- Light path calls `createGemShareRoute({ kind:"gem", name, provenance, generatedAtMs })` → `{ id, url }` (never send an empty/whitespace `name` — the endpoint rejects it).
- Reuse `ShareLinks` (`panels/Mine/ShareLinks.tsx`) verbatim for every result row.
- Button copy: light = **"Share link"** where paired with Publish; Mine's existing "Share"/"Share gem" stay unchanged.
- Match the file's existing style (double quotes, `.js` import extensions, no semicolon changes elsewhere).
- Tests inject the network call via a `createGemShare` prop; never hit the real route in tests.
- Run tests from `packages/console`: `pnpm --filter @agentgem/console test`.

---

## File Structure

- **Create** `packages/console/src/panels/_shared/QuickShareButton.tsx` — the reusable light-mint button + result row + upgrade nudge. One responsibility: mint a gem share card and render its result.
- **Create** `packages/console/src/panels/_shared/__tests__/QuickShareButton.test.tsx` — states + nudge tests.
- **Modify** `packages/console/src/panels/Observe/index.tsx` — fetch inventory once on load; derive setup name/provenance/empty; pass light-share props + an `onPublishSetup` down.
- **Modify** `packages/console/src/panels/Observe/Dashboard.tsx` — render `[ Share link ][ Publish ]` + result strip between `obs-head` and `obs-filters`.
- **Modify** `packages/console/src/panels/Observe/TranscriptViewer.tsx` — lesson row gets `[ Share link ]` beside the existing Publish.
- **Modify** `packages/console/src/panels/Curate/index.tsx` — pass `defaultName` (from `pendingContribution.name`) into the publish form.
- **Modify** `packages/console/src/panels/Curate/PublishToExplore.tsx` — prefill scope/name, add visible labels, rename heading.
- **Modify** `packages/console/src/shell/theme.css` — `.quick-share*` classes (result strip, hint, nudge).

Dreaming (`panels/Dreaming/index.tsx`) already ships a single `Publish →` button routing to `#/curate` (`index.tsx:118`); it needs **no code change** — it inherits the prefilled form from Task 5. No task is created for it (see NOT in scope in the spec).

---

### Task 1: `QuickShareButton` component

**Files:**
- Create: `packages/console/src/panels/_shared/QuickShareButton.tsx`
- Test: `packages/console/src/panels/_shared/__tests__/QuickShareButton.test.tsx`
- Modify: `packages/console/src/shell/theme.css` (append `.quick-share*`)

**Interfaces:**
- Consumes: `createGemShareRoute`, `makeClient` from `../../api/routes.js`; `ShareLinks` from `../Mine/ShareLinks.js`.
- Produces:
  ```ts
  function QuickShareButton(props: {
    apiBase: string;
    name: string;
    provenance: string;
    title?: string;
    label?: string;          // default "Share link"
    disabled?: boolean;      // empty-payload guard (D3)
    disabledReason?: string; // visible + a11y hint when disabled
    onUpgrade?: () => void;  // if set, render the Publish nudge after success (D4)
    createGemShare?: (body: { kind: "gem"; name: string; provenance: string; generatedAtMs: number }) => Promise<{ id: string; url: string }>;
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/_shared/__tests__/QuickShareButton.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
afterEach(cleanup);
import { QuickShareButton } from "../QuickShareButton.js";

describe("QuickShareButton", () => {
  it("mints a gem card and shows the share link + intents", async () => {
    const createGemShare = vi.fn(async () => ({ id: "abc", url: "https://agentgem.ai/share/abc" }));
    render(<QuickShareButton apiBase="" name="my-setup" provenance="12 skills · 3 MCP" createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gem", name: "my-setup", provenance: "12 skills · 3 MCP" }),
    ));
    const link = await screen.findByRole("link", { name: "X" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent("https://agentgem.ai/share/abc"));
  });

  it("when disabled, shows the reason and does not mint", () => {
    const createGemShare = vi.fn();
    render(<QuickShareButton apiBase="" name="x" provenance="" disabled disabledReason="Nothing to share yet" createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    expect(createGemShare).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing to share yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /share link/i }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the Publish upgrade nudge after success and fires onUpgrade", async () => {
    const createGemShare = vi.fn(async () => ({ id: "a", url: "https://agentgem.ai/share/a" }));
    const onUpgrade = vi.fn();
    render(<QuickShareButton apiBase="" name="n" provenance="p" onUpgrade={onUpgrade} createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    const nudge = await screen.findByRole("button", { name: /publish to explore/i });
    fireEvent.click(nudge);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @agentgem/console test QuickShareButton`
Expected: FAIL — cannot find module `../QuickShareButton.js`.

- [ ] **Step 3: Write the component**

```tsx
// packages/console/src/panels/_shared/QuickShareButton.tsx
import { useState } from "react";
import { createGemShareRoute, makeClient } from "../../api/routes.js";
import { ShareLinks } from "../Mine/ShareLinks.js";

type CreateGemShare = (body: { kind: "gem"; name: string; provenance: string; generatedAtMs: number }) => Promise<{ id: string; url: string }>;

// The light "Share link" path: mints a hosted gem card (createGemShareRoute) and
// reveals ShareLinks inline. Lifts Mine/Scorecard's mint state machine (busy/slow/
// error) so every surface inherits cold-start handling. `disabled` guards empty
// payloads (D3); `onUpgrade`, when set, renders the Publish nudge after success (D4).
export function QuickShareButton({
  apiBase, name, provenance, title,
  label = "Share link",
  disabled = false, disabledReason,
  onUpgrade, createGemShare,
}: {
  apiBase: string;
  name: string;
  provenance: string;
  title?: string;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  onUpgrade?: () => void;
  createGemShare?: CreateGemShare;
}) {
  const doCreate: CreateGemShare = createGemShare ?? ((body) => createGemShareRoute.call(makeClient(apiBase), { body }));
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Mirrors Scorecard.tsx: show a spinner, and past ~3s a "waking the server" hint
  // for the hosted cold start, instead of a silent wait.
  const onShare = async () => {
    setBusy(true); setErr(null); setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 3000);
    try {
      const res = await doCreate({ kind: "gem", name, provenance, generatedAtMs: Date.now() });
      setUrl(res.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create a share link — try again.");
    } finally { clearTimeout(slowTimer); setBusy(false); setSlow(false); }
  };

  return (
    <span className="quick-share">
      <button
        type="button"
        className="mine-wf-share"
        aria-disabled={disabled || undefined}
        disabled={busy}
        onClick={disabled ? undefined : onShare}
      >
        {busy ? "Creating link…" : label}
      </button>
      {disabled && disabledReason && <span className="quick-share-hint">{disabledReason}</span>}
      {busy && slow && <p className="scorecard-pending">Waking the server — the first share after a while can take up to ~30s.</p>}
      {err && <span className="obs-error">{err}</span>}
      {(busy || url) && (
        <div className="quick-share-result">
          <ShareLinks url={url ?? undefined} title={title ?? name} />
          {url && onUpgrade && (
            <button type="button" className="quick-share-upgrade" onClick={onUpgrade}>
              Want others to install this? Publish to Explore →
            </button>
          )}
        </div>
      )}
    </span>
  );
}
```

- [ ] **Step 4: Add the CSS**

Append to `packages/console/src/shell/theme.css`:

```css
.quick-share { display: inline-flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.quick-share-hint { font-size: 0.7rem; color: var(--muted); }
.quick-share-result { margin-top: 4px; }
.quick-share-upgrade { background: none; border: none; padding: 2px 0; cursor: pointer; font-size: 0.75rem; color: var(--accent); text-align: left; }
.quick-share-upgrade:hover { text-decoration: underline; }
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @agentgem/console test QuickShareButton`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/_shared/QuickShareButton.tsx \
        packages/console/src/panels/_shared/__tests__/QuickShareButton.test.tsx \
        packages/console/src/shell/theme.css
git commit -m "feat(console): QuickShareButton — reusable 1-click gem-card share"
```

---

### Task 2: Curate publish form — prefill + visible labels + heading

**Files:**
- Modify: `packages/console/src/panels/Curate/PublishToExplore.tsx`
- Modify: `packages/console/src/panels/Curate/index.tsx:235-241` (pass `defaultName`)
- Test: `packages/console/src/panels/Curate/__tests__/PublishToExplore.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `PendingContribution.name` (already read in `Curate/index.tsx:46-53`).
- Produces: `PublishToExplore` gains an optional `defaultName?: string` prop; heading text becomes "Publish to Explore".

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Curate/__tests__/PublishToExplore.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
afterEach(cleanup);
import { PublishToExplore } from "../PublishToExplore.js";

describe("PublishToExplore", () => {
  it("prefills the name field from defaultName", () => {
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={3} lessonCount={0} defaultName="my-setup" />);
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("my-setup");
  });
  it("renders visible labels for scope, name, version", () => {
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={0} lessonCount={0} />);
    expect(screen.getByText(/^scope$/i)).toBeTruthy();
    expect(screen.getByText(/^name$/i)).toBeTruthy();
    expect(screen.getByText(/^version$/i)).toBeTruthy();
  });
  it("titles the form Publish to Explore", () => {
    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={0} lessonCount={0} />);
    expect(screen.getByRole("heading", { name: /publish to explore/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @agentgem/console test PublishToExplore`
Expected: FAIL — `defaultName` not a prop / labels absent / heading is "Share to Explore".

- [ ] **Step 3: Add `defaultName` to the props interface and name init**

In `PublishToExplore.tsx`, change the interface (currently lines 13-18) to add `defaultName`:

```tsx
export interface PublishToExploreProps {
  apiBase: string;
  selected: Set<string>;
  skillCount: number;
  lessonCount: number;
  defaultName?: string;
}
```

Change the destructure + `name` init (currently `export function PublishToExplore({ apiBase, selected, skillCount, lessonCount }: PublishToExploreProps) {` and `const [name, setName] = useState("");`):

```tsx
export function PublishToExplore({ apiBase, selected, skillCount, lessonCount, defaultName }: PublishToExploreProps) {
  const [scope, setScope] = useState("");
  const [name, setName] = useState(defaultName ?? "");
```

- [ ] **Step 4: Prefill scope from the bound login**

In the existing `useEffect` (lines 36-39), set scope to `@login` once bind status resolves, without clobbering a value the user already typed:

```tsx
  useEffect(() => {
    const client = makeClient(apiBase);
    bindStatusRoute.call(client).then((s) => {
      setBindStatus(s);
      if (s.bound && s.login) setScope((cur) => cur || `@${s.login}`);
    }).catch(() => setBindStatus({ bound: false }));
  }, [apiBase]);
```

- [ ] **Step 5: Rename heading + add visible labels**

Change the heading (line 139) `<h3>Share to Explore</h3>` → `<h3>Publish to Explore</h3>`.

Replace the three bare inputs (lines 170-197) with labeled fields (keep the same ids, classes, values, handlers; add a visible `<label htmlFor>` and drop the now-redundant `aria-label`):

```tsx
      <div className="publish-fields">
        <label className="publish-field">
          <span className="publish-label">scope</span>
          <input id="publish-scope" className="ledger-search publish-scope" placeholder="e.g. @me"
            value={scope} onChange={(e) => setScope(e.target.value)} required />
        </label>
        <label className="publish-field">
          <span className="publish-label">name</span>
          <input id="publish-name" className="ledger-search" placeholder="playbook name"
            value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="publish-field">
          <span className="publish-label">version</span>
          <input id="publish-version" className="ledger-search publish-version" placeholder="1.0.0"
            value={version} onChange={(e) => setVersion(e.target.value)} />
        </label>
      </div>
```

Append CSS to `theme.css`:

```css
.publish-field { display: flex; flex-direction: column; gap: 3px; }
.publish-label { font-size: 0.68rem; color: var(--muted); text-transform: lowercase; }
```

- [ ] **Step 6: Pass `defaultName` from Curate**

In `Curate/index.tsx`: add a state to hold the pending name, set it where the contribution is consumed (lines 46-53), and pass it to the form (lines 235-241).

Add near the other publish state (line 30 area):
```tsx
  const [publishDefaultName, setPublishDefaultName] = useState<string | undefined>(undefined);
```
Inside the `if (contrib) {` block (after line 48), add:
```tsx
      setPublishDefaultName(contrib.name);
```
Update the render (lines 235-241):
```tsx
      {showPublish && (
        <PublishToExplore
          apiBase={apiBase}
          selected={selected}
          skillCount={publishCounts.skills}
          lessonCount={publishCounts.lessons}
          defaultName={publishDefaultName}
        />
      )}
```

- [ ] **Step 7: Run the test, verify it passes**

Run: `pnpm --filter @agentgem/console test PublishToExplore`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Curate/PublishToExplore.tsx \
        packages/console/src/panels/Curate/index.tsx \
        packages/console/src/panels/Curate/__tests__/PublishToExplore.test.tsx \
        packages/console/src/shell/theme.css
git commit -m "feat(console): prefill + visible labels on Publish to Explore form"
```

---

### Task 3: Observe — Share link beside Publish, result strip below header

**Files:**
- Modify: `packages/console/src/panels/Observe/index.tsx`
- Modify: `packages/console/src/panels/Observe/Dashboard.tsx`
- Test: `packages/console/src/panels/Observe/__tests__/Dashboard.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `QuickShareButton` (Task 1); `inventoryRoute`, `setPendingContribution` (already imported in `Observe/index.tsx`).
- Produces: `Dashboard` gains props `setupShare?: { name: string; provenance: string; empty: boolean } | null` and `onPublishSetup?: () => void` (replacing the single `onShareSetup`).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Observe/__tests__/Dashboard.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
afterEach(cleanup);
import { Dashboard } from "../Dashboard.js";

const base = { data: { facets: { agents: [], projects: [], models: [] } } } as never;

describe("Dashboard share row", () => {
  it("renders both Share link and Publish when a setup is present", () => {
    render(<Dashboard {...base} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}}
      apiBase="" setupShare={{ name: "my-setup", provenance: "3 skills", empty: false }} onPublishSetup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /share link/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /publish/i })).toBeTruthy();
  });
  it("disables Share link with a reason when the setup is empty", () => {
    render(<Dashboard {...base} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}}
      apiBase="" setupShare={{ name: "my-setup", provenance: "", empty: true }} onPublishSetup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /share link/i }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/nothing to share yet/i)).toBeTruthy();
  });
});
```

> Note: match `base` to the real props `Dashboard` requires — read the current `Dashboard` prop type first and fill every required field so the render doesn't throw. The two fields under test are `setupShare` and `onPublishSetup`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @agentgem/console test Observe/__tests__/Dashboard`
Expected: FAIL — `setupShare`/`onPublishSetup` not props.

- [ ] **Step 3: Wire the light-share data in `Observe/index.tsx`**

Fetch inventory once on load (Inspect currently fetches it lazily on click; the light path needs counts up front to build provenance and detect empty). Add alongside the existing stats effect:

```tsx
  const [setupShare, setSetupShare] = useState<{ name: string; provenance: string; empty: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    inventoryRoute.call(makeClient(apiBase)).then((inv) => {
      if (!alive) return;
      const parts = [
        [inv.skills.length, "skill"], [inv.mcpServers.length, "MCP"],
        [inv.instructions.length, "instruction"], [inv.hooks.length, "hook"],
      ] as const;
      const total = parts.reduce((n, [c]) => n + c, 0);
      const provenance = parts.filter(([c]) => c > 0)
        .map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`).join(" · ");
      setSetupShare({ name: "my-setup", provenance, empty: total === 0 });
    }).catch(() => setSetupShare({ name: "my-setup", provenance: "", empty: true }));
    return () => { alive = false; };
  }, [apiBase]);
```

Keep the existing `onShareSetup` handler but rename it to `onPublishSetup` (it already bundles inventory → `pendingContribution` → `#/curate`; that IS the Publish action now). Pass both down:

```tsx
      <Dashboard
        /* ...existing props... */
        apiBase={apiBase}
        setupShare={setupShare}
        onPublishSetup={onPublishSetup}
      />
```

- [ ] **Step 4: Render the two-button row + strip in `Dashboard.tsx`**

Add to the `Dashboard` prop type: `apiBase: string; setupShare?: { name: string; provenance: string; empty: boolean } | null; onPublishSetup?: () => void;`. Import `QuickShareButton` from `../_shared/QuickShareButton.js`.

Replace the single share button (lines 58-62) with a Publish button, and add the light path + result strip. In the header, keep a compact Publish:

```tsx
        {onPublishSetup && (
          <button type="button" className="obs-range-btn obs-share-setup" onClick={onPublishSetup}>
            Publish ↗
          </button>
        )}
```

After the closing `</div>` of `obs-head` (line 64) and before `obs-filters` (line 66), insert the light-share strip:

```tsx
      {setupShare && (
        <div className="obs-share-strip">
          <QuickShareButton
            apiBase={apiBase}
            name={setupShare.name}
            provenance={setupShare.provenance}
            title="My agent setup"
            disabled={setupShare.empty}
            disabledReason={setupShare.empty ? "Nothing to share yet — add skills first" : undefined}
            onUpgrade={onPublishSetup}
          />
        </div>
      )}
```

Append CSS to `theme.css`:
```css
.obs-share-strip { padding: 6px 0 2px; }
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @agentgem/console test Observe/__tests__/Dashboard`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full Observe + Mine suites (regression)**

Run: `pnpm --filter @agentgem/console test Observe Mine`
Expected: PASS (no regressions in existing Observe/Mine tests).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Observe/index.tsx \
        packages/console/src/panels/Observe/Dashboard.tsx \
        packages/console/src/panels/Observe/__tests__/Dashboard.test.tsx \
        packages/console/src/shell/theme.css
git commit -m "feat(console): Share link + Publish on Inspect, with empty-setup guard"
```

---

### Task 4: TranscriptViewer lesson — Share link beside Publish

**Files:**
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx` (the `LessonCard`, lines 246-278)
- Test: `packages/console/src/panels/Observe/__tests__/TranscriptViewer.test.tsx` (create if absent; if present, add a `describe`)

**Interfaces:**
- Consumes: `QuickShareButton` (Task 1). Existing `share` handler (line 258) becomes the Publish action.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Observe/__tests__/TranscriptViewer.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
afterEach(cleanup);
import { LessonCard } from "../TranscriptViewer.js"; // export it in Step 3

const lesson = { name: "prefer-rg", importance: "high", body: "use rg not grep" } as never;

describe("LessonCard share link", () => {
  it("mints a gem card for the lesson via Share link", async () => {
    const createGemShare = vi.fn(async () => ({ id: "l1", url: "https://agentgem.ai/share/l1" }));
    render(<LessonCard apiBase="" lesson={lesson} createGemShare={createGemShare} />);
    fireEvent.click(screen.getByRole("button", { name: /share link/i }));
    await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gem", name: "prefer-rg" }),
    ));
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter @agentgem/console test TranscriptViewer`
Expected: FAIL — `LessonCard` not exported / no Share link button.

- [ ] **Step 3: Add the light path to `LessonCard`**

Export `LessonCard` (change `function LessonCard` → `export function LessonCard`) and thread an optional `createGemShare` prop for testability. Add `QuickShareButton` import at the top of the file: `import { QuickShareButton } from "../_shared/QuickShareButton.js";`.

Update the signature and the head row (lines 246, 262-273). Keep the existing Save/Publish behavior; add Share link (always available once there's a lesson — a lesson always has name+body, so no empty guard needed here):

```tsx
export function LessonCard({ apiBase, lesson, createGemShare }: { apiBase: string; lesson: DistilledLesson; createGemShare?: Parameters<typeof QuickShareButton>[0]["createGemShare"] }) {
  // ...unchanged state + save + share...
  return (
    <div className="tv-draft">
      <div className="tv-draft-head">
        <span className="tv-draft-name">{lesson.name}</span>
        <span className="obs-chip">{lesson.importance}</span>
        <QuickShareButton
          apiBase={apiBase}
          name={lesson.name}
          provenance={`Distilled lesson · ${lesson.importance}`}
          title={lesson.name}
          createGemShare={createGemShare}
          onUpgrade={saved ? share : undefined}
        />
        {saved
          ? <>
              <span className="obs-muted tv-draft-saved">saved → {saved}</span>
              <button type="button" className="obs-open-transcript" onClick={share}>Publish</button>
            </>
          : <button type="button" className="obs-open-transcript" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save lesson"}</button>}
      </div>
      <p className="tv-draft-desc">{lesson.body}</p>
      {err && <span className="obs-error tv-distill-note">{err}</span>}
    </div>
  );
}
```

> The existing `share` handler keeps its comment/behavior (hands the saved lesson into Curate's Publish flow); it is now labeled "Publish" and also serves as the `onUpgrade` target once the lesson is saved.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter @agentgem/console test TranscriptViewer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/TranscriptViewer.tsx \
        packages/console/src/panels/Observe/__tests__/TranscriptViewer.test.tsx
git commit -m "feat(console): Share link on distilled lessons"
```

---

### Task 5: Full suite + typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full console test suite**

Run: `pnpm --filter @agentgem/console test`
Expected: PASS (all suites, including pre-existing Mine/Curate/Observe).

- [ ] **Step 2: Typecheck the console package**

Run: `pnpm --filter @agentgem/console exec tsc --noEmit`
Expected: no type errors. (CI does not run console typecheck — this is the local gate; see memory `ci-skips-console-tests`.)

- [ ] **Step 3: Build the console to catch bundler issues**

Run: `pnpm --filter @agentgem/console build`
Expected: build succeeds.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A packages/console
git commit -m "test(console): green suite + typecheck for share-funnel UX" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Light/heavy split + two buttons → Tasks 3, 4 (Observe, TranscriptViewer); Mine unchanged (spec D5). ✓
- `QuickShareButton` reusable unit → Task 1. ✓
- Result-strip placement on non-card surfaces (D2) → Task 3 (`obs-share-strip` between head and filters), Task 4 (in `tv-draft`). ✓
- Empty-payload guard (D3) → Task 1 `disabled`/`disabledReason`, applied in Task 3 (`setupShare.empty`). ✓
- Upgrade nudge (D4) → Task 1 `onUpgrade`, wired in Tasks 3 and 4. ✓
- Context-varied labels (D5) → light buttons say "Share link"; Mine untouched. ✓
- Visible form labels + a11y (D6) → Task 2 labeled fields; Task 1 `aria-disabled` + visible hint. ✓
- Prefill scope/name (goal #1) → Task 2. ✓
- Heading rename → Task 2. ✓
- Dreaming single-button → no-op, documented in File Structure. ✓
- OAuth relocation (D7) → deferred TODO, correctly absent from tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. The one "read the current prop type first" note (Task 3 Step 1) is a genuine instruction (the `Dashboard` prop shape must be filled for the render), not a placeholder for missing plan content.

**Type consistency:** `createGemShare` signature identical across Task 1, 3, 4. `setupShare` shape `{ name; provenance; empty }` consistent between `Observe/index.tsx` producer and `Dashboard` consumer. `defaultName?: string` consistent between `Curate/index.tsx` and `PublishToExplore`. `onUpgrade?: () => void` consistent. ✓

**One deliberate deviation from the spec, flagged:** Observe now fetches inventory **once on load** rather than lazily on click, because the light path needs counts up front (provenance + empty detection). Cost: one extra `inventoryRoute` call per Inspect open. This is the smallest change that makes `QuickShareButton` purely sync-prop-driven. If that call cost matters, an alternative is a click-time resolver, but that fights the component boundary.
