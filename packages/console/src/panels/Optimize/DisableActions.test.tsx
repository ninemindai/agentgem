import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Dashboard } from "./Dashboard.js";
import type { OptimizePayload } from "../../api/routes.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const artifact = (over: Partial<any> = {}) => ({
  name: "old-skill", type: "skill", source: "standalone", contextTokens: 400, uses: 0,
  lastUsedMs: null, prune: true, change: { file: "~/.claude/skills/old-skill", key: "remove" }, ...over,
});
const payload = (over: Partial<any> = {}) => ({
  range: "30d", instructions: [],
  artifacts: [artifact(), artifact({ name: "kept", source: "distilled-draft", prune: false })],
  disabled: [], ...over,
}) as unknown as OptimizePayload;

describe("Prune disable actions", () => {
  it("selecting an eligible row arms 'Disable selected', POSTs the checked items, and moves them locally (no refetch)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ results: [{ type: "skill", name: "old-skill", ok: true, message: "disabled" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();
    const onMutate = vi.fn();
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={onRefresh} onMutate={onMutate} apiBase="" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /select old-skill/i }));
    fireEvent.click(screen.getByRole("button", { name: /disable selected \(1\)/i }));
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ artifacts: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    // Optimistic transform: the row leaves the prune list and joins `disabled` — no full reload.
    expect(onRefresh).not.toHaveBeenCalled();
    const next = onMutate.mock.calls[0][0](payload());
    expect(next.artifacts.some((a: any) => a.name === "old-skill")).toBe(false);
    expect(next.disabled).toEqual([{ type: "skill", name: "old-skill", source: "standalone" }]);
  });

  it("shows the estimated context freed for the current selection", () => {
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} onMutate={() => {}} apiBase="" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /select old-skill/i }));
    expect(screen.getByText(/est\. context freed/i)).toBeTruthy();
  });

  it("select-all checks every eligible row, then deselects", () => {
    const data = payload({ artifacts: [
      { name: "a-skill", type: "skill", source: "standalone", contextTokens: 100, uses: 0, lastUsedMs: null, prune: true, change: { file: "f", key: "k" } },
      { name: "b-skill", type: "skill", source: "standalone", contextTokens: 200, uses: 0, lastUsedMs: null, prune: true, change: { file: "f", key: "k" } },
    ] });
    render(<Dashboard data={data} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} onMutate={() => {}} apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: /select all \(2\)/i }));
    expect(screen.getByRole("button", { name: /disable selected \(2\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /deselect all/i }));
    expect(screen.getByRole("button", { name: /disable selected \(0\)/i })).toBeTruthy();
  });

  it("filters the prune table by name", () => {
    const data = payload({ artifacts: [
      { name: "alpha", type: "skill", source: "standalone", contextTokens: 100, uses: 0, lastUsedMs: null, prune: true, change: { file: "f", key: "k" } },
      { name: "beta", type: "skill", source: "standalone", contextTokens: 200, uses: 0, lastUsedMs: null, prune: true, change: { file: "f", key: "k" } },
    ] });
    render(<Dashboard data={data} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} onMutate={() => {}} apiBase="" />);
    fireEvent.change(screen.getByRole("searchbox", { name: /filter artifacts/i }), { target: { value: "alph" } });
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("does not render a checkbox for ineligible (distilled-draft) rows", () => {
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} onMutate={() => {}} apiBase="" />);
    expect(screen.queryByRole("checkbox", { name: /select kept/i })).toBeNull();
  });

  it("renders the Disabled section and re-enables a row locally", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ results: [{ type: "skill", name: "old-skill", ok: true, message: "restored" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onMutate = vi.fn();
    const data = payload({ disabled: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    render(<Dashboard data={data} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} onMutate={onMutate} apiBase="" />);
    expect(screen.getByRole("heading", { name: /Disabled/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /re-enable old-skill/i }));
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ artifacts: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    const next = onMutate.mock.calls[0][0](data);
    expect(next.disabled).toEqual([]);
  });
});
