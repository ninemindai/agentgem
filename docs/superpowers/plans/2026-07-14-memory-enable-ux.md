# Memory Provider Enable/Save UX Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Fix a data-loss footgun and two UX gaps in the Memory Providers panel: (1) saving a provider with a blank key must PRESERVE the stored key (today it overwrites it with empty), (2) the Enabled toggle must persist on change, (3) Pull now should show a loading state.

**Architecture:** Server-side merge in the `POST /api/memory/providers` handler (protects any client, not just this UI). Client-side: the enable checkbox persists via the same save call (now safe because blank keys are preserved), and Pull now shows a "pulling…" note while in flight.

**Tech Stack:** TypeScript ESM, duck-typed Express (goldmine), React (console), Vitest.

## Global Constraints

- ESM `.js` specifiers, NodeNext, no new deps.
- `POST /api/memory/providers` stays local-core-only (gated by SERVE_CONSOLE, unchanged).
- `ProviderConfig = { enabled: boolean; apiKey: string; baseUrl?: string; userId?: string }`.
- Never log or return the API key (the providers GET returns only booleans — unchanged).
- Console tests are NOT in CI — run them locally (`packages/console` vitest, capped 4 workers).

---

## Task 1: Server-side — blank key / missing fields preserve the stored config

**Files:**
- Modify: `src/goldmine/memoryRoutes.ts` (the `POST /api/memory/providers` handler)
- Test: `src/goldmine/__tests__/memoryRoutes.test.ts`

**Interfaces:**
- Consumes: `loadProviderConfigs`, `saveProviderConfig`, `getProvider`, `IMPLEMENTED` (already imported).

**Current handler (memoryRoutes.ts ~41-50):**
```ts
app.post("/api/memory/providers", guard, async (req, res) => {
  const id = req.body?.id as ProviderId;
  const config = req.body?.config as ProviderConfig;
  if (!id || !config) { res.status(400).json({ error: "id and config required" }); return; }
  saveProviderConfig(id, config);
  try {
    const r = IMPLEMENTED.has(id) ? await getProvider(id).test(config) : { ok: false, detail: "not implemented yet" };
    res.json(r);
  } catch (e) { res.json({ ok: false, detail: String((e as Error).message) }); }
});
```

- [ ] **Step 1: Write the failing test**

Add to `src/goldmine/__tests__/memoryRoutes.test.ts` (follow the file's existing fake-app + temp-`AGENTGEM_HOME` pattern; import `loadProviderConfigs` from `@agentgem/memory` to assert persisted state):

```ts
it("POST /providers with a blank apiKey preserves the previously-stored key", async () => {
  const { app, routes } = makeApp();
  registerMemoryRoutes(app as any);
  // seed an existing config with a real key + userId
  const seed = res();
  await routes.get("POST /api/memory/providers")!(
    { body: { id: "mem0", config: { enabled: false, apiKey: "sk-real", userId: "u1" } }, query: {}, params: {} }, seed);
  // now enable with a BLANK key (what the UI sends — the key field is empty)
  const r = res();
  await routes.get("POST /api/memory/providers")!(
    { body: { id: "mem0", config: { enabled: true, apiKey: "" } }, query: {}, params: {} }, r);
  const { loadProviderConfigs } = await import("@agentgem/memory");
  const saved = loadProviderConfigs().mem0!;
  expect(saved.apiKey).toBe("sk-real"); // key preserved, not wiped
  expect(saved.enabled).toBe(true);     // enabled applied
  expect(saved.userId).toBe("u1");      // untouched field preserved
});
```
(Adjust `makeApp`/`res` helper access to match how the existing tests in this file invoke POST handlers — reuse their exact mechanism; the routes map may key POST handlers differently, mirror the existing POST test in this file.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run dist/goldmine/__tests__/memoryRoutes.test.js` (repo root; the suite runs compiled dist — build first with `npx tsc -b`). Expected: FAIL (key wiped to `""`).

- [ ] **Step 3: Implement the merge**

Replace the handler body so a blank key / omitted fields fall back to the stored config:
```ts
app.post("/api/memory/providers", guard, async (req, res) => {
  const id = req.body?.id as ProviderId;
  const incoming = req.body?.config as ProviderConfig;
  if (!id || !incoming) { res.status(400).json({ error: "id and config required" }); return; }
  const existing = loadProviderConfigs()[id];
  // The UI never re-populates the key field (it's write-only for security), so a save from an
  // already-connected provider arrives with a blank apiKey. Merge over the stored config: keep the
  // existing key (and any baseUrl/userId the client didn't send) unless the client provides a new value.
  const config: ProviderConfig = {
    ...existing,
    ...incoming,
    apiKey: incoming.apiKey || existing?.apiKey || "",
  };
  saveProviderConfig(id, config);
  try {
    const r = IMPLEMENTED.has(id) ? await getProvider(id).test(config) : { ok: false, detail: "not implemented yet" };
    res.json(r);
  } catch (e) { res.json({ ok: false, detail: String((e as Error).message) }); }
});
```

- [ ] **Step 4: Run — verify pass + full route suite**

Run: `npx tsc -b && npx vitest run dist/goldmine/__tests__/memoryRoutes.test.js`
Expected: PASS (new test + existing 2 route tests).

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/memoryRoutes.ts src/goldmine/__tests__/memoryRoutes.test.ts
git commit -m "fix(memory): blank apiKey on save preserves the stored provider key"
```

---

## Task 2: Console — enable toggle persists + Pull now loading state

**Files:**
- Modify: `packages/console/src/panels/Memory/ProviderItem.tsx`
- Test: `packages/console/src/panels/Memory/Memory.test.tsx`

**Interfaces:**
- Consumes: `saveProvider`, `pull` from `./api.js` (unchanged signatures).

**Current `ProviderItem.tsx`** has: `save()` posts `{ enabled, apiKey }`; the checkbox `onChange={(e) => setEnabled(e.target.checked)}` (local only, never persisted); `pullNow()` sets `note` only after completion; Pull now `disabled={disabled || !row.enabled || busy}`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/console/src/panels/Memory/Memory.test.tsx` (mirror its existing `stubFetch` + `fireEvent` style; capture the fetch mock to assert calls). Provide an implemented+connected provider so the toggle is interactive:

```ts
it("persists the enable toggle by POSTing to /providers on change", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/memory/providers") && init?.method === "POST")
      return new Response(JSON.stringify({ ok: true }));
    if (String(url).endsWith("/api/memory/providers"))
      return new Response(JSON.stringify({ providers: [{ id: "mem0", implemented: true, enabled: false, connected: true }] }));
    if (String(url).endsWith("/api/memory/outbox")) return new Response(JSON.stringify({ candidates: [] }));
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<Memory apiBase="" />);
  await waitFor(() => screen.getByText(/mem0/i));
  const checkbox = screen.getByRole("checkbox", { name: /enabled/i });
  fireEvent.click(checkbox);
  await waitFor(() => {
    const posted = fetchMock.mock.calls.find(([u, i]: any[]) => String(u).endsWith("/api/memory/providers") && i?.method === "POST");
    expect(posted).toBeTruthy();
    expect(String(posted![1].body)).toContain('"enabled":true');
  });
});

