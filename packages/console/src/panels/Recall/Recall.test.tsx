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
    if (url.includes("/api/recall/status")) {
      return new Response(JSON.stringify({ ready: true, indexed: 214, total: 214, facets: { projects: ["agentgem"], agents: ["claude", "codex"] } }));
    }
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

    // the reconcile runs in an effect on [moments], i.e. a commit *after* the render above — so wait for
    // it rather than asserting in the same tick (that races, and loses under full-suite concurrency).
    await waitFor(() => expect(document.querySelector(".rc-selcount")?.textContent).toBe("0 selected"));
    expect((screen.getByRole("button", { name: /chat with these/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /extract across these/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the indexing hint while the index is still building, not once it's ready", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/recall/status")) {
        return new Response(JSON.stringify({ ready: false, indexed: 3, total: 10, facets: { projects: [], agents: [] } }));
      }
      if (url.includes("/api/recall/search")) return new Response(JSON.stringify({ moments: MOMENTS }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Recall apiBase="" />);
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "prod db" } });
    await waitFor(() => expect(screen.getByText(/indexing your sessions…/i)).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText(/indexing your sessions…/i).textContent).toContain("3 of 10");

    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/recall/status")) {
        return new Response(JSON.stringify({ ready: true, indexed: 214, total: 214, facets: { projects: ["agentgem"], agents: ["claude", "codex"] } }));
      }
      if (url.includes("/api/recall/search")) return new Response(JSON.stringify({ moments: MOMENTS }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Recall apiBase="" />);
    fireEvent.change(screen.getByLabelText(/search transcripts/i), { target: { value: "prod db" } });
    await waitFor(() => expect(screen.getAllByText("agentgem").length).toBeGreaterThan(0), { timeout: 2000 });
    expect(screen.queryByText(/indexing your sessions…/i)).toBeNull();
  });

  it("populates the project and agent filter selects from status.facets", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/recall/status")) {
        return new Response(JSON.stringify({ ready: true, indexed: 2, total: 2, facets: { projects: ["a", "b"], agents: ["claude"] } }));
      }
      if (url.includes("/api/recall/search")) return new Response(JSON.stringify({ moments: [] }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Recall apiBase="" />);
    const projectSelect = await screen.findByLabelText("project") as HTMLSelectElement;
    await waitFor(() => {
      const values = [...projectSelect.options].map((o) => o.value);
      expect(values).toEqual(["", "a", "b"]);
    });
    const agentSelect = screen.getByLabelText("agent") as HTMLSelectElement;
    expect([...agentSelect.options].map((o) => o.value)).toEqual(["", "claude"]);
  });
});
