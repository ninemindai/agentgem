# EMBER phase 2 — BANK → `/compact` handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** EMBER's live clean-cut BANK copies `/compact` to the clipboard via a new consent-gated `copy-command` action capability, so acting on the nudge is one paste.

**Architecture:** New `ActionCapability` `copy-command` (method `copyCommand`, wire `ui/copy-command`), mirroring `open-link` — but the egress is the OS clipboard. Consent-gated, never remembered, always shows the exact text.

**Tech Stack:** TypeScript, Zod, Vitest + jsdom, `@agentgem/model` capability unions, the `window.agentgemApp` shim (`mcpAppClient`), the console MCP-Apps host router.

Spec: `docs/superpowers/specs/2026-07-15-ember-bank-compact-handoff-design.md`.

## Global Constraints

- `copy-command` is an **ActionCapability** (method `copyCommand`, wire `ui/copy-command`), **consent-gated, NEVER remembered** (mirrors `open-link`), text length-capped `<= 256`.
- Guard surfaces (miss any → compile error or drift-test failure): `ActionCapability` union + `CAP_METHOD` (`packages/model`), `portability` CAP_CLASS (`= "enhancement"`), `GameCapabilityEnum` (`src/schemas.ts`), `PlayNeedsSchema` (console routes), `consent.ts` `CAP_LABEL` + `CONSENT_CAPS` (drift test: every `CAP_METHOD` key ∈ `CONSENT_CAPS`), the shim `mcpAppClient.ts`.
- Build: root `tsc -b`. Tests run from compiled `dist/` (root `pnpm test`) or per-package `pnpm --filter <pkg> exec vitest run`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Add the `copy-command` capability + shim method

**Files:** `packages/model/src/types.ts`, `packages/model/src/capabilities.ts`, `packages/play/src/portability.ts`, `src/schemas.ts`, `packages/console/src/api/routes.ts`, `packages/console/src/panels/Play/consent.ts`, `packages/play/src/mcpAppClient.ts`. Test: `capTool.drift.test.ts` (existing, must stay green).

- [ ] **Step 1: Model union + method map.**
  - `types.ts` `ActionCapability`: add `| "copy-command"` (with a `// ui/copy-command: copy a command to the clipboard (consent-gated, shows text, never remembered)` comment).
  - `capabilities.ts` `CAP_METHOD`: add `"copy-command": "copyCommand",`.
- [ ] **Step 2: Portability + wire enum + client mirror.**
  - `portability.ts` `CAP_CLASS`: add `"copy-command": "enhancement",`.
  - `src/schemas.ts` `GameCapabilityEnum`: add `"copy-command"` (in the action group, after `update-model-context`).
  - `routes.ts` `PlayNeedsSchema`: add `"copy-command"` (same position).
- [ ] **Step 3: Consent copy.**
  - `consent.ts` `CAP_LABEL`: `"copy-command": "copy a command to your clipboard",`.
  - `consent.ts` `CONSENT_CAPS`: add `"copy-command"` (append).
- [ ] **Step 4: Shim method.** `mcpAppClient.ts`, beside `openLink`:
  ```js
  copyCommand: function (text) { return sendRequest("ui/copy-command", { text: text }); },
  ```
- [ ] **Step 5: Verify.** `pnpm --filter @agentgem/console exec vitest run capTool.drift` → PASS. Root `tsc -b` → clean.
- [ ] **Step 6: Commit** `feat(play): add copy-command action capability (clipboard egress)`.

---

### Task 2: Broker + Runner clipboard egress (TDD)

**Files:** `packages/console/src/panels/Play/mcpUiHost.ts`, `packages/console/src/panels/Play/Runner.tsx`. Test: `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts`.

**Interfaces:** Consumes `CAP_METHOD["copy-command"]`. Produces `UiHostDeps.copyText?: (text: string) => void` and `ui/copy-command` handling.