it("shows a pulling… state then the pulled count", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/memory/providers")) return new Response(JSON.stringify({ providers: [{ id: "mem0", implemented: true, enabled: true, connected: true }] }));
    if (String(url).endsWith("/api/memory/outbox")) return new Response(JSON.stringify({ candidates: [] }));
    if (String(url).endsWith("/api/memory/pull")) return new Response(JSON.stringify({ pulled: 3 }));
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<Memory apiBase="" />);
  await waitFor(() => screen.getByText(/mem0/i));
  fireEvent.click(screen.getByRole("button", { name: /pull now/i }));
  await waitFor(() => screen.getByText(/pulled 3/i));
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd packages/console && npx vitest run src/panels/Memory/Memory.test.tsx`
Expected: FAIL (toggle doesn't POST; no pulling state assertion satisfied yet if the count path changed).

- [ ] **Step 3: Implement in `ProviderItem.tsx`**

- Add a toggle handler that persists and reverts on failure:
```ts
const toggleEnabled = async (next: boolean) => {
  setEnabled(next);
  setBusy(true); setNote(next ? "enabling…" : "disabling…");
  try {
    const r = await saveProvider(apiBase, row.id, { enabled: next, apiKey });
    setNote(r.ok ? (next ? "enabled" : "disabled") : (r.detail ?? "failed"));
    onChanged();
  } catch {
    setEnabled(!next);            // revert optimistic toggle
    setNote("failed — try again");
  } finally { setBusy(false); }
};
```
- Wire the checkbox: `onChange={(e) => void toggleEnabled(e.target.checked)}` and add `disabled={disabled || busy}`.
- In `pullNow()`, set the loading note at the start: `setBusy(true); setNote("pulling…");` (keep the existing `pulled ${r.pulled}` on success and `pull failed` on error).
- Keep `save()` (the explicit "Save & test" button) as-is — it now benefits from the server-side blank-key preserve too.

- [ ] **Step 4: Run — verify pass + full console suite**

Run: `cd packages/console && npx vitest run src/panels/Memory/Memory.test.tsx && npx vitest run && npx tsc -b`
Expected: Memory tests pass; full console suite stays green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Memory/ProviderItem.tsx packages/console/src/panels/Memory/Memory.test.tsx
git commit -m "feat(memory): enable toggle persists on change + Pull now loading state"
```

---

## Task 3: Verify live

- [ ] **Step 1:** `pnpm -F @agentgem/memory build && npx tsc -b && pnpm -F @agentgem/console build`.
- [ ] **Step 2:** Boot local core (isolated temp `AGENTGEM_HOME`). Save a provider with a key + enabled:false; then POST `{enabled:true, apiKey:""}`; confirm `GET /providers` shows `connected:true, enabled:true` and a subsequent `POST /pull` is NOT rejected (key preserved). Kill + clean temp home.

## Self-Review
- Blank-key-preserve (Task 1) covers the data-loss footgun server-side. ✓
- Toggle persistence + revert-on-failure + Pull loading state (Task 2). ✓
- No key ever logged/returned; SERVE_CONSOLE gate unchanged. ✓
