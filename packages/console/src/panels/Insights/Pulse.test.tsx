import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Pulse } from "./Pulse.js";

afterEach(cleanup);

describe("Pulse", () => {
  it("renders totals and a verified percentage", () => {
    render(<Pulse data={{ ingredients: 120, producers: 50, verifiedProducers: 20, invocations: 999, sessions: 300 }} loading={false} />);
    expect(screen.getByText(/120/)).toBeTruthy();
    expect(screen.getByText("50")).toBeTruthy();
    expect(screen.getByText("producers")).toBeTruthy();
    expect(screen.getByText(/40%/)).toBeTruthy(); // 20/50 verified
  });
  it("shows a below-floor message when the network has no exposable producers", () => {
    render(<Pulse data={{ ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 }} loading={false} />);
    expect(screen.getByText(/not enough producers yet/i)).toBeTruthy();
  });
});
