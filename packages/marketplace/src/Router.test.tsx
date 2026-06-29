import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "./Router";
import { makeApi } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Router", () => {
  it("renders the leaderboard at /", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([{ id: "skill:a/b", kind: "skill", producers: 5, verifiedProducers: 2, invocations: 9, sessions: 4 }])));
    window.history.pushState({}, "", "/");
    render(<Router api={makeApi("")} />);
    expect(await screen.findByText("b")).toBeTruthy();
  });

  it("renders the ingredient page at /ingredient/:id with the decoded id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/co-occurrence")) return res([{ id: "skill:c/d", producers: 1, verifiedProducers: 0 }]);
      return res([]);
    }));
    window.history.pushState({}, "", "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
    render(<Router api={makeApi("")} />);
    expect(await screen.findByText("brainstorming")).toBeTruthy(); // header from decoded id
  });
});
