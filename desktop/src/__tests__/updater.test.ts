import { describe, it, expect, vi } from "vitest";
import { updaterFeed, repoUrlFromPackageJson, createUpdateController } from "../updater.js";

// A fake standing in for electron-updater's AppUpdater: `on` records listeners,
// `emit` fires one, and checkForUpdates resolves or rejects on demand.
function fakeUpdater(check: () => Promise<unknown> = () => Promise.resolve(null)) {
  const listeners = new Map<string, (...args: any[]) => void>();
  return {
    autoDownload: false,
    on(event: string, cb: (...args: any[]) => void) {
      listeners.set(event, cb);
    },
    checkForUpdates: vi.fn(check),
    emit(event: string, ...args: any[]) {
      listeners.get(event)?.(...args);
    },
    listeners,
  };
}

const fakeSurface = () => ({
  upToDate: vi.fn(),
  downloading: vi.fn(),
  ready: vi.fn(),
  failed: vi.fn(),
});

describe("updaterFeed", () => {
  it("parses an https git url", () => {
    expect(updaterFeed("git+https://github.com/ninemindai/agentgem.git")).toEqual({
      provider: "github",
      owner: "ninemindai",
      repo: "agentgem",
    });
  });
  it("parses an ssh url", () => {
    expect(updaterFeed("git@github.com:ninemindai/agentgem.git")).toEqual({
      provider: "github",
      owner: "ninemindai",
      repo: "agentgem",
    });
  });
  it("throws on a non-github url", () => {
    expect(() => updaterFeed("https://gitlab.com/x/y.git")).toThrow(/github/i);
  });
});

describe("repoUrlFromPackageJson", () => {
  it("reads the object form { url }", () => {
    expect(
      repoUrlFromPackageJson({ repository: { url: "git+https://github.com/ninemindai/agentgem.git" } }),
    ).toBe("git+https://github.com/ninemindai/agentgem.git");
  });
  it("reads the bare string form", () => {
    expect(repoUrlFromPackageJson({ repository: "ninemindai/agentgem" })).toBe("ninemindai/agentgem");
  });
  it("throws when repository is missing", () => {
    expect(() => repoUrlFromPackageJson({})).toThrow(/repository/i);
  });
  it("feeds updaterFeed end-to-end from the object form", () => {
    const pkg = { repository: { url: "git+https://github.com/ninemindai/agentgem.git" } };
    expect(updaterFeed(repoUrlFromPackageJson(pkg))).toEqual({
      provider: "github",
      owner: "ninemindai",
      repo: "agentgem",
    });
  });
});

describe("createUpdateController", () => {
  it("subscribes to the four lifecycle events and auto-downloads", () => {
    const u = fakeUpdater();
    createUpdateController(u, fakeSurface());
    expect(u.autoDownload).toBe(true);
    expect([...u.listeners.keys()].sort()).toEqual([
      "error",
      "update-available",
      "update-downloaded",
      "update-not-available",
    ]);
  });

  it("a manual check surfaces up-to-date and downloading; a background check stays silent", () => {
    const u = fakeUpdater();
    const s = fakeSurface();
    const c = createUpdateController(u, s);

    c.check({ manual: true });
    u.emit("update-not-available", { version: "0.5.0" });
    expect(s.upToDate).toHaveBeenCalledWith("0.5.0");

    c.check({ manual: true });
    u.emit("update-available", { version: "0.6.0" });
    expect(s.downloading).toHaveBeenCalledWith("0.6.0");
    u.emit("update-downloaded", { version: "0.6.0" }); // terminal — closes out the manual check

    // Background (no manual flag): neither dialog fires.
    s.upToDate.mockClear();
    s.downloading.mockClear();
    c.check();
    u.emit("update-available", { version: "0.7.0" });
    u.emit("update-not-available", { version: "0.6.0" });
    expect(s.downloading).not.toHaveBeenCalled();
    expect(s.upToDate).not.toHaveBeenCalled();
  });

  it("always prompts to restart when an update finishes downloading, manual or not", () => {
    const u = fakeUpdater();
    const s = fakeSurface();
    const c = createUpdateController(u, s);

    c.check(); // background
    u.emit("update-downloaded", { version: "0.6.0" });
    expect(s.ready).toHaveBeenCalledWith("0.6.0");
  });

  it("surfaces a manual check failure but keeps a background failure silent", () => {
    const u = fakeUpdater();
    const s = fakeSurface();
    const c = createUpdateController(u, s);
    const err = new Error("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");

    c.check({ manual: true });
    u.emit("error", err);
    expect(s.failed).toHaveBeenCalledWith(err);

    s.failed.mockClear();
    c.check(); // background
    u.emit("error", err);
    expect(s.failed).not.toHaveBeenCalled();
  });

  it("ignores an overlapping check until the in-flight one resolves", () => {
    const u = fakeUpdater();
    const c = createUpdateController(u, fakeSurface());
    c.check({ manual: true });
    c.check({ manual: true }); // still in flight — ignored
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    u.emit("update-not-available", { version: "0.5.0" }); // resolves the check
    c.check({ manual: true });
    expect(u.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  // A missing latest*.yml rejects the promise as well as emitting "error". Leaving that
  // rejection unhandled is what makes the main process noisy (or fatal) on a bad release.
  it("does not leave a rejected check as an unhandled rejection", async () => {
    const u = fakeUpdater(() => Promise.reject(new Error("404")));
    const c = createUpdateController(u, fakeSurface());
    expect(() => c.check({ manual: true })).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
