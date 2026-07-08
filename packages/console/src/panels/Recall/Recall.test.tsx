// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Recall } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const MOMENTS = [
  { sessionId: "s1", agent: "claude", turn: 3, project: "agentgem", branch: "main", startMs: Date.now() - 60_000, snippet: "the ⌈prod⌉ db", score: -1, turnsMatched: 2 },
  { sessionId: "s2", agent: "codex", turn: 0, project: "agentgem", branch: "fix/x", startMs: Date.now() - 60_000, snippet: "another ⌈moment⌉ here", score: -1, turnsMatched: 1 },
];

const OTHER_MOMENTS = [
  { sessionId: "s3", agent: "claude", turn: 1, project: "agentgem", branch: "main", startMs: Date.now() - 60_000, snippet: "a ⌈different⌉ thing", score: -1, turnsMatched: 1 },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/recall/status")) return new Response(JSON.stringify({ ready: true, indexed: 214, total: 214 }));
    if (url.includes("/api/recall/search")) {
      const moments = url.includes("q=other") ? OTHER_MOMENTS : MOMENTS;
      return new Response(JSON.stringify({ moments }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe("Recall panel", () => {
  it("renders moment cards for a query and starts with the action bar disabled", async () => {
    render(<Recall apiBase="" />);
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "prod db" } });
    await waitFor(() => expect(screen.getAllByText("agentgem").length).toBeGreaterThan(0), { timeout: 2000 });
    expect((screen.getByRole("button", { name: /chat with these/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /extract across these/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".rc-selcount")?.textContent).toBe("0 selected");
  });

  it("selecting a card enables the action bar and updates the count", async () => {
    render(<Recall apiBase="" />);
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "prod db" } });
    const cards = await screen.findAllByRole("button", { name: /matching turn/i }, { timeout: 2000 });
    fireEvent.click(cards[0]);
    await waitFor(() => expect((screen.getByRole("button", { name: /chat with these/i }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: /extract across these/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector(".rc-selcount")?.textContent).toBe("1 selected");
  });

  it("an empty query shows no moments and no request is made", () => {
    render(<Recall apiBase="" />);
    expect(screen.queryByText(/matched/i)).toBeNull();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("/api/recall/search"))).toBe(false);
  });

  it("the since select keeps its chosen preset and the search carries a since cutoff", async () => {
    render(<Recall apiBase="" />);
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "prod db" } });
    await waitFor(() => expect(screen.getAllByText("agentgem").length).toBeGreaterThan(0), { timeout: 2000 });

    const sinceSelect = screen.getByLabelText("since") as HTMLSelectElement;
    fireEvent.change(sinceSelect, { target: { value: "7" } });

    expect(sinceSelect.value).toBe("7");
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => String(c[0]).includes("/api/recall/search") && String(c[0]).includes("since="))).toBe(true);
    }, { timeout: 2000 });
    // the select must still reflect the chosen preset after the search re-ran
    expect(sinceSelect.value).toBe("7");
  });

  it("reconciles stale selection when the moment list becomes disjoint", async () => {
    render(<Recall apiBase="" />);
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "prod db" } });
    const cards = await screen.findAllByRole("button", { name: /matching turn/i }, { timeout: 2000 });
    fireEvent.click(cards[0]);
    fireEvent.click(cards[1]);
    await waitFor(() => expect(document.querySelector(".rc-selcount")?.textContent).toBe("2 selected"));
    expect((screen.getByRole("button", { name: /chat with these/i }) as HTMLButtonElement).disabled).toBe(false);

    // switch to a query whose results share no session with the current selection
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "other stuff" } });
    await waitFor(() => expect(screen.getAllByText("different").length).toBeGreaterThan(0), { timeout: 2000 });

    expect(document.querySelector(".rc-selcount")?.textContent).toBe("0 selected");
    expect((screen.getByRole("button", { name: /chat with these/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /extract across these/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
