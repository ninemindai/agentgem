import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Sources } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const SKILL_BODY = "---\nname: ai-engineer\n---\n# ai-engineer\nHELLO_SKILL_BODY_MARKER";

// Route the console client's fetch to canned source responses. `/import` returns the
// full SKILL.md; the more specific paths must be matched before the bare list.
const stubFetch = () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/sources/divisions")) return res({ divisions: [{ key: "engineering", label: "Engineering" }] });
    if (u.includes("/api/sources/agents")) return res({ agents: [{ division: "engineering", slug: "ai-engineer", name: "ai-engineer", path: "engineering/ai-engineer.md" }] });
    if (u.includes("/api/sources/import")) { calls.push("import"); return res({ type: "skill", name: "ai-engineer", source: "agency-agents", content: SKILL_BODY }); }
    if (u.includes("/api/sources")) return res({ sources: [{ id: "agency-agents", label: "The Agency", description: "curated personas", repo: "o/agency-agents", ref: "main", kind: "agency-layout" }] });
    throw new Error(`unexpected: ${u}`);
  }));
  return calls;
};

describe("Sources — View skill before install", () => {
  it("fetches and toggles the full SKILL.md via /import without installing", async () => {
    const calls = stubFetch();
    render(<Sources apiBase="" />);

    // Drill in: source auto-selected → division loads → click it → agents load.
    fireEvent.click(await screen.findByText("Engineering"));
    const viewBtn = await screen.findByText("View skill");

    // View skill → /import called → full body rendered in the scrollable pre.
    fireEvent.click(viewBtn);
    await waitFor(() => expect(screen.getByText(/HELLO_SKILL_BODY_MARKER/)).toBeTruthy());
    expect(calls).toEqual(["import"]);
    // The button flips to a hide affordance.
    expect(screen.getByText("Hide skill")).toBeTruthy();

    // Toggle off — content disappears, no second fetch.
    fireEvent.click(screen.getByText("Hide skill"));
    await waitFor(() => expect(screen.queryByText(/HELLO_SKILL_BODY_MARKER/)).toBeNull());
    expect(calls).toEqual(["import"]);
  });
});
