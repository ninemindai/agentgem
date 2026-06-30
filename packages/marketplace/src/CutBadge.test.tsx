import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CutBadge } from "./CutBadge";

afterEach(() => cleanup());

describe("CutBadge", () => {
  it("renders a labeled pill for a known cut", () => {
    render(<CutBadge cut="playbook" />);
    const el = screen.getByText("Playbook");
    expect(el).toBeTruthy();
    expect(el.getAttribute("title")).toContain("Pearl");
  });
  it("renders nothing for an undefined or unknown cut", () => {
    const { container } = render(<CutBadge cut={undefined} />);
    expect(container.querySelector(".ex-cut")).toBeNull();
    cleanup();
    const { container: c2 } = render(<CutBadge cut="bogus" />);
    expect(c2.querySelector(".ex-cut")).toBeNull();
  });
});