- [ ] **Step 1: Failing tests** (mirror the open-link tests in the file). Add:
  ```ts
  it("ui/copy-command copies the text when consent is granted", async () => {
    const copyText = vi.fn();
    const { host, target, requestConsent } = mkHost({ needs: ["copy-command"], copyText });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 30, params: { text: "/compact" } }));
    await tick();
    expect(requestConsent).toHaveBeenCalledWith("copy-command", "/compact");
    expect(copyText).toHaveBeenCalledWith("/compact");
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 30, result: {} }), "*");
  });
  it("ui/copy-command denied does not copy", async () => {
    const copyText = vi.fn();
    const { host, target } = mkHost({ needs: ["copy-command"], copyText, requestConsent: vi.fn(async () => false) });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 31, params: { text: "/compact" } }));
    await tick();
    expect(copyText).not.toHaveBeenCalled();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 31, error: expect.objectContaining({ code: -32001 }) }), "*");
  });
  it("ui/copy-command not in needs is rejected", async () => {
    const { host, target } = mkHost({ needs: [] });
    host.handleMessage(msg(target, { method: "ui/copy-command", id: 32, params: { text: "/compact" } }));
    await tick();
    expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 32, error: expect.objectContaining({ code: -32601 }) }), "*");
  });
  ```
  (`mkHost` already spreads `over` into deps, so `copyText`/`requestConsent` overrides work.)
- [ ] **Step 2: Run → FAIL** (`pnpm --filter @agentgem/console exec vitest run mcpUiHost`): unknown method / capability not permitted.
- [ ] **Step 3: Implement broker.** In `mcpUiHost.ts`:
  - `UiHostDeps`: add `copyText?: (text: string) => void;`.
  - `handleMessage`: add `if (d.method === "ui/copy-command") { void handleCopy(d); return; }` beside the `ui/open-link` line.
  - Add `handleCopy` after `handleOpenLink`:
  ```ts
  async function handleCopy(d: RpcMessage): Promise<void> {
    const cap = "copy-command";
    if (!deps.needs.includes(cap)) { replyError(d.id, -32601, `capability not permitted: ${cap}`); return; }
    const text = d.params?.text;
    if (typeof text !== "string" || text.length === 0 || text.length > 256) { replyError(d.id, -32602, "invalid params: text must be a 1-256 char string"); return; }
    const gen = generation;
    const ok = await deps.requestConsent(cap, text);
    if (stale(gen)) return;
    if (!ok) { replyError(d.id, -32001, "consent denied"); return; }
    deps.copyText?.(text);
    reply(d.id, {});
  }
  ```
  (`RpcMessage.params` already includes `& Record<string, unknown>`, so `text` reads without a type change.)
- [ ] **Step 4: Runner.** In `Runner.tsx`:
  - Supply the dep in the `createUiHost({...})` call: `copyText: (text) => { void navigator.clipboard?.writeText(text); },`.
  - Generalize the three `open-link` special-cases to also match `copy-command`:
    - `requestConsent`: `if (cap !== "open-link" && cap !== "copy-command") { /* remembered path */ }`.
    - the `setConsent` skip: `if (pending !== "open-link" && pending !== "copy-command") setConsent(...)`.
    - the modal detail render: `{(pending === "open-link" || pending === "copy-command") && pendingDetail && (<div className="play-consent__sub"><code>{pendingDetail}</code></div>)}` and the same in the action-label condition.
- [ ] **Step 5: Run → PASS** (`mcpUiHost` + `Runner` suites). Root `tsc -b` clean.
- [ ] **Step 6: Commit** `feat(play): broker copy-command to the clipboard, consent-gated + never remembered`.

---

### Task 3: EMBER live BANK copies `/compact` (TDD)

**Files:** `packages/play/src/ember.ts`. Test: `packages/play/src/__tests__/ember.test.ts`.

