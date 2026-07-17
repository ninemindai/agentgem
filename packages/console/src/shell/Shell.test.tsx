import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { Shell } from "./Shell.js";
import { defineConsolePage, type ConsolePage } from "../registry.js";
import { setKeys, setName, resetGem } from "../activeGem.js";
import * as routes from "../api/routes.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
  resetGem();
  localStorage.clear();
});

type P = Partial<ConsolePage> & Pick<ConsolePage, "id">;
const p = (o: P): ConsolePage =>
  defineConsolePage({
    title: o.id,
    order: 10,
    route: `#/${o.id}`,
    component: () => <p>{`panel-${o.id}`}</p>,
    ...o,
  } as ConsolePage);

// Mirrors the shape of the real registry (see pages.tsx / pages.test.ts): three
// always-visible foreground pages (no group), one grouped-and-gated page per
// disclosure group, a hidden (never-in-rail) page, and a footer page.
const pages = [
  p({ id: "overview", phase: "observe", category: "usage", order: 10 }),
  p({ id: "curate", phase: "build", category: "setup", order: 10 }),
  p({ id: "gems", phase: "build", category: "setup", order: 20 }),
  p({ id: "deploy", phase: "build", category: "projects", order: 10, group: "observe", hiddenUntilUnlock: true, requiresGem: true }),
  p({ id: "rubrics", phase: "observe", category: "setup", order: 10, group: "build", hiddenUntilUnlock: true }),
  p({ id: "watch", phase: "observe", category: "sessions", order: 10, group: "evaluate", hiddenUntilUnlock: true }),
  p({ id: "optimize", phase: "observe", category: "projects", order: 20, group: "evaluate", hiddenUntilUnlock: true }),
  p({ id: "reviews", phase: "build", category: "projects", order: 40, group: "share", hiddenUntilUnlock: true }),
  p({ id: "publish", phase: "build", category: "projects", order: 30, hidden: true }),
  p({ id: "settings", footer: true }),
];

const goHash = (h: string) =>
  act(() => {
    window.location.hash = h;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

// Home-state mocks: the hook (useHomeState) fetches GET /api/home/state on mount and
// POSTs one-way through setHomeStateRoute. Tests that care about unlock state mock
// homeStateRoute.call; tests that don't leave it unmocked (the real fetch fails
// against no server, same "degrades to the locked default" pattern as the identity
// chip tests below) — that default is exactly what most of these tests want anyway,
// since foreground pages render regardless of lock state.
const mockHomeState = (state: Partial<routes.HomeState>) =>
  vi.spyOn(routes.homeStateRoute, "call").mockResolvedValue({
    unlocked: false, existingUser: false, revealSeen: false, ...state,
  } as never);

describe("Shell — route resolution + foreground nav", () => {
  it("renders the Overview panel by default", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("panel-overview")).toBeTruthy();
  });

  // (a) REGRESSION: default/unknown hash lands on Overview, not "first page of some
  // implicit phase order" (the retired firstRouteOf("observe") semantics).
  it("(a) an empty or unknown hash falls back to the Overview route", () => {
    window.location.hash = "#/this-route-does-not-exist";
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("panel-overview")).toBeTruthy();
  });

  // (b) REGRESSION: hiddenUntilUnlock / hidden pages stay reachable by direct hash
  // even though they never render in the rail while locked.
  it("(b) deep links to optimize/watch/publish resolve to their panels while hidden from the rail", () => {
    for (const id of ["optimize", "watch", "publish"]) {
      window.location.hash = `#/${id}`;
      const { unmount } = render(<Shell pages={pages} apiBase="" />);
      expect(screen.getByText(`panel-${id}`)).toBeTruthy();
      expect(screen.queryByRole("button", { name: id })).toBeNull();
      unmount();
    }
  });

  it("navigates when a foreground nav button is clicked", () => {
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: "curate" }));
    expect(window.location.hash).toBe("#/curate");
  });

  it("resolves a drill-down sub-route via longest-prefix match", () => {
    window.location.hash = "#/overview/claude/abc-123";
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("panel-overview")).toBeTruthy();
  });

  it("normalizes a legacy route on cold start (#/your-gems → #/gems)", () => {
    const withGems = [
      p({ id: "overview", phase: "observe", category: "setup", order: 10 }),
      p({ id: "gems", phase: "build", category: "setup", order: 30 }),
    ];
    window.location.hash = "#/your-gems"; // no hashchange fires on first render
    render(<Shell pages={withGems} apiBase="" />);
    expect(window.location.hash).toBe("#/gems");
    expect(screen.getByText("panel-gems")).toBeTruthy();
  });

  it("isolates page hooks across different hook counts", () => {
    const Hooky = () => { useState(0); useState(0); return <p>hooky</p>; };
    const hookPages = [
      p({ id: "a", phase: "observe", category: "setup", order: 10, component: Hooky }),
      p({ id: "b", phase: "observe", category: "setup", order: 20 }),
    ];
    render(<Shell pages={hookPages} apiBase="" />);
    expect(screen.getByText("hooky")).toBeTruthy();
    goHash("#/b");
    expect(screen.getByText("panel-b")).toBeTruthy();
  });
});

