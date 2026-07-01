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
  it("selecting an eligible row arms 'Disable selected' and POSTs the checked items", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ results: [{ type: "skill", name: "old-skill", ok: true, message: "disabled" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={onRefresh} apiBase="" />);
    fireEvent.click(screen.getByRole("checkbox", { name: /select old-skill/i }));
    fireEvent.click(screen.getByRole("button", { name: /disable selected \(1\)/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ artifacts: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("does not render a checkbox for ineligible (distilled-draft) rows", () => {
    render(<Dashboard data={payload()} range="30d" onRange={() => {}} pending={false} onRefresh={() => {}} apiBase="" />);
    expect(screen.queryByRole("checkbox", { name: /select kept/i })).toBeNull();
  });

  it("renders the Disabled section and re-enables a row", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res({ results: [{ type: "skill", name: "old-skill", ok: true, message: "restored" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();
    const data = payload({ disabled: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    render(<Dashboard data={data} range="30d" onRange={() => {}} pending={false} onRefresh={onRefresh} apiBase="" />);
    expect(screen.getByRole("heading", { name: /Disabled/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /re-enable old-skill/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ artifacts: [{ type: "skill", name: "old-skill", source: "standalone" }] });
    expect(onRefresh).toHaveBeenCalled();
  });
});
