import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { OutcomesView } from "./OutcomesView.js";
import type { InsightsEvent } from "./insightsStream.js";

afterEach(cleanup);

function fakeStream() {
  const calls: { root: string; opts: unknown; emit: (e: InsightsEvent) => void }[] = [];
  const open = (_api: string, root: string, onEvent: (e: InsightsEvent) => void, opts?: unknown) => {
    calls.push({ root, opts, emit: onEvent });
    return () => {};
  };
  return { calls, open };
}
const emptyReport = { totals: { sessions: 0, mostly: 0, partially: 0, not: 0 }, outcomes_summary: "", narrative: "", by_model: [], friction: [], publish_candidates: [] };

describe("OutcomesView", () => {
  it("peeks the cache with cacheOnly on mount and does not auto-run the LLM", () => {
    const s = fakeStream();
    render(<OutcomesView apiBase="http://x" scope="/proj" openStream={s.open as never} />);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].opts).toMatchObject({ cacheOnly: true });
  });

  it("shows Generate when the peek reports no cache", () => {
    const s = fakeStream();
    render(<OutcomesView apiBase="http://x" scope="/proj" openStream={s.open as never} />);
    s.calls[0].emit({ type: "done", report: emptyReport as never, degraded: false, cached: false, updatedAt: null });
    expect(screen.getByRole("button", { name: /generate/i })).toBeTruthy();
  });

  it("generate opens a compute stream (no cacheOnly)", () => {
    const s = fakeStream();
    render(<OutcomesView apiBase="http://x" scope="/proj" openStream={s.open as never} />);
    s.calls[0].emit({ type: "done", report: emptyReport as never, degraded: false, cached: false, updatedAt: null });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));
    expect(s.calls[1].opts ?? {}).not.toMatchObject({ cacheOnly: true });
  });
});
