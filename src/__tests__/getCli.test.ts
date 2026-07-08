// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGetArgs, runGetCommand } from "../getCli.js";
import { exportGem } from "@agentgem/distribute";
import { listWorkspaces } from "@agentgem/base";
import type { Gem } from "@agentgem/model";

const skillGem: Gem = {
  name: "auth-hunt", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\n" }],
};
const execGem: Gem = {
  name: "danger", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
  artifacts: [{ type: "hook", name: "preflight", event: "PreToolUse", config: { command: "echo hi" } }],
};
const bytesOf = (g: Gem, version: string) => async () => exportGem(g, { version }).bytes;

describe("parseGetArgs", () => {
  it("parses a plain key with no version", () => {
    expect(parseGetArgs(["raymondfeng/agentgem-biz"])).toMatchObject({ key: "raymondfeng/agentgem-biz", version: undefined, yes: false });
  });
  it("splits <key>@<version>", () => {
    expect(parseGetArgs(["raymondfeng/agentgem-biz@0.1.0"])).toMatchObject({ key: "raymondfeng/agentgem-biz", version: "0.1.0" });
  });
  it("keeps a leading @scope and only splits a version after position 0", () => {
    expect(parseGetArgs(["@octocat/kit@1.2.3"])).toMatchObject({ key: "@octocat/kit", version: "1.2.3" });
    expect(parseGetArgs(["@octocat/kit"])).toMatchObject({ key: "@octocat/kit", version: undefined });
  });
  it("reads --version and --yes/-y", () => {
    expect(parseGetArgs(["k", "--version", "2.0.0"])).toMatchObject({ key: "k", version: "2.0.0" });
    expect(parseGetArgs(["k", "-y"]).yes).toBe(true);
    expect(parseGetArgs(["k", "--yes"]).yes).toBe(true);
  });
});

describe("runGetCommand", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; vi.restoreAllMocks(); });

  it("imports a pinned gem into a local workspace and returns 0", async () => {
    const code = await runGetCommand(["raymondfeng/agentgem-biz@0.1.0"], { fetchArchive: bytesOf(skillGem, "0.1.0") });
    expect(code).toBe(0);
    const ws = listWorkspaces();
    expect(ws.map((w) => w.name)).toContain("raymondfeng-agentgem-biz");
  });

  it("resolves the latest version from the registry when none is pinned", async () => {
    const http = async () => ({ status: 200, json: async () => ({ gems: [{ key: "acme/kit", version: "1.0.0" }, { key: "acme/kit", version: "1.2.0" }] }) });
    const fetchArchive = vi.fn(bytesOf(skillGem, "1.2.0"));
    const code = await runGetCommand(["acme/kit"], { http: http as never, fetchArchive });
    expect(code).toBe(0);
    expect(fetchArchive).toHaveBeenCalledWith(expect.objectContaining({ version: "1.2.0" }));
  });

  it("refuses a gem with executable artifacts unless --yes, and imports it with --yes", async () => {
    const denied = await runGetCommand(["danger@1.0.0"], { fetchArchive: bytesOf(execGem, "1.0.0") });
    expect(denied).toBe(1);
    expect(listWorkspaces()).toHaveLength(0);
    const allowed = await runGetCommand(["danger@1.0.0", "--yes"], { fetchArchive: bytesOf(execGem, "1.0.0") });
    expect(allowed).toBe(0);
    expect(listWorkspaces().map((w) => w.name)).toContain("danger");
  });

  it("returns 1 with a message when the fetch fails", async () => {
    const code = await runGetCommand(["nope@1.0.0"], { fetchArchive: async () => { throw new Error("that gem is not available for install (no uploaded archive)"); } });
    expect(code).toBe(1);
  });
});
