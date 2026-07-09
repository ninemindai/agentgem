# Console Identity Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the user's GitHub identity in the console shell — a footer chip that opens `app.agentgem.ai` signed in, signs in via a modal when unbound — and make Play/Studio's publish auto-resume after an inline GitHub connect instead of dead-ending.

**Architecture:** The device-flow connect UI is currently copy-pasted in `Settings/index.tsx` and `Curate/PublishToExplore.tsx`; Studio would be a third copy. Extract it into `packages/console/src/identity/`: an `IdentityProvider` React context owning **status** (one `bindStatusRoute` fetch, plus `refresh()`), and a `useGitHubBind()` hook owning **flow** (device code, polling). `ConnectGitHub` is a chrome-free presentational component so Studio renders it as an inline banner and `IdentityChip` renders it inside `ConnectGitHubModal`. No server change: `POST /api/auth/web-handoff` already mints a one-time code and returns a signed-in URL.

**Tech Stack:** React 19 + TypeScript, vitest + @testing-library/react, plain CSS in `packages/console/src/shell/theme.css`. Routes are typed clients from `packages/console/src/api/routes.ts`.

**Spec:** `docs/superpowers/specs/2026-07-08-console-identity-shell-design.md`

## Global Constraints

- Worktree: `/Users/rfeng/Projects/ninemind/agentgem-identity-chip`, branch `feat/console-identity-chip`. All paths below are relative to it.
- Console tests are **not in CI**. Run `pnpm -C packages/console test` locally; report real output.
- Console has a **single warm-paper theme**. No dark-mode variants. Use existing CSS vars: `--raised`, `--line`, `--line-soft`, `--ink`, `--ink-soft`, `--muted`, `--accent`, `--paper-2`, `--shadow-md`, `--font-ui`, `--font-display`.
- Console vitest is capped at 4 workers (PR #195). Do not raise it.
- Existing assertions in `Settings.test.tsx` and `PublishToExplore.test.tsx` must survive **byte-for-byte**. The only permitted edit is wrapping `render(...)` in `<IdentityProvider>`. If an assertion must change, stop and escalate.
- Imports inside `packages/console/src` use explicit `.js` extensions (ESM), e.g. `from "../api/routes.js"`.
- Do **not** extract a shared `<Modal>` primitive, and do not touch the existing modals in `Setup/index.tsx` or `Play/Runner.tsx`.
- Never commit to `main`. Commit to `feat/console-identity-chip`.

---

### Task 1: Identity status context

The one fact about the machine — who is signed in — fetched once and shared, so connecting in Studio updates the footer chip.

**Files:**
- Create: `packages/console/src/identity/IdentityProvider.tsx`
- Test: `packages/console/src/identity/__tests__/IdentityProvider.test.tsx`

**Interfaces:**
- Consumes: `bindStatusRoute`, `makeClient` from `packages/console/src/api/routes.ts`.
- Produces:
  - `type IdentityStatus = { bound: boolean; login?: string; provider?: string; avatarUrl?: string; sessionActive?: boolean }`
  - `function IdentityProvider(props: { apiBase: string; children: React.ReactNode }): ReactElement`
  - `function useIdentity(): { status: IdentityStatus | null; refresh: () => Promise<void>; setStatus: (s: IdentityStatus) => void }` — throws `Error("useIdentity must be used inside <IdentityProvider>")` when no provider. `status` is `null` until the first fetch settles.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/identity/__tests__/IdentityProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider, useIdentity } from "../IdentityProvider.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Probe() {
  const { status, refresh } = useIdentity();
  return (
    <div>
      <span data-testid="login">{status === null ? "loading" : status.bound ? `@${status.login}` : "unbound"}</span>
      <button onClick={() => void refresh()}>refresh</button>
    </div>
  );
}

