import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Targets, sortedFiles } from "./Targets.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("sortedFiles", () => {
  it("sorts file paths alphabetically", () => {
    expect(sortedFiles({ "b.md": "x", "a/c.md": "y", "a/b.md": "z" })).toEqual(["a/b.md", "a/c.md", "b.md"]);
  });
});

describe("Targets", () => {
  it("materializes the selection and shows files + content", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(String(url)).toContain("/api/materialize");
      expect(body.target).toBe("codex");
      return res({
        target: "codex",
        files: { "AGENTS.md": "# hello agents", "skills/pdf/SKILL.md": "pdf skill" },
        skipped: [],
        compatibility: { codex: { supported: 1, skipped: 0 } },
      });
    }));
    render(<Targets apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    fireEvent.change(screen.getByLabelText("target"), { target: { value: "codex" } });
    fireEvent.click(screen.getByText("Materialize"));
    expect(await screen.findByText("AGENTS.md")).toBeTruthy();
    // .md content renders as markdown by default ("# hello agents" -> <h1>hello agents</h1>)
    await waitFor(() => expect(screen.getByText("hello agents")).toBeTruthy());
    fireEvent.click(screen.getByText("skills/pdf/SKILL.md"));
    expect(screen.getByText("pdf skill")).toBeTruthy();
  });
});
