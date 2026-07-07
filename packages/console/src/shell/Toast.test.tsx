import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./Toast.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Trigger() {
  const { push } = useToast();
  return <button onClick={() => push("hello world")}>go</button>;
}

describe("Toast", () => {
  it("pushes a toast that appears in an aria-live region", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("hello world")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("auto-dismisses after 6s", () => {
    vi.useFakeTimers();
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    expect(screen.queryByText("hello world")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText("hello world")).toBeNull();
  });

  it("dismisses on the close button", () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("hello world")).toBeNull();
  });

  it("cancels the pending auto-dismiss timer on manual dismiss", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    render(<ToastProvider><Trigger /></ToastProvider>);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(clearSpy).toHaveBeenCalled();
    expect(screen.queryByText("hello world")).toBeNull();
    // Advancing past the original TTL must not throw or warn about updating
    // an already-removed toast (the timer was cancelled, not just outrun).
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText("hello world")).toBeNull();
    clearSpy.mockRestore();
  });
});
