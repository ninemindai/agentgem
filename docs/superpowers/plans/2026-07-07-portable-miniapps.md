# Portable Miniapps (redact + bake + publish gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every source-seeded miniapp self-contained so it runs everywhere — offline and on app.agentgem.ai (which has no capability broker) — by baking a *redacted* snapshot of the author's source and blocking publish of any miniapp that would need a host to render.

**Architecture:** Three pure additions in `packages/play`, wired at two existing seams. (1) A `redactForBake` string-scrubber removes the author's home path, secret-looking tokens, and caps timeline size. (2) `seedStudio` stops skipping the data-bake for replay and bakes `redactForBake(data)` for every genre — the replay scaffold already renders from baked `#game-data` *and* upgrades on a broker `agentgem:feed`, so baking makes it portable while the local broker can still upgrade it. (3) `assertPortable(html, needs)` fails a save when a game declares a content-critical capability (`session-data`) but bakes no fallback, wired into `saveMiniapp` (the prerequisite of publish).

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 24, Vitest (runs compiled `dist/**`), `@agentgem/play` workspace package, no new dependencies.

## Global Constraints

- **Node floor ≥ 24**, ESM only (`.js` import specifiers in TS source).
- **No new dependencies.** Redaction uses only `node:os` / `node:path` and regex.
- **Package source** lives in `packages/play/src/`; **its tests** live in root `src/play/__tests__/` and import the built `@agentgem/play` (never a relative `../../packages` path).
- **Tests run against compiled dist.** Always build before running: `npx tsc -b` compiles both the package and the root test tree into `dist/`. Vitest `include` is `dist/**/__tests__/**/*.test.js`.
- **New exports** must be re-exported from `packages/play/src/index.ts`.
- **Redaction is best-effort de-identification, not a security boundary** — say so in code comments; do not claim it guarantees no leakage.
- **Scope isolation:** this is a *separate scope* from the auto-send change already in PR #194. Execute on a **new branch off freshly-fetched `origin/main`** (per repo `CLAUDE.md`: one PR = one settled scope). Do not append to `feat/play-blank-first-prompt`.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `packages/play/src/redact.ts` — `redactForBake(data)`: deep string-scrub + shape-aware trims. One responsibility: de-identify baked source data.
- **Create** `packages/play/src/portability.ts` — `assertPortable(html, needs)`: the "runs without a host" invariant.
- **Modify** `packages/play/src/index.ts` — re-export the two new symbols.
- **Modify** `packages/play/src/studio.ts:63-66` — bake redacted data for every genre (reverse the replay skip).
- **Modify** `packages/play/src/miniapps.ts:38-39` — call `assertPortable` in `saveMiniapp` after `gameGate`.
- **Create** `src/play/__tests__/redact.test.ts`
- **Create** `src/play/__tests__/portability.test.ts`
- **Modify** `src/play/__tests__/studio.test.ts:38-46` — replay now bakes redacted data (was: asserts no bake).

---

### Task 1: Redactor (`redactForBake`)

**Files:**
- Create: `packages/play/src/redact.ts`
- Modify: `packages/play/src/index.ts`
- Test: `src/play/__tests__/redact.test.ts`

**Interfaces:**
- Consumes: nothing (pure; `node:os`, `node:path` only).
- Produces: `export function redactForBake(data: unknown): unknown` — returns a deep copy with the current user's home-dir prefix replaced by `~`, secret-looking tokens replaced by `‹redacted›`, any `timeline` array capped to 500 entries, any `path` string reduced to its basename, and any `files` string array reduced to basenames. Non-string/loose values pass through unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/redact.test.ts`:

```typescript
// src/play/__tests__/redact.test.ts
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { redactForBake } from "@agentgem/play";

describe("redactForBake", () => {
  it("replaces the user's home-dir prefix with ~ in any string", () => {
    const home = homedir();
    const out = redactForBake({ timeline: [{ text: `edited ${home}/proj/app.ts` }] }) as { timeline: { text: string }[] };
    expect(out.timeline[0].text).toBe("edited ~/proj/app.ts");
    expect(out.timeline[0].text).not.toContain(home);
  });

  it("redacts secret-looking tokens", () => {
    const out = redactForBake({ meta: { note: "key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 here" } }) as { meta: { note: string } };
    expect(out.meta.note).toBe("key ‹redacted› here");
  });

  it("caps a long timeline to 500 entries", () => {
    const timeline = Array.from({ length: 620 }, (_, i) => ({ role: "user", text: `t${i}` }));
    const out = redactForBake({ timeline }) as { timeline: unknown[] };
    expect(out.timeline).toHaveLength(500);
  });

  it("reduces a project path + files to basenames (no local dir leak)", () => {
    const out = redactForBake({ path: "/Users/someone/work/secret-proj", flavor: "node", files: ["/Users/someone/work/secret-proj/package.json"] }) as { path: string; files: string[] };
    expect(out.path).toBe("secret-proj");
    expect(out.files).toEqual(["package.json"]);
  });

  it("passes non-string primitives through and does not mutate the input", () => {
    const input = { meta: { msgs: 3, ok: true }, timeline: [] };
    const out = redactForBake(input) as typeof input;
    expect(out).toEqual({ meta: { msgs: 3, ok: true }, timeline: [] });
    expect(out).not.toBe(input);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/redact.test.js`
