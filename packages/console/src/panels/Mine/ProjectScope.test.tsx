import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
afterEach(cleanup);
import { ProjectScope } from "./ProjectScope.js";

vi.mock("../../api/routes.js", async (orig) => {
  const m = await (orig as any)();
  return {
    ...m,
    makeClient: () => ({}),
    testbedProjectsRoute: {
      call: async () => ({ projects: [{ path: "/a", flavor: "claude", name: "a" }] }),
    },
    testbedRecentsRoute: {
      call: async () => ({ recents: [] }),
    },
  };
});

describe("ProjectScope", () => {
  it("opens the dropdown, lists All projects first, and calls onChange on select", async () => {
    const onChange = vi.fn();
    render(<ProjectScope apiBase="http://x" scope="*" onChange={onChange} />);
    // Compact dropdown: the project list is hidden until the trigger is clicked.
    expect(screen.queryByText("/a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /all projects/i }));
    const row = await waitFor(() => screen.getByText("/a"));
    fireEvent.click(row);
    expect(onChange).toHaveBeenCalledWith("/a");
  });

  it("marks the menu row matching scope as active", async () => {
    render(<ProjectScope apiBase="http://x" scope="*" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /all projects/i }));
    const rowLabel = await waitFor(() => screen.getByText("All projects", { selector: "span.mine-scope-name" }));
    expect(rowLabel.closest("button")?.className).toContain("is-active");
  });
});
