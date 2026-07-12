import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const updateServiceWorker = vi.fn();
let needRefresh = true;

// The virtual module is provided by vite-plugin-pwa at build time; mock it so the component
// is testable under plain vitest.
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    needRefresh: [needRefresh, vi.fn()],
    updateServiceWorker,
  }),
}));

import { PwaUpdatePrompt } from "./PwaUpdatePrompt";

describe("PwaUpdatePrompt", () => {
  beforeEach(() => { updateServiceWorker.mockClear(); needRefresh = true; });

  it("shows a Reload prompt when a new version is waiting", () => {
    render(<PwaUpdatePrompt />);
    expect(screen.getByText("New version available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("renders nothing when there is no update", () => {
    needRefresh = false;
    const { container } = render(<PwaUpdatePrompt />);
    expect(container.firstChild).toBeNull();
  });
});
