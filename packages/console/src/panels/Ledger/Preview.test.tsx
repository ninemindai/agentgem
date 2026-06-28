import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Preview } from "./Preview.js";

afterEach(cleanup);

const gem = {
  name: "my-gem",
  createdFrom: "/home/me/.claude",
  artifacts: [{ type: "skill", name: "pdf" }, { type: "mcp_server", name: "github" }],
  checks: [],
  requiredSecrets: [{ name: "API_KEY" }],
};

describe("Preview", () => {
  it("shows the summary by default with counts and artifacts", () => {
    render(<Preview gem={gem as any} />);
    expect(screen.getByText("my-gem")).toBeTruthy();
    expect(screen.getByText("2 artifacts")).toBeTruthy();
    expect(screen.getByText("1 secrets")).toBeTruthy();
    expect(screen.getByText("pdf")).toBeTruthy();
  });

  it("toggles to raw JSON", () => {
    render(<Preview gem={gem as any} />);
    fireEvent.click(screen.getByText("JSON"));
    expect(screen.getByText(/"name": "my-gem"/)).toBeTruthy();
  });
});
