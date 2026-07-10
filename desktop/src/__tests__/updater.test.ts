import { describe, it, expect, vi } from "vitest";
import { updaterFeed, repoUrlFromPackageJson, configureUpdater } from "../updater.js";

// A fake standing in for electron-updater's AppUpdater: `on` records listeners, and
// checkForUpdatesAndNotify resolves or rejects on demand.
function fakeUpdater(check: () => Promise<unknown>) {
  const listeners = new Map<string, (...args: any[]) => void>();
  return {
    autoDownload: false,
    on(event: string, cb: (...args: any[]) => void) {
      listeners.set(event, cb);
    },
    checkForUpdatesAndNotify: check,
    listeners,
  };
}

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

describe("configureUpdater", () => {
  const handlers = () => ({ onAvailable: vi.fn(), onDownloaded: vi.fn(), onError: vi.fn() });

  it("subscribes to error alongside available/downloaded, and auto-downloads", () => {
    const u = fakeUpdater(() => Promise.resolve(null));
    configureUpdater(u, handlers());
    expect(u.autoDownload).toBe(true);
    expect([...u.listeners.keys()].sort()).toEqual(["error", "update-available", "update-downloaded"]);
  });

  it("reports a failed check through onError rather than swallowing it", () => {
    const u = fakeUpdater(() => Promise.resolve(null));
    const h = handlers();
    configureUpdater(u, h);
    const err = new Error("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND");
    u.listeners.get("error")!(err);
    expect(h.onError).toHaveBeenCalledWith(err);
  });

  // A missing latest*.yml rejects the promise as well as emitting "error". Leaving that
  // rejection unhandled is what makes the main process noisy (or fatal) on a bad release.
  it("does not leave a rejected check as an unhandled rejection", async () => {
    const u = fakeUpdater(() => Promise.reject(new Error("404")));
    expect(() => configureUpdater(u, handlers())).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});