Expected: FAIL — `redactForBake` is not exported from `@agentgem/play` (build error / import undefined).

- [ ] **Step 3: Write the implementation**

Create `packages/play/src/redact.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// De-identify the source data BEFORE it is baked into a shareable, publicly-runnable miniapp bundle.
// Best-effort scrubbing (home-dir path + common secret token shapes), NOT a security guarantee — a
// determined leak in free-form transcript text can still slip through. The point is to keep the obvious
// author-identifying bits (home path, API keys) out of an artifact that will run on app.agentgem.ai.
import { homedir } from "node:os";
import { basename } from "node:path";

// Common secret shapes: OpenAI (sk-…), GitHub (ghp_/gho_/ghu_/ghs_/ghr_…), AWS access key (AKIA…),
// Slack (xoxb-/xoxp-…), and JWTs (three base64url segments).
const TOKEN =
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

const MAX_TIMELINE = 500;

function redactText(s: string): string {
  const home = homedir();
  const dehomed = home ? s.split(home).join("~") : s;
  return dehomed.replace(TOKEN, "‹redacted›");
}

export function redactForBake(data: unknown): unknown {
  return walk(data);
  function walk(v: unknown): unknown {
    if (typeof v === "string") return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "timeline" && Array.isArray(val)) { out[k] = val.slice(0, MAX_TIMELINE).map(walk); continue; }
        if (k === "files" && Array.isArray(val)) { out[k] = val.map((f) => (typeof f === "string" ? basename(f) : walk(f))); continue; }
        if (k === "path" && typeof val === "string") { out[k] = basename(val); continue; }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
}
```

Add to `packages/play/src/index.ts` (alongside the existing exports):

