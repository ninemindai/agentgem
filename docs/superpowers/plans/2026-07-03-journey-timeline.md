# `/journey` Unified Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One chronological timeline of everything AgentGem learned (queue items across all statuses, dream passes, verification-ledger records) — `GET /api/journey` + the Dreaming panel grown into "Journey".

**Architecture:** A tolerant ledger reader (`readVerifications`) joins the existing queue/diary readers; a pure `buildJourney` core merges the three sources into typed events (newest first, kind filter, limit+truncated); a thin `GET /api/journey` on the dream controller; the Dreaming panel's review/diary tabs become one timeline with kind filter chips, keeping the status strip, accept/dismiss, and the opportunity→Curate bridge. Spec: `docs/superpowers/specs/2026-07-03-journey-timeline-design.md`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest from compiled `dist/` for backend (`pnpm exec tsc -b && pnpm exec vitest run dist/<path>.test.js`), React + @testing-library for the console (`pnpm --dir packages/console test` — NOT in CI, must run locally).

## Global Constraints

- Working dir: the `../agentgem-journey` worktree, branch `journey`.
- A lens, not a store: the only mutations are the existing `/dream/queue/accept|dismiss` endpoints; `buildJourney` writes nothing.
- All three source readers are tolerant: missing/corrupt files → empty contributions; `GET /api/journey` never 500s for store-shape reasons.
- One event per queue item (ts = `reviewedMs ?? firstSeenMs`), not two.
- Panel id stays `dreaming` (navigation stability); title becomes "Journey"; icon 🌙, order 9, group observe unchanged; the opportunity→Curate bridge and the dream status strip are preserved.
- Node built-ins only; no new dependencies. Commits `feat(scope):`/`test(scope):`.

---

### Task 1: `readVerifications` — the ledger's first reader

