import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Sources } from "./Sources";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const res = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as unknown as Response;

const stub = () => vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
  const u = String(url);
  if (u.includes("/api/sources/divisions")) return res({ divisions: [{ key: "engineering", label: "Engineering" }] });
  if (u.includes("/api/sources/agents")) return res({ agents: [{ division: "engineering", slug: "ai-engineer", name: "ai-engineer", path: "engineering/ai-engineer.md" }] });
  if (u.includes("/api/sources/import")) return res({ name: "ai-engineer", content: "HELLO_SKILL_BODY" });
  if (u.includes("/api/sources")) return res({ sources: [{ id: "agency-agents", label: "The Agency", description: "d", repo: "o/agency-agents", ref: "main", kind: "agency-layout", license: "MIT", homepage: "https://github.com/o/agency-agents" }] });
  throw new Error(`unexpected: ${u}`);
}));

describe("Sources page", () => {
  it("shows the install command and the full SKILL.md on View skill", async () => {
    stub();
    render(<Sources api={makeApi("")} />);
    fireEvent.click(await screen.findByText("Engineering"));
    // the copy-able install command is present
    expect(await screen.findByText(/agentgem sources install agency-agents engineering\/ai-engineer\.md/)).toBeTruthy();
    // View skill loads the full body
    fireEvent.click(screen.getByText("View skill"));
    await waitFor(() => expect(screen.getByText(/HELLO_SKILL_BODY/)).toBeTruthy());
    expect(screen.getByText("Hide skill")).toBeTruthy();
  });
});
