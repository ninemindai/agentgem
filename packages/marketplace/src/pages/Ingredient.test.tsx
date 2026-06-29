import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Ingredient } from "./Ingredient";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/co-occurrence")) return res([{ id: "skill:superpowers/writing-plans", producers: 30, verifiedProducers: 15 }]);
    if (url.includes("/adoption")) return res([{ bucket: "2026-06-01", producers: 10, verifiedProducers: 4, invocations: 22 }]);
    throw new Error("unexpected " + url);
  }));
}

describe("Ingredient", () => {
  it("renders the prettified header, co-occurrence, and adoption", async () => {
    stub();
    render(<Ingredient api={makeApi("")} id="skill:superpowers/brainstorming" />);
    expect(await screen.findByText("brainstorming")).toBeTruthy();      // header
    await waitFor(() => expect(screen.getByText("writing-plans")).toBeTruthy()); // co-occurrence
    expect(screen.getByText(/adoption/i)).toBeTruthy();
  });

  it("refetches adoption when the bucket toggles", async () => {
    stub();
    render(<Ingredient api={makeApi("")} id="skill:superpowers/brainstorming" />);
    await screen.findByText("brainstorming");
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "month" }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before));
  });
});
