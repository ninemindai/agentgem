import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gem } from "./Gem";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Gem (detail)", () => {
  it("renders a known gem's fields + kind chips", () => {
    render(<Gem keyName="brainstorming-kit" />);
    expect(screen.getByRole("heading", { name: /brainstorming-kit/ })).toBeTruthy();
    expect(screen.getByText(/1\.2\.0/)).toBeTruthy();
    expect(screen.getByText(/superpowers/)).toBeTruthy();
  });

  it("lists bundled ingredients, each linking to its ingredient page (encoded id)", () => {
    render(<Gem keyName="brainstorming-kit" />);
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("copy-key writes the key to the clipboard", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Gem keyName="brainstorming-kit" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("brainstorming-kit");
  });

  it("shows a not-found state for an unknown key", () => {
    render(<Gem keyName="does-not-exist" />);
    expect(screen.getByText(/gem not found/i)).toBeTruthy();
  });
});
