import { describe, it, expect } from "vitest";
import { updaterFeed, repoUrlFromPackageJson } from "../updater.js";

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
