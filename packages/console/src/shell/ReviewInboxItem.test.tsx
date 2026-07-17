import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ReviewInboxItem } from "./ReviewInboxItem.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

describe("ReviewInboxItem", () => {
  it("is absent at count 0", () => {
    const { container } = render(<ReviewInboxItem count={0} active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("is present with a count badge at n>0", () => {
    render(<ReviewInboxItem count={3} active={false} />);
    expect(screen.getByRole("button", { name: /review inbox/i })).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // the count is text content, not color-only
  });

  it("routes to the Dreaming panel when clicked", () => {
    render(<ReviewInboxItem count={1} active={false} />);
    fireEvent.click(screen.getByRole("button", { name: /review inbox/i }));
    expect(window.location.hash).toBe("#/dreaming");
  });
});
