import { describe, it, expect, vi } from "vitest";
import { installGracefulShutdown } from "../index.js";

describe("installGracefulShutdown", () => {
  it("on SIGTERM, drains the app (stop) then exits 0", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    const exit = vi.fn();
    installGracefulShutdown({ stop }, {
      on: (sig, cb) => { handlers[sig] = cb; },
      exit,
      log: () => {},
    });
    expect(handlers.SIGTERM).toBeTypeOf("function");
    expect(handlers.SIGINT).toBeTypeOf("function");
    handlers.SIGTERM();
    await new Promise((r) => setTimeout(r, 0)); // let the async shutdown settle
    expect(stop).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second signal during shutdown doesn't double-stop", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const handlers: Record<string, () => void> = {};
    installGracefulShutdown({ stop }, { on: (s, cb) => { handlers[s] = cb; }, exit: () => {}, log: () => {} });
    handlers.SIGTERM();
    handlers.SIGINT();
    await new Promise((r) => setTimeout(r, 0));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("exits 1 if draining throws (so the orchestrator sees a failed stop)", async () => {
    const stop = vi.fn().mockRejectedValue(new Error("pool drain failed"));
    const handlers: Record<string, () => void> = {};
    const exit = vi.fn();
    installGracefulShutdown({ stop }, { on: (s, cb) => { handlers[s] = cb; }, exit, log: () => {} });
    handlers.SIGTERM();
    await new Promise((r) => setTimeout(r, 0));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
