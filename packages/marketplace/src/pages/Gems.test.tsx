import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gems } from "./Gems";

afterEach(() => cleanup());

describe("Gems (browse)", () => {
  it("renders gem cards from the catalog", () => {
    render(<Gems />);
    expect(screen.getByText("brainstorming-kit")).toBeTruthy();
    expect(screen.getByText("github-flow")).toBeTruthy();
  });

  it("a card links to the gem detail page (encoded key)", () => {
    render(<Gems />);
    const link = screen.getByText("brainstorming-kit").closest("a");
    expect(link?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("brainstorming-kit"));
  });

  it("search narrows the list", () => {
    render(<Gems />);
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "github" } });
    expect(screen.getByText("github-flow")).toBeTruthy();
    expect(screen.queryByText("brainstorming-kit")).toBeNull();
  });

  it("shows a no-match state", () => {
    render(<Gems />);
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "zzzznomatch" } });
    expect(screen.getByText(/no gems match/i)).toBeTruthy();
  });
});