```typescript
export { redactForBake } from "./redact.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/redact.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/redact.ts packages/play/src/index.ts src/play/__tests__/redact.test.ts
git commit -m "feat(play): add redactForBake to de-identify baked miniapp source data

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bake a redacted snapshot for every genre (portable replay)

**Files:**
- Modify: `packages/play/src/studio.ts:63-66`
- Test: `src/play/__tests__/studio.test.ts:38-46` (update existing) + one new assertion

**Interfaces:**
- Consumes: `redactForBake` (Task 1); existing `seedHtml`, `scaffoldFor`, `genreFor`, `extractSource`.
- Produces: no signature change to `seedStudio`. Behavior change: the written `<name>.html` now contains a baked `<script id="game-data" type="application/json">…</script>` for **all** seeded genres (replay included), and its content is redacted. `meta.needs` is unchanged (broker-fed genres still declare `session-data` so a *local* host can upgrade the baked snapshot later — Follow-on).

- [ ] **Step 1: Update the existing replay test to the new contract, and add a redaction assertion**

In `src/play/__tests__/studio.test.ts`, replace the test at lines 38-46 with:

```typescript
  it("seedStudio for a session (replay) bakes a redacted snapshot AND keeps the session-data need for local upgrade", async () => {
    const secretReaders: SourceReaders = {
      ...readers,
      loadSession: async (id) => ({ sessionId: id, meta: { msgs: 1 }, turns: [{ role: "assistant", text: "used ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 to push" }] }),
    };
    const { name } = await seedStudio({ kind: "session", agent: "claude", sessionId: "s1", summary: "auth" }, secretReaders);
    const dir = join(miniappsRoot(), name);
    const html = readFileSync(join(dir, `${name}.html`), "utf8");
    expect(html).toContain('id="game-data" type="application/json"'); // now baked → runs with no host
    expect(html).toContain("‹redacted›");                             // the token was scrubbed
    expect(html).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.needs).toEqual(["session-data"]);                    // still declared for the local upgrade path
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/studio.test.js`
Expected: FAIL — current `seedStudio` skips the bake for broker-fed genres, so `html` has no `id="game-data"` and no `‹redacted›`.

- [ ] **Step 3: Make the change**

In `packages/play/src/studio.ts`, add the import near the other `./` imports:

```typescript
import { redactForBake } from "./redact.js";
```

Then replace lines 63-66 (the `brokerFed` block) with:

```typescript
  // Bake a REDACTED, self-contained snapshot so the miniapp runs everywhere — offline and on
  // app.agentgem.ai, which has no capability broker. Broker-fed genres additionally keep their `needs`
  // (below) so a LOCAL host can later upgrade the baked snapshot to fresh/full data; the scaffold already
  // renders from the baked <script id="game-data"> and re-renders on an agentgem:feed.
  writeFileSync(join(dir, `${name}.html`), seedHtml(scaffoldFor(g.scaffold), redactForBake(input.data)));
```

(The following `const meta = … needs …` line and everything else stays as-is.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/studio.test.js`
Expected: PASS (all `studio` tests, including the updated replay test and the pre-existing project/skill/blank tests).

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/studio.ts src/play/__tests__/studio.test.ts
git commit -m "feat(play): bake a redacted snapshot for every seeded genre so replays run without a host

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Publish portability gate (`assertPortable`) wired into `saveMiniapp`

**Files:**
- Create: `packages/play/src/portability.ts`
- Modify: `packages/play/src/index.ts`
- Modify: `packages/play/src/miniapps.ts:38-39`
- Test: `src/play/__tests__/portability.test.ts`

**Interfaces:**
- Consumes: `GameCapability` type from `@agentgem/model`; the baked-HTML shape produced by `seedHtml` (`<script id="game-data" type="application/json">{…,"timeline":[…]}</script>`).
- Produces:
  - `export interface PortabilityResult { ok: boolean; failures: string[] }`
  - `export function assertPortable(html: string, needs: GameCapability[] | undefined): PortabilityResult` — `ok:false` when the game declares a content-critical capability (`session-data`) but the HTML has no baked, non-empty `timeline`.
  - `saveMiniapp` now throws `miniapp is not portable: <reasons>` when `assertPortable` fails (after the existing `gameGate`).

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/portability.test.ts`:

```typescript
// src/play/__tests__/portability.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPortable, saveMiniapp } from "@agentgem/play";

const sealed = (body: string) => `<!doctype html><html><head></head><body>${body}<script>/* sealed */</script></body></html>`;
const baked = (timeline: unknown[]) => `<script id="game-data" type="application/json">${JSON.stringify({ meta: {}, timeline })}</script>`;

describe("assertPortable", () => {
  it("passes a session-data game that bakes a non-empty timeline", () => {
    const r = assertPortable(sealed(baked([{ role: "user", text: "hi" }])), ["session-data"]);
    expect(r.ok).toBe(true);
  });

  it("fails a session-data game that bakes no data", () => {
    const r = assertPortable(sealed(""), ["session-data"]);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/would not run without a host/i);
  });

  it("fails a session-data game whose baked timeline is empty", () => {
    const r = assertPortable(sealed(baked([])), ["session-data"]);
    expect(r.ok).toBe(false);
  });

  it("passes a game that declares no needs, even with no baked data", () => {
    expect(assertPortable(sealed(""), undefined).ok).toBe(true);
    expect(assertPortable(sealed(""), []).ok).toBe(true);
  });
});