describe("IdentityProvider", () => {
  it("fetches bind status once on mount and exposes it", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    expect(await screen.findByText("@bob")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("refresh() re-fetches and propagates the new status to consumers", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "alice" } as never);
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    expect(await screen.findByText("unbound")).toBeTruthy();
    fireEvent.click(screen.getByText("refresh"));
    expect(await screen.findByText("@alice")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("treats a failed status fetch as unbound rather than crashing the shell", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockRejectedValue(new Error("offline"));
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    expect(await screen.findByText("unbound")).toBeTruthy();
  });

  it("useIdentity() throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside/);
  });

  it("does not poll", async () => {
    const call = vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    render(<IdentityProvider apiBase=""><Probe /></IdentityProvider>);
    await screen.findByText("unbound");
    await new Promise((r) => setTimeout(r, 50));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/IdentityProvider.test.tsx`
Expected: FAIL — `Failed to resolve import "../IdentityProvider.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/identity/IdentityProvider.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// One source of truth for "who is signed in" across the console. Mounted once in
// Shell. Fetched on mount and on explicit refresh() — never polled: the bind only
// changes as a result of a user action in this app.
import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { bindStatusRoute, makeClient } from "../api/routes.js";

export type IdentityStatus = {
  bound: boolean;
  login?: string;
  provider?: string;
  avatarUrl?: string;
  sessionActive?: boolean;
};

type IdentityContextValue = {
  status: IdentityStatus | null; // null until the first fetch settles
  refresh: () => Promise<void>;
  setStatus: (s: IdentityStatus) => void;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function useIdentity(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used inside <IdentityProvider>");
  return ctx;
}

export function IdentityProvider({ apiBase, children }: { apiBase: string; children: ReactNode }): ReactElement {
  const [status, setStatus] = useState<IdentityStatus | null>(null);

  // A status fetch that fails (daemon down, offline) must not take the shell with
  // it — an unbound chip is the correct degraded state.
  const refresh = useCallback(async () => {
    try {
      setStatus(await bindStatusRoute.call(makeClient(apiBase)));
    } catch {
      setStatus({ bound: false });
    }
  }, [apiBase]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <IdentityContext.Provider value={{ status, refresh, setStatus }}>
      {children}
    </IdentityContext.Provider>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/IdentityProvider.test.tsx`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/identity/IdentityProvider.tsx packages/console/src/identity/__tests__/IdentityProvider.test.tsx
git commit -m "feat(console): IdentityProvider context for bind status"
```

---

### Task 2: The device-flow hook

Flow state is ephemeral and per-panel — Studio's banner and Settings' row must not share a spinner — so this is a hook, not context. It calls the context's `refresh()` on success so every consumer converges.

**Files:**
- Create: `packages/console/src/identity/useGitHubBind.ts`
- Test: `packages/console/src/identity/__tests__/useGitHubBind.test.tsx`

**Interfaces:**
- Consumes: `useIdentity` (Task 1); `bindStartRoute`, `bindCompleteRoute`, `makeClient` from `../api/routes.js`.
- Produces:
  - `function rejectionMessage(slug: string): string`
  - `type BindFlow = { userCode: string; openUrl: string; deviceCode: string; interval?: number }`
  - `type GitHubBind = { flow: BindFlow | null; unconfigured: boolean; connectBusy: boolean; polling: boolean; codeCopied: boolean; error: string | null; connect: () => Promise<void>; copyOpenAndWait: () => Promise<void>; reset: () => void }`
  - `function useGitHubBind(apiBase: string, opts?: { onBound?: (login: string) => void }): GitHubBind`

Behavior contract (each is asserted below):
- `connect()` calls `bindStartRoute` and shows the code. It does **not** poll and does **not** open a browser — so the code being polled is always the code the user authorized.
- `copyOpenAndWait()` copies the code, opens `openUrl`, then polls via `bindCompleteRoute`.
- `openUrl` is `verificationUriComplete ?? verificationUri` (code-prefilled when the server supplies it).
- On `{bound:true}`: clears the flow, calls `useIdentity().refresh()`, then `opts.onBound(login)`.
- On `{bound:false, rejected}`: sets `error` to `rejectionMessage(rejected)`, leaves the flow up so the user can retry.
- `reset()` clears flow, error, and `unconfigured` (used when a modal closes).

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/identity/__tests__/useGitHubBind.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../IdentityProvider.js";
import { useGitHubBind, rejectionMessage } from "../useGitHubBind.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bound: string[] = [];
function Probe({ onBound }: { onBound?: (l: string) => void }) {
  const b = useGitHubBind("", { onBound });
  return (
    <div>
      <button onClick={() => void b.connect()}>connect</button>
      <button onClick={() => void b.copyOpenAndWait()}>copyopen</button>
      <button onClick={b.reset}>reset</button>
      <span data-testid="code">{b.flow?.userCode ?? ""}</span>
      <span data-testid="error">{b.error ?? ""}</span>
      <span data-testid="unconfigured">{String(b.unconfigured)}</span>
    </div>
  );
}
const mount = (onBound?: (l: string) => void) =>
  render(<IdentityProvider apiBase=""><Probe onBound={onBound} /></IdentityProvider>);

describe("useGitHubBind", () => {
  it("connect() shows the code without polling or opening a browser", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc", interval: 5 } as never);
    const complete = vi.spyOn(routes.bindCompleteRoute, "call");
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(screen.getByText("connect"));
    expect((await screen.findByTestId("code")).textContent).toBe("AB-12");
    expect(complete).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("prefers verificationUriComplete when the server supplies it", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", verificationUriComplete: "https://gh/device?user_code=AB-12", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    expect(openSpy).toHaveBeenCalledWith("https://gh/device?user_code=AB-12", "_blank", "noopener");
  });

  it("falls back to the bare verificationUri when no complete URL is supplied", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    expect(openSpy).toHaveBeenCalledWith("https://gh/device", "_blank", "noopener");
  });

  it("on success refreshes identity status and calls onBound(login)", async () => {
    const status = vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "bob" } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.stubGlobal("open", vi.fn());
    const onBound = vi.fn();
    mount(onBound);
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(onBound).toHaveBeenCalledWith("bob"));
    expect(status).toHaveBeenCalledTimes(2); // mount + refresh
    expect(screen.getByTestId("code").textContent).toBe("");
  });

  it("maps a rejection slug to guidance copy and keeps the flow up for retry", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: false, rejected: "unknown-producer" } as never);
    vi.stubGlobal("open", vi.fn());
    const onBound = vi.fn();
    mount(onBound);
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toMatch(/Publish or share a Gem first/));
    expect(onBound).not.toHaveBeenCalled();
    expect(screen.getByTestId("code").textContent).toBe("AB-12"); // retryable
  });

  it("surfaces a thrown network error instead of swallowing it", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockRejectedValue(new Error("expired_token"));
    vi.stubGlobal("open", vi.fn());
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("expired_token"));
  });

  it("sets unconfigured when the server has no GitHub app", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: false } as never);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(screen.getByTestId("unconfigured").textContent).toBe("true"));
    expect(screen.getByTestId("code").textContent).toBe("");
  });

  it("reset() clears flow, error and unconfigured", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("reset"));
    expect(screen.getByTestId("code").textContent).toBe("");
    expect(screen.getByTestId("unconfigured").textContent).toBe("false");
  });

  it("rejectionMessage maps known slugs and passes unknown ones through", () => {
    expect(rejectionMessage("unknown-producer")).toMatch(/Publish or share a Gem first/);
    expect(rejectionMessage("bad-signature")).toMatch(/signature check/);
    expect(rejectionMessage("weird")).toBe("Verification failed: weird");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/useGitHubBind.test.tsx`
Expected: FAIL — `Failed to resolve import "../useGitHubBind.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/identity/useGitHubBind.ts`. `rejectionMessage` is moved verbatim from `panels/Settings/index.tsx:19-34`.

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The GitHub device-flow, once. Flow state is per-consumer (a Studio banner and a
// Settings row must not share a spinner), so this is a hook — not context. Status
// lives in IdentityProvider; on success we refresh it so every consumer converges.
import { useCallback, useState } from "react";
import { bindStartRoute, bindCompleteRoute, makeClient } from "../api/routes.js";
import { useIdentity } from "./IdentityProvider.js";

// The aggregator returns machine-readable rejection slugs; turn them into guidance.
// `unknown-producer` is the common one on a fresh key — the bind requires you to
// have produced (shared/published) at least once before an identity can be linked.
export function rejectionMessage(slug: string): string {
  switch (slug) {
    case "unknown-producer":
      return "Publish or share a Gem first — verification links your GitHub to an identity that has already produced something.";
    case "bad-signature":
      return "Verification failed a signature check. Please try Connect again.";
    case "stale":
      return "The verification request expired. Please try Connect again.";
    case "provider-error":
      return "Couldn't reach GitHub just now. Please try again in a moment.";
    case "not-configured":
      return "Identity verification isn't configured on this server.";
    default:
      return `Verification failed: ${slug}`;
  }
}

export type BindFlow = { userCode: string; openUrl: string; deviceCode: string; interval?: number };

export type GitHubBind = {
  flow: BindFlow | null;
  unconfigured: boolean;
  connectBusy: boolean;
  polling: boolean;
  codeCopied: boolean;
  error: string | null;
  connect: () => Promise<void>;
  copyOpenAndWait: () => Promise<void>;
  reset: () => void;
};

export function useGitHubBind(apiBase: string, opts: { onBound?: (login: string) => void } = {}): GitHubBind {
  const { refresh } = useIdentity();
  const [flow, setFlow] = useState<BindFlow | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => { setFlow(null); setError(null); setUnconfigured(false); }, []);

  // Step 1: mint the device code and show it. Deliberately does NOT poll and does NOT
  // open a browser yet — both happen in copyOpenAndWait, so the code being polled and
  // the code the user authorizes are always the same, and the ~5-min poll window
  // aligns with the moment they actually go to authorize.
  const connect = useCallback(async () => {
    setError(null); setUnconfigured(false); setFlow(null); setConnectBusy(true);
    try {
      const r = await bindStartRoute.call(makeClient(apiBase), { body: {} });
      if (!r.configured) { setUnconfigured(true); return; }
      setFlow({
        userCode: r.userCode!,
        openUrl: r.verificationUriComplete ?? r.verificationUri!,
        deviceCode: r.deviceCode!,
        interval: r.interval,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub — try again.");
    } finally {
      setConnectBusy(false);
    }
  }, [apiBase]);

  // Step 2: copy the code, open GitHub in the system browser, then poll. The long-poll
  // resolves once the user authorizes there.
  const copyOpenAndWait = useCallback(async () => {
    if (!flow || polling) return;
    void navigator.clipboard?.writeText(flow.userCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 1500);
    window.open(flow.openUrl, "_blank", "noopener"); // desktop: main.ts routes to the system browser
    setError(null);
    setPolling(true);
    try {
      const res = await bindCompleteRoute.call(makeClient(apiBase), { body: { deviceCode: flow.deviceCode, interval: flow.interval } });
      if (res.bound) {
        setFlow(null);
        await refresh();
        // Pass login straight through: reading it back off the refreshed context would
        // race the render that applies it, so a resuming caller could see a stale null.
        opts.onBound?.(res.login!);
      } else {
        // Leave the flow up: a rejection is retryable with the same code.
        setError(rejectionMessage(res.rejected!));
      }
    } catch (e) {
      // Any thrown error (network, expired/denied device code) must surface, not vanish.
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub — try again.");
    } finally {
      setPolling(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, flow, polling, refresh]);

  return { flow, unconfigured, connectBusy, polling, codeCopied, error, connect, copyOpenAndWait, reset };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/useGitHubBind.test.tsx`
Expected: PASS — 9 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/identity/useGitHubBind.ts packages/console/src/identity/__tests__/useGitHubBind.test.tsx
git commit -m "feat(console): useGitHubBind hook owning the device flow"
```

---

### Task 3: ConnectGitHub presentational component

Chrome-free on purpose: Studio renders it as an inline banner, the chip renders it inside modal chrome. One flow hook, two chromes.

**Files:**
- Create: `packages/console/src/identity/ConnectGitHub.tsx`
- Test: `packages/console/src/identity/__tests__/ConnectGitHub.test.tsx`

**Interfaces:**
- Consumes: `GitHubBind` (Task 2).
- Produces: `function ConnectGitHub(props: { bind: GitHubBind; idleHint?: ReactNode; idleLabel?: string }): ReactElement`
  - Idle (`flow === null && !unconfigured`): a `Connect GitHub` button (label overridable via `idleLabel`) + `idleHint`.
  - Code (`flow !== null`): `Your code: <strong>CODE</strong>`, a `⧉ Copy code & open GitHub` button, and a "Didn't open?" anchor to `flow.openUrl`.
  - `unconfigured`: `Verification unavailable (not configured)`.
  - `error` renders in all states.

Button labels are load-bearing — `Settings.test.tsx` and `PublishToExplore.test.tsx` match `/connect github/i` and `/copy code & open github/i`. Do not reword.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/identity/__tests__/ConnectGitHub.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConnectGitHub } from "../ConnectGitHub.js";
import type { GitHubBind } from "../useGitHubBind.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bind = (over: Partial<GitHubBind> = {}): GitHubBind => ({
  flow: null, unconfigured: false, connectBusy: false, polling: false, codeCopied: false, error: null,
  connect: vi.fn(), copyOpenAndWait: vi.fn(), reset: vi.fn(), ...over,
});

describe("ConnectGitHub", () => {
  it("idle: renders Connect GitHub and calls connect() on click", () => {
    const b = bind();
    render(<ConnectGitHub bind={b} idleHint={<p>optional hint</p>} />);
    expect(screen.getByText("optional hint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect github/i }));
    expect(b.connect).toHaveBeenCalledTimes(1);
  });

  it("idle: connectBusy disables the button and shows Generating code…", () => {
    render(<ConnectGitHub bind={bind({ connectBusy: true })} />);
    const btn = screen.getByRole("button", { name: /generating code/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("code: shows the code, links openUrl, and calls copyOpenAndWait()", () => {
    const b = bind({ flow: { userCode: "AB-12", openUrl: "https://gh/device?user_code=AB-12", deviceCode: "dc" } });
    render(<ConnectGitHub bind={b} />);
    expect(screen.getByText("AB-12")).toBeTruthy();
    expect(screen.getByRole("link", { name: /open github/i }).getAttribute("href")).toBe("https://gh/device?user_code=AB-12");
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    expect(b.copyOpenAndWait).toHaveBeenCalledTimes(1);
  });

  it("code: polling disables the button and announces the wait", () => {
    const b = bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" }, polling: true });
    render(<ConnectGitHub bind={b} />);
    const btn = screen.getByRole("button", { name: /waiting for authorization/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("unconfigured: explains that verification is unavailable", () => {
    render(<ConnectGitHub bind={bind({ unconfigured: true })} />);
    expect(screen.getByText(/Verification unavailable/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect github/i })).toBeNull();
  });

  it("renders the error text", () => {
    render(<ConnectGitHub bind={bind({ error: "expired_token" })} />);
    expect(screen.getByText("expired_token")).toBeTruthy();
  });

  it("honours an overridden idle label", () => {
    render(<ConnectGitHub bind={bind()} idleLabel="Sign in with GitHub" />);
    expect(screen.getByRole("button", { name: /sign in with github/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/ConnectGitHub.test.tsx`
Expected: FAIL — `Failed to resolve import "../ConnectGitHub.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/identity/ConnectGitHub.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Chrome-free device-flow UI. Studio renders it as an inline banner; IdentityChip
// renders it inside ConnectGitHubModal. Button labels are asserted by
// Settings.test.tsx and PublishToExplore.test.tsx — do not reword them.
import type { ReactElement, ReactNode } from "react";
import type { GitHubBind } from "./useGitHubBind.js";

export function ConnectGitHub({
  bind,
  idleHint,
  idleLabel = "Connect GitHub",
}: {
  bind: GitHubBind;
  idleHint?: ReactNode;
  idleLabel?: string;
}): ReactElement {
  const { flow, unconfigured, connectBusy, polling, codeCopied, error, connect, copyOpenAndWait } = bind;

  return (
    <div className="identity-connect">
      {error && <p className="identity-connect__error">{error}</p>}

      {unconfigured ? (
        <p className="deploy-hint">Verification unavailable (not configured)</p>
      ) : flow ? (
        <>
          <p className="ws-note">Your code: <strong>{flow.userCode}</strong></p>
          <button type="button" className="ledger-build" onClick={() => void copyOpenAndWait()} disabled={polling}>
            {polling ? "Waiting for authorization…" : codeCopied ? "✓ Copied — opening GitHub…" : "⧉ Copy code & open GitHub"}
          </button>
          <p className="deploy-hint">
            Copies the code and opens GitHub in your browser — enter it there and authorize; this verifies automatically.
            {" "}Didn't open? <a href={flow.openUrl} target="_blank" rel="noreferrer">Open GitHub</a>.
          </p>
        </>
      ) : (
        <>
          <button type="button" className="ledger-build" onClick={() => void connect()} disabled={connectBusy}>
            {connectBusy ? "Generating code…" : idleLabel}
          </button>
          {idleHint}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/ConnectGitHub.test.tsx`
Expected: PASS — 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/identity/ConnectGitHub.tsx packages/console/src/identity/__tests__/ConnectGitHub.test.tsx
git commit -m "feat(console): ConnectGitHub presentational device-flow component"
```

---

### Task 4: Migrate Settings onto the hook

The first of the two copies dies here. `Settings.test.tsx` is the safety net: every assertion must survive byte-for-byte; only the `render(...)` wrapper may change.

**Files:**
- Modify: `packages/console/src/panels/Settings/index.tsx` — delete lines 11-14 (`BindFlow`), 16-34 (`rejectionMessage`), 43-47 (bind state), 55-59 (status effect), 61-116 (`connectGitHub`, `copyOpenAndWait`), and rewrite the "Verify identity" section (lines 167-209).
- Modify: `packages/console/src/panels/Settings/Settings.test.tsx` — wrap `render(<Settings …/>)` in `<IdentityProvider apiBase="">`. **No assertion changes.**

**Interfaces:**
- Consumes: `useIdentity` (Task 1), `useGitHubBind` (Task 2), `ConnectGitHub` (Task 3).
- Produces: nothing new. `openOnWeb` and `disconnectGitHub` stay local to Settings — the chip never disconnects.

Note: `disconnectGitHub` currently does `setBindStatus(r)`. It must now call `setStatus(r)` from `useIdentity()` so the footer chip reverts to "Sign in" in the same tick.

- [ ] **Step 1: Wrap the existing tests in the provider (they should fail)**

In `packages/console/src/panels/Settings/Settings.test.tsx`, add the import and a helper directly under the existing imports:

```tsx
import { IdentityProvider } from "../../identity/IdentityProvider.js";

const renderSettings = () => render(<IdentityProvider apiBase=""><Settings apiBase="" /></IdentityProvider>);
```

Then replace every `render(<Settings apiBase="" />);` with `renderSettings();`. Change nothing else — no `expect` line may be touched.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/console vitest run src/panels/Settings/Settings.test.tsx`
Expected: FAIL. The `/api/bind/status` mock is now consumed by the provider while `Settings` still keeps its own `bindStatus` state, so bind assertions (e.g. `Verified as @bob`) fail — Settings has not been migrated yet.

- [ ] **Step 3: Migrate Settings to the shared hook**

In `packages/console/src/panels/Settings/index.tsx`, replace the import block and the identity internals. The final imports:

```tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { Loading } from "../../shell/Loading.js";
import {
  deployTargetsRoute, setCredentialRoute, CREDENTIAL_KEYS, makeClient,
  bindDisconnectRoute, webHandoffRoute,
} from "../../api/routes.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
```

Delete the `BindStatus` type, the `BindFlow` type, and `rejectionMessage` (it now lives in `useGitHubBind.ts`). Inside `Settings`, replace the bind state + effect + `connectGitHub` + `copyOpenAndWait` with:

```tsx
  const { status: bindStatus, refresh, setStatus } = useIdentity();
  const bind = useGitHubBind(apiBase);
  const [bindError, setBindError] = useState<string | null>(null);
```

`openOnWeb` keeps its body but recovers by opening the connect flow instead of only reporting:

```tsx
  // Open app.agentgem.ai already signed in: the local session mints a one-time handoff
  // code (server-side, bearer-authenticated), and we open the redeem URL in the browser.
  const openOnWeb = async () => {
    setBindError(null);
    try {
      const r = await webHandoffRoute.call(makeClient(apiBase), { body: {} });
      if (r.authenticated && r.url) window.open(r.url, "_blank", "noopener");
      else { await refresh(); setBindError("Session expired — reconnect GitHub to open on the web."); }
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
    }
  };
```

`disconnectGitHub` writes through the context so the footer chip updates:

```tsx
  const disconnectGitHub = async () => {
    setBindError(null);
    bind.reset();
    try {
      setStatus(await bindDisconnectRoute.call(makeClient(apiBase), { body: {} }));
    } catch (e) {
      setBindError(e instanceof Error ? e.message : String(e));
    }
  };
```

Replace the whole "Verify identity" section body with:

```tsx
      <section className="ledger-group">
        <h2 className="ledger-group-label">Verify identity</h2>
        {bindError && <p className="ledger-error">{bindError}</p>}
        {bindStatus === null ? null : bindStatus.bound ? (
          <div className="ledger-bar">
            <span className="ws-note">
              {bindStatus.avatarUrl && (
                <img src={bindStatus.avatarUrl} alt={`@${bindStatus.login}`} width={20} height={20}
                     style={{ borderRadius: "50%", verticalAlign: "middle", marginRight: 6 }} />
              )}
              Verified as @{bindStatus.login}
            </span>
            {bindStatus.sessionActive
              ? <button type="button" className="ledger-build" onClick={openOnWeb}>Open on the web ↗</button>
              : <span className="ws-note">Session expired — Disconnect then Connect to sign in on the web</span>}
            <button type="button" className="ledger-view" onClick={disconnectGitHub}>Disconnect</button>
          </div>
        ) : (
          <>
            <p className="deploy-hint">Not verified — your installs won't count toward verified ratings</p>
            <ConnectGitHub
              bind={bind}
              idleHint={<p className="deploy-hint">Connect to unlock 💎 Diamond — verified installs count toward your rating</p>}
            />
          </>
        )}
      </section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console vitest run src/panels/Settings/Settings.test.tsx`
Expected: PASS — 9 passed. If any `expect` needed editing, revert and escalate: the hook's shape is wrong.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C packages/console exec tsc --noEmit
git add packages/console/src/panels/Settings/
git commit -m "refactor(console): Settings uses the shared identity hook"
```

---

### Task 5: Migrate PublishToExplore onto the hook

The second copy dies. Same rule: assertions byte-for-byte, only the `render` wrapper changes.

**Files:**
- Modify: `packages/console/src/panels/Curate/PublishToExplore.tsx` — delete lines 29-33 (bind/connect state), 37-43 (status effect), 45-88 (`connectGitHub`, `copyOpenAndWait`); rewrite the connect block (lines 150-172).
- Modify: `packages/console/src/panels/Curate/PublishToExplore.test.tsx` — wrap `render(<PublishToExplore …/>)` in `<IdentityProvider apiBase="">`. **No assertion changes.**

**Interfaces:**
- Consumes: `useIdentity`, `useGitHubBind`, `ConnectGitHub`.
- Produces: nothing new.

The scope field currently prefills from the bind status inside the fetch callback. That callback is gone, so prefill in an effect keyed on `status`. Prefill must not clobber a scope the user already typed — keep the `cur || …` guard.

- [ ] **Step 1: Wrap the existing tests in the provider (they should fail)**

In `packages/console/src/panels/Curate/PublishToExplore.test.tsx` add under the imports:

```tsx
import { IdentityProvider } from "../../identity/IdentityProvider.js";

const renderPublish = (props: React.ComponentProps<typeof PublishToExplore>) =>
  render(<IdentityProvider apiBase=""><PublishToExplore {...props} /></IdentityProvider>);
```

Replace each `render(<PublishToExplore … />)` with `renderPublish({ … })`, passing the same props. Touch no `expect`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/console vitest run src/panels/Curate/PublishToExplore.test.tsx`
Expected: FAIL — the provider consumes `/api/bind/status` while the component still holds its own `bindStatus`, so `verified as @octocat` and the connect-flow assertions fail.

- [ ] **Step 3: Migrate PublishToExplore to the shared hook**

Final imports:

```tsx
import { useEffect, useState } from "react";
import { createWorkspaceRoute, publishSetupRoute, makeClient } from "../../api/routes.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
import { buildSelection } from "./selection.js";
```

Replace the bind state, the status effect, `connectGitHub` and `copyOpenAndWait` with:

```tsx
  const { status: bindStatus } = useIdentity();
  const bind = useGitHubBind(apiBase);

  // Prefill the scope from the verified login, without clobbering a typed value.
  useEffect(() => {
    if (bindStatus?.bound && bindStatus.login) setScope((cur) => cur || `@${bindStatus.login}`);
  }, [bindStatus?.bound, bindStatus?.login]);
```

Replace the connect block (the `{bindStatus && !bindStatus.bound && (…)}` JSX) with:

```tsx
      {bindStatus && !bindStatus.bound && (
        <div className="explore-connect">
          <ConnectGitHub
            bind={bind}
            idleHint={<p>Optional — verify authorship so your Playbook publishes as verified.</p>}
          />
        </div>
      )}
```

The `publish-verified` badge above it is unchanged; it now reads `bindStatus` from the context, so it flips to "✓ Verified as @octocat" the moment `refresh()` lands.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console vitest run src/panels/Curate/PublishToExplore.test.tsx`
Expected: PASS — 6 passed. In particular `expect(openSpy).toHaveBeenCalledWith("https://github.com/login/device", "_blank", "noopener")` still passes: the stub sets no `verificationUriComplete`, so `?? ` yields the bare URL.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C packages/console exec tsc --noEmit
git add packages/console/src/panels/Curate/
git commit -m "refactor(console): PublishToExplore uses the shared identity hook"
```

---

### Task 6: ConnectGitHubModal

Centered modal chrome around `ConnectGitHub`. Owns its own `identity-modal` classes — `Setup`'s `setup-modal` classes are Setup's to rename, and coupling to them would break the chip on an unrelated refactor.

**Files:**
- Create: `packages/console/src/identity/ConnectGitHubModal.tsx`
- Test: `packages/console/src/identity/__tests__/ConnectGitHubModal.test.tsx`
- Modify: `packages/console/src/shell/theme.css` — append the `identity-modal` block after the `.setup-config` rule (currently line 894).

**Interfaces:**
- Consumes: `ConnectGitHub` (Task 3), `GitHubBind` (Task 2).
- Produces: `function ConnectGitHubModal(props: { bind: GitHubBind; onClose: () => void; title?: string }): ReactElement`
  - `role="dialog"`, `aria-modal="true"`, `aria-label` = `title` (default `"Connect GitHub"`).
  - Escape closes. Overlay click closes. Panel click does not (`stopPropagation`).
  - The caller owns `bind` and is responsible for calling `bind.reset()` on close.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/identity/__tests__/ConnectGitHubModal.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConnectGitHubModal } from "../ConnectGitHubModal.js";
import type { GitHubBind } from "../useGitHubBind.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bind = (over: Partial<GitHubBind> = {}): GitHubBind => ({
  flow: null, unconfigured: false, connectBusy: false, polling: false, codeCopied: false, error: null,
  connect: vi.fn(), copyOpenAndWait: vi.fn(), reset: vi.fn(), ...over,
});

describe("ConnectGitHubModal", () => {
  it("renders a labelled modal dialog wrapping ConnectGitHub", () => {
    render(<ConnectGitHubModal bind={bind()} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Connect GitHub");
    expect(screen.getByRole("button", { name: /connect github/i })).toBeTruthy();
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<ConnectGitHubModal bind={bind()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("overlay click closes, panel click does not", () => {
    const onClose = vi.fn();
    const { container } = render(<ConnectGitHubModal bind={bind()} onClose={onClose} />);
    fireEvent.click(container.querySelector(".identity-modal__panel")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".identity-modal")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close button closes", () => {
    const onClose = vi.fn();
    render(<ConnectGitHubModal bind={bind()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the device code once the flow is live", () => {
    render(<ConnectGitHubModal bind={bind({ flow: { userCode: "AB-12", openUrl: "https://gh/d", deviceCode: "dc" } })} onClose={vi.fn()} />);
    expect(screen.getByText("AB-12")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/ConnectGitHubModal.test.tsx`
Expected: FAIL — `Failed to resolve import "../ConnectGitHubModal.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/identity/ConnectGitHubModal.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Modal chrome around ConnectGitHub, for signing in from the shell's identity chip.
// Owns its own classes: Setup's `setup-modal` styles are panel-local and renaming
// them there must not silently break the chip.
import { useEffect, type ReactElement } from "react";
import { ConnectGitHub } from "./ConnectGitHub.js";
import type { GitHubBind } from "./useGitHubBind.js";

export function ConnectGitHubModal({
  bind,
  onClose,
  title = "Connect GitHub",
}: {
  bind: GitHubBind;
  onClose: () => void;
  title?: string;
}): ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="identity-modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="identity-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="identity-modal__head">
          <strong>{title}</strong>
          <button type="button" className="identity-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="identity-modal__body">
          <ConnectGitHub
            bind={bind}
            idleLabel="Sign in with GitHub"
            idleHint={<p className="deploy-hint">Signs you in here and on app.agentgem.ai.</p>}
          />
        </div>
      </div>
    </div>
  );
}
```

Append to `packages/console/src/shell/theme.css`, immediately after the `.setup-config` rule:

```css
.identity-modal { position: fixed; inset: 0; z-index: 60; background: rgba(32, 25, 15, .38); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; padding: 4vh 4vw; }
.identity-modal__panel { background: var(--raised); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow-md); width: min(440px, 100%); display: flex; flex-direction: column; overflow: hidden; }
.identity-modal__head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); }
.identity-modal__head strong { flex: 1; font: 600 16px/1.2 var(--font-display); color: var(--ink); }
.identity-modal__close { flex: none; border: 1px solid var(--line); background: var(--paper-2); color: var(--ink-soft);
  border-radius: 7px; width: 28px; height: 28px; cursor: pointer; font-size: 13px; }
.identity-modal__close:hover { border-color: var(--accent); color: var(--accent); }
.identity-modal__body { padding: 12px 16px 18px; }
.identity-connect__error { margin: 0 0 8px; color: var(--accent); font: 12.5px/1.5 var(--font-ui); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/ConnectGitHubModal.test.tsx`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/identity/ConnectGitHubModal.tsx packages/console/src/identity/__tests__/ConnectGitHubModal.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): ConnectGitHubModal for signing in from the shell"
```

---

### Task 7: IdentityChip

The chip is the primary identity affordance. Signed in it opens `app.agentgem.ai` via the one-time handoff; otherwise it opens the modal.

**Files:**
- Create: `packages/console/src/identity/IdentityChip.tsx`
- Test: `packages/console/src/identity/__tests__/IdentityChip.test.tsx`
- Modify: `packages/console/src/shell/theme.css` — append the `identity-chip` block after the `identity-modal` block from Task 6.

**Interfaces:**
- Consumes: `useIdentity`, `useGitHubBind`, `ConnectGitHubModal`; `webHandoffRoute`, `makeClient` from `../api/routes.js`.
- Produces: `function IdentityChip(props: { apiBase: string }): ReactElement | null` — renders `null` while `status === null` (first fetch in flight), so the footer doesn't flash "Sign in" for a signed-in user.

Click behavior:
- `bound && sessionActive` → `webHandoffRoute`. `{authenticated:true,url}` → `window.open(url,"_blank","noopener")`. `{authenticated:false}` → `refresh()` then open the modal (the server already cleared the dead session).
- `bound && !sessionActive` → open the modal directly (no handoff code can be minted without a live session).
- `!bound` → open the modal.
- Closing the modal calls `bind.reset()`, so reopening mints a fresh device code rather than resuming a possibly-expired one.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/identity/__tests__/IdentityChip.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../IdentityProvider.js";
import { IdentityChip } from "../IdentityChip.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = () => render(<IdentityProvider apiBase=""><IdentityChip apiBase="" /></IdentityProvider>);

describe("IdentityChip", () => {
  it("signed in: shows @login and opens the handoff URL", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png", sessionActive: true } as never);
    vi.spyOn(routes.webHandoffRoute, "call").mockResolvedValue({ authenticated: true, url: "https://api.agentgem.ai/api/auth/github/handoff?code=xyz" } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith("https://api.agentgem.ai/api/auth/github/handoff?code=xyz", "_blank", "noopener"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("signed in: renders the avatar", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png", sessionActive: true } as never);
    mount();
    const img = await screen.findByRole("img", { name: /bob/i });
    expect(img.getAttribute("src")).toBe("https://a/bob.png");
  });

  it("unbound: shows Sign in and opens the modal, minting a device code", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    const start = vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /sign in with github/i }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("AB-12")).toBeTruthy();
  });

  it("completing the bind closes the modal and the chip becomes @login", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "alice", sessionActive: true } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "alice" } as never);
    vi.stubGlobal("open", vi.fn());
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));
    expect(await screen.findByRole("button", { name: /@alice/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("session expired: clicking opens the modal instead of a signed-out tab", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: false } as never);
    const handoff = vi.spyOn(routes.webHandoffRoute, "call");
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(handoff).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("handoff says unauthenticated: opens the modal, does not open a tab", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.webHandoffRoute, "call").mockResolvedValue({ authenticated: false } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /@bob/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("closing the modal resets the flow, so reopening mints a fresh code", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    const start = vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    fireEvent.click(await screen.findByRole("button", { name: /sign in with github/i }));
    expect(await screen.findByText("AB-12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
    // The code is gone — the modal reopened in its idle state.
    expect(screen.queryByText("AB-12")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /sign in with github/i }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it("renders nothing until the first status fetch settles", () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockReturnValue(new Promise(() => {}) as never);
    const { container } = mount();
    expect(container.querySelector(".identity-chip")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/IdentityChip.test.tsx`
Expected: FAIL — `Failed to resolve import "../IdentityChip.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/console/src/identity/IdentityChip.tsx`:

```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The console's identity affordance. Signed in, it mints a one-time handoff code and
// opens app.agentgem.ai already authenticated (desktop: main.ts routes window.open to
// the system browser). Otherwise it opens the device-flow modal.
import { useState, type ReactElement } from "react";
import { webHandoffRoute, makeClient } from "../api/routes.js";
import { useIdentity } from "./IdentityProvider.js";
import { useGitHubBind } from "./useGitHubBind.js";
import { ConnectGitHubModal } from "./ConnectGitHubModal.js";

export function IdentityChip({ apiBase }: { apiBase: string }): ReactElement | null {
  const { status, refresh } = useIdentity();
  const [open, setOpen] = useState(false);
  // Closing the modal on success is the natural end of the flow.
  const bind = useGitHubBind(apiBase, { onBound: () => setOpen(false) });

  // Abandon the device code on close: reopening mints a fresh one rather than
  // resuming a code that may have expired against GitHub in the meantime.
  const close = () => { setOpen(false); bind.reset(); };

  if (status === null) return null; // first fetch in flight — don't flash "Sign in"

  const openOnWeb = async () => {
    try {
      const r = await webHandoffRoute.call(makeClient(apiBase), { body: {} });
      if (r.authenticated && r.url) { window.open(r.url, "_blank", "noopener"); return; }
    } catch {
      /* fall through to the connect modal — a dead session is the likely cause */
    }
    // The server clears the dead session on its own 401, so reconnecting is the fix.
    await refresh();
    setOpen(true);
  };

  const onClick = () => {
    if (status.bound && status.sessionActive) { void openOnWeb(); return; }
    setOpen(true);
  };

  const label = status.bound ? `@${status.login}` : "Sign in";
  const title = status.bound
    ? status.sessionActive ? "Open app.agentgem.ai signed in" : "Session expired — reconnect GitHub"
    : "Sign in with GitHub";

  return (
    <>
      <button
        type="button"
        className={"identity-chip" + (status.bound && !status.sessionActive ? " is-stale" : "")}
        onClick={onClick}
        title={title}
      >
        {status.avatarUrl
          ? <img className="identity-chip__avatar" src={status.avatarUrl} alt={`@${status.login}`} width={20} height={20} />
          : <span className="identity-chip__avatar identity-chip__avatar--empty" aria-hidden="true" />}
        <span className="identity-chip__label">{label}</span>
        {status.bound && status.sessionActive && <span className="identity-chip__ext" aria-hidden="true">↗</span>}
      </button>
      {open && <ConnectGitHubModal bind={bind} onClose={close} />}
    </>
  );
}
```

Append to `packages/console/src/shell/theme.css`, after the `identity-modal` block:

```css
.identity-chip { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 6px;
  border: 1px solid var(--line); background: var(--paper-2); color: var(--ink-soft);
  border-radius: 8px; padding: 6px 10px; cursor: pointer; font: 600 12px/1 var(--font-ui);
  transition: border-color .13s ease, color .13s ease; }
.identity-chip:hover { border-color: var(--accent); color: var(--accent); }
.identity-chip.is-stale { opacity: .62; }
.identity-chip__avatar { width: 20px; height: 20px; border-radius: 50%; flex: none; }
.identity-chip__avatar--empty { background: var(--line); }
.identity-chip__label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.identity-chip__ext { flex: none; opacity: .7; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console vitest run src/identity/__tests__/IdentityChip.test.tsx`
Expected: PASS — 8 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/identity/IdentityChip.tsx packages/console/src/identity/__tests__/IdentityChip.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): identity chip opens app.agentgem.ai signed in"
```

---

### Task 8: Mount the provider and chip in Shell

**Files:**
- Modify: `packages/console/src/shell/Shell.tsx` — import `IdentityProvider` + `IdentityChip`; wrap the tree; render the chip in `.console-footer`.
- Modify: `packages/console/src/shell/Shell.test.tsx` — existing tests render `Shell` with no fetch stub. The provider swallows fetch failures into `{bound:false}`, so the chip renders "Sign in". Add one test asserting it.

**Interfaces:**
- Consumes: `IdentityProvider` (Task 1), `IdentityChip` (Task 7).
- Produces: nothing.

`IdentityProvider` must wrap `IdentityChip` — put it just inside `ToastProvider` so any future panel can call `useIdentity()`.

- [ ] **Step 1: Write the failing test**

Append to `packages/console/src/shell/Shell.test.tsx`, inside the top-level `describe`:

```tsx
  it("renders the identity chip in the footer, unbound when the daemon is unreachable", async () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
  });
```

(`pages` is the existing two-phase registry fixture defined at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/shell/Shell.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "button" and name /sign in/i`.

- [ ] **Step 3: Wire the provider and chip into Shell**

In `packages/console/src/shell/Shell.tsx`, add to the imports:

```tsx
import { IdentityProvider } from "../identity/IdentityProvider.js";
import { IdentityChip } from "../identity/IdentityChip.js";
```

Wrap the tree and add the chip to the footer. The `return` becomes:

```tsx
  return (
    <ToastProvider>
      <IdentityProvider apiBase={apiBase}>
        <div className="console">
          <nav className="console-nav">
            {/* …brand, WarmingPill, phase switch, ActiveGemSwitcher, groups — unchanged… */}
            <div className="console-footer">
              <NotifyBell />
              {footer.map(item)}
              <IdentityChip apiBase={apiBase} />
            </div>
          </nav>
          <main className="console-main">{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
          <NotificationsProvider apiBase={apiBase} />
        </div>
      </IdentityProvider>
    </ToastProvider>
  );
```

Change only the wrapper and the `.console-footer` line — leave every other element byte-for-byte as it was.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console vitest run src/shell/Shell.test.tsx`
Expected: PASS. If a pre-existing Shell test counts nav buttons and now fails, that is a real regression in this task — fix by scoping its query, not by removing the chip.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C packages/console exec tsc --noEmit
git add packages/console/src/shell/
git commit -m "feat(console): mount IdentityProvider + identity chip in the shell"
```

---

### Task 9: Studio publish auto-resumes after an inline connect

The dead end (`Studio.tsx:143`) becomes an inline connect that finishes the publish the user already asked for.

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` — split `shareToExplore` into a gate + `publishWorkspace(login)`; drop the `bindStatusRoute` import; add the connect banner.
- Test: `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx` (create)

**Interfaces:**
- Consumes: `useIdentity`, `useGitHubBind`, `ConnectGitHub`.
- Produces: nothing.

Three properties the tests below pin down:
1. `publishWorkspace(login)` takes `login` as a parameter — reading it off the refreshed context would race the render that applies the refresh.
2. `save()` is **not** re-run on resume. The workspace and its seal already exist; re-saving could surface a spurious gate banner right after a successful authorization.
3. `pendingPublish` resets on modal-less banner dismiss and on bind error, so a stale flag can't fire on some later unrelated bind.

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const miniapp = { html: "<html></html>", meta: { title: "Snake", genre: "project-fun", createdFrom: "blank", engineVersion: "1" } };

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

describe("Studio → Share to app.agentgem.ai", () => {
  it("bound: saves then publishes with the verified login as scope", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake" }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("unbound: shows the inline connect instead of publishing, and does not dead-end", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    expect(await screen.findByText(/Connect GitHub to publish/i)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect your GitHub in Curate/)).toBeNull();
  });

  it("unbound: authorizing resumes the publish automatically, without re-saving", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    vi.stubGlobal("open", vi.fn());

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob" }) });
    expect(save).toHaveBeenCalledTimes(1); // NOT re-saved on resume
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("a failed save never reaches the bind gate", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockRejectedValue(new Error("gate: needs a seal"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(screen.getByText(/save failed|Not sealed yet/i)).toBeTruthy());
    expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull();
  });

  it("dismissing the connect banner clears the pending publish", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull());
    expect(publish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console vitest run src/panels/Play/__tests__/StudioShare.test.tsx`
Expected: FAIL — the unbound tests find the old dead-end string `Connect your GitHub in Curate to publish publicly.` and no `Connect GitHub to publish` banner.

- [ ] **Step 3: Rewrite Studio's share path**

In `packages/console/src/panels/Play/Studio.tsx`, change the route import (drop `bindStatusRoute`) and add the identity imports:

```tsx
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute, publishSetupRoute } from "../../api/routes.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
```

Add state next to the existing `share` / `gate` state:

```tsx
  const [pendingPublish, setPendingPublish] = useState(false); // Share clicked while unbound
  const { status: identity } = useIdentity();
```

Register the hook, resuming the publish the user already asked for:

```tsx
  // Resume the publish the user already asked for. `login` comes straight from
  // bindComplete — reading it off the refreshed identity context would race the
  // React render that applies the refresh, and resume could see a stale null.
  const bind = useGitHubBind(apiBase, {
    onBound: (login) => {
      if (!pendingPublish) return;
      setPendingPublish(false);
      void publishWorkspace(login);
    },
  });
```

Replace `shareToExplore` (lines 135-156) with a gate plus the publish body:

```tsx
  // The actual publish. Takes `login` explicitly (see the onBound comment above) and
  // deliberately does NOT save: the caller already did, and the workspace + seal exist.
  async function publishWorkspace(login: string) {
    setStatus("publishing to app.agentgem.ai…");
    try {
      const g = genreOf(meta?.genre ?? "project-fun");
      const pub = await publishSetupRoute.call(makeClient(apiBase), { body: {
        workspace: name, scope: login, name, version: "0.1.0", provenance: "play",
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun"],
      } });
      // Link the gem's marketplace page (installable / playable), not just the OG teaser card.
      setShare({ gemUrl: `https://app.agentgem.ai/gems/${encodeURIComponent(pub.exploreRef)}`, cardUrl: pub.shareUrl }); setStatus("");
    } catch (e) {
      const body = (e as Record<string, unknown>).body;
      setStatus(`share failed: ${typeof body === "string" ? body : (e as Error).message}`);
    }
  }

  // Share to Explore (app.agentgem.ai): Save (creates the game-gem workspace + enforces
  // the seal), then publish. Unbound → offer the inline connect and resume afterwards.
  async function shareToExplore() {
    setStatus("preparing…"); setShare(null);
    if (!(await save())) return; // gate failure already surfaced as the banner
    if (identity?.bound && identity.login) { await publishWorkspace(identity.login); return; }
    setStatus("");
    setPendingPublish(true);
  }

  // A latent resume flag that fires on some later, unrelated bind is worse than no
  // resume at all — dropping the banner drops the pending publish with it.
  function dismissConnect() {
    setPendingPublish(false);
    bind.reset();
  }
```

Render the connect banner beside the existing `gate` banner (after the `{gate && …}` block):

```tsx
      {pendingPublish && (
        <div className="play-banner">
          <span className="play-banner__ico">🔑</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Connect GitHub to publish</div>
            <ConnectGitHub bind={bind} idleHint={<p className="play-banner__detail">Publishing continues automatically once you authorize.</p>} />
          </div>
          <button className="play-btn play-btn--ghost" onClick={dismissConnect}>Dismiss</button>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/console vitest run src/panels/Play/__tests__/StudioShare.test.tsx`
Expected: PASS — 5 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm -C packages/console exec tsc --noEmit
git add packages/console/src/panels/Play/
git commit -m "feat(console): Studio publish resumes after an inline GitHub connect"
```

---

### Task 10: Full suite, real-app verification, PR

**Files:** none (verification only).

- [ ] **Step 1: Run the full console suite**

Run: `pnpm -C packages/console test`
Expected: all pass. Report the real numbers. If `Play/__tests__/Runner.test.tsx` or `gemTypeRegistry` counts changed, investigate — do not paper over.

- [ ] **Step 2: Typecheck the console and the root package**

```bash
pnpm -C packages/console exec tsc --noEmit
pnpm -C . exec tsc --noEmit
```
Expected: no errors. The root typecheck matters because `src/gem.controller.ts` is untouched but the console imports its route types.

- [ ] **Step 3: Verify in the real app**

Use the `verify` skill (or `/run`) to launch the console and exercise the flow — tests alone do not prove `window.open` reaches the system browser through Electron's `main.ts`.

Check, and report what you actually observe:
1. Footer chip shows the avatar + `@login` when bound; clicking opens `app.agentgem.ai` **already signed in** (not the logged-out marketplace).
2. `agentgem` disconnected (`rm ~/.agentgem/binding.json ~/.agentgem/session.json`, restart) → chip reads "Sign in"; clicking opens the modal; Escape closes it.
3. Play → a saved game → "Share to app.agentgem.ai" while disconnected → the connect banner appears (not the old Curate string).

- [ ] **Step 4: Confirm the branch is ahead of origin/main only**

```bash
git fetch origin
git log --oneline origin/main..HEAD
git log --oneline HEAD..origin/main   # must be empty
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/console-identity-chip
gh pr create --title "feat(console): identity chip + inline GitHub connect on publish" \
  --body "$(cat <<'EOF'
Surfaces the existing web-handoff as a footer identity chip, and replaces
Play/Studio's dead-end "Connect your GitHub in Curate" string with an inline
device-flow connect that auto-resumes the publish.

Extracts the device-flow UI — previously copy-pasted in Settings and
PublishToExplore — into `IdentityProvider` (status) + `useGitHubBind` (flow) +
`ConnectGitHub` (presentational). No server change.

Spec: docs/superpowers/specs/2026-07-08-console-identity-shell-design.md

Note: console tests are not in CI; `pnpm -C packages/console test` was run locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then per CLAUDE.md: `gh run watch <run-id> --exit-status`, merge with `gh pr merge --rebase --delete-branch` once green, and afterwards `git fetch && git grep IdentityChip origin/main -- packages/console/src/shell/Shell.tsx` to confirm **every** commit landed, not just the first.

---

## Self-Review

**Spec coverage.** Status/flow split → Tasks 1-2. `ConnectGitHub` two-chrome composition → Tasks 3, 6, 9. Chip's three states → Task 7. Modal semantics (Escape, overlay, no shared primitive, fresh code on reopen) → Tasks 6-7. Studio resume with `login` passed through, `save()` not re-run, `pendingPublish` reset → Task 9. The three Settings/Curate divergences (opened URL, `rejectionMessage`, `unconfigured`) → Tasks 2-5. "Assertions byte-for-byte" → Tasks 4-5 Step 1. Out-of-scope items (no server change, no Disconnect on the chip, no shared `<Modal>`) are respected: no task touches `src/`, `Setup/index.tsx`, or `Play/Runner.tsx`.

**Type consistency.** `GitHubBind` is produced in Task 2 and consumed by name in 3, 6, 7, 9. `IdentityStatus`/`useIdentity()` produced in Task 1, consumed in 4, 5, 7, 9. `BindFlow.openUrl` (not `verificationUri`) is the field name everywhere after Task 2. `onBound: (login: string) => void` has the same signature in Tasks 2, 7, 9. `reset()` is called in Tasks 6 (via caller), 7, 9.

**Known risk.** Task 8 adds a chip to `.console-footer`; a pre-existing `Shell.test.tsx` assertion that counts footer buttons would break. Task 8 Step 4 calls this out as a real regression to fix by scoping the query, never by dropping the chip.
