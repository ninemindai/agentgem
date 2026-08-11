// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { FactorSessionList } from "../FactorSessionList.js";
import type { PerSessionRow } from "../rubricStream.js";

afterEach(cleanup);

const FACTOR = "retry-storm";

// n rows, each firing FACTOR `count` times, newest ids first so sorting is observable.
function rows(specs: { id: string; count: number }[]): PerSessionRow[] {
  return specs.map(({ id, count }) => ({
    sessionId: id,
    transcript: `/tmp/${id}.jsonl`,
    factors: [{ id: FACTOR, title: "Retry storm", advice: "a", severity: "warn" as const, count, sessions: 1 }],
  }));
}

const base = {
  factorId: FACTOR,
  summarySessions: 3,
  truncated: false,
  verdictFor: () => undefined,
  noteFor: () => undefined,
  onRecord: () => {},
  onNote: () => {},
  failedIds: new Set<string>(),
};

describe("FactorSessionList", () => {
  it("renders one row per firing session, worst-first", () => {
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }, { id: "b", count: 5 }, { id: "c", count: 3 }])} />);
    const labels = screen.getAllByTestId("rub-fire-row").map((n) => n.textContent ?? "");
    // The component must NOT sort — it renders what it is given, in order.
    expect(labels[0]).toContain("a.jsonl");
    expect(labels[1]).toContain("b.jsonl");
  });

  it("shows each row's own fire count", () => {
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 5 }])} />);
    expect(screen.getByTestId("rub-fire-row").textContent).toContain("5×");
  });

  it("batches at 10 and reveals the next batch on Show more", () => {
    const many = rows(Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, count: 1 })));
    render(<FactorSessionList {...base} rows={many} summarySessions={25} />);
    expect(screen.getAllByTestId("rub-fire-row")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getAllByTestId("rub-fire-row")).toHaveLength(20);
  });

  it("states the batch honestly and says nothing about a cap that did not bite", () => {
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} summarySessions={1} />);
    const footer = screen.getByTestId("rub-fire-footer").textContent ?? "";
    expect(footer).toContain("showing 1 of 1 available");
    expect(footer).not.toMatch(/cap/i);
  });

  it("names the report cap when fires are missing entirely", () => {
    // The summary says 40 sessions; only 3 rows survived the 200-row report cap.
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }, { id: "b", count: 1 }, { id: "c", count: 1 }])} summarySessions={40} truncated />);
    const footer = screen.getByTestId("rub-fire-footer").textContent ?? "";
    expect(footer).toContain("showing 3 of 3 available");
    expect(footer).toContain("37 more beyond this report's 200-session cap");
  });

  it("posts the row's OWN sessionId, never a neighbour's", () => {
    const onRecord = vi.fn();
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }, { id: "b", count: 1 }])} onRecord={onRecord} />);
    const second = screen.getAllByTestId("rub-fire-row")[1];
    fireEvent.click(within(second).getByRole("button", { name: /^wrong/i }));
    expect(onRecord).toHaveBeenCalledWith("b", FACTOR, "wrong");
  });

  it("marks only the row that failed", () => {
    render(<FactorSessionList {...base}
      rows={rows([{ id: "a", count: 1 }, { id: "b", count: 1 }])}
      failedIds={new Set([`b\u0000${FACTOR}`])} />);
    const [first, second] = screen.getAllByTestId("rub-fire-row");
    expect(first.textContent).not.toMatch(/not saved/i);
    expect(second.textContent).toMatch(/not saved/i);
  });

  it("reveals a row's note input only after that row has a verdict", () => {
    const { rerender } = render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} />);
    expect(screen.queryByLabelText(/note on/i)).toBeNull();
    rerender(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} verdictFor={() => "wrong"} />);
    expect(screen.getByLabelText(/note on/i)).toBeTruthy();
  });

  it("posts a note with the row's own sessionId and current verdict", () => {
    const onNote = vi.fn();
    render(<FactorSessionList {...base} rows={rows([{ id: "a", count: 1 }])} verdictFor={() => "wrong"} onNote={onNote} />);
    const input = screen.getByLabelText(/note on/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "flaky test" } });
    fireEvent.blur(input);
    expect(onNote).toHaveBeenCalledWith("a", FACTOR, "wrong", "flaky test");
  });
});
