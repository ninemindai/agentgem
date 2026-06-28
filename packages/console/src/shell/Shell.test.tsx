import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Shell } from "./Shell.js";
import { defineConsolePage, groupedPages } from "../registry.js";

describe("groupedPages", () => {
  const p = (id: string, order: number, group?: "build" | "library" | "settings") =>
    defineConsolePage({ id, title: id, order, group, route: `#/${id}`, component: () => null });

  it("buckets by group (default build), each sorted by order", () => {
    const g = groupedPages([p("b", 20), p("a", 10), p("lib", 5, "library"), p("set", 1, "settings")]);
    expect(g.build.map((x) => x.id)).toEqual(["a", "b"]);
    expect(g.library.map((x) => x.id)).toEqual(["lib"]);
    expect(g.settings.map((x) => x.id)).toEqual(["set"]);
  });
});

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

  it("renders group labels and places items under them", () => {
    const groupedTestPages = [
      defineConsolePage({ id: "a", title: "Build A", order: 10, group: "build", route: "#/a", component: () => <p>pa</p> }),
      defineConsolePage({ id: "l", title: "Lib L", order: 10, group: "library", route: "#/l", component: () => <p>pl</p> }),
      defineConsolePage({ id: "s", title: "Settings", order: 10, group: "settings", route: "#/s", component: () => <p>ps</p> }),
    ];
    render(<Shell pages={groupedTestPages} apiBase="" />);
    expect(screen.getByText("Build")).toBeTruthy();
    expect(screen.getByText("Library")).toBeTruthy();
    expect(screen.getByText("Build A")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
  });
});
