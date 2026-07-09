import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
afterEach(cleanup);
import { ScopePicker, type Scope } from "./ScopePicker.js";

vi.mock("../../api/routes.js", async (orig) => {
  const m = await (orig as any)();
  return {
    ...m,
    makeClient: () => ({}),
    testbedRecentsRoute: {
      call: async () => ({ recents: [{ path: "/repo/a", flavor: "x", name: "a", lastUsed: "2026-01-01", exists: true }] }),
    },
    testbedProjectsRoute: {
      call: async () => ({ projects: [{ path: "/repo/b", flavor: "x", lastUsed: null, exists: true }] }),
    },
  };
});

describe("ScopePicker", () => {
  it("highlights Global by default and switches to a picked project", async () => {
    let scope: Scope = { kind: "global" };
    const onScope = vi.fn((s: Scope) => { scope = s; });
    render(<ScopePicker apiBase="" scope={scope} onScope={onScope} />);
    expect(screen.getByRole("button", { name: "Global" }).className).toContain("is-active");
    fireEvent.click(screen.getByRole("button", { name: /project/i }));
    const opt = await screen.findByText("/repo/a");
    fireEvent.click(opt);
    expect(onScope).toHaveBeenCalledWith({ kind: "project", root: "/repo/a", label: "a" });
  });

  it("uses a custom globalLabel and disables its buttons", () => {
    render(<ScopePicker apiBase="" scope={{ kind: "global" }} onScope={() => {}} globalLabel="Neutral" disabled />);
    expect((screen.getByRole("button", { name: "Neutral" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /project/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
