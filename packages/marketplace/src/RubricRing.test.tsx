import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RubricRing } from "./RubricRing";
import type { RubricCheck } from "./types";

afterEach(cleanup);
const mk = (pass: boolean[]): RubricCheck[] => pass.map((p, i) => ({ id: "c" + i, label: "L" + i, pass: p, howToFix: "fix" }));

describe("RubricRing", () => {
  it("shows pass/total and an accessible label", () => {
    render(<RubricRing checks={mk([true, true, false, false, false])} />);
    expect(screen.getByText("2/5")).toBeTruthy();
    expect(screen.getByLabelText(/2 of 5 checks pass/i)).toBeTruthy();
  });

  it("renders 0/0 safely for an empty rubric", () => {
    render(<RubricRing checks={[]} />);
    expect(screen.getByText("0/0")).toBeTruthy();
  });
});
