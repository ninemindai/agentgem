import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const popularityRow = [
  { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/co-occurrence")) return res([]);
      if (url.includes("/adoption")) return res([]);
      return res(popularityRow);
    }),
  );
}

describe("App link interceptor", () => {
  it("intercepts an internal link and does pushState without a full reload", async () => {
    stubFetch();
    window.history.pushState({}, "", "/");
    render(<App />);

    // Wait for the leaderboard row link to appear
    const link = (await screen.findByText("brainstorming")).closest("a")!;
    expect(link).toBeTruthy();
    const expectedPath = "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming");
    expect(link.getAttribute("href")).toBe(expectedPath);

    fireEvent.click(link);

    // pushState happened — pathname changed
    expect(window.location.pathname).toBe(expectedPath);
    // The document wasn't torn down — the app root is still present
    expect(document.querySelector(".ex-app")).toBeTruthy();
  });

  it("leaves external links alone (does not change pathname)", async () => {
    stubFetch();
    window.history.pushState({}, "", "/");
    render(<App />);

    // Wait for the app to render (footer is always present)
    await screen.findByText("brainstorming");

    const externalLink = document.querySelector('a[href="https://agentgem.ai"]')!;
    expect(externalLink).toBeTruthy();

    fireEvent.click(externalLink);

    // Interceptor must NOT have called pushState — pathname unchanged
    expect(window.location.pathname).toBe("/");
  });
});
