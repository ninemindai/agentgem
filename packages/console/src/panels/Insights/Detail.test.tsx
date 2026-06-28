import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Detail } from "./Detail.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function stub(co: unknown[], adoption: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/co-occurrence")) return res(co);
    if (url.includes("/adoption")) return res(adoption);
    throw new Error("unexpected " + url);
  }));
}

describe("Detail", () => {
  it("renders co-occurrence partners and an adoption chart for the id", async () => {
    stub(
      [{ id: "skill:superpowers/writing-plans", producers: 60, verifiedProducers: 30 }],
      [{ bucket: "2026-06-01", producers: 10, verifiedProducers: 4, invocations: 22 },
       { bucket: "2026-06-08", producers: 18, verifiedProducers: 9, invocations: 40 }],
    );
    const { container } = render(<Detail id="skill:superpowers/brainstorming" apiBase="" />);
    await screen.findByText("writing-plans");
    expect(screen.getByText(/used together with/i)).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".ins-spark")).toBeTruthy());
  });

  it("shows an empty hint when there is no co-occurrence data", async () => {
    stub([], []);
    render(<Detail id="skill:x" apiBase="" />);
    await waitFor(() => expect(screen.getByText(/not enough data yet/i)).toBeTruthy());
  });
});
