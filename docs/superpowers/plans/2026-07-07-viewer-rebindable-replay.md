# Viewer-Rebindable Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a viewer replay a shared session-replay miniapp against one of *their own* local sessions via a host-owned "Replay yours" picker, without the sealed game ever naming a session.

**Architecture:** A pure `resolveSessionRef` decides which session the `session-data` feed loads (author default, or a viewer override validated against the host's own enumerated sessions); the `/api/play/session-data` route gains an optional `sessionId`+`agent` override wired through it; the console `Runner` adds a "Replay yours" picker that feeds the chosen session on the existing `session-data` channel, which the replay scaffold already re-renders on.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 24, Vitest. The `@agentgem/play` package + root `src/` tests run against compiled `dist/`; the `@agentgem/console` package runs Vitest against `src/` (jsdom). No new dependencies.

**Design doc:** `docs/superpowers/specs/2026-07-07-viewer-rebindable-replay-design.md`

## Global Constraints

- Node ≥ 24, ESM only (`.js` import specifiers in TS source). No new dependencies.
- `@agentgem/play` package source is in `packages/play/src/`; its tests live in root `src/play/__tests__/` and import built `@agentgem/play`. New exports re-exported from `packages/play/src/index.ts`. These run under the ROOT vitest, which executes compiled dist — build first: `npx tsc -b` then `npx vitest run dist/play/...`.
- `@agentgem/console` runs its OWN vitest against source (`packages/console`, `include: src/**/*.test.{ts,tsx}`, jsdom). Console typecheck needs the insight package built first: `pnpm --filter @agentgem/insight build` before `pnpm --filter @agentgem/console typecheck`.
- Security invariant: a viewer `sessionId`+`agent` override is honored ONLY when that pair is in `listActiveSessions()`. The sealed game never sends a `sessionId`.
- Scope: `replay` only; detect it via `needs?.includes("session-data")` (no new `genre` prop, no new `GameCapability`). No scaffold change. No marketplace change.
- Separate scope from prior branches. Work on `feat/replay-rebind` (already branched off `origin/main`).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

- **Create** `packages/play/src/sessionRef.ts` — `resolveSessionRef(createdFrom, override, active)`: pure decision of which session to load.
- **Modify** `packages/play/src/index.ts` — re-export it.
- **Modify** `src/schemas.ts` — add `PlaySessionDataQuerySchema` (name + optional sessionId/agent).
- **Modify** `src/play.controller.ts:50-59` — `sessionData` uses the new query + `resolveSessionRef` + `listActiveSessions`.
- **Modify** `packages/console/src/api/routes.ts` — `playSessionDataRoute` query gains optional `sessionId`/`agent`.
- **Modify** `packages/console/src/panels/Play/Runner.tsx` — "Replay yours" picker + `feedSession`.
- **Create** `src/play/__tests__/sessionRef.test.ts`
- **Modify** `packages/console/src/panels/Play/__tests__/Runner.test.tsx` — picker tests.

---

### Task 1: Server rebind support — `resolveSessionRef` + route wiring

**Files:**
- Create: `packages/play/src/sessionRef.ts`
- Modify: `packages/play/src/index.ts`
- Modify: `src/schemas.ts` (Play section, near `PlaySessionDataSchema`)
- Modify: `src/play.controller.ts` (imports + `sessionData`, lines ~4-13 and ~50-59)
- Modify: `packages/console/src/api/routes.ts` (`playSessionDataRoute`)
- Test: `src/play/__tests__/sessionRef.test.ts`

**Interfaces:**
- Consumes: `GameSource` from `@agentgem/model`; `listActiveSessions(): WatchSession[]` from `src/watchSessions.js` (each `{ id, agent, … }`); `defaultReaders.loadSession`, `compactTurns`, `readMiniapp` (existing).
- Produces:
  - `resolveSessionRef(createdFrom: GameSource, override: { sessionId?: string; agent?: string }, active: { id: string; agent: string }[]): { sessionId: string; agent: string }` — returns the override pair when both present AND in `active` (else throws); otherwise the miniapp's own session (throws if `createdFrom.kind !== "session"`).
  - `PlaySessionDataQuerySchema` = `{ name: string; sessionId?: string; agent?: string }`.
  - `playSessionDataRoute` query extended with optional `sessionId`/`agent` (response unchanged).

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/sessionRef.test.ts`:

```typescript
// src/play/__tests__/sessionRef.test.ts
import { describe, it, expect } from "vitest";
import { resolveSessionRef } from "@agentgem/play";
import type { GameSource } from "@agentgem/model";

const authored: GameSource = { kind: "session", agent: "claude", sessionId: "author-1", summary: "auth" };
const active = [{ id: "mine-1", agent: "codex" }, { id: "mine-2", agent: "claude" }];

describe("resolveSessionRef", () => {
  it("returns the miniapp's own session when there is no override", () => {
    expect(resolveSessionRef(authored, {}, active)).toEqual({ sessionId: "author-1", agent: "claude" });
  });

  it("returns a viewer override that names an available local session", () => {
    expect(resolveSessionRef(authored, { sessionId: "mine-1", agent: "codex" }, active)).toEqual({ sessionId: "mine-1", agent: "codex" });
  });

  it("rejects an override whose (sessionId, agent) is not in the active list", () => {
    expect(() => resolveSessionRef(authored, { sessionId: "mine-1", agent: "claude" }, active)).toThrow(/not an available local session/i);
    expect(() => resolveSessionRef(authored, { sessionId: "elsewhere", agent: "codex" }, active)).toThrow(/not an available local session/i);
  });

  it("ignores a partial override (only one of sessionId/agent) and falls back to the author session", () => {
    expect(resolveSessionRef(authored, { sessionId: "mine-1" }, active)).toEqual({ sessionId: "author-1", agent: "claude" });
  });

  it("throws when there is no override and the miniapp has no session source", () => {
    const blank: GameSource = { kind: "blank", title: "x" };
    expect(() => resolveSessionRef(blank, {}, active)).toThrow(/no session data/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/sessionRef.test.js`
Expected: FAIL — `resolveSessionRef` not exported.

- [ ] **Step 3: Implement the pure helper**

Create `packages/play/src/sessionRef.ts`:

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Decide WHICH session a replay's session-data feed should load. Default = the miniapp's own recorded
// (author) session. A viewer OVERRIDE (sessionId + agent) is honored ONLY when it names one of the
// host's currently-enumerated local sessions — so a crafted client can never coerce the route into
// loading an arbitrary transcript. A partial override (only one field) is ignored.
import type { GameSource } from "@agentgem/model";

export interface SessionRef { sessionId: string; agent: string }

export function resolveSessionRef(
  createdFrom: GameSource,
  override: { sessionId?: string; agent?: string },
  active: { id: string; agent: string }[],
): SessionRef {
  if (override.sessionId && override.agent) {
    const ok = active.some((s) => s.id === override.sessionId && s.agent === override.agent);
    if (!ok) throw new Error(`session '${override.sessionId}' is not an available local session`);
    return { sessionId: override.sessionId, agent: override.agent };
  }
  if (createdFrom.kind !== "session") throw new Error("this miniapp has no session data");
  return { sessionId: createdFrom.sessionId, agent: createdFrom.agent };
}
```

Add to `packages/play/src/index.ts`:

```typescript
export { resolveSessionRef, type SessionRef } from "./sessionRef.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsc -b && npx vitest run dist/play/__tests__/sessionRef.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the route (schema + controller + client route)**

In `src/schemas.ts`, immediately after `PlayMiniappQuerySchema`:

```typescript
export const PlaySessionDataQuerySchema = z.object({ name: z.string(), sessionId: z.string().optional(), agent: z.string().optional() });
```

In `src/play.controller.ts`, add to the `@agentgem/play` import (line ~6) `resolveSessionRef`, add the schema import (line ~12) `PlaySessionDataQuerySchema`, and add near the other imports:

```typescript
import { listActiveSessions } from "./watchSessions.js";
```

Replace the `sessionData` method (currently lines ~50-59) with:

```typescript
  // Host-brokered feed: a replay's source-session transcript, compacted. Defaults to the miniapp's OWN
  // (author) session; a viewer may override with one of THEIR local sessions (validated against
  // listActiveSessions so a crafted client can't request an arbitrary transcript).
  @get("/play/session-data", { query: PlaySessionDataQuerySchema, response: PlaySessionDataSchema })
  async sessionData(input: { query: z.infer<typeof PlaySessionDataQuerySchema> }): Promise<z.infer<typeof PlaySessionDataSchema>> {
    try {
      const { name, sessionId, agent } = input.query;
      const src = readMiniapp(name).meta.createdFrom;
      const ref = resolveSessionRef(src, { sessionId, agent }, listActiveSessions().map((s) => ({ id: s.id, agent: s.agent })));
      const s = await defaultReaders.loadSession(ref.sessionId, ref.agent);
      if (!s) throw new Error("session not found");
      return { meta: (s.meta ?? {}) as Record<string, unknown>, timeline: compactTurns(s.turns) };
    } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
  }
```

In `packages/console/src/api/routes.ts`, change `playSessionDataRoute`'s query (keep the response as-is):

```typescript
export const playSessionDataRoute = defineRoute("GET", "/api/play/session-data", {
  query: z.object({ name: z.string(), sessionId: z.string().optional(), agent: z.string().optional() }),
  response: z.object({ meta: z.record(z.string(), z.unknown()), timeline: z.array(z.object({ role: z.string(), tsMs: z.number(), text: z.string() })) }),
});
```

- [ ] **Step 6: Verify the wiring builds and nothing regresses**

Run: `npx tsc -b && npx vitest run dist/play`
Expected: whole monorepo compiles (proves the controller/schema/client-route types line up) and the full play suite passes, including the pre-existing `session-data` behavior.

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/console typecheck`
Expected: console typechecks with the widened `playSessionDataRoute` query.

- [ ] **Step 7: Commit**

```bash
git add packages/play/src/sessionRef.ts packages/play/src/index.ts src/play/__tests__/sessionRef.test.ts src/schemas.ts src/play.controller.ts packages/console/src/api/routes.ts
git commit -m "feat(play): resolveSessionRef + session-data override for viewer-rebindable replay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Runner "Replay yours" picker

**Files:**
- Modify: `packages/console/src/panels/Play/Runner.tsx`
- Test: `packages/console/src/panels/Play/__tests__/Runner.test.tsx`

**Interfaces:**
- Consumes: `fetchSessions(apiBase): Promise<WatchSession[]>` and `type WatchSession` from `../Watch/watchStream.js`; `playSessionDataRoute` (extended in Task 1, already imported in `Runner.tsx`); existing `iframeRef`, `gameGen`, `makeClient`.
- Produces: an interactive-only "Replay yours" control shown when `needs?.includes("session-data")`; selecting a session calls `playSessionDataRoute.call(client, { query: { name, sessionId, agent } })` and postMessages the result as `{ type: "agentgem:feed", channel: "session-data", data }` into the sealed iframe.

- [ ] **Step 1: Write the failing tests**

Add to `packages/console/src/panels/Play/__tests__/Runner.test.tsx` a new `describe` block (keep existing tests). Match the file's existing imports/harness; add what's missing:

```typescript
import { playSessionDataRoute } from "../../../api/routes.js";

describe("Runner — Replay yours picker", () => {
  const sessions = [
    { id: "mine-1", file: "/f1", agent: "codex", project: "app", model: "gpt", msgs: 12, startMs: 0, endMs: 1, ageMs: 1 },
    { id: "mine-2", file: "/f2", agent: "claude", project: "lib", model: "opus", msgs: 5, startMs: 0, endMs: 1, ageMs: 1 },
  ];
  const html = "<!doctype html><body><div id=\"app\"></div></body>";

  it("offers the picker for an interactive session-data miniapp and feeds the chosen session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/watch/sessions")) return { ok: true, json: async () => ({ sessions }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    const data = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [{ role: "user", tsMs: 0, text: "hi" }] } as never);

    render(<Runner html={html} name="dup" apiBase="" needs={["session-data"]} />);
    const open = await screen.findByRole("button", { name: /replay yours/i });
    fireEvent.click(open);
    // picker lists the viewer's local sessions
    const row = await screen.findByText(/app/);
    fireEvent.click(row);
    await waitFor(() => expect(data).toHaveBeenCalled());
    expect(data.mock.calls[0][1]).toMatchObject({ query: { name: "dup", sessionId: "mine-1", agent: "codex" } });
  });

  it("does not offer the picker without the session-data need", () => {
    render(<Runner html={html} name="g" apiBase="" needs={["invoke-agent"]} />);
    expect(screen.queryByRole("button", { name: /replay yours/i })).toBeNull();
  });

  it("does not offer the picker for a non-interactive thumbnail", () => {
    render(<Runner html={html} name="g" apiBase="" needs={["session-data"]} interactive={false} />);
    expect(screen.queryByRole("button", { name: /replay yours/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Play/__tests__/Runner.test.tsx`
Expected: FAIL — no "Replay yours" button rendered.

- [ ] **Step 3: Implement the picker in `Runner.tsx`**

Add `WatchSession` to the existing Watch import:

```typescript
import { fetchSessions, openWatchStream, type WatchSession } from "../Watch/watchStream.js";
```

Add state near the other `useState` hooks (after `const [pending, setPending] = ...`):

```typescript
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
```

Add these near the other callbacks (after `serve`), plus the gating flag before the `return`:

```typescript
  // Feed a viewer-picked session into the sealed iframe on the session-data channel (the scaffold
  // re-renders on it). Reuses the serve() staleness guard shape; the picked ref is host-owned.
  const feedSession = useCallback(async (sessionId: string, agent: string) => {
    if (name == null || apiBase == null) return;
    const gen = gameGen.current;
    try {
      const data = await playSessionDataRoute.call(makeClient(apiBase), { query: { name, sessionId, agent } });
      if (gen === gameGen.current) iframeRef.current?.contentWindow?.postMessage({ type: "agentgem:feed", channel: "session-data", data }, "*");
    } catch { /* keep the current render */ }
    setPickerOpen(false);
  }, [name, apiBase]);

  const canRebind = interactive && !!needs?.includes("session-data");
  function openPicker() {
    setPickerOpen(true);
    if (sessions == null && apiBase != null) fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
  }
```

In the returned JSX, add the button next to the fullscreen button (inside the same `interactive &&` area is fine, but gate on `canRebind`), positioned top-left so it doesn't overlap the top-right ⛶:

```tsx
      {canRebind && (
        <button onClick={openPicker} title="Replay one of your own sessions" aria-label="Replay yours"
          style={{ position: fs ? "fixed" : "absolute", top: 8, left: 8, zIndex: 1001, height: 30, padding: "0 10px",
            borderRadius: 8, border: "1px solid rgba(255,255,255,.25)", background: "rgba(20,22,28,.7)", color: "#fff",
            cursor: "pointer", font: "600 12px system-ui" }}>
          ↺ Replay yours
        </button>
      )}
      {pickerOpen && (
        <div className="play-consent" role="dialog" aria-label="Pick a session to replay">
          <div className="play-consent__box">
            <div className="play-consent__title">Replay one of your sessions</div>
            {sessions == null ? <div className="play-consent__sub">Loading your sessions…</div>
              : sessions.length === 0 ? <div className="play-consent__sub">No local sessions yet.</div>
              : (
                <ul className="play-src" style={{ maxHeight: 260, overflow: "auto" }}>
                  {sessions.map((s) => (
                    <li key={`${s.agent}:${s.id}`} className="play-src-row" onClick={() => feedSession(s.id, s.agent)}>
                      <span className="play-src-row__main">{s.project ?? "session"}</span>
                      <span className="play-src-row__meta">{s.agent} · {s.msgs} msgs</span>
                    </li>
                  ))}
                </ul>
              )}
            <div className="play-consent__btns">
              <button className="play-btn" onClick={() => setPickerOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Play/__tests__/Runner.test.tsx`
Expected: PASS (the 3 new picker tests + the pre-existing Runner tests in the file).

- [ ] **Step 5: Typecheck the console package**

Run: `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/console typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Play/Runner.tsx packages/console/src/panels/Play/__tests__/Runner.test.tsx
git commit -m "feat(console): 'Replay yours' picker to rebind a shared replay to your own session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Play + console suites green:**
  - `npx tsc -b && npx vitest run dist/play` (root/play)
  - `pnpm --filter @agentgem/insight build && pnpm --filter @agentgem/console typecheck && pnpm --filter @agentgem/console test` (console)
  If a pre-existing real-FS scan test flakes under full-suite concurrency, re-run it in isolation to confirm it is unrelated (known flake).

- [ ] **Open a PR** off freshly-fetched `origin/main` on `feat/replay-rebind`, gate on CI (`test (24)` + `test (26)`), merge with `--rebase` once green.

## Notes for the implementer

- Do NOT add a `genre` prop to `Runner` — detect replays via `needs?.includes("session-data")` (only replays declare it).
- Do NOT change the replay scaffold — it already re-renders on an `agentgem:feed` (`packages/play/src/scaffolds.ts:97-101`).
- The marketplace player (`packages/marketplace/src/GamePlayer.tsx`) is intentionally untouched — no broker there; the baked default is correct.
