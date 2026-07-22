// packages/console/src/panels/Play/__tests__/SourceList.test.tsx
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SourceList } from "../SourceList.js";

afterEach(cleanup);

type Row = { id: string; name: string };
const rows: Row[] = [{ id: "a", name: "alpha" }, { id: "b", name: "beta" }, { id: "c", name: "gamma" }];
const renderList = (onPick = vi.fn()) => {
  render(<SourceList<Row> items={rows} filter={(r, q) => r.name.includes(q)} onPick={onPick}
    renderRow={(r) => ({ key: r.id, main: r.name })} placeholder="search…" loadingLabel="Loading…" />);
  return onPick;
};

describe("SourceList", () => {
  it("shows the loading label while items is null", () => {
    render(<SourceList<Row> items={null} filter={() => true} onPick={vi.fn()}
      renderRow={(r) => ({ main: r.name })} placeholder="search…" loadingLabel="Loading rows…" />);
    expect(screen.getByText("Loading rows…")).toBeTruthy();
  });

  it("filters rows case-insensitively and shows No matches", () => {
    renderList();
    fireEvent.change(screen.getByPlaceholderText("search…"), { target: { value: "BET" } });
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("search…"), { target: { value: "zzz" } });
    expect(screen.getByText(/no matches/i)).toBeTruthy();
  });

  it("picks the highlighted row on ArrowDown+Enter", () => {
    const onPick = renderList();
    const input = screen.getByPlaceholderText("search…");
    fireEvent.keyDown(input, { key: "ArrowDown" });   // highlight -> beta (index 1)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(rows[1]);
  });

  it("picks a row on click", () => {
    const onPick = renderList();
    fireEvent.click(screen.getByText("gamma"));
    expect(onPick).toHaveBeenCalledWith(rows[2]);
  });
});

describe("SourceList shortlist", () => {
  const many: Row[] = Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, name: `item-${i}` }));
  const renderMany = () =>
    render(<SourceList<Row> items={many} filter={(r, q) => r.name.includes(q)} onPick={vi.fn()}
      renderRow={(r) => ({ key: r.id, main: r.name })} placeholder="search…" loadingLabel="Loading…" />);

  it("shows only the top 6 by default with a Show all toggle, expandable to all", () => {
    renderMany();
    expect(screen.getAllByRole("option").length).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: /show all 10/i }));
    expect(screen.getAllByRole("option").length).toBe(10);
    fireEvent.click(screen.getByRole("button", { name: /show fewer/i }));
    expect(screen.getAllByRole("option").length).toBe(6);
  });

  it("search reveals a match beyond the shortlist (ignores the cap)", () => {
    renderMany();
    fireEvent.change(screen.getByPlaceholderText("search…"), { target: { value: "item-9" } });
    expect(screen.getByText("item-9")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBe(1);
    expect(screen.queryByRole("button", { name: /show all/i })).toBeNull();
  });

  it("orders the shortlist by the rank comparator", () => {
    render(<SourceList<Row> items={many} filter={(r, q) => r.name.includes(q)} onPick={vi.fn()}
      renderRow={(r) => ({ key: r.id, main: r.name })} placeholder="search…" loadingLabel="Loading…"
      rank={(a, b) => b.name.localeCompare(a.name)} />);   // reverse-alpha → item-9 first
    expect(screen.getAllByRole("option")[0].textContent).toContain("item-9");
  });

  it("shows no toggle when items fit within the shortlist", () => {
    render(<SourceList<Row> items={rows} filter={(r, q) => r.name.includes(q)} onPick={vi.fn()}
      renderRow={(r) => ({ key: r.id, main: r.name })} placeholder="search…" loadingLabel="Loading…" />);
    expect(screen.queryByRole("button", { name: /show all/i })).toBeNull();
  });
});
