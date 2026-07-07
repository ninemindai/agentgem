import { describe, it, expect, vi } from "vitest";
import { dispatch } from "./dispatch.js";
import type { NotifyEvent } from "./events.js";

const ev: NotifyEvent = { key: "k", title: "T", message: "M" };

describe("dispatch", () => {
  it("does nothing when disabled", () => {
    const toast = vi.fn(), notify = vi.fn();
    dispatch(ev, { enabled: false, hidden: true, toast, notify });
    expect(toast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  it("toast only when focused (not hidden)", () => {
    const toast = vi.fn(), notify = vi.fn();
    dispatch(ev, { enabled: true, hidden: false, toast, notify });
    expect(toast).toHaveBeenCalledWith("M");
    expect(notify).not.toHaveBeenCalled();
  });
  it("toast + OS notify when hidden", () => {
    const toast = vi.fn(), notify = vi.fn();
    dispatch(ev, { enabled: true, hidden: true, toast, notify });
    expect(toast).toHaveBeenCalledWith("M");
    expect(notify).toHaveBeenCalledWith("T", "M");
  });
});
