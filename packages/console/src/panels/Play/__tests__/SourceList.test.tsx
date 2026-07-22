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
