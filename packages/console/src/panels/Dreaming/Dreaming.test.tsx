import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Dreaming } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 1, lastPassAtMs: 1 }));
    if (url.endsWith("/api/dream/queue")) return new Response(JSON.stringify({ items: [{ key: "k1", kind: "skill", name: "foo", summary: "does foo" }] }));
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe("Dreaming panel", () => {
  it("renders the phase readout, promoted count, and a queued draft", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("foo")).toBeTruthy());
    expect(screen.getByText(/2 promoted/i)).toBeTruthy();
    expect(screen.getByText("DEEP")).toBeTruthy();
  });

  it("accept posts to the accept endpoint", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).endsWith("/api/dream/queue/accept"))).toBe(true));
  });
});
