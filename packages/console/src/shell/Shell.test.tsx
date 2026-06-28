import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Shell } from "./Shell.js";
import { defineConsolePage } from "../registry.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const pages = [
  defineConsolePage({ id: "a", title: "Alpha", order: 10, route: "#/a", component: () => <p>panel-a</p> }),
  defineConsolePage({ id: "b", title: "Beta", order: 20, route: "#/b", component: () => <p>panel-b</p> }),
];

describe("Shell", () => {
  it("lists nav items in order and renders the first panel by default", () => {
    render(<Shell pages={pages} apiBase="" />);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["Alpha", "Beta"]);
    expect(screen.getByText("panel-a")).toBeTruthy();
  });

  it("switches panel on hashchange", () => {
    render(<Shell pages={pages} apiBase="" />);
    act(() => { window.location.hash = "#/b"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(screen.getByText("panel-b")).toBeTruthy();
  });

  it("navigates when a nav button is clicked", () => {
    render(<Shell pages={pages} apiBase="" />);
    fireEvent.click(screen.getByText("Beta"));
    expect(window.location.hash).toBe("#/b");
  });
});
