import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GemContents } from "./GemContents";

afterEach(() => cleanup());

const artifacts = [
  { name: "brainstorm", type: "skill" }, { name: "debug", type: "skill" },
  { name: "gh", type: "mcp_server" }, { name: "fmt", type: "hook" },
];

describe("GemContents", () => {
  it("groups artifacts by kind and flags executable groups", () => {
    render(<GemContents artifacts={artifacts} />);
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByText("MCP servers")).toBeTruthy();
    expect(screen.getByText("Hooks")).toBeTruthy();
    expect(screen.getByText(/executable artifacts/i)).toBeTruthy();
  });
  it("lists each artifact name", () => {
    render(<GemContents artifacts={artifacts} />);
    for (const n of ["brainstorm", "debug", "gh", "fmt"]) expect(screen.getByText(n)).toBeTruthy();
  });
  it("renders nothing when there are no artifacts", () => {
    const { container } = render(<GemContents artifacts={[]} />);
    expect(container.querySelector(".ex-contents")).toBeNull();
  });
});
