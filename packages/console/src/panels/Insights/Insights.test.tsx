import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Insights } from "./index.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const overview = { ingredients: 120, producers: 50, verifiedProducers: 20, invocations: 999, sessions: 300 };
const pop = [{ id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 }];

function stubAll() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/overview")) return res(overview);
    if (url.includes("/popularity")) return res(pop);
    if (url.includes("/co-occurrence")) return res([{ id: "skill:superpowers/writing-plans", producers: 60, verifiedProducers: 30 }]);
    if (url.includes("/adoption")) return res([{ bucket: "2026-06-01", producers: 10, verifiedProducers: 4, invocations: 22 }]);
    throw new Error("unexpected " + url);
  }));
}

describe("Insights page", () => {
  it("renders the pulse + leaderboard, and drills into a row", async () => {
    stubAll();
    render(<Insights apiBase="" />);
    await screen.findByText("50");                        // producers count in Pulse (from overview)
    expect(screen.getByText("producers")).toBeTruthy();   // unit label alongside count
    await screen.findByText("brainstorming");             // leaderboard from popularity
    fireEvent.click(screen.getByText("brainstorming"));
    await waitFor(() => expect(screen.getByText("writing-plans")).toBeTruthy()); // detail co-occurrence
  });
});