describe("Shell — grouped rail (cold console)", () => {
  // (d) REGRESSION: locked rail shows exactly the foreground pages + footer.
  it("(d) locked rail shows exactly the foreground pages, no group headers, plus the footer and Show everything", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByRole("button", { name: "overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "curate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "gems" })).toBeTruthy();
    for (const label of ["Observe", "Build", "Evaluate", "Share"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "deploy" })).toBeNull();
    expect(screen.getByRole("button", { name: "settings" })).toBeTruthy();
    expect(screen.getByText("Show everything")).toBeTruthy();
  });

  // (e) REGRESSION: unlocked rail shows the four disclosure-group headers.
  it("(e) unlocked rail shows the four groups and drops Show everything", async () => {
    mockHomeState({ unlocked: true });
    render(<Shell pages={pages} apiBase="" />);
    expect(await screen.findByText("Observe")).toBeTruthy();
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Evaluate")).toBeTruthy();
    expect(screen.getByText("Share")).toBeTruthy();
    expect(screen.queryByText("Show everything")).toBeNull();
  });

  // (c) REGRESSION: requiresGem dimming still applies once a grouped page is
  // visible (unlocked + expanded), composing with the disclosure groups.
  it("(c) requiresGem still dims a grouped page post-unlock, until a gem is active", async () => {
    mockHomeState({ unlocked: true });
    window.location.hash = "#/curate";
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(await screen.findByText("Observe")); // expand to reveal deploy
    const deployBtn = () => screen.getByRole("button", { name: "deploy" });
    expect(deployBtn().classList.contains("is-locked")).toBe(true);
    act(() => { setKeys(new Set(["x"])); });
    expect(deployBtn().classList.contains("is-locked")).toBe(false);
  });

  // (f) REGRESSION: Show everything unlocks (POST fires) and expands every group.
  it("(f) Show everything unlocks the console and expands every group", async () => {
    mockHomeState({ unlocked: false });
    const setSpy = vi.spyOn(routes.setHomeStateRoute, "call").mockResolvedValue({
      unlocked: true, existingUser: false, revealSeen: false,
    } as never);
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(await screen.findByText("Show everything"));
    expect(setSpy).toHaveBeenCalledWith(expect.anything(), { body: { unlocked: true } });
    await waitFor(() => expect(screen.getByText("Observe")).toBeTruthy());
    // Expanded immediately alongside the unlock — no extra click needed to see deploy.
    expect(screen.getByRole("button", { name: "deploy" })).toBeTruthy();
  });

  // (g) REGRESSION: per-group expansion persists across a remount via localStorage.
  it("(g) group expansion persists across remount", async () => {
    mockHomeState({ unlocked: true });
    const { unmount } = render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(await screen.findByText("Observe"));
    expect(screen.getByRole("button", { name: "deploy" })).toBeTruthy();
    unmount();

    render(<Shell pages={pages} apiBase="" />);
    await screen.findByText("Observe");
    expect(screen.getByRole("button", { name: "deploy" })).toBeTruthy();
  });

  // (h) Task 8: a LIVE locked→unlocked transition (Show everything, same as (f))
  // gets the unlock choreography — an entrance class on the newly-revealed group
  // headers, and an aria-live announcement naming how many groups appeared. The
  // fixture has exactly four disclosure groups, matching the brief's own example copy.
  it("(h) Show everything triggers the unlock choreography: entrance class + aria-live announcement", async () => {
    mockHomeState({ unlocked: false });
    vi.spyOn(routes.setHomeStateRoute, "call").mockResolvedValue({
      unlocked: true, existingUser: false, revealSeen: false,
    } as never);
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(await screen.findByText("Show everything"));
    // Flush the setUnlocked promise via `act` rather than `waitFor`'s real-timer
    // polling — `justUnlocked` self-clears after 260ms (real timer too), so a slow
    // poll interval could otherwise race past the assertion window.
    await act(async () => {});

    expect(screen.getByText("Observe")).toBeTruthy();
    expect(screen.getByText("Observe").closest("button")?.classList.contains("rail-enter")).toBe(true);
    expect(screen.getByText("Console unlocked — 4 new groups.")).toBeTruthy();
  });

  // (i) Task 8 sweep item 5: a locally-cached "unlocked" render-hint shows the groups
  // on the very first paint, ahead of the real fetch settling — and the server's
  // answer always wins outright, correcting a stale hint back to locked.
  it("(i) a cached unlocked hint renders groups before the fetch resolves; the server's answer corrects it", async () => {
    localStorage.setItem("agentgem.console.homeState.hint", "unlocked");
    let resolveFetch!: (v: routes.HomeState) => void;
    const pending = new Promise<routes.HomeState>((r) => { resolveFetch = r; });
    vi.spyOn(routes.homeStateRoute, "call").mockReturnValue(pending as never);

    render(<Shell pages={pages} apiBase="" />);
    // Hinted render — the real fetch hasn't resolved yet.
    expect(screen.getByText("Observe")).toBeTruthy();

    await act(async () => {
      resolveFetch({ unlocked: false, existingUser: false, revealSeen: false });
      await pending;
    });
    // Server truth (locked) wins outright and corrects the hinted render.
    expect(screen.queryByText("Observe")).toBeNull();
  });
});

