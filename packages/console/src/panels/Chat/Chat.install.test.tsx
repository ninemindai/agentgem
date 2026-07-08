import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Chat } from "./index.js";

const agentsMissing = { agents: [
  { id: "claude-code", name: "Claude Code", available: true, installable: false, source: "path" },
  { id: "codex", name: "Codex", available: false, installable: true, source: "missing" },
] };
const agentsInstalled = { agents: [
  { id: "claude-code", name: "Claude Code", available: true, installable: false, source: "path" },
  { id: "codex", name: "Codex", available: true, installable: false, source: "managed" },
] };

describe("Chat adapter install", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("installs a missing adapter and refetches", async () => {
    let agentsCall = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/agents")) return { ok: true, json: async () => (agentsCall++ === 0 ? agentsMissing : agentsInstalled) } as Response;
      if (String(url).endsWith("/api/agents/codex/install")) {
        expect(JSON.parse(String(init?.body))).toEqual({ consent: true });
        return { ok: true, json: async () => ({ available: true, source: "managed", needsLogin: true }) } as Response;
      }
      throw new Error("unexpected " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<Chat apiBase="" />);
    const btn = await screen.findByRole("button", { name: /install codex/i });
    fireEvent.click(btn);                                   // opens inline consent
    fireEvent.click(await screen.findByRole("button", { name: /^install$/i })); // confirm
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/agents/codex/install"), expect.anything()));
    await screen.findByText(/needs login/i);
  });
});