- [ ] **Step 1: Failing test.** Add to `ember.test.ts`:
  ```ts
  it("declares copy-command and copies /compact on a live clean-cut BANK", () => {
    expect(EMBER_META.needs).toContain("copy-command");
    expect(EMBER_HTML).toContain("copyCommand");
    const dom = new JSDOM(EMBER_HTML, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/" });
    const w = dom.window as unknown as { __emberFeed?: (e: unknown) => void; agentgemApp?: Record<string, unknown>; document: Document };
    const copyCommand = (globalThis as { fn?: unknown }).fn; // placeholder — use vi.fn below
    const spy = { calls: [] as unknown[] };
    (w as { agentgemApp?: unknown }).agentgemApp = {
      onNotification() {}, callTool() { return Promise.resolve({}); },
      copyCommand(t: string) { spy.calls.push(t); return Promise.resolve({}); },
    };
    // Drive into the sweet spot: cap 200k, ctx 60k (30% -> within [14%,32%]).
    w.__emberFeed!({ type: "hygiene", cap: 200000, curveTail: [{ turn: 10, msgIndex: 20, ctxTokens: 60000, cacheCreation: 0, outTokens: 0 }] });
    (w.document.getElementById("bank") as HTMLElement).click();
    expect(spy.calls).toContain("/compact");
    dom.window.close();
  });
  ```
  Note: EMBER reads `window.agentgemApp` at script-eval time. Since JSDOM runs the script on construction, set `agentgemApp` via the `beforeParse` hook OR restructure EMBER to read `app` lazily. **Chosen: read `app` lazily in the copy path** — `var app = window.agentgemApp;` at top stays for `onNotification`/`callTool`, but the BANK copy calls `window.agentgemApp` fresh so a test can inject it post-construction. Adjust the test to set `agentgemApp` BEFORE `__emberFeed`/click (as written).
- [ ] **Step 2: Run → FAIL** (`pnpm --filter @agentgem/play exec vitest run ember`).
- [ ] **Step 3: Implement.**
  - `EMBER_META.needs`: `["context-hygiene", "copy-command"] as GameCapability[]`.
  - In `bankIt()` live clean-cut branch, after scoring:
    ```js
    var api = window.agentgemApp;
    if (cleanL && api && typeof api.copyCommand === 'function') {
      api.copyCommand('/compact').then(function(){
        toast('🟢 <b>clean cut.</b> copied <b>/compact</b> — paste it into your session.');
      }, function(){
        toast('🟢 <b>clean cut.</b> run <b>/compact</b> now to bank this work.');
      });
    } else {
      toast(cleanL ? '🟢 <b>clean cut.</b> run <b>/compact</b> now — the flame cools when the real window resets.' : 'run <b>/compact</b> to bank and reset the window.');
    }
    ```
    (Replaces the current single `toast(...)` in the live branch. The `combo(...)` + score lines stay above.)
- [ ] **Step 4: Run → PASS.** Rebuild (`tsc -b`) so play `dist` is current, then `pnpm --filter @agentgem/play exec vitest run ember`.
- [ ] **Step 5: Real-browser verify.** Dump `EMBER_HTML`, drive a live sweet-spot event, stub `window.agentgemApp.copyCommand`, click BANK, confirm it's called with `/compact` and the toast updates. (Full consent-modal path verified via the console in a live session if available.)
- [ ] **Step 6: Commit** `feat(play): EMBER live clean-cut BANK copies /compact to the clipboard`.

---

## Final verification
- [ ] Root `tsc -b` clean; root suite (`pnpm build && vitest run`) green; console suite green.
- [ ] Real-browser BANK→copy check captured.
- [ ] Push, open PR, watch `test (24)`, merge on green, verify each commit on `origin/main`.

## Self-review
- Coverage: capability across all action-guard surfaces (T1) ✓; broker + Runner egress + consent posture (T2) ✓; EMBER BANK call + fallback (T3) ✓; security (never-remembered, shows text, length cap) in T2 ✓.
- Type consistency: `copy-command` / `copyCommand` / `ui/copy-command` used identically across shim, broker, model, EMBER.
- Known jsdom note: EMBER must read `window.agentgemApp` for the copy at BANK time (not only the eval-time `app`) so the test can inject a stub — see T3 Step 1/3.
