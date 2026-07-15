import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent, act, within, waitFor } from "@testing-library/react";
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

// A small two-phase registry used by most tests.
const pages = [
  p({ id: "overview", phase: "observe", category: "usage", order: 10 }), // Usage leads Observe
  p({ id: "watch", phase: "observe", category: "sessions", order: 10 }),
  p({ id: "rubrics", phase: "observe", category: "setup", order: 10 }), // Configuration, last
  p({ id: "curate", phase: "build", category: "setup", order: 10 }),
  p({ id: "deploy", phase: "build", category: "projects", order: 10, requiresGem: true }),
  p({ id: "settings", footer: true }),
];

const goHash = (h: string) =>
  act(() => {
    window.location.hash = h;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

describe("Shell — phase-primary nav", () => {
  it("defaults to the Observe phase and renders its first panel", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("panel-overview")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Observe" }).getAttribute("aria-checked")).toBe("true");
  });

  it("renders artifact category labels for the active phase", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("Configuration")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    // Build-only categories are not shown while in Observe
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("only shows the active phase's pages", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByRole("button", { name: "watch" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "curate" })).toBeNull();
  });

  it("switching to Build shows Build pages and navigates to the first one", () => {
    render(<Shell pages={pages} apiBase="" />);
    act(() => { fireEvent.click(screen.getByRole("radio", { name: "Build" })); });
    expect(window.location.hash).toBe("#/curate");
    goHash("#/curate");
    expect(screen.getByRole("button", { name: "curate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "watch" })).toBeNull();
  });

  it("derives the phase from the route: deep-linking a Build route opens in Build", () => {
    window.location.hash = "#/deploy";
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("panel-deploy")).toBeTruthy();
  });

  it("footer Settings keeps the current phase (does not snap to Observe)", () => {
    window.location.hash = "#/deploy"; // Build
    render(<Shell pages={pages} apiBase="" />);
    goHash("#/settings");
    // Sidebar stays in Build even though Settings has no phase
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("panel-settings")).toBeTruthy();
  });

  it("remembers the last screen per phase across a switch", () => {
    const multi = [
      p({ id: "overview", phase: "observe", category: "setup", order: 10 }),
      p({ id: "curate", phase: "build", category: "setup", order: 10 }),
      p({ id: "deploy", phase: "build", category: "projects", order: 20 }),
    ];
    window.location.hash = "#/deploy"; // land in Build on deploy
    render(<Shell pages={multi} apiBase="" />);
    // switch to Observe, then back to Build → should restore #/deploy, not the first build page
    act(() => { fireEvent.click(screen.getByRole("radio", { name: "Observe" })); });
    goHash(window.location.hash);
    act(() => { fireEvent.click(screen.getByRole("radio", { name: "Build" })); });
    expect(window.location.hash).toBe("#/deploy");
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

  it("navigates when a nav button is clicked", () => {
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: "watch" }));
    expect(window.location.hash).toBe("#/watch");
  });

  it("resolves a drill-down sub-route via longest-prefix match", () => {
    window.location.hash = "#/overview/claude/abc-123";
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("panel-overview")).toBeTruthy();
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

  it("dims a requiresGem stage until a gem is active", () => {
    window.location.hash = "#/curate"; // Build phase so the gem-scoped stage shows
    const { rerender } = render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("deploy").classList.contains("is-locked")).toBe(true);
    act(() => { setKeys(new Set(["x"])); });
    rerender(<Shell pages={pages} apiBase="" />);
    expect(screen.getByText("deploy").classList.contains("is-locked")).toBe(false);
  });

  it("shows the active-gem switcher only in the Build phase", () => {
    render(<Shell pages={pages} apiBase="" />); // Observe
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

  it("renders the report-activity menu in the footer", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.getByRole("button", { name: /report activity/i })).toBeTruthy();
  });

  it("renders the identity chip in the footer, unbound when the daemon is unreachable", async () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
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

describe("Shell — nav item badge slot", () => {
  const badged = p({
    id: "reviews", title: "Reviews", phase: "build", category: "projects", order: 20,
    badge: (apiBase) => <span>badge-for-{apiBase || "root"}</span>,
  });
  it("renders a page's badge render-prop next to its title, passing apiBase through", () => {
    render(<Shell pages={[...pages, badged]} apiBase="root" />);
    goHash("#/reviews");
    expect(screen.getByText("badge-for-root")).toBeTruthy();
  });
  it("renders nothing extra for pages without a badge", () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(screen.queryByText(/badge-for-/)).toBeNull();
  });
});

describe("Shell — cross-phase review unread signal", () => {
  it("shows an unread indicator on the Build phase button even while Observe is active", async () => {
    vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({
      requests: [{ id: "1", unread: true }, { id: "2", unread: true }, { id: "3", unread: false }],
    } as never);

    render(<Shell pages={pages} apiBase="" />); // defaults to Observe
    expect(screen.getByRole("radio", { name: "Observe" }).getAttribute("aria-checked")).toBe("true");

    const build = screen.getByRole("radio", { name: "Build" });
    expect(await within(build).findByText("2")).toBeTruthy();
  });

  it("does not show the indicator once Build is the active phase", async () => {
    const inbox = vi.spyOn(routes.reviewInboxRoute, "call").mockResolvedValue({
      requests: [{ id: "1", unread: true }],
    } as never);

    window.location.hash = "#/curate"; // Build
    render(<Shell pages={pages} apiBase="" />);

    const build = await screen.findByRole("radio", { name: "Build" });
    await waitFor(() => expect(inbox).toHaveBeenCalled());
    expect(within(build).queryByText("1")).toBeNull();
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
