import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AtifHealth } from "./AtifHealth.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const stub = (body: unknown) => { vi.stubGlobal("fetch", vi.fn(async () => res(body))); };

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AtifHealth", () => {
  it("renders nothing when there are no issues", async () => {
    stub({ totalFiles: 5, imported: 5, groups: [] });
    const { container } = render(<AtifHealth apiBase="" />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("shows a red rejection summary and expands to the group", async () => {
    stub({
      totalFiles: 20, imported: 3,
      groups: [
        { code: "unknown_schema_version", rejection: true, occurrences: 12, files: Array.from({ length: 12 }, (_, i) => ({ name: `conv-${i}.json` })) },
        { code: "orphan_tool_result", rejection: false, occurrences: 40, files: [{ name: "partial.json", detail: "step 2" }] },
      ],
    });
    render(<AtifHealth apiBase="" />);
    await flush();
    // headline: distinct problem files = 12 + 1 = 13
    expect(screen.getByText(/3\/20 imported · 13 with issues/)).toBeTruthy();
    const root = screen.getByText(/3\/20 imported/).closest(".watch-atif")!;
    expect(root.className).toContain("is-rejection");

    // collapsed: group codes not shown yet
    expect(screen.queryByText(/unknown_schema_version/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/unknown_schema_version/)).toBeTruthy();
    // file list elides past 6
    expect(screen.getByText(/\(\+6\)/)).toBeTruthy();
    expect(screen.getByText(/partial\.json \(step 2\)/)).toBeTruthy();
  });

  it("uses the degraded (amber) class when no group is a rejection", async () => {
    stub({ totalFiles: 4, imported: 4, groups: [{ code: "orphan_tool_result", rejection: false, occurrences: 2, files: [{ name: "a.json", detail: "step 1" }] }] });
    render(<AtifHealth apiBase="" />);
    await flush();
    const root = screen.getByText(/4\/4 imported/).closest(".watch-atif")!;
    expect(root.className).toContain("is-degraded");
  });
});
