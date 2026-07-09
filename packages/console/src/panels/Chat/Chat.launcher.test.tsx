import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Chat } from "./index.js";

afterEach(cleanup);

// Chat's own fetches parse via `response.json()`, but ScopePicker's testbed
// calls go through @agentback/client, which parses via `response.text()` +
// JSON.parse (see Curate.test.tsx) — so every stub response needs both.
const res = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

// Records the POST /api/chat body so we can assert `project` is sent.
function stubFetch(bodies: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/agents")) return res({ agents: [{ id: "claude-code", name: "Claude Code", available: true }] });
    if (u.endsWith("/api/testbed/recents")) return res({ recents: [{ path: "/repo/a", flavor: "x", name: "a", lastUsed: "2026-01-01", exists: true }] });
    if (u.endsWith("/api/testbed/projects")) return res({ projects: [] });
    if (u.endsWith("/api/chat")) { bodies.push(String(init?.body ?? "")); return res({ chatId: "c1" }); }
    return res({});
  }));
}

describe("Chat project launcher", () => {
  it("sends the picked project root in the POST /api/chat body", async () => {
    const bodies: string[] = [];
    stubFetch(bodies);
    render(<Chat apiBase="" />);
    await screen.findByRole("button", { name: /neutral/i });
    fireEvent.click(screen.getByRole("button", { name: /project/i }));
    fireEvent.click(await screen.findByText("/repo/a"));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(JSON.parse(bodies[0])).toMatchObject({ agentId: "claude-code", project: "/repo/a" });
  });
});
