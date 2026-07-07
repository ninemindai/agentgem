import { describe, it, expect, afterEach, vi } from "vitest";
import { osNotify } from "./osNotify.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("osNotify", () => {
  it("uses the Electron bridge when present and never touches Notification", () => {
    const notify = vi.fn();
    vi.stubGlobal("agentgem", { notify });
    const Ctor = vi.fn();
    vi.stubGlobal("Notification", Ctor);
    osNotify("T", "B");
    expect(notify).toHaveBeenCalledWith("T", "B");
    expect(Ctor).not.toHaveBeenCalled();
  });

  it("constructs a browser Notification when granted and no bridge", () => {
    vi.stubGlobal("agentgem", undefined);
    const Ctor = vi.fn();
    (Ctor as unknown as { permission: string }).permission = "granted";
    vi.stubGlobal("Notification", Ctor);
    osNotify("T", "B");
    expect(Ctor).toHaveBeenCalledWith("T", { body: "B" });
  });

  it("does nothing when permission is not granted and no bridge", () => {
    vi.stubGlobal("agentgem", undefined);
    const Ctor = vi.fn();
    (Ctor as unknown as { permission: string }).permission = "default";
    vi.stubGlobal("Notification", Ctor);
    osNotify("T", "B");
    expect(Ctor).not.toHaveBeenCalled();
  });
});
