# gemit PR-3 (landing chrome + skill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gemit card's `/games/<key>` page grows invite chrome ("What's your steering level?" + copyable `npx -y @ninemind/agentgem gemit`), and a thin `/gemit` SKILL.md ships in `skills/`; post-merge, verify the OG unfurl of a real unlisted gemit card end-to-end.

**Architecture:** Detection is client-side off the canonical key shape (`<scope>/gemit-YYYY-MM-DD`, fixed by PR-2) via a new `isGemitKey` in `entityPath.ts` — no wire/server change. The `Play` page branches: gemit keys render a landing layout (title + inline sealed player + CTA aside) instead of mounting straight into fullscreen; every new className gets a matching `styles.css` rule (repo rule). The skill is presentation-free: run the npx command, relay the tier, offer `--share` — zero scoring logic, drift-guarded by a root test.

**Tech Stack:** packages/marketplace (React SPA, hand-authored styles.css, local vitest — NOT CI-gated, run locally), root `src/__tests__/` for the CI-collected skill drift-guard.

## Global Constraints

- Marketplace has NO CSS framework: every new className needs a rule in `packages/marketplace/src/styles.css` in the same change; reuse `--ink`/`--muted`/`--display` tokens and mirror sibling components (`.mg-h`, `.mg-intro`).
- Root `src/__tests__/` is the only CI-collected test dir; root tests run compiled dist (`npx tsc -b` then `npx vitest run dist/__tests__/<file>.js`). Marketplace tests run via `pnpm -C packages/marketplace test` (local gate only).
- CTA one-liner is exactly `npx -y @ninemind/agentgem gemit`; chrome lives on the PAGE, never inside the sealed iframe (sealed html can't link out).
- SKILL.md is thin: run the command, open report, offer `--share`. All scoring stays in the CLI; the skill must say so.
- PR description = mechanics only.
- Verified seam facts (2026-07-19, worktree at origin/main b8596eb3):
  - Route: `Router.tsx:67` → `Play` (`pages/Play.tsx`) with `gemKey`; currently always `startFullscreen`.
  - `GamePlayer` (`GamePlayer.tsx:48`) supports non-fullscreen `interactive` embedding (scaled 1200×780).
  - Copy pattern precedent: `pages/Gem.tsx:106-107` (`installCmd` + `copyCmd` + 1.5s `setCmdCopied` reset); tests stub `navigator.clipboard` (`Gem.test.tsx:44-46`).
  - `game-meta` returns `{title, genre, version}` only — hence key-shape detection, not tags.
  - Skill convention: `skills/<name>/SKILL.md` with `---\nname: …\ndescription: …` frontmatter; drift-guard precedent `src/__tests__/reportSkill.test.ts`.
  - OG: unlisted resolves (`src/og/meta.ts:17` gates only `private`); served by the hosted aggregator express app (`src/og/install.ts`); card image at `/og/card.png?type=game&key=…`; no cover for gemit (text card, v1 decision).

---

### Task 1: `isGemitKey` in entityPath.ts

**Files:**
- Modify: `packages/marketplace/src/entityPath.ts`
- Test: `packages/marketplace/src/entityPath.test.ts` (append)

**Interfaces:**
- Produces: `isGemitKey(key: string): boolean` — true only for `<scope>/gemit-YYYY-MM-DD` keys (Task 2 consumes it).

- [ ] **Step 1: Write the failing test** — append to `entityPath.test.ts`:

```ts
describe("isGemitKey", () => {
  it("matches only the canonical <scope>/gemit-YYYY-MM-DD shape", () => {
    expect(isGemitKey("raymondfeng/gemit-2026-07-19")).toBe(true);
    expect(isGemitKey("@org/gemit-2026-01-01")).toBe(true);
    expect(isGemitKey("raymondfeng/gemit-tools")).toBe(false);   // not a dated card
    expect(isGemitKey("gemit-2026-07-19")).toBe(false);          // unlisted share id, no scope
    expect(isGemitKey("acme/tetris")).toBe(false);
  });
});
```
(import `isGemitKey` alongside the file's existing imports from `./entityPath`)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -C packages/marketplace test -- entityPath`
Expected: FAIL — `isGemitKey` not exported.

- [ ] **Step 3: Implement** — append to `entityPath.ts`:

```ts
/** A gemit steering-report card's key: <scope>/gemit-YYYY-MM-DD (shape fixed by the CLI's
 *  --share publisher). Drives the invite chrome on the game page; a false negative just
 *  renders the plain player, so the shape check stays strict. */
export function isGemitKey(key: string): boolean {
  return /^[^/]+\/gemit-\d{4}-\d{2}-\d{2}$/.test(key);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -C packages/marketplace test -- entityPath`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/entityPath.ts packages/marketplace/src/entityPath.test.ts
git commit -m "feat(marketplace): isGemitKey — canonical gemit card key discriminator"
```

---

### Task 2: gemit landing chrome on the Play page

**Files:**
- Modify: `packages/marketplace/src/pages/Play.tsx`
- Modify: `packages/marketplace/src/styles.css` (append `.gemit-*` rules)
- Test: `packages/marketplace/src/pages/Play.test.tsx` (append)

**Interfaces:**
- Consumes: `isGemitKey` (Task 1), existing `GamePlayer` non-fullscreen mode.

- [ ] **Step 1: Write the failing tests** — append to `Play.test.tsx`:

```tsx
describe("gemit landing chrome", () => {
  const gemitApi = () => apiStub({
    getGameMeta: vi.fn().mockResolvedValue({ title: "Lapidary — Agent Steering Report", genre: "session-heatmap", version: "1.0.0" }),
  });

  it("renders CTA chrome + inline (non-fullscreen) player for a gemit key", async () => {
    render(<Play api={gemitApi()} gemKey="tester/gemit-2026-07-19" />);
    await waitFor(() => expect(screen.getByText(/What's your steering level\?/)).toBeTruthy());
    expect(screen.getByText("npx -y @ninemind/agentgem gemit")).toBeTruthy();
    // landing embeds the player; it must NOT mount into the fixed fullscreen overlay
    expect(document.querySelector("iframe[sandbox]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /play fullscreen/i })).toBeTruthy();
  });

  it("copy button writes the one-liner to the clipboard", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Play api={gemitApi()} gemKey="tester/gemit-2026-07-19" />);
    await waitFor(() => expect(screen.getByText(/What's your steering level\?/)).toBeTruthy());
    screen.getByRole("button", { name: /copy/i }).click();
    expect(writeText).toHaveBeenCalledWith("npx -y @ninemind/agentgem gemit");
    vi.unstubAllGlobals();
  });

  it("keeps plain fullscreen play for non-gemit keys (no CTA)", async () => {
    render(<Play api={apiStub()} gemKey="@acme/tetris" />);
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
    expect(screen.queryByText(/What's your steering level\?/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm -C packages/marketplace test -- Play`
Expected: existing 4 PASS, new 3 FAIL.

- [ ] **Step 3: Implement Play.tsx**

Add imports: `import { isGemitKey } from "../entityPath";` and `useState` already imported. Replace the final return with:

```tsx
  if (!isGemitKey(gemKey)) {
    return <GamePlayer html={html} interactive startFullscreen onExitFullscreen={() => navigate("/minigames")} />;
  }
  return <GemitLanding html={html} title={title} />;
```

And add (same file, below `Play`):

```tsx
const GEMIT_CMD = "npx -y @ninemind/agentgem gemit";

// Invite chrome around a shared steering card. PAGE chrome on purpose: the sealed
// null-origin iframe can't link out, so the "score yours" loop lives out here.
function GemitLanding({ html, title }: { html: string; title: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(GEMIT_CMD);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mg gemit-landing">
      <h2 className="mg-h">{title ?? "Agent Steering Report"}</h2>
      <p className="mg-intro">Scored from 30 days of real agent sessions — deterministic detectors, no LLM.</p>
      <GamePlayer html={html} interactive />
      <aside className="gemit-cta">
        <h3 className="gemit-cta-q">What's your steering level?</h3>
        <p className="gemit-cta-sub">Score your own last 30 days. Free and local — nothing leaves your machine unless you choose to share.</p>
        <div className="gemit-cmd">
          <code>{GEMIT_CMD}</code>
          <button type="button" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
        </div>
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS rules** — append to `styles.css` (verify with `grep -c "gemit-cta" src/styles.css` > 0 before finishing):

```css
/* ---- gemit landing (invite chrome around a shared steering card) ---- */
.gemit-landing { max-width: 860px; margin: 0 auto; }
.gemit-cta { margin: 22px 0 8px; padding: 18px 20px; border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 12px; background: var(--surface, transparent); }
.gemit-cta-q { font-family: var(--display); font-size: 19px; margin: 0 0 4px; color: var(--ink); }
.gemit-cta-sub { color: var(--muted); margin: 0 0 12px; font-size: 14px; }
.gemit-cmd { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gemit-cmd code { font-family: ui-monospace, Menlo, monospace; font-size: 13.5px; padding: 8px 12px; border: 1px solid var(--line, rgba(127,127,127,.25)); border-radius: 8px; background: var(--surface2, rgba(127,127,127,.08)); color: var(--ink); user-select: all; }
.gemit-cmd button { font: inherit; font-size: 13.5px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line, rgba(127,127,127,.25)); background: var(--ink); color: var(--bg, #fff); cursor: pointer; }
```
Before committing, check which token names actually exist in styles.css (`grep -n ":root" -A 12 src/styles.css | head -20`) and replace any `var(--x, fallback)` whose token is absent with a sibling component's actual values — match the design language, don't invent tokens.

- [ ] **Step 5: Run marketplace suite**

Run: `pnpm -C packages/marketplace test`
Expected: ALL PASS (including the 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/pages/Play.tsx packages/marketplace/src/pages/Play.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): gemit card pages carry the steering-level invite chrome"
```

---

### Task 3: `skills/gemit/SKILL.md` + drift-guard test

**Files:**
- Create: `skills/gemit/SKILL.md`
- Test: `src/__tests__/gemitSkill.test.ts` (root — CI-collected)

- [ ] **Step 1: Write the failing test** — create `src/__tests__/gemitSkill.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The /gemit skill is deliberately THIN: run the CLI, relay the tier, offer --share.
// This guard keeps scoring logic out of the skill and the one-liner exact.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const md = (): string => readFileSync(join(process.cwd(), "skills/gemit/SKILL.md"), "utf8");

describe("gemit skill", () => {
  it("is a skills.sh-discoverable skill file", () => {
    expect(md()).toMatch(/^---\nname: gemit\ndescription: \S/);
  });

  it("carries the exact one-liner and the share offer", () => {
    expect(md()).toContain("npx -y @ninemind/agentgem gemit");
    expect(md()).toContain("--share");
  });

  it("keeps all scoring in the CLI and the publish consent with the user", () => {
    expect(md()).toContain("Never estimate, adjust, or re-derive a score");
    expect(md()).toMatch(/Don't pass `--yes`/);
  });

  it("stays thin", () => {
    expect(md().length).toBeLessThan(3000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsc -b && npx vitest run dist/__tests__/gemitSkill.test.js`
Expected: FAIL — ENOENT `skills/gemit/SKILL.md`.

- [ ] **Step 3: Create `skills/gemit/SKILL.md`:**

```markdown
---
name: gemit
description: Use when the user wants to score their agent steering — "how well am I steering my agents", "what's my steering level", "run gemit". Runs the AgentGem gemit self-assessment: one npx command, a local HTML report, optional share.
---

# gemit

Score the user's last 30 days of coding-agent steering into a local report.

## Procedure

1. Run: `npx -y @ninemind/agentgem gemit`
   - It scans local transcripts (last 30 days), scores context discipline, process
     quality, and setup maturity with deterministic detectors (no LLM), and writes a
     self-contained HTML report.
   - On a TTY the report opens in the browser; otherwise open the printed `Report:` path.
2. Relay the printed tier and the three scores to the user in one line.
3. Offer the share. If the user wants their card published, run
   `npx -y @ninemind/agentgem gemit --share`.
   - It shows exactly what would ship (scores, counts, window dates — never
     skill/subagent names, project names, or transcripts) and asks for confirmation.
   - It prints the card URL and a prefilled X share link — hand both to the user.

## Rules

- All scoring lives in the CLI. Never estimate, adjust, or re-derive a score yourself.
- Don't pass `--yes` for the user — the pre-publish confirmation is theirs to answer.
- Fewer than 5 substantial sessions? Relay that the sheet fills itself after a few
  more steered sessions; don't apologize for the tool.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsc -b && npx vitest run dist/__tests__/gemitSkill.test.js`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add skills/gemit/SKILL.md src/__tests__/gemitSkill.test.ts
git commit -m "feat(gemit): thin /gemit skill — run the CLI, relay the tier, offer --share"
```

---

### Task 4: Full verification + PR

- [ ] **Step 1:** `pnpm build` then `npx vitest run` (root, what CI gates) AND `pnpm -C packages/marketplace test` — all green.
- [ ] **Step 2:** Commit the plan doc; push `feat/gemit-landing`; `gh pr create` (mechanics-only body); `gh run watch <id> --exit-status`; `gh pr merge --rebase --delete-branch` (local delete errors — verify remote merge landed).
- [ ] **Step 3:** Verify EVERY commit's content on origin/main (`git show origin/main:packages/marketplace/src/pages/Play.tsx | grep -c gemit`, `git show origin/main:skills/gemit/SKILL.md | head -2`, `git show origin/main:packages/marketplace/src/entityPath.ts | grep -c isGemitKey`).

---

### Task 5 (post-merge ops): OG unfurl e2e on a real unlisted card

- [ ] **Step 1:** Publish a real card from the PR-2 CLI: `node dist/cli.js gemit --share --yes` (user's own data; unlisted; upsert-keyed by today's date so it's re-runnable and unpublishable from My apps).
- [ ] **Step 2:** `curl -s "https://api.agentgem.ai/games/<key>" | grep -o '<meta property="og:[^>]*>'` — expect `og:title` with the tier name and an `og:image` pointing at `/og/card.png?type=game&key=…`.
- [ ] **Step 3:** `curl -s -o /dev/null -w "%{http_code} %{content_type}" "https://api.agentgem.ai/og/card.png?type=game&key=<url-encoded-key>"` — expect `200 image/png`.
- [ ] **Step 4:** Report the live card URL + unfurl result. Note: the new landing chrome appears on app.agentgem.ai only after the next marketplace deploy — call that out if not yet visible.
