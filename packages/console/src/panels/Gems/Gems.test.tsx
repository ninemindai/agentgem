import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("../Workspaces/index.js", () => ({ Workspaces: () => <div>stub-yours</div> }));
vi.mock("../Received/index.js", () => ({ Received: () => <div>stub-received</div> }));
vi.mock("../GetGems/index.js", () => ({ GetGems: () => <div>stub-market</div> }));

import { Gems } from "./Gems.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const setHash = (h: string) => act(() => {
  window.location.hash = h;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});

describe("Gems tabbed screen", () => {
  it("renders the Yours tab at #/gems", () => {
    window.location.hash = "#/gems";
    render(<Gems apiBase="" />);
    expect(screen.getByText("stub-yours")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Yours" }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders the Received tab at #/gems/received", () => {
    window.location.hash = "#/gems/received";
    render(<Gems apiBase="" />);
    expect(screen.getByText("stub-received")).toBeTruthy();
    expect(screen.queryByText("stub-yours")).toBeNull(); // unmount-on-switch
    expect(screen.getByRole("tab", { name: "Received" }).getAttribute("aria-selected")).toBe("true");
  });

  it("renders the Get-more (market) tab at #/gems/market, ignoring the query", () => {
    window.location.hash = "#/gems/market?install=abc&v=1";
    render(<Gems apiBase="" />);
    expect(screen.getByText("stub-market")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Get more" }).getAttribute("aria-selected")).toBe("true");
  });

  it("navigates to a tab's sub-route when its tab is clicked", () => {
    window.location.hash = "#/gems";
    render(<Gems apiBase="" />);
    fireEvent.click(screen.getByRole("tab", { name: "Received" }));
    expect(window.location.hash).toBe("#/gems/received");
  });

  it("re-derives the active tab on hashchange", () => {
    window.location.hash = "#/gems";
    render(<Gems apiBase="" />);
    expect(screen.getByText("stub-yours")).toBeTruthy();
    setHash("#/gems/market");
    expect(screen.getByText("stub-market")).toBeTruthy();
  });
});
