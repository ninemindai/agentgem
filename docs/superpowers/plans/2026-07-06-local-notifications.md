# Local Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alert the user via an in-app toast and/or an OS notification when a warm pass finishes or new review-queue items appear, on both the browser console and the Electron desktop app.

**Architecture:** A `NotificationsProvider` mounted once in `Shell.tsx` polls `/api/warm/status` and `/api/dream/status`, detects transitions with pure detector functions, and routes each event through a `dispatch` function: always a toast, plus an OS notification when the window is hidden. The OS layer is one shared `osNotify()` that prefers the Electron `window.agentgem.notify` bridge and falls back to the browser `Notification` API. A 🔔 header button owns a master on/off preference in `localStorage`.

**Tech Stack:** React 19 + TypeScript (ESM, `.js` import specifiers), esbuild bundle, Vitest + `@testing-library/react` + jsdom (console), plain Vitest (desktop/Electron), Electron 43 `contextBridge`/`ipcMain`.

## Global Constraints

- **ESM import specifiers:** intra-package TS imports use the `.js` extension (e.g. `import { osNotify } from "./osNotify.js"`), matching every existing file.
- **No new dependencies.** Everything uses existing libs (React, Electron, Vitest).
- **No server-side changes.** Both triggers read existing endpoints.
- **Console tests are NOT in CI** — run `pnpm --filter @agentgem/console test` (and `typecheck`) locally before landing. Desktop tests run under `desktop/`.
- **Test style:** `import { describe, it, expect, afterEach, vi } from "vitest"`; stub browser globals with `vi.stubGlobal(...)` and `vi.unstubAllGlobals()` in `afterEach`; render with `@testing-library/react`.
- **Warm status shape:** `{ running: boolean; last: {...} | null }` — the trigger is the **top-level `running`** flag (the same `s.running` that `packages/console/src/components/WarmingPill.tsx:16` reads).
- **Dream status shape:** `DreamStatus { enabled; phasesLit; promoted; queued; lastPassAtMs }` from `packages/console/src/panels/Dreaming/api.ts` — the trigger is the **`queued`** count increasing.
- **localStorage master-toggle key:** `agentgem.notify`, value `"on"` / `"off"`.
- **Electron channel name:** `agentgem:notify` (namespaced, matching the existing `agentgem:pick-folder` / `agentgem:update`).
- **Poll interval:** 5000ms, matching `WarmingPill`.
- Do NOT modify `WarmingPill.tsx` — the notifications poller is independent (surgical, keeps the existing pill untouched).

---

### Task 1: Electron `notify` bridge (channel + preload + main handler)

Adds the native-notification path for the desktop app. Self-contained in `desktop/`; no console dependency.

**Files:**
- Modify: `desktop/src/ipc.ts` (add `NOTIFY` constant)
- Modify: `desktop/src/preload.ts` (expose `notify` on the bridge, inline the channel literal)
- Modify: `desktop/src/main.ts` (register `ipcMain.on(NOTIFY, …)`)
- Test: `desktop/src/__tests__/ipc.test.ts` (extend the existing drift-guard test)

**Interfaces:**
- Produces: channel constant `NOTIFY = "agentgem:notify"`; renderer-side bridge method `window.agentgem.notify(title: string, body: string): void`.

- [ ] **Step 1: Extend the failing drift-guard test**

In `desktop/src/__tests__/ipc.test.ts`, add `NOTIFY` to the imports and assertions:

```ts
import { PICK_FOLDER, UPDATE_EVENT, NOTIFY, pickFolderResult } from "../ipc.js";
```

Add inside `describe("ipc channels", …)`:

```ts
  it("defines the notify channel", () => {
    expect(NOTIFY).toBe("agentgem:notify");
  });
```

And extend the "mirrored verbatim in the sandboxed preload" test to also assert:

```ts
    expect(preload).toContain(`const NOTIFY = "${NOTIFY}"`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop && npx vitest run src/__tests__/ipc.test.ts`
Expected: FAIL — `NOTIFY` is not exported / not found in preload.

- [ ] **Step 3: Add the channel constant**

In `desktop/src/ipc.ts`, after the `UPDATE_EVENT` line:

```ts
export const NOTIFY = "agentgem:notify";
```

- [ ] **Step 4: Expose `notify` on the preload bridge**

In `desktop/src/preload.ts`, add the inlined channel literal next to the others and a `notify` method on the exposed object:

