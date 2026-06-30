// packages/console/src/panels/Optimize/Discover.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { DiscoverSection } from "./Discover.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const cand = (name: string) => ({ name, source: "o/r", skillId: name, registry: "skills.sh", installs: 1234, url: `https://skills.sh/o/r/${name}`, reason: `matches your ${name} workflow`, installCmd: `npx skills add o/r@${name}` });

describe("DiscoverSection", () => {
  it("fetches and renders recommendations on click", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ candidates: [cand("a"), cand("b")], topics: ["a"], reranked: false })));
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    expect(await screen.findByText("npx skills add o/r@a")).toBeTruthy();
    // installs labelled as registry-reported
    expect(screen.getByText(/registry-reported/i)).toBeTruthy();
  });

  it("shows a degraded message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ candidates: [], topics: [], degraded: { reason: "No workflow signal yet — use some skills first." } })));
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    expect(await screen.findByText(/no workflow signal/i)).toBeTruthy();
  });

  it("re-ranks via the AI button once candidates exist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ candidates: [cand("a"), cand("b")], topics: ["a"], reranked: false }))
      .mockResolvedValueOnce(res({ candidates: [cand("b"), cand("a")], topics: ["a"], reranked: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    await screen.findByText("npx skills add o/r@a");
    fireEvent.click(screen.getByRole("button", { name: /re-rank with ai/i }));
    await waitFor(() => {
      const cmds = screen.getAllByText(/npx skills add/).map((n) => n.textContent);
      expect(cmds[0]).toBe("npx skills add o/r@b"); // b now first
    });
  });

  it("installs a skill: Install → confirm → POSTs source+skillId → shows installed", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ candidates: [cand("a")], topics: ["a"], reranked: false }))
      .mockResolvedValueOnce(res({ ok: true, skill: "o/r@a", message: "Installed 1 skill" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    await screen.findByText("npx skills add o/r@a");
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));         // arm confirm
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));         // execute
    expect(await screen.findByText(/✓ installed/)).toBeTruthy();
    // the install POST carried the canonical source + skillId, not the display string
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({ source: "o/r", skillId: "a" });
  });

  it("surfaces an install failure (ok:false) without throwing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res({ candidates: [cand("a")], topics: ["a"], reranked: false }))
      .mockResolvedValueOnce(res({ ok: false, skill: "o/r@a", message: "Repository not found" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    await screen.findByText("npx skills add o/r@a");
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(await screen.findByText(/Repository not found/)).toBeTruthy();
  });

  it("Cancel aborts the install without POSTing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ candidates: [cand("a")], topics: ["a"], reranked: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DiscoverSection apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /find recommendations/i }));
    await screen.findByText("npx skills add o/r@a");
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByRole("button", { name: /^install$/i })).toBeTruthy();     // back to idle
    expect(fetchMock).toHaveBeenCalledTimes(1);                                  // only the find call
  });
});
