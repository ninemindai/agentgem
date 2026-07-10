import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startEmbeddedServer, parseReadyUrl, type CoreChild, type ForkCore } from "../server.js";

// __dirname at runtime is desktop/src/__tests__ under vitest; the core resolver
// expects the compiled main dir (desktop/dist). The dev candidate walks two
// levels up from there to repo dist, so pass a path two levels below repo root.
const fakeMainDir = join(__dirname, "..", "..", "dist");
const NO_RESOURCES = "/nonexistent-resources";

/** A CoreChild whose stdout and exit we drive by hand. */
class FakeChild extends EventEmitter implements CoreChild {
  pid: number | undefined = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** Write stdout bytes exactly as given — callers split a line mid-chunk on purpose. */
  say(chunk: string): void {
    this.stdout.write(chunk);
  }
  exit(code: number | null): void {
    this.emit("exit", code);
  }
}

const forkFake = (child: CoreChild): ForkCore => () => child;
/** Keeps tests from firing SIGTERM at a real pid. */
const noSignal = (): void => {};

describe("parseReadyUrl", () => {
  it("reads the url out of the ready line", () => {
    expect(parseReadyUrl('{"type":"ready","url":"http://127.0.0.1:5051"}')).toBe("http://127.0.0.1:5051");
  });

  it("ignores the core's human log lines and malformed json", () => {
    expect(parseReadyUrl("agentgem listening at http://127.0.0.1:5051")).toBeNull();
    expect(parseReadyUrl('{"type":"ready"')).toBeNull();
    expect(parseReadyUrl('{"type":"other","url":"http://x"}')).toBeNull();
    expect(parseReadyUrl('{"type":"ready","url":42}')).toBeNull();
  });
});

describe("startEmbeddedServer", () => {
  it("resolves the url from a ready line split across stdout chunks", async () => {
    const child = new FakeChild();
    const pending = startEmbeddedServer(fakeMainDir, NO_RESOURCES, { fork: forkFake(child), signal: noSignal });
    child.say('{"type":"ready","url":"htt');
    child.say('p://127.0.0.1:5051"}\nagentgem listening at http://127.0.0.1:5051\n');
    await expect(pending).resolves.toMatchObject({ url: "http://127.0.0.1:5051" });
  });

  it("rejects when the core dies before reporting ready", async () => {
    const child = new FakeChild();
    const pending = startEmbeddedServer(fakeMainDir, NO_RESOURCES, { fork: forkFake(child), signal: noSignal });
    child.exit(1);
    await expect(pending).rejects.toThrow(/exited \(1\) before it was ready/);
  });

  it("rejects when the core never reports ready", async () => {
    const child = new FakeChild();
    const pending = startEmbeddedServer(fakeMainDir, NO_RESOURCES, {
      fork: forkFake(child),
      signal: noSignal,
      startTimeoutMs: 10,
    });
    await expect(pending).rejects.toThrow(/did not report a ready url/i);
  });

  it("reports a crash after ready, but not the exit that stop() asked for", async () => {
    const onCrash = vi.fn();
    const child = new FakeChild();
    const pending = startEmbeddedServer(fakeMainDir, NO_RESOURCES, { fork: forkFake(child), onCrash, signal: noSignal });
    child.say('{"type":"ready","url":"http://127.0.0.1:5051"}\n');
    const srv = await pending;

    child.exit(9);
    expect(onCrash).toHaveBeenCalledWith(9);

    onCrash.mockClear();
    const stopped = srv.stop();
    child.exit(0);
    await stopped;
    expect(onCrash).not.toHaveBeenCalled();
  });

  it("stop() drains on SIGTERM, and force-kills only if the drain overruns", async () => {
    const signal = vi.fn();
    const child = new FakeChild();
    const pending = startEmbeddedServer(fakeMainDir, NO_RESOURCES, { fork: forkFake(child), signal, drainTimeoutMs: 10 });
    child.say('{"type":"ready","url":"http://127.0.0.1:5051"}\n');
    const srv = await pending;

    await srv.stop();
    expect(signal).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(child.killed).toBe(true); // the fake never exits, so the drain times out
  });

  it("stop() resolves without force-killing when the core drains in time", async () => {
    const child = new FakeChild();
    const pending = startEmbeddedServer(fakeMainDir, NO_RESOURCES, {
      fork: forkFake(child),
      signal: () => child.exit(0),
      drainTimeoutMs: 1_000,
    });
    child.say('{"type":"ready","url":"http://127.0.0.1:5051"}\n');
    const srv = await pending;

    await srv.stop();
    expect(child.killed).toBe(false);
  });

  // The production fork is Electron's utilityProcess, which can't run under vitest.
  // Spawning the same entry on plain node exercises the identical handshake, and is
  // the seam a future "ship our own node binary" build would reuse verbatim.
  it("starts the real core out-of-process and serves the UI, then stops cleanly", async () => {
    const fork: ForkCore = (entry, env) =>
      spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "pipe"], env }) as unknown as CoreChild;

    const srv = await startEmbeddedServer(fakeMainDir, NO_RESOURCES, { fork });
    try {
      expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${srv.url}/`);
      expect(res.status).toBe(200);
      expect((await res.text()).toLowerCase()).toContain("<!doctype html");
    } finally {
      await srv.stop();
    }
    await expect(fetch(`${srv.url}/`)).rejects.toThrow(); // the port is really gone
  }, 60_000);
});