describe("Shell — collapsible sidebar", () => {
  it("sets --rail-w and toggles is-hidden on Cmd+B", () => {
    const { container } = render(<Shell pages={pages} apiBase="" />);
    const console_ = container.querySelector(".console") as HTMLElement;
    expect(console_.style.getPropertyValue("--rail-w")).toBe("244px");
    act(() => { fireEvent.keyDown(window, { key: "b", metaKey: true }); });
    expect(console_.classList.contains("is-hidden")).toBe(true);
    expect(console_.style.getPropertyValue("--rail-w")).toBe("0px");
    // re-open affordance appears when hidden
    expect(screen.getByRole("button", { name: /open sidebar/i })).toBeTruthy();
  });

  it("renders a resize separator with sidebar bounds", () => {
    const { container } = render(<Shell pages={pages} apiBase="" />);
    const sep = container.querySelector(".console-rail-handle") as HTMLElement;
    expect(sep.getAttribute("role")).toBe("separator");
    expect(sep.getAttribute("aria-valuemax")).toBe("420");
  });
});

describe("Shell — active-gem switcher (build phase)", () => {
  it("shows the active-gem switcher only on Build-phase routes", () => {
    render(<Shell pages={pages} apiBase="" />); // Overview — Observe
    expect(screen.queryByText("New Gem")).toBeNull();
    goHash("#/curate"); // Build
    expect(screen.getByText("New Gem")).toBeTruthy();
  });

  it("shows the active gem name in the switcher when set (Build phase)", () => {
    setName("My Gem"); setKeys(new Set(["a"]));
    window.location.hash = "#/curate";
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("My Gem")).toBeTruthy();
  });

  it("footer Settings keeps the Build-phase switcher visible (does not snap to Observe)", () => {
    window.location.hash = "#/curate"; // Build
    render(<Shell pages={pages} apiBase="" />);
    goHash("#/settings");
    expect(screen.getByText("New Gem")).toBeTruthy();
  });
});

describe("Shell — footer + identity", () => {
  it("renders the report-activity menu in the footer", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByRole("button", { name: /report activity/i })).toBeTruthy();
  });

  it("renders the identity chip in the footer, unbound when the daemon is unreachable", async () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
  });
});

describe("Shell — nav item badge slot", () => {
  const badged = p({
    id: "reviewsbadge", title: "Reviews", phase: "build", category: "projects", order: 20,
    badge: (apiBase) => <span>badge-for-{apiBase || "root"}</span>,
  });
  it("renders a page's badge render-prop next to its title, passing apiBase through", () => {
    render(<Shell pages={[...pages, badged]} apiBase="root" />);
    goHash("#/reviewsbadge");
    expect(screen.getByText("badge-for-root")).toBeTruthy();
  });
  it("renders nothing extra for pages without a badge", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.queryByText(/badge-for-/)).toBeNull();
  });
});

describe("Shell — full-width pages + Studio rename", () => {
  const wide = p({ id: "studio", title: "Studio", phase: "build", category: "setup", order: 5, fullWidth: true });
  it("adds console-main--wide only for fullWidth pages", () => {
    const { container } = render(<Shell pages={[...pages, wide]} apiBase="" />);
    goHash("#/curate");
    expect(container.querySelector(".console-main--wide")).toBeNull();
    goHash("#/studio");
    expect(container.querySelector(".console-main--wide")).toBeTruthy();
  });
});
