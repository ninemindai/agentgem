// src/gem/__tests__/sandboxLaunch.test.ts
import { describe, it, expect } from "vitest";
import { seatbeltPolicy, bwrapArgs, wrapWithSandbox } from "../sandboxLaunch.js";

describe("seatbeltPolicy", () => {
  it("allows by default, denies writes, re-allows writes under runDir + tmp", () => {
    const p = seatbeltPolicy("/runs/g", "/tmp");
    expect(p).toContain("(allow default)");
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain('(subpath "/runs/g")');
    // /tmp on macOS resolves to /private/tmp via symlink; accept either form.
    expect(p.includes('(subpath "/tmp")') || p.includes('(subpath "/private/tmp")')).toBe(true);
    // write-allow must come AFTER the blanket deny so it wins
    expect(p.indexOf("(deny file-write*)")).toBeLessThan(p.indexOf('(subpath "/runs/g")'));
    expect(p.indexOf("(deny file-write*)")).toBeLessThan(p.indexOf("(allow file-write*"));
  });
});

describe("bwrapArgs", () => {
  it("read-only-binds the root and writable-binds only runDir + tmp", () => {
    const a = bwrapArgs("/runs/g", "/tmp");
    expect(a).toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
    // writable bind for the run dir
    const i = a.indexOf("--bind");
    expect(a.slice(i, i + 3)).toEqual(["--bind", "/runs/g", "/runs/g"]);
    const j = a.indexOf("--bind", i + 1);
    expect(a.slice(j, j + 3)).toEqual(["--bind", "/tmp", "/tmp"]);
    expect(a).toContain("--die-with-parent");
  });
});

describe("wrapWithSandbox", () => {
  it("prepends sandbox-exec -p <policy> for seatbelt", () => {
    const cmd = wrapWithSandbox("macos-seatbelt", "/runs/g", ["claude-agent-acp", "--x"]);
    expect(cmd[0]).toBe("sandbox-exec");
    expect(cmd[1]).toBe("-p");
    expect(cmd[2]).toContain("(deny file-write*)");
    expect(cmd.slice(3)).toEqual(["claude-agent-acp", "--x"]);
  });

  it("prepends bwrap … -- for bubblewrap", () => {
    const cmd = wrapWithSandbox("linux-bubblewrap", "/runs/g", ["claude-agent-acp"]);
    expect(cmd[0]).toBe("bwrap");
    const sep = cmd.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(cmd.slice(sep + 1)).toEqual(["claude-agent-acp"]);
  });
});
