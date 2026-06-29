import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Mine } from "../index.js";

describe("Mine panel", () => {
  it("shows the scoring skeleton on mount", () => {
    render(<Mine apiBase="http://localhost:0" />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
  });
});
