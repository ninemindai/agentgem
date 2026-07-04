import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

afterEach(() => cleanup());

describe("Modal", () => {
  it("renders as a labelled dialog with its content", () => {
    render(<Modal title="ask-matt" onClose={() => {}}><p>body text</p></Modal>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("ask-matt");
    expect(screen.getByText("body text")).toBeTruthy();
  });

  it("closes on ESC, backdrop click, and the close button", () => {
    const onClose = vi.fn();
    const { container } = render(<Modal title="t" onClose={onClose}><p>x</p></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(container.querySelector(".ex-modal")!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not close when the panel itself is clicked", () => {
    const onClose = vi.fn();
    render(<Modal title="t" onClose={onClose}><p>x</p></Modal>);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus into the panel on open (close button)", () => {
    render(<Modal title="t" onClose={() => {}}><p>x</p></Modal>);
    expect(document.activeElement).toBe(screen.getByLabelText("Close"));
  });
});
