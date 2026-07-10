import { describe, it, expect, vi, afterEach } from "vitest";
import { visitorId } from "./visitor";

function stubStorage(store: Record<string, string> = {}) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("visitorId", () => {
  it("mints an id once and reuses it on later calls", () => {
    stubStorage();
    const first = visitorId();
    expect(first).not.toBe("");
    expect(visitorId()).toBe(first);
  });

  it("reuses an id already in storage rather than minting a new one", () => {
    stubStorage({ "agentgem.visitorId": "existing-id" });
    expect(visitorId()).toBe("existing-id");
  });

  it("returns empty when storage throws — a blocked browser still plays, just undeduped", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => {} });
    expect(visitorId()).toBe("");
  });
});