**Files:**
- Modify: `packages/run/src/evidenceLedger.ts` (append the function)
- Test: `src/gem/__tests__/evidenceLedger.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ledgerPath(home?)`, `VerificationRecord`, `appendVerification`.
- Produces: `readVerifications(home?: string, limit = 500): VerificationRecord[]` exported from `@agentgem/run` — Task 2 consumes it.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/evidenceLedger.test.ts` (reuse its existing imports and `rec` fixture; extend the `@agentgem/run` import with `readVerifications` and the `node:fs` import with `appendFileSync`):

```ts
  it("readVerifications returns records, skipping corrupt lines, keeping the newest `limit`", () => {
    const home = mkdtempSync(join(tmpdir(), "agem-ledger-"));
    try {
      appendVerification(rec, home);
      appendFileSync(ledgerPath(home), "{corrupt-not-json\n", "utf8");
      appendVerification({ ...rec, agent: "codex" }, home);
      const all = readVerifications(home);
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.agent)).toEqual(["claude", "codex"]);
      expect(readVerifications(home, 1).map((r) => r.agent)).toEqual(["codex"]); // newest kept
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("readVerifications returns [] for a missing ledger", () => {
    expect(readVerifications(join(tmpdir(), "agem-no-such-ledger"))).toEqual([]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/evidenceLedger.test.js`
Expected: FAIL at compile — `readVerifications` not exported.

- [ ] **Step 3: Implement**

Append to `packages/run/src/evidenceLedger.ts` (extend the `node:fs` import with `readFileSync`):

```ts
// Tolerant read — the writer is best-effort append, so a torn/corrupt line must not
// break every future read: unparseable lines are skipped. Returns file order
// (oldest→newest), keeping only the newest `limit` parseable records.
export function readVerifications(home?: string, limit = 500): VerificationRecord[] {
  let raw: string;
  try { raw = readFileSync(ledgerPath(home), "utf8"); } catch { return []; }
  const out: VerificationRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as VerificationRecord); } catch { /* torn line — skip */ }
  }
  return out.slice(-limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/evidenceLedger.test.js`
Expected: PASS (4 tests: 2 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/evidenceLedger.ts src/gem/__tests__/evidenceLedger.test.ts
git commit -m "feat(run): readVerifications — tolerant reader for the evidence ledger"
```

---

### Task 2: `buildJourney` aggregation core

**Files:**
- Create: `src/journeyCore.ts`
- Test: `src/__tests__/journeyCore.test.ts` (new)

**Interfaces:**
- Consumes: `readQueue`, `readDiary` from `./dream/store.js` (both take `(base?: string)`); `readVerifications` from `@agentgem/run` (Task 1); `DreamQueueEntry`/`DreamDiaryEntry` from `./dream/types.js`.
- Produces (Tasks 3–4 rely on exact names): `JourneyEvent`, `JourneyResult { events, truncated }`, `buildJourney(opts: { base?; kind?; limit?; readLedger? }): JourneyResult`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/journeyCore.test.ts`:

```ts
// src/__tests__/journeyCore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJourney } from "../journeyCore.js";
import { enqueueNew, setStatus, appendDiary } from "../dream/store.js";
import type { DreamQueueEntry } from "../dream/types.js";
import type { VerificationRecord } from "@agentgem/run";

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "journey-")); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const entry = (over: Partial<DreamQueueEntry>): DreamQueueEntry => ({
  key: "skill:/p:s1:h", kind: "skill", root: "/p", name: "s1", summary: "does s1",
  phase: "DEEP", draft: {} as DreamQueueEntry["draft"], status: "queued", firstSeenMs: 100, ...over,
});
const verification = (ts: string, over: Partial<VerificationRecord> = {}): VerificationRecord => ({
  ts, gemName: "g", agent: "claude", contractApplied: true,
  run: { ok: true, toolCalls: 1 },
  verification: { passed: true, checks: [{ name: "no tool failures", passed: true, detail: "ok" }] },
  ...over,
});

describe("buildJourney", () => {
  it("merges queue + diary + ledger newest-first, one event per queue item", () => {
    enqueueNew([entry({})], base);                                   // ts 100 (queued)
    enqueueNew([entry({ key: "lesson:/p:l1", kind: "lesson", name: "l1", phase: "LEARN", firstSeenMs: 300 })], base);
    setStatus("skill:/p:s1:h", "accepted", 500, base);               // reviewed → ts 500
    appendDiary({ atMs: 200, passId: 1, rootsProcessed: ["/p"], phasesLit: ["DEEP"], enqueued: { skills: 1, lessons: 0 }, degraded: false }, base);
    const r = buildJourney({ base, readLedger: () => [verification(new Date(400).toISOString())] });
    expect(r.truncated).toBe(false);
    expect(r.events.map((e) => `${e.kind}@${e.ts}`)).toEqual([
      "skill@500", "verified@400", "lesson@300", "pass@200",
    ]);
    const skill = r.events[0];
    expect(skill).toMatchObject({ status: "accepted", firstSeenMs: 100, key: "skill:/p:s1:h", root: "/p" });
    const learn = r.events[2];
    expect(learn).toMatchObject({ phase: "LEARN", status: "queued" });
    const verified = r.events[1];
    expect(verified).toMatchObject({ title: "g", agent: "claude", passed: true });
  });

  it("filters by kind server-side", () => {
    enqueueNew([entry({})], base);
    const r = buildJourney({ base, kind: "verified", readLedger: () => [verification(new Date(50).toISOString())] });
    expect(r.events.map((e) => e.kind)).toEqual(["verified"]);
  });

  it("applies limit newest-first and reports truncation", () => {
    enqueueNew([entry({}), entry({ key: "skill:/p:s2:h", name: "s2", firstSeenMs: 900 })], base);
    const r = buildJourney({ base, limit: 1, readLedger: () => [] });
    expect(r.events.map((e) => e.title)).toEqual(["s2"]);
    expect(r.truncated).toBe(true);
  });

  it("skips ledger records with unparseable timestamps; empty stores yield empty result", () => {
    const bad = buildJourney({ base, readLedger: () => [verification("not-a-date")] });
    expect(bad.events).toEqual([]);
    expect(bad.truncated).toBe(false);
  });

  it("verified failure events carry the first failed check as detail", () => {
    const rec = verification(new Date(10).toISOString(), {
      verification: { passed: false, checks: [{ name: "c1", passed: true, detail: "ok" }, { name: "c2", passed: false, detail: "missed" }] },
    });
    const r = buildJourney({ base, readLedger: () => [rec] });
    expect(r.events[0]).toMatchObject({ passed: false, detail: "c2: missed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/journeyCore.test.js`
Expected: FAIL at compile — `../journeyCore.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/journeyCore.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/journeyCore.ts
//
// The /journey timeline: a pure read-side merge of everything AgentGem learned —
// dream-queue items (ALL statuses, so accepted/dismissed history is visible),
// dream passes, and the verification-evidence ledger. A lens, not a store: this
// module writes nothing; the only mutations stay on the existing queue endpoints.
import { readVerifications } from "@agentgem/run";
import { readQueue, readDiary } from "./dream/store.js";

export interface JourneyEvent {
  ts: number;                                   // epoch ms, sort key (newest first)
  kind: "skill" | "lesson" | "opportunity" | "pass" | "verified";
  title: string;
  detail?: string;
  status?: "queued" | "accepted" | "dismissed"; // queue-backed events only
  phase?: "DEEP" | "REM" | "LEARN";             // queue-backed events only
  key?: string;                                 // queue key — with status "queued", enables actions
  firstSeenMs?: number;                         // queue-backed: when it originally queued
  root?: string;
  agent?: string;                               // verified events
  passed?: boolean;                             // verified events
}

export interface JourneyResult { events: JourneyEvent[]; truncated: boolean }

export function buildJourney(opts: {
  base?: string;
  kind?: JourneyEvent["kind"];
  limit?: number;
  readLedger?: typeof readVerifications;
} = {}): JourneyResult {
  const limit = opts.limit ?? 100;
  const events: JourneyEvent[] = [];

  for (const e of readQueue(opts.base)) {
    events.push({
      ts: e.reviewedMs ?? e.firstSeenMs,
      kind: e.kind, title: e.name, detail: e.summary,
      status: e.status, phase: e.phase, key: e.key,
      firstSeenMs: e.firstSeenMs, root: e.root,
    });
  }
  for (const d of readDiary(opts.base)) {
    events.push({
      ts: d.atMs, kind: "pass", title: `dream pass #${d.passId}`,
      detail: `${d.phasesLit.join("+") || "no phases"} · +${d.enqueued.skills} skills · +${d.enqueued.lessons} lessons · +${d.enqueued.opportunities ?? 0} opportunities${d.degraded ? " · degraded" : ""}`,
      root: d.rootsProcessed.length === 1 ? d.rootsProcessed[0] : undefined,
    });
  }
  for (const r of (opts.readLedger ?? readVerifications)(opts.base)) {
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) continue;             // torn record — skip, never throw
    const firstFail = r.verification.checks.find((c) => !c.passed);
    events.push({
      ts, kind: "verified",
      title: r.gemName ?? r.gemDigest ?? "gem",
      detail: firstFail ? `${firstFail.name}: ${firstFail.detail}` : "all checks passed",
      agent: r.agent, passed: r.verification.passed,
    });
  }

  const filtered = (opts.kind ? events.filter((e) => e.kind === opts.kind) : events)
    .sort((a, b) => b.ts - a.ts);
  return { events: filtered.slice(0, limit), truncated: filtered.length > limit };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/journeyCore.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/journeyCore.ts src/__tests__/journeyCore.test.ts
git commit -m "feat(journey): buildJourney — merge queue, passes, and verifications into one timeline"
```

---

### Task 3: `GET /api/journey`

**Files:**
- Modify: `src/dream.controller.ts` (schemas near the existing ones; endpoint method after `diary`)
- Test: `src/__tests__/dream.controller.test.ts` (extend)

**Interfaces:**
- Consumes: `buildJourney`, `JourneyEvent` (Task 2); `appendVerification` from `@agentgem/run` (test seeding).
- Produces: `GET /api/journey?kind=&limit=` → `{ events, truncated }`, bad `kind` → 400 (schema enum). Task 4's console fetcher targets this.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/dream.controller.test.ts` (extend the `@agentgem/run` import — the file may not have one; add `import { appendVerification } from "@agentgem/run";`):

```ts
  it("GET /journey merges queue and ledger events newest-first", async () => {
    enqueueNew([lessonEntry()], base);           // firstSeenMs: 1
    appendVerification({
      gemName: "g", agent: "claude", contractApplied: true,
      run: { ok: true, toolCalls: 1 },
      verification: { passed: true, checks: [] },
    }, base);                                    // ts: now (newest)
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const r = await c.journey({ query: {} });
    expect(r.events.map((e) => e.kind)).toEqual(["verified", "lesson"]);
    expect(r.truncated).toBe(false);
  });

  it("GET /journey filters by kind", async () => {
    enqueueNew([lessonEntry(), skillEntry()], base);
    const c = new DreamController();
    (c as unknown as { base: string }).base = base;
    const r = await c.journey({ query: { kind: "skill" } });
    expect(r.events.map((e) => e.kind)).toEqual(["skill"]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/dream.controller.test.js`
Expected: FAIL at compile — `c.journey` does not exist.

- [ ] **Step 3: Implement**

In `src/dream.controller.ts`, add near the other schemas:

```ts
const JourneyQuerySchema = z.object({
  kind: z.enum(["skill", "lesson", "opportunity", "pass", "verified"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
const JourneyEventSchema = z.object({
  ts: z.number(),
  kind: z.enum(["skill", "lesson", "opportunity", "pass", "verified"]),
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(["queued", "accepted", "dismissed"]).optional(),
  phase: z.enum(["DEEP", "REM", "LEARN"]).optional(),
  key: z.string().optional(),
  firstSeenMs: z.number().optional(),
  root: z.string().optional(),
  agent: z.string().optional(),
  passed: z.boolean().optional(),
});
const JourneySchema = z.object({ events: z.array(JourneyEventSchema), truncated: z.boolean() });
```

Import: `import { buildJourney } from "./journeyCore.js";` and add the method after `diary`:

```ts
  // The unified learning timeline: queue items (all statuses), dream passes, and
  // verification-ledger records, newest first. A read-side lens — mutations stay
  // on the queue endpoints above.
  @get("/journey", { query: JourneyQuerySchema, response: JourneySchema })
  async journey(input: { query: z.infer<typeof JourneyQuerySchema> }): Promise<z.infer<typeof JourneySchema>> {
    return buildJourney({ base: this.base, kind: input.query.kind, limit: input.query.limit });
  }
```

(Note: `@api({ basePath: "/api" })` on the class makes the route `/api/journey` — intentionally not under `/dream/`, matching the spec's endpoint name.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/dream.controller.test.js dist/__tests__/journeyCore.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/dream.controller.ts src/__tests__/dream.controller.test.ts
git commit -m "feat(journey): GET /api/journey — the unified timeline endpoint"
```

---

### Task 4: Dreaming panel becomes Journey

**Files:**
- Modify: `packages/console/src/panels/Dreaming/api.ts`
- Modify: `packages/console/src/panels/Dreaming/index.tsx`
- Test: `packages/console/src/panels/Dreaming/Dreaming.test.tsx` (rewrite)

**Interfaces:**
- Consumes: `GET /api/journey` (Task 3 shape), existing `/api/dream/status`, `/api/dream/queue/accept|dismiss`, `/api/dream/enable`, `/api/dream/run`.
- Produces: panel title "Journey" (id `dreaming` unchanged); timeline UI with kind filter chips; accept/dismiss/Publish→ on queued events.

- [ ] **Step 1: Rewrite the panel test (failing first)**

Replace `packages/console/src/panels/Dreaming/Dreaming.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Dreaming } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const EVENTS = [
  { ts: 500, kind: "skill", title: "foo", detail: "does foo", status: "queued", phase: "LEARN", key: "k1", firstSeenMs: 500, root: "/p" },
  { ts: 400, kind: "verified", title: "qa-gem", detail: "all checks passed", agent: "claude", passed: true },
  { ts: 300, kind: "opportunity", title: "sess-1", detail: "ship it", status: "queued", key: "o1", firstSeenMs: 300, root: "/proj" },
  { ts: 200, kind: "pass", title: "dream pass #1", detail: "DEEP · +3 skills · +1 lessons · +0 opportunities" },
  { ts: 100, kind: "lesson", title: "use-pnpm", detail: "use pnpm", status: "dismissed", key: "k2", firstSeenMs: 50, root: "/p" },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 2, lastPassAtMs: 1 }));
    if (url.includes("/api/journey")) {
      const kind = new URL(url, "http://x").searchParams.get("kind");
      const events = kind ? EVENTS.filter((e) => e.kind === kind) : EVENTS;
      return new Response(JSON.stringify({ events, truncated: false }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe("Journey panel", () => {
  it("renders all event kinds on one timeline with the status strip", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("foo")).toBeTruthy());
    expect(screen.getByText("qa-gem")).toBeTruthy();       // verified
    expect(screen.getByText("dream pass #1")).toBeTruthy(); // pass
    expect(screen.getByText("use-pnpm")).toBeTruthy();      // dismissed lesson (history visible)
    expect(screen.getByText(/2 promoted/i)).toBeTruthy();   // status strip intact
    expect(screen.getByText("LEARN")).toBeTruthy();          // phase badge
  });

  it("filter chips refetch with ?kind=", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /^verified$/i }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("/api/journey?kind=verified"))).toBe(true));
  });

  it("accept posts to the accept endpoint for a queued skill", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getAllByRole("button", { name: /^accept$/i })[0]);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).endsWith("/api/dream/queue/accept"))).toBe(true));
  });

  it("reviewed events show status and no action buttons", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("use-pnpm"));
    expect(screen.getByText("dismissed")).toBeTruthy();
    // one queued skill + one queued opportunity → exactly 1 Accept and 2 Dismiss buttons
    expect(screen.getAllByRole("button", { name: /^accept$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^dismiss$/i })).toHaveLength(2);
  });

  it("opportunity 'Publish →' routes into Curate", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("ship it"));
    fireEvent.click(screen.getByRole("button", { name: /publish/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/curate"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --dir packages/console test -- Dreaming`
Expected: FAIL — the panel still renders tabs/queue, no journey fetch.

- [ ] **Step 3: Update `api.ts`**

Replace `packages/console/src/panels/Dreaming/api.ts` content's queue/diary parts — keep `DreamStatus`, `getStatus`, `post`; DELETE `DreamItem`, `DreamDiaryEntry`, `getQueue`, `getDiary` (first verify nothing else imports them: `grep -rn "getQueue\|getDiary\|DreamItem\|DreamDiaryEntry" packages/console/src --include="*.ts*" | grep -v panels/Dreaming` must be empty; if not, keep whatever is used and note it). Add:

```ts
export interface JourneyEvent {
  ts: number;
  kind: "skill" | "lesson" | "opportunity" | "pass" | "verified";
  title: string;
  detail?: string;
  status?: "queued" | "accepted" | "dismissed";
  phase?: "DEEP" | "REM" | "LEARN";
  key?: string;
  firstSeenMs?: number;
  root?: string;
  agent?: string;
  passed?: boolean;
}
export interface JourneyResult { events: JourneyEvent[]; truncated: boolean }
export const getJourney = (b: string, kind?: string): Promise<JourneyResult> =>
  fetch(`${b}/api/journey${kind ? `?kind=${kind}` : ""}`).then(j);
```

- [ ] **Step 4: Rewrite the panel**

Replace the `Dreaming` component body in `packages/console/src/panels/Dreaming/index.tsx` (keep the file's imports pattern; drop `getQueue`/`getDiary`/`DreamItem`/`DreamDiaryEntry` imports, add `getJourney`, `type JourneyEvent`):

```tsx
const KINDS = ["all", "skill", "lesson", "opportunity", "pass", "verified"] as const;
const PHASES = ["LIGHT", "DEEP", "REM"] as const;

/** Journey: the unified learning timeline — everything the background job and
 *  intent-driven /learn distilled (queue items across all statuses), dream passes,
 *  and gem verification results, newest first. Nothing lands without accept. */
export function Dreaming({ apiBase }: { apiBase: string }) {
  const [filter, setFilter] = useState<(typeof KINDS)[number]>("all");
  const [status, setStatus] = useState<DreamStatus | null>(null);
  const [events, setEvents] = useState<JourneyEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getStatus(apiBase).then(setStatus).catch(() => setStatus(null));
    getJourney(apiBase, filter === "all" ? undefined : filter)
      .then((r) => { setEvents(r.events); setTruncated(r.truncated); })
      .catch(() => setEvents([]));
  }, [apiBase, filter]);
  useEffect(() => { refresh(); }, [refresh]);

  const act = (path: string, key: string) =>
    post(apiBase, path, { key }).then(() => { setError(null); refresh(); }).catch(() => setError("Action failed — try again."));

  // Opportunity accept routes into Curate's "suggest from a project" flow (unchanged bridge).
  const openOpportunity = (e: JourneyEvent) =>
    post(apiBase, "queue/accept", { key: e.key }).then(() => {
      if (e.root) setPendingAnalyze(e.root);
      window.location.hash = "#/curate";
    }).catch(() => setError("Could not open this opportunity."));

  const actionable = (e: JourneyEvent) => e.key && e.status === "queued";

  return (
    <div className="dreaming">
      <header>
        <h1>Journey</h1>
        <p>Everything your sessions taught AgentGem, in order. Nothing lands without your accept.</p>
        <span className="dream-flag" data-on={!!status?.enabled}>{status?.enabled ? "DREAMING ON" : "DREAMING OFF"}</span>
        <button className="dream-btn" onClick={() => post(apiBase, "enable", { enabled: !status?.enabled }).then(() => { setError(null); refresh(); }).catch(() => setError("Could not change Dreaming."))}>
          {status?.enabled ? "Turn off" : "Turn on"}
        </button>
      </header>

      {status && (
        <section className="dream-scene">
          <div className="phases">
            {PHASES.map((p) => <span key={p} data-lit={status.phasesLit.includes(p)}>{p}</span>)}
          </div>
          <p className="dream-counts">{status.promoted} promoted · {status.queued} queued</p>
          <button className="dream-btn" onClick={() => post(apiBase, "run").then(() => { setError(null); setTimeout(refresh, 1500); }).catch(() => setError("Dream run failed."))}>Dream now</button>
        </section>
      )}

      <nav className="dream-tabs">
        {KINDS.map((k) => (
          <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{k}</button>
        ))}
      </nav>

      {error && <p className="ledger-error" role="alert">{error}</p>}

      <ul className="dream-queue journey-timeline">
        {events.map((e) => (
          <li key={`${e.kind}:${e.key ?? e.title}:${e.ts}`}>
            <span className="dream-item-when">{timeAgo(e.ts)}</span>
            <span className="dream-item-kind">{e.kind}</span>
            {e.phase === "LEARN" && <span className="dream-item-phase">LEARN</span>}
            <span className="dream-item-name">{e.title}</span>
            {e.detail && <span className="dream-item-summary">{e.detail}</span>}
            {e.kind === "verified" && <span className="dream-item-verdict" data-passed={e.passed}>{e.passed ? `✓ ${e.agent}` : `✗ ${e.agent}`}</span>}
            {e.status && e.status !== "queued" && <span className="dream-item-status">{e.status}</span>}
            {actionable(e) && (e.kind === "opportunity"
              ? <button className="dream-act is-accept" onClick={() => openOpportunity(e)}>Publish →</button>
              : <button className="dream-act is-accept" onClick={() => act("queue/accept", e.key!)}>Accept</button>)}
            {actionable(e) && <button className="dream-act" onClick={() => act("queue/dismiss", e.key!)}>Dismiss</button>}
          </li>
        ))}
        {events.length === 0 && <li className="is-empty">Nothing on the timeline yet.</li>}
      </ul>
      {truncated && <p className="dream-truncated">Showing the newest 100 events.</p>}
    </div>
  );
}

export const dreamingPage = defineConsolePage({
  id: "dreaming", title: "Journey", icon: "🌙", order: 9, group: "observe",
  route: "#/dreaming", component: Dreaming,
});
```

- [ ] **Step 5: Run console tests + typecheck**

Run: `pnpm --dir packages/console test && pnpm --dir packages/console exec tsc --noEmit`
Expected: PASS (all — including the 5 rewritten Journey tests). If another console test asserts the "Dreaming" title text, update it to "Journey" (check `pages.test.ts` — it asserts ids only, which are unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Dreaming/api.ts packages/console/src/panels/Dreaming/index.tsx packages/console/src/panels/Dreaming/Dreaming.test.tsx
git commit -m "feat(console): Dreaming grows into Journey — one timeline for queue, passes, verifications"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build + full root suite**

Run: `pnpm build && pnpm test`
Expected: all green. Known flakes: observeScan/scorecard/observe.controller real-FS tests under concurrency — re-run in isolation before blaming.

- [ ] **Step 2: Console tests + typecheck (changed this slice — required locally, not in CI)**

Run: `pnpm --dir packages/console test && pnpm --dir packages/console exec tsc --noEmit`
Expected: all green.

- [ ] **Step 3: Endpoint smoke through the built server**

Run: `node -e "import('./dist/journeyCore.js').then(m => console.log(JSON.stringify(m.buildJourney({ base: process.env.TMPDIR || '/tmp' }))))"`
Expected: `{"events":[...],"truncated":false}` (possibly empty events) — proves the compiled module loads and tolerates arbitrary store state.

- [ ] **Step 4: Branch state**

```bash
git status --short   # expect empty (never commit .superpowers/; note task-5-report.md is a TRACKED file — restore it if a fix agent writes there)
git log --oneline origin/main..HEAD   # spec + plan + 4 code commits
```