describe("saveMiniapp portability gate", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

  it("rejects saving a session-data miniapp with no baked fallback", async () => {
    await expect(saveMiniapp({
      name: "bad-replay",
      html: sealed(""),
      meta: { title: "Bad", genre: "replay", createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "x" }, engineVersion: "1", needs: ["session-data"] },
    })).rejects.toThrow(/not portable/i);
  });

  it("allows saving a session-data miniapp that bakes a fallback", async () => {
    const res = await saveMiniapp({
      name: "good-replay",
      html: sealed(baked([{ role: "user", text: "hi" }])),
      meta: { title: "Good", genre: "replay", createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "x" }, engineVersion: "1", needs: ["session-data"] },
    });
    expect(res.name).toBe("good-replay");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/portability.test.js`
Expected: FAIL — `assertPortable` is not exported.

- [ ] **Step 3: Write the implementation**

Create `packages/play/src/portability.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Publish invariant: a shared miniapp must render with NO host. app.agentgem.ai plays games in a sealed
// iframe with no capability broker, so a game that depends on a host-brokered content feed would sit
// empty there. Content-critical capabilities must therefore ship a baked, self-contained fallback.
import type { GameCapability } from "@agentgem/model";

export interface PortabilityResult { ok: boolean; failures: string[] }

// Caps whose data IS the game's primary content (so it must be baked to run offline). The privileged /
// live caps (invoke-agent, live-session-events, local-project-access) are local-only by design and are
// intentionally NOT in this list — a game may use them as an enhancement over a baked default.
const CONTENT_CAPS: readonly GameCapability[] = ["session-data"];

export function assertPortable(html: string, needs: GameCapability[] | undefined): PortabilityResult {
  const failures: string[] = [];
  const declaresContentCap = (needs ?? []).some((c) => CONTENT_CAPS.includes(c));
  if (declaresContentCap && !hasBakedTimeline(html)) {
    failures.push("declares session-data but bakes no fallback data — it would not run without a host (e.g. on app.agentgem.ai)");
  }
  return { ok: failures.length === 0, failures };
}

function hasBakedTimeline(html: string): boolean {
  const m = /<script[^>]*id="game-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return false;
  try {
    const d = JSON.parse(m[1] || "{}") as { timeline?: unknown };
    return Array.isArray(d.timeline) && d.timeline.length > 0;
  } catch { return false; }
}
```

Add to `packages/play/src/index.ts`:

```typescript
export { assertPortable, type PortabilityResult } from "./portability.js";
```

In `packages/play/src/miniapps.ts`, add the import next to the `gameGate` import:

```typescript
import { assertPortable } from "./portability.js";
```

Then in `saveMiniapp`, immediately after the existing gate block (lines 38-39):

```typescript
  const gate = await gameGate(input.html);
  if (!gate.ok) throw new Error(`miniapp failed the gate: ${gate.failures.join("; ")}`);
  const port = assertPortable(input.html, input.meta.needs);
  if (!port.ok) throw new Error(`miniapp is not portable: ${port.failures.join("; ")}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/portability.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full play suite to check for regressions**

Run: `npx tsc -b && npx vitest run dist/play`
Expected: PASS (all `dist/play/__tests__/*` — redact, portability, studio, miniapps, gameGate*, sourceContext, scaffolds, genres, git, readMiniapp).

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/portability.ts packages/play/src/index.ts packages/play/src/miniapps.ts src/play/__tests__/portability.test.ts
git commit -m "feat(play): gate saveMiniapp on portability — session-data games must bake a fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite (dist), since some tests hardcode cross-module counts:**

Run: `npx tsc -b && npx vitest run`
Expected: PASS. If a pre-existing real-FS scan test flakes under full-suite concurrency, re-run it in isolation to confirm it is unrelated (known flake; see repo memory).

- [ ] **Open a PR** off freshly-fetched `origin/main` (new branch, e.g. `feat/portable-miniapps`), let CI (`test (24)` + `test (26)`) gate it, and merge with `--rebase` once green. Do **not** reuse the PR #194 branch.

---

## Follow-on (separate plan): local viewer-rebindable replay

This slice makes replays **portable** (they run everywhere on the author's baked snapshot). It does **not** yet let a viewer rebind a replay to their *own* session — that is a distinct subsystem (Runner broker + a host-side session picker + a new route + consent + a scaffold affordance) and should be its own plan. Sketch of that follow-on, for reference:

1. **New capability `pick-session`** (`@agentgem/model` `GameCapability`, `playMeta.ts`/`consent.ts` labels) — gated (the picker is the consent).
2. **Scaffold**: change `replayScaffold` so that even when baked data is present it still requests an *upgrade* (today it only requests when the baked timeline is empty — `scaffolds.ts:169`); render baked first, re-render on feed.
3. **Runner** (`Runner.tsx` `serve`): handle `pick-session` by listing the viewer's local sessions (`fetchSessions`, already used for `live-session-events`) in a host-owned picker overlay, then feeding the chosen session's compacted data as `channel:"session-data"`. The sealed game never names a session — it only asks for the capability; the host picks. Marketplace has no Runner, so this is inert there (baked default shows).
4. **Route**: extend `playSessionDataRoute` / `sessionData` (`play.controller.ts:50`) with an optional `sessionId`+`agent`, honored only when it matches a session in the host's own list.

Because the baked default (this plan) always renders, adding these caps never breaks "runs everywhere": the broker stays a pure local enhancement.
