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
});
