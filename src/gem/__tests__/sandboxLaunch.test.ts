// src/gem/__tests__/sandboxLaunch.test.ts
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { seatbeltPolicy, bwrapArgs, wrapWithSandbox } from "@agentgem/run";

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

describe("seatbeltPolicy extra writable", () => {
  it("re-allows writes under extra subpaths (e.g. the agent's isolated home)", () => {
    const home = "/home/.agentgem/sandbox-homes/g";
    const p = seatbeltPolicy("/runs/g", "/tmp", [home]);
    expect(p).toContain(`(subpath "${home}")`);
    expect(p.indexOf("(deny file-write*)")).toBeLessThan(p.indexOf(`(subpath "${home}")`));
  });
});

describe("seatbeltPolicy denied", () => {
  it("appends a deny block AFTER the allow so denied paths lose write access (last match wins)", () => {
    const denied = "/home/.claude/settings.json";
    const p = seatbeltPolicy("/runs/g", "/tmp", ["/home/.claude"], [{ path: denied, kind: "file" }]);
    expect(p).toContain(`(subpath "${denied}")`);
    // the denied entry's LAST occurrence must be inside a deny block that follows the allow block
    expect(p.indexOf("(allow file-write*")).toBeLessThan(p.lastIndexOf("(deny file-write*"));
    expect(p.lastIndexOf("(deny file-write*")).toBeLessThan(p.lastIndexOf(`(subpath "${denied}")`));
  });
  it("emits no deny block when there are no denied paths", () => {
    const p = seatbeltPolicy("/runs/g", "/tmp", ["/home/.claude"], []);
    // only the single blanket (deny file-write*) — no trailing path-specific deny block
    expect(p.match(/\(deny file-write\*/g)?.length).toBe(1);
  });
});

describe("bwrapArgs", () => {
  it("read-only-binds the root and writable-binds only runDir + tmp", () => {
    const a = bwrapArgs("/runs/g", "/tmp");
    expect(a).toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
    // run dir doesn't exist -> realpath falls back to the original
    const i = a.indexOf("--bind");
    expect(a.slice(i, i + 3)).toEqual(["--bind", "/runs/g", "/runs/g"]);
    // tmp bind: /tmp resolves to /private/tmp on macOS, stays /tmp on Linux; src === dest
    const j = a.indexOf("--bind", i + 1);
    expect(["/tmp", "/private/tmp"]).toContain(a[j + 1]);
    expect(a[j + 2]).toBe(a[j + 1]);
    // own PID namespace, with a fresh procfs mounted AFTER --unshare-pid
    expect(a).toContain("--unshare-pid");
    expect(a.indexOf("--unshare-pid")).toBeLessThan(a.indexOf("--proc"));
    expect(a).toContain("--die-with-parent");
  });
});

describe("bwrapArgs extra writable", () => {
  it("writable-binds extra paths (e.g. the agent's isolated home)", () => {
    const home = "/home/.agentgem/sandbox-homes/g";
    const a = bwrapArgs("/runs/g", "/tmp", [home]);
    // find a --bind whose src===dest===home
    let found = false;
    for (let k = a.indexOf("--bind"); k >= 0; k = a.indexOf("--bind", k + 1)) {
      if (a[k + 1] === home && a[k + 2] === home) { found = true; break; }
    }
    expect(found).toBe(true);
  });
});

describe("bwrapArgs denied", () => {
  it("without masks, falls back to --ro-bind-try AFTER the writable binds (best-effort)", () => {
    const home = "/home/.claude";
    const denied = "/home/.claude/settings.json";   // absent on this host
    const a = bwrapArgs("/runs/g", "/tmp", [home], [{ path: denied, kind: "file" }]);
    const rwIdx = a.findIndex((x, i) => x === "--bind" && a[i + 1] === home);
    const roIdx = a.findIndex((x, i) => x === "--ro-bind-try" && a[i + 1] === denied && a[i + 2] === denied);
    expect(rwIdx).toBeGreaterThanOrEqual(0);
    expect(roIdx).toBeGreaterThan(rwIdx);
  });

  it("masks an ABSENT denied FILE with a read-only bind of the file placeholder (no --try, so it can't be skipped)", () => {
    const denied = "/home/.claude/settings.json";   // absent
    const masks = { file: "/masks/empty.json", dir: "/masks/empty" };
    const a = bwrapArgs("/runs/g", "/tmp", ["/home/.claude"], [{ path: denied, kind: "file" }], masks);
    // placeholder file mounted RO at the denied dest; NOT a --ro-bind-try
    const idx = a.findIndex((x, i) => x === "--ro-bind" && a[i + 1] === masks.file && a[i + 2] === denied);
    expect(idx).toBeGreaterThan(0);
    expect(a).not.toContain("--ro-bind-try");
  });

  it("masks an ABSENT denied DIR with the dir placeholder", () => {
    const denied = "/home/.claude/skills";          // absent
    const masks = { file: "/masks/empty.json", dir: "/masks/empty" };
    const a = bwrapArgs("/runs/g", "/tmp", ["/home/.claude"], [{ path: denied, kind: "dir" }], masks);
    const idx = a.findIndex((x, i) => x === "--ro-bind" && a[i + 1] === masks.dir && a[i + 2] === denied);
    expect(idx).toBeGreaterThan(0);
  });

  it("read-only-binds an EXISTING denied path to ITSELF (real, readable, not writable) — not the placeholder", () => {
    const real = realpathSync(tmpdir());   // exists → resolved
    const masks = { file: "/masks/empty.json", dir: "/masks/empty" };
    const a = bwrapArgs("/runs/g", "/tmp", ["/home/.claude"], [{ path: real, kind: "dir" }], masks);
    const idx = a.findIndex((x, i) => x === "--ro-bind" && a[i + 1] === real && a[i + 2] === real);
    expect(idx).toBeGreaterThan(0);
    expect(a).not.toContain(masks.dir);
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

  it("threads extra writable paths into the seatbelt policy", () => {
    const home = "/home/.agentgem/sandbox-homes/g";
    const cmd = wrapWithSandbox("macos-seatbelt", "/runs/g", ["claude-agent-acp"], [home]);
    expect(cmd[2]).toContain(`(subpath "${home}")`);
  });

  it("threads extra writable paths into the bwrap binds", () => {
    const home = "/home/.agentgem/sandbox-homes/g";
    const cmd = wrapWithSandbox("linux-bubblewrap", "/runs/g", ["claude-agent-acp"], [home]);
    expect(cmd).toEqual(expect.arrayContaining(["--bind", home, home]));
  });

  it("threads denied paths into the seatbelt policy", () => {
    const denied = "/home/.claude/settings.json";
    const cmd = wrapWithSandbox("macos-seatbelt", "/runs/g", ["claude-agent-acp"], ["/home/.claude"], [{ path: denied, kind: "file" }]);
    expect(cmd[2]).toContain(`(subpath "${denied}")`);
    expect(cmd[2].lastIndexOf("(deny file-write*")).toBeLessThan(cmd[2].lastIndexOf(`(subpath "${denied}")`));
  });

  it("threads denied paths + masks into the bwrap ro-binds", () => {
    const denied = "/home/.claude/settings.json";   // absent → masked
    const masks = { file: "/masks/empty.json", dir: "/masks/empty" };
    const cmd = wrapWithSandbox("linux-bubblewrap", "/runs/g", ["claude-agent-acp"], ["/home/.claude"], [{ path: denied, kind: "file" }], masks);
    expect(cmd).toEqual(expect.arrayContaining(["--ro-bind", masks.file, denied]));
  });
});
