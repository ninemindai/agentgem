import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useDialogA11y } from "../useDialogA11y.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Dialog({ onClose, autofocus }: { onClose: () => void; autofocus?: boolean }) {
  const panelRef = useDialogA11y(onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label="Test">
      <div ref={panelRef}>
        <button type="button">Close</button>
        <button type="button" {...(autofocus ? { "data-autofocus": "" } : {})}>Primary</button>
      </div>
    </div>
  );
}

// Mirrors how the real modals are used: a trigger opens the dialog, and closing must
// hand focus back to that trigger rather than dropping it on <body>.
function Harness({ autofocus }: { autofocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && <Dialog onClose={() => setOpen(false)} autofocus={autofocus} />}
    </>
  );
}

describe("useDialogA11y", () => {
  it("moves focus into the dialog on open (first focusable by default)", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("prefers a [data-autofocus] element over the first focusable", () => {
    render(<Harness autofocus />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Primary" }));
  });

  it("returns focus to the element that opened it", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a non-Escape key does not close", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls the LATEST onClose, and does not refocus on re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Dialog onClose={first} />);
    const primary = screen.getByRole("button", { name: "Primary" });
    primary.focus(); // user tabbed away from the initially-focused element

    rerender(<Dialog onClose={second} />);
    // A re-render must not yank focus back to the top of the dialog.
    expect(document.activeElement).toBe(primary);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
