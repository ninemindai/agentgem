import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
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

  it("moves focus onto the panel on open (not the close button)", () => {
    // Auto-focusing the close button makes the × look pre-selected (a heavy :focus-visible ring the
    // instant the dialog opens). Focus the panel container instead — a11y-valid, visually quiet.
    render(<Modal title="t" onClose={() => {}}><p>x</p></Modal>);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("focuses a [data-autofocus] child on open and keeps focus there across re-renders", () => {
    // The bug: a parent re-render passes a NEW inline onClose each keystroke; if the focus effect
    // re-runs on onClose it steals focus out of the field. Focus must both land on the marked input
    // and survive a controlled-input re-render.
    function Harness() {
      const [v, setV] = useState("");
      return (
        <Modal title="t" onClose={() => {}}>
          <input aria-label="f" data-autofocus value={v} onChange={(e) => setV(e.target.value)} />
        </Modal>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText("f") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "M" } });
    expect(document.activeElement).toBe(input);
  });
});
