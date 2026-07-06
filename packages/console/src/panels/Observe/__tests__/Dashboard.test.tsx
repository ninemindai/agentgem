// packages/console/src/panels/Observe/__tests__/Dashboard.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
afterEach(cleanup);
import { Dashboard } from "../Dashboard.js";
import type { ObservePayload } from "../../../api/routes.js";

const data: ObservePayload = {
  pulse: { sessions: 0, msgs: 0, tokens: 0, activeMs: 0 },
  daily: [],
  models: [],
  sessions: [],
  facets: { agents: [], projects: [], models: [] },
} as never;

const base = {
  data, range: "7d" as const, onRange: () => {}, filter: {}, onFilter: () => {}, apiBase: "",
};

describe("Dashboard share row", () => {
  it("renders both Share link and Publish when a setup is present", () => {
    render(<Dashboard {...base} setupShare={{ name: "my-setup", provenance: "3 skills", empty: false }} onPublishSetup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /share link/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /publish/i })).toBeTruthy();
  });

  it("disables Share link with a reason when the setup is empty", () => {
    render(<Dashboard {...base} setupShare={{ name: "my-setup", provenance: "", empty: true }} onPublishSetup={vi.fn()} />);
    expect(screen.getByRole("button", { name: /share link/i }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/nothing to share yet/i)).toBeTruthy();
  });
});