```ts
const PICK_FOLDER = "agentgem:pick-folder";
const UPDATE_EVENT = "agentgem:update";
const NOTIFY = "agentgem:notify";

// contextIsolation is on; expose only a minimal, typed surface to the page.
contextBridge.exposeInMainWorld("agentgem", {
  pickFolder: (): Promise<{ path: string | null }> => ipcRenderer.invoke(PICK_FOLDER),
  onUpdate: (cb: (info: { status: string }) => void): void => {
    ipcRenderer.on(UPDATE_EVENT, (_e, info) => cb(info));
  },
  notify: (title: string, body: string): void => {
    ipcRenderer.send(NOTIFY, { title, body });
  },
});
```

- [ ] **Step 5: Handle `NOTIFY` in the main process**

In `desktop/src/main.ts`, import `Notification` and `NOTIFY`:

```ts
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification } from "electron";
```
```ts
import { PICK_FOLDER, UPDATE_EVENT, NOTIFY, pickFolderResult } from "./ipc.js";
```

In `boot()`, right after the existing `ipcMain.handle(PICK_FOLDER, …)` block, add:

```ts
  // Renderer-requested OS notification. Native Notification needs no permission
  // and no HTTPS in the main process. Clicking it surfaces the window.
  ipcMain.on(NOTIFY, (_e, arg: { title: string; body: string }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: arg.title, body: arg.body });
    n.on("click", () => showWindow());
    n.show();
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd desktop && npx vitest run src/__tests__/ipc.test.ts`
Expected: PASS. Then `cd desktop && npx tsc -p tsconfig.json --noEmit` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/ipc.ts desktop/src/preload.ts desktop/src/main.ts desktop/src/__tests__/ipc.test.ts
git commit -m "feat(desktop): add agentgem:notify bridge for native OS notifications"
```

---

### Task 2: `osNotify` shared call site

The one function every notification goes through. Prefers the Electron bridge, falls back to the browser API.

**Files:**
- Create: `packages/console/src/notify/osNotify.ts`
- Test: `packages/console/src/notify/osNotify.test.ts`

**Interfaces:**
- Produces: `osNotify(title: string, body: string): void`; type `AgentGemBridge { notify?: (title: string, body: string) => void }`.

- [ ] **Step 1: Write the failing test**

`packages/console/src/notify/osNotify.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { osNotify } from "./osNotify.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("osNotify", () => {
  it("uses the Electron bridge when present and never touches Notification", () => {
    const notify = vi.fn();
    vi.stubGlobal("agentgem", { notify });
    const Ctor = vi.fn();
    vi.stubGlobal("Notification", Ctor);
    osNotify("T", "B");
    expect(notify).toHaveBeenCalledWith("T", "B");
    expect(Ctor).not.toHaveBeenCalled();
  });

  it("constructs a browser Notification when granted and no bridge", () => {
    vi.stubGlobal("agentgem", undefined);
    const Ctor = vi.fn();
    (Ctor as unknown as { permission: string }).permission = "granted";
    vi.stubGlobal("Notification", Ctor);
    osNotify("T", "B");
    expect(Ctor).toHaveBeenCalledWith("T", { body: "B" });
  });

  it("does nothing when permission is not granted and no bridge", () => {
    vi.stubGlobal("agentgem", undefined);
    const Ctor = vi.fn();
    (Ctor as unknown as { permission: string }).permission = "default";
    vi.stubGlobal("Notification", Ctor);
    osNotify("T", "B");
    expect(Ctor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/osNotify.test.ts`
Expected: FAIL — cannot find `./osNotify.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/notify/osNotify.ts`:

```ts
export interface AgentGemBridge {
  notify?: (title: string, body: string) => void;
}

// Single call site for OS notifications. In Electron the preload bridge is
// present and needs no permission; in a plain browser we fall back to the
// Notification API (only fires once the user has granted permission).
export function osNotify(title: string, body: string): void {
  const bridge = (window as unknown as { agentgem?: AgentGemBridge }).agentgem;
  if (bridge?.notify) {
    bridge.notify(title, body);
    return;
  }
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/osNotify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/notify/osNotify.ts packages/console/src/notify/osNotify.test.ts
git commit -m "feat(console): osNotify shared call site (Electron bridge → browser fallback)"
```

---

### Task 2b: Ambient type for the Electron bridge on `window`

TypeScript needs to know `window.agentgem` exists so later tasks (`NotifyBell`) can read it without `any` casts everywhere.

**Files:**
- Create: `packages/console/src/notify/global.d.ts`

**Interfaces:**
- Produces: global `Window.agentgem?: AgentGemBridge`.

- [ ] **Step 1: Write the declaration**

`packages/console/src/notify/global.d.ts`:

```ts
import type { AgentGemBridge } from "./osNotify.js";

declare global {
  interface Window {
    agentgem?: AgentGemBridge;
  }
}

export {};
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `pnpm --filter @agentgem/console typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/console/src/notify/global.d.ts
git commit -m "chore(console): ambient type for window.agentgem bridge"
```

---

### Task 3: Transition detectors

Pure functions that turn a previous/next status snapshot into a notification event (or null). No React, trivially testable.

**Files:**
- Create: `packages/console/src/notify/events.ts`
- Test: `packages/console/src/notify/events.test.ts`

**Interfaces:**
- Produces:
  - `interface NotifyEvent { key: string; title: string; message: string }`
  - `interface WarmSnapshot { running: boolean }`
  - `interface DreamSnapshot { queued: number }`
  - `detectWarm(prev: WarmSnapshot | null, next: WarmSnapshot): NotifyEvent | null`
  - `detectDream(prev: DreamSnapshot | null, next: DreamSnapshot): NotifyEvent | null`

- [ ] **Step 1: Write the failing test**

`packages/console/src/notify/events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectWarm, detectDream } from "./events.js";

describe("detectWarm", () => {
  it("does not fire on the first snapshot (no prev)", () => {
    expect(detectWarm(null, { running: false })).toBeNull();
    expect(detectWarm(null, { running: true })).toBeNull();
  });
  it("fires when running goes true → false", () => {
    const e = detectWarm({ running: true }, { running: false });
    expect(e?.key).toBe("warm-finished");
    expect(e?.title).toBe("Warm pass finished");
  });
  it("does not fire on false → true or unchanged", () => {
    expect(detectWarm({ running: false }, { running: true })).toBeNull();
    expect(detectWarm({ running: true }, { running: true })).toBeNull();
    expect(detectWarm({ running: false }, { running: false })).toBeNull();
  });
});

describe("detectDream", () => {
  it("does not fire on the first snapshot (no prev)", () => {
    expect(detectDream(null, { queued: 3 })).toBeNull();
  });
  it("fires with a singular message when queued rises by 1", () => {
    const e = detectDream({ queued: 0 }, { queued: 1 });
    expect(e?.key).toBe("dream-queue");
    expect(e?.message).toBe("1 new item to review.");
  });
  it("fires with a pluralized delta when queued rises by more than 1", () => {
    const e = detectDream({ queued: 2 }, { queued: 5 });
    expect(e?.message).toBe("3 new items to review.");
  });
  it("does not fire when queued stays or drops", () => {
    expect(detectDream({ queued: 4 }, { queued: 4 })).toBeNull();
    expect(detectDream({ queued: 4 }, { queued: 2 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/events.test.ts`
Expected: FAIL — cannot find `./events.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/notify/events.ts`:

```ts
export interface NotifyEvent {
  key: string;
  title: string;
  message: string;
}
export interface WarmSnapshot { running: boolean }
export interface DreamSnapshot { queued: number }

export function detectWarm(prev: WarmSnapshot | null, next: WarmSnapshot): NotifyEvent | null {
  if (prev && prev.running && !next.running) {
    return {
      key: "warm-finished",
      title: "Warm pass finished",
      message: "Insights are freshly precomputed.",
    };
  }
  return null;
}

export function detectDream(prev: DreamSnapshot | null, next: DreamSnapshot): NotifyEvent | null {
  if (prev && next.queued > prev.queued) {
    const n = next.queued - prev.queued;
    return {
      key: "dream-queue",
      title: "New review-queue items",
      message: `${n} new item${n === 1 ? "" : "s"} to review.`,
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/notify/events.ts packages/console/src/notify/events.test.ts
git commit -m "feat(console): pure warm/dream transition detectors"
```

---

### Task 4: `dispatch` routing

Given an event and the current focus/preference state, decides toast-only vs toast+OS. Pure function with injected side-effect callbacks.

**Files:**
- Create: `packages/console/src/notify/dispatch.ts`
- Test: `packages/console/src/notify/dispatch.test.ts`

**Interfaces:**
- Consumes: `NotifyEvent` from `./events.js`.
- Produces:
  - `interface DispatchDeps { enabled: boolean; hidden: boolean; toast: (message: string) => void; notify: (title: string, body: string) => void }`
  - `dispatch(event: NotifyEvent, deps: DispatchDeps): void`

- [ ] **Step 1: Write the failing test**

`packages/console/src/notify/dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { dispatch } from "./dispatch.js";
import type { NotifyEvent } from "./events.js";

const ev: NotifyEvent = { key: "k", title: "T", message: "M" };

describe("dispatch", () => {
  it("does nothing when disabled", () => {
    const toast = vi.fn(), notify = vi.fn();
    dispatch(ev, { enabled: false, hidden: true, toast, notify });
    expect(toast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it("toast only when focused (not hidden)", () => {
    const toast = vi.fn(), notify = vi.fn();
    dispatch(ev, { enabled: true, hidden: false, toast, notify });
    expect(toast).toHaveBeenCalledWith("M");
    expect(notify).not.toHaveBeenCalled();
  });
  it("toast + OS notify when hidden", () => {
    const toast = vi.fn(), notify = vi.fn();
    dispatch(ev, { enabled: true, hidden: true, toast, notify });
    expect(toast).toHaveBeenCalledWith("M");
    expect(notify).toHaveBeenCalledWith("T", "M");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/dispatch.test.ts`
Expected: FAIL — cannot find `./dispatch.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/notify/dispatch.ts`:

```ts
import type { NotifyEvent } from "./events.js";

export interface DispatchDeps {
  enabled: boolean;
  hidden: boolean;
  toast: (message: string) => void;
  notify: (title: string, body: string) => void;
}

// The master toggle gates everything. When on: always show a toast; escalate to
// an OS notification only when the window is hidden (the OS banner is the
// attention-getter the in-app toast can't be).
export function dispatch(event: NotifyEvent, deps: DispatchDeps): void {
  if (!deps.enabled) return;
  deps.toast(event.message);
  if (deps.hidden) deps.notify(event.title, event.message);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/notify/dispatch.ts packages/console/src/notify/dispatch.test.ts
git commit -m "feat(console): dispatch routing (toast always, OS notify when hidden)"
```

---

### Task 5: Notification preference (localStorage)

The master on/off flag the bell writes and the provider reads.

**Files:**
- Create: `packages/console/src/notify/prefs.ts`
- Test: `packages/console/src/notify/prefs.test.ts`

**Interfaces:**
- Produces: `readNotifyPref(): boolean`; `writeNotifyPref(on: boolean): void`; `const LS_NOTIFY = "agentgem.notify"`.

- [ ] **Step 1: Write the failing test**

`packages/console/src/notify/prefs.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { readNotifyPref, writeNotifyPref, LS_NOTIFY } from "./prefs.js";

afterEach(() => localStorage.clear());

describe("notify prefs", () => {
  it("defaults to off when unset", () => {
    expect(readNotifyPref()).toBe(false);
  });
  it("round-trips on/off", () => {
    writeNotifyPref(true);
    expect(localStorage.getItem(LS_NOTIFY)).toBe("on");
    expect(readNotifyPref()).toBe(true);
    writeNotifyPref(false);
    expect(readNotifyPref()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/prefs.test.ts`
Expected: FAIL — cannot find `./prefs.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/notify/prefs.ts`:

```ts
export const LS_NOTIFY = "agentgem.notify";

export function readNotifyPref(): boolean {
  try {
    return localStorage.getItem(LS_NOTIFY) === "on";
  } catch {
    return false;
  }
}

export function writeNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(LS_NOTIFY, on ? "on" : "off");
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/prefs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/notify/prefs.ts packages/console/src/notify/prefs.test.ts
git commit -m "feat(console): master notification on/off preference"
```

---

### Task 6: Toast system (context + container + styles)

The console's first shared toast. A `useToast().push(message)` API and a container rendered once.

**Files:**
- Create: `packages/console/src/shell/Toast.tsx`
- Modify: `packages/console/src/shell/theme.css` (append toast styles)
- Test: `packages/console/src/shell/Toast.test.tsx`

**Interfaces:**
- Produces:
  - `useToast(): { push: (message: string) => void }`
  - `<ToastProvider>{children}</ToastProvider>` — renders children plus the toast stack.

- [ ] **Step 1: Write the failing test**

`packages/console/src/shell/Toast.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Trigger() {
  const { push } = useToast();
  return <button onClick={() => push("hello world")}>go</button>;
}

describe("Toast", () => {
  it("pushes a toast that appears in an aria-live region", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("hello world")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("auto-dismisses after 6s", () => {
    vi.useFakeTimers();
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.queryByText("hello world")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText("hello world")).toBeNull();
  });

  it("dismisses on the close button", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("hello world")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/shell/Toast.test.tsx`
Expected: FAIL — cannot find `./Toast.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/shell/Toast.tsx`:

```tsx
import { createContext, useContext, useCallback, useRef, useState, type ReactElement, type ReactNode } from "react";

interface ToastItem { id: number; message: string }
interface ToastApi { push: (message: string) => void }

const ToastCtx = createContext<ToastApi>({ push: () => {} });
export const useToast = (): ToastApi => useContext(ToastCtx);

const TTL_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string) => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { id, message }]);
    setTimeout(() => remove(id), TTL_MS);
  }, [remove]);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className="toast">
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => remove(t.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
```

- [ ] **Step 4: Append toast styles**

At the end of `packages/console/src/shell/theme.css`:

```css
.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1000;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 320px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--ink, #1a1a1a);
  color: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
  font-size: 13px;
}
.toast-msg { flex: 1; }
.toast-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: .7;
}
.toast-close:hover { opacity: 1; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/shell/Toast.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/shell/Toast.tsx packages/console/src/shell/Toast.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): shared in-app toast system"
```

---

### Task 7: NotificationsProvider (poll → detect → dispatch)

Wires the pieces: polls both endpoints, holds prev snapshots in refs, dispatches events to the toast + OS layers. Renders nothing.

**Files:**
- Create: `packages/console/src/notify/NotificationsProvider.tsx`
- Test: `packages/console/src/notify/NotificationsProvider.test.tsx`

**Interfaces:**
- Consumes: `useToast` (`../shell/Toast.js`), `detectWarm`/`detectDream` (`./events.js`), `dispatch` (`./dispatch.js`), `osNotify` (`./osNotify.js`), `readNotifyPref` (`./prefs.js`).
- Produces: `<NotificationsProvider apiBase={string} />` — an effectful component returning `null`.

- [ ] **Step 1: Write the failing test**

`packages/console/src/notify/NotificationsProvider.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ToastProvider } from "../shell/Toast.js";
import { NotificationsProvider } from "./NotificationsProvider.js";
import { writeNotifyPref } from "./prefs.js";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

// Sequences the two status endpoints across successive poll rounds.
function fetchScript(rounds: Array<{ warm: unknown; dream: unknown }>) {
  let round = 0;
  return vi.fn(async (url: string) => {
    const r = rounds[Math.min(round, rounds.length - 1)];
    const body = url.includes("/warm/") ? r.warm : r.dream;
    if (url.includes("/dream/")) round++; // advance after both endpoints of a round are read
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

describe("NotificationsProvider", () => {
  it("does not toast on the first poll (baseline seed)", async () => {
    writeNotifyPref(true);
    vi.stubGlobal("fetch", fetchScript([{ warm: { running: true, last: null }, dream: { queued: 0 } }]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/precomputed|review/i)).toBeNull();
  });

  it("toasts when a warm pass finishes (running true → false) while enabled + focused", async () => {
    writeNotifyPref(true);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchScript([
      { warm: { running: true, last: null }, dream: { queued: 0 } },
      { warm: { running: false, last: null }, dream: { queued: 0 } },
    ]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });        // first poll seeds baseline
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); // second poll → transition
    expect(await screen.findByText(/precomputed/i)).toBeTruthy();
  });

  it("does nothing when the preference is off", async () => {
    writeNotifyPref(false);
    vi.useFakeTimers();
    vi.stubGlobal("fetch", fetchScript([
      { warm: { running: true, last: null }, dream: { queued: 0 } },
      { warm: { running: false, last: null }, dream: { queued: 0 } },
    ]));
    render(<ToastProvider><NotificationsProvider apiBase="" /></ToastProvider>);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText(/precomputed/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/NotificationsProvider.test.tsx`
Expected: FAIL — cannot find `./NotificationsProvider.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/notify/NotificationsProvider.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { useToast } from "../shell/Toast.js";
import { detectWarm, detectDream, type WarmSnapshot, type DreamSnapshot, type NotifyEvent } from "./events.js";
import { dispatch } from "./dispatch.js";
import { osNotify } from "./osNotify.js";
import { readNotifyPref } from "./prefs.js";

const POLL_MS = 5000;

// Mounted once in Shell. Polls warm + dream status, detects transitions, and
// routes events through dispatch. Renders nothing. Independent of WarmingPill's
// own poll (kept separate so the pill stays untouched).
export function NotificationsProvider({ apiBase }: { apiBase: string }): null {
  const { push } = useToast();
  const warmPrev = useRef<WarmSnapshot | null>(null);
  const dreamPrev = useRef<DreamSnapshot | null>(null);

  useEffect(() => {
    let alive = true;

    const fire = (event: NotifyEvent | null) => {
      if (!event || !alive) return;
      dispatch(event, {
        enabled: readNotifyPref(),
        hidden: document.visibilityState === "hidden",
        toast: push,
        notify: osNotify,
      });
    };

    const poll = async () => {
      try {
        const [wr, dr] = await Promise.all([
          fetch(`${apiBase}/api/warm/status`),
          fetch(`${apiBase}/api/dream/status`),
        ]);
        if (!alive) return;
        if (wr.ok) {
          const w = (await wr.json()) as { running: boolean };
          const next: WarmSnapshot = { running: w.running };
          fire(detectWarm(warmPrev.current, next));
          warmPrev.current = next;
        }
        if (dr.ok) {
          const d = (await dr.json()) as { queued: number };
          const next: DreamSnapshot = { queued: d.queued };
          fire(detectDream(dreamPrev.current, next));
          dreamPrev.current = next;
        }
      } catch {
        /* best-effort — a failed poll leaves the baseline untouched */
      }
    };

    void poll();
    const h = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase, push]);

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/NotificationsProvider.test.tsx`
Expected: PASS. If the fake-timer round sequencing is flaky, confirm the `fetchScript` round advances only after the dream fetch; the provider reads warm then dream within one `Promise.all`, so both hit the same round before it increments.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/notify/NotificationsProvider.tsx packages/console/src/notify/NotificationsProvider.test.tsx
git commit -m "feat(console): NotificationsProvider polls warm/dream and dispatches"
```

---

### Task 8: NotifyBell header toggle

The 🔔 button that grants permission (browser) or just flips the preference (Electron).

**Files:**
- Create: `packages/console/src/notify/NotifyBell.tsx`
- Modify: `packages/console/src/shell/theme.css` (append bell styles)
- Test: `packages/console/src/notify/NotifyBell.test.tsx`

**Interfaces:**
- Consumes: `readNotifyPref`/`writeNotifyPref` (`./prefs.js`).
- Produces: `<NotifyBell />` — a header button, no props.

- [ ] **Step 1: Write the failing test**

`packages/console/src/notify/NotifyBell.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NotifyBell } from "./NotifyBell.js";
import { readNotifyPref } from "./prefs.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("NotifyBell", () => {
  it("enables directly (no prompt) when the Electron bridge is present", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    render(<NotifyBell />);
    fireEvent.click(screen.getByRole("button", { name: /notification/i }));
    expect(readNotifyPref()).toBe(true);
  });

  it("requests browser permission on first enable and turns on when granted", async () => {
    vi.stubGlobal("agentgem", undefined);
    const req = vi.fn(async () => "granted");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission: req }));
    render(<NotifyBell />);
    fireEvent.click(screen.getByRole("button", { name: /notification/i }));
    await waitFor(() => expect(req).toHaveBeenCalled());
    await waitFor(() => expect(readNotifyPref()).toBe(true));
  });

  it("stays off when browser permission is denied", async () => {
    vi.stubGlobal("agentgem", undefined);
    const req = vi.fn(async () => "denied");
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission: req }));
    render(<NotifyBell />);
    fireEvent.click(screen.getByRole("button", { name: /notification/i }));
    await waitFor(() => expect(req).toHaveBeenCalled());
    expect(readNotifyPref()).toBe(false);
  });

  it("toggles back off when already enabled", () => {
    vi.stubGlobal("agentgem", { notify: vi.fn() });
    render(<NotifyBell />);
    const btn = screen.getByRole("button", { name: /notification/i });
    fireEvent.click(btn); // on
    fireEvent.click(btn); // off
    expect(readNotifyPref()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/NotifyBell.test.tsx`
Expected: FAIL — cannot find `./NotifyBell.js`.

- [ ] **Step 3: Write the implementation**

`packages/console/src/notify/NotifyBell.tsx`:

```tsx
import { useState, type ReactElement } from "react";
import { readNotifyPref, writeNotifyPref } from "./prefs.js";

// Master on/off for notifications. In Electron (bridge present) enabling is a
// pure preference — the native path needs no permission. In a plain browser the
// first enable triggers the one-time permission prompt (on a user gesture).
export function NotifyBell(): ReactElement {
  const [on, setOn] = useState(() => readNotifyPref());
  const [blocked, setBlocked] = useState(
    () => "Notification" in window && Notification.permission === "denied",
  );

  const enable = async () => {
    const hasBridge = Boolean(window.agentgem?.notify);
    if (hasBridge) {
      writeNotifyPref(true);
      setOn(true);
      return;
    }
    if (!("Notification" in window)) return; // unsupported: leave off
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm === "granted") {
      writeNotifyPref(true);
      setOn(true);
    } else {
      setBlocked(perm === "denied");
    }
  };

  const toggle = () => {
    if (on) {
      writeNotifyPref(false);
      setOn(false);
    } else {
      void enable();
    }
  };

  const label = blocked
    ? "Notifications blocked by the browser"
    : on
      ? "Notifications on — click to turn off"
      : "Enable notifications";

  return (
    <button
      type="button"
      className={"notify-bell" + (on ? " is-on" : "") + (blocked ? " is-blocked" : "")}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={toggle}
    >
      {on ? "🔔" : "🔕"}
    </button>
  );
}
```

- [ ] **Step 4: Append bell styles**

At the end of `packages/console/src/shell/theme.css`:

```css
.notify-bell {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 6px;
  opacity: .7;
}
.notify-bell:hover { opacity: 1; background: rgba(154, 51, 36, .06); }
.notify-bell.is-on { opacity: 1; }
.notify-bell.is-blocked { opacity: .4; cursor: not-allowed; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/notify/NotifyBell.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/notify/NotifyBell.tsx packages/console/src/notify/NotifyBell.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): notification bell toggle (permission-aware)"
```

---

### Task 9: Wire into Shell + full verification

Mount the provider + toast container + bell, then run the whole suite.

**Files:**
- Modify: `packages/console/src/shell/Shell.tsx`
- Test: `packages/console/src/shell/Shell.test.tsx` (add one assertion)

**Interfaces:**
- Consumes: `ToastProvider` (`./Toast.js`), `NotificationsProvider` (`../notify/NotificationsProvider.js`), `NotifyBell` (`../notify/NotifyBell.js`).

- [ ] **Step 1: Add a failing assertion for the bell**

In `packages/console/src/shell/Shell.test.tsx`, add to the first `describe`:

```tsx
  it("renders the notification bell in the header", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByRole("button", { name: /notification/i })).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/shell/Shell.test.tsx`
Expected: FAIL — no button matching /notification/i.

- [ ] **Step 3: Wire Shell**

In `packages/console/src/shell/Shell.tsx`, add imports:

```ts
import { ToastProvider } from "./Toast.js";
import { NotificationsProvider } from "../notify/NotificationsProvider.js";
import { NotifyBell } from "../notify/NotifyBell.js";
```

Wrap the returned tree in `<ToastProvider>`, render `<NotifyBell />` next to `WarmingPill`, and mount `<NotificationsProvider apiBase={apiBase} />` inside the provider. The return becomes:

```tsx
  return (
    <ToastProvider>
      <div className="console">
        <nav className="console-nav">
          <div className="console-brand">
            <svg className="console-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill="currentColor" fillOpacity=".14" />
              <path d="M6 3h12l4 6-10 12L2 9l4-6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" opacity=".7" />
            </svg>
            AgentGem
          </div>
          <WarmingPill apiBase={apiBase} />
          <NotifyBell />
          <div className="console-phase-switch" role="radiogroup" aria-label="Phase" {...roving.containerProps}>
            {PHASES.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === phase}
                className={"console-phase-btn" + (p.id === phase ? " is-active" : "")}
                {...roving.getTabProps(i)}
                onClick={() => goPhase(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {phase === "build" ? <ActiveGemSwitcher apiBase={apiBase} /> : null}
          {groups.map((g) => (
            <div key={g.category} className="console-group">
              <div className="console-group-label">{CATEGORY_LABEL[g.category]}</div>
              {g.pages.map(item)}
            </div>
          ))}
          <div className="console-footer">{footer.map(item)}</div>
        </nav>
        <main className="console-main">{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
        <NotificationsProvider apiBase={apiBase} />
      </div>
    </ToastProvider>
  );
```

- [ ] **Step 4: Run Shell tests to verify they pass**

Run: `pnpm --filter @agentgem/console exec vitest run src/shell/Shell.test.tsx`
Expected: PASS (all existing tests + the new bell assertion).

- [ ] **Step 5: Run the FULL console suite + typecheck**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck`
Expected: all green. (Full suite guards against the hardcoded-count tests noted in project memory — `registry.test`, `pages.test`, `gemTypeRegistry.test`. We add no page, so counts are unchanged; confirm anyway.)

- [ ] **Step 6: Build the console bundle**

Run: `pnpm --filter @agentgem/console build`
Expected: `dist/index.html` rebuilds with no errors (the toast/bell CSS + new modules are inlined).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/shell/Shell.tsx packages/console/src/shell/Shell.test.tsx
git commit -m "feat(console): mount toast + notifications provider + bell in Shell"
```

---

### Task 10: Manual verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Desktop suite + typecheck**

Run: `cd desktop && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: green (Task 1's channel + drift-guard tests included).

- [ ] **Step 2: Manual smoke — browser**

Start the local app (per the `run` skill / project convention), open the console in a browser, click 🔕 → grant permission → confirm it becomes 🔔. With DevTools, temporarily point the poller by triggering a warm pass (or stub `/api/warm/status`), blur the tab, and confirm an OS banner appears; focused, confirm a bottom-right toast instead. Note this in the PR description as manually verified (no automated E2E).

- [ ] **Step 3: Manual smoke — Electron (optional but preferred)**

Run the Electron app in dev, enable via the bell (no permission prompt expected), and confirm a native banner fires on a warm-finish/queue event with the window hidden to tray; clicking it surfaces the window.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/local-notifications
gh pr create --title "feat: local notifications (console + Electron)" \
  --body "$(cat <<'EOF'
Adds in-app toasts + OS notifications for two low-frequency triggers (warm pass
finished, new review-queue items), on both the browser console and the Electron
app, behind a master bell toggle. One shared osNotify() call site prefers the
Electron bridge and falls back to the browser Notification API. No server
changes. Session-finished + Web Push are out of scope (see the design doc).

Spec: docs/superpowers/specs/2026-07-06-local-notifications-design.md
Plan: docs/superpowers/plans/2026-07-06-local-notifications.md

Console tests are not in CI — run locally; verified green. Manual OS-notification
smoke described in the plan's Task 10.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then follow the repo PR lifecycle: `gh run watch <run-id> --exit-status`, and after merge verify each commit's content landed on `origin/main`.

---

## Self-Review

**Spec coverage:**
- Warm-finished trigger → Task 3 (`detectWarm`) + Task 7 (poll/wire). ✓
- Dream-queue trigger → Task 3 (`detectDream`) + Task 7. ✓
- Shared `osNotify` (bridge → browser) → Task 2. ✓
- Focus-based routing (toast vs toast+OS) → Task 4. ✓
- Master toggle in localStorage → Task 5 + Task 8 (bell). ✓
- In-app toast system → Task 6. ✓
- Electron bridge (`ipc.ts`/`preload.ts`/`main.ts`) → Task 1. ✓
- Shell wiring (provider + toast container + bell) → Task 9. ✓
- Testing across both packages → Tasks 1–9 (unit) + Task 10 (desktop suite + manual). ✓
- "No server changes" → honored; no `src/` task. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one "optional" step (Task 10 Step 3, Electron manual smoke) is explicitly optional, not a gap.

**Type consistency:** `NotifyEvent { key, title, message }` used identically in Tasks 3/4/7. `WarmSnapshot { running }` / `DreamSnapshot { queued }` defined in Task 3, consumed in Task 7. `useToast().push` defined in Task 6, consumed in Task 7. `osNotify(title, body)` defined in Task 2, consumed in Tasks 4-deps/7. `window.agentgem?.notify` typed in Task 2b, used in Tasks 7-via-osNotify/8. Channel `NOTIFY = "agentgem:notify"` defined in Task 1, mirrored in preload + asserted by the drift guard. Consistent.
