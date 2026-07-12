import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOnline } from "./useOnline";

describe("useOnline", () => {
  it("tracks online/offline events", () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    act(() => { Object.defineProperty(navigator, "onLine", { value: false, configurable: true }); window.dispatchEvent(new Event("offline")); });
    expect(result.current).toBe(false);
    act(() => { Object.defineProperty(navigator, "onLine", { value: true, configurable: true }); window.dispatchEvent(new Event("online")); });
    expect(result.current).toBe(true);
  });
});
