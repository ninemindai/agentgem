// src/play/__tests__/migrateMiniapps.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp, migrateAllMiniapps, miniappDir, scaffoldFor, MCP_CLIENT_MARKER } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const oldBridgeHtml = scaffoldFor("replay"); // baked with the OLD private postMessage bridge
const meta = {
  title: "Old Replay", genre: "replay" as const,
  createdFrom: { kind: "session" as const, agent: "claude", sessionId: "s1", summary: "a replay" },
  engineVersion: "1",
};

describe("migrateAllMiniapps", () => {
  it("rewrites the stored file, bumps engineVersion, and reports migrated; a second run reports already", async () => {
    await saveMiniapp({ name: "old-replay", html: oldBridgeHtml, meta });

    const first = await migrateAllMiniapps();
    const entry = first.find((r) => r.name === "old-replay");
    expect(entry?.outcome).toBe("migrated");
    expect(entry?.commit).toMatch(/^[0-9a-f]{7,40}$/);

    const storedHtml = readFileSync(join(miniappDir("old-replay"), "old-replay.html"), "utf8");
    expect(storedHtml).toContain(MCP_CLIENT_MARKER);
    const storedMeta = JSON.parse(readFileSync(join(miniappDir("old-replay"), "meta.json"), "utf8")) as { engineVersion: string };
    expect(storedMeta.engineVersion).not.toBe("1");

    const second = await migrateAllMiniapps();
    const entry2 = second.find((r) => r.name === "old-replay");
    expect(entry2?.outcome).toBe("already");
    expect(entry2?.commit).toBeNull();
  });

  it("leaves an already-current miniapp alone (no write, reported already/unrecognized)", async () => {
    await saveMiniapp({ name: "fresh", html: "<!doctype html><body><canvas></canvas></body>", meta: { ...meta, genre: "project-fun" } });
    const results = await migrateAllMiniapps();
    const entry = results.find((r) => r.name === "fresh");
    expect(entry?.outcome).toBe("unrecognized");
    expect(entry?.commit).toBeNull();
  });
});

describe("readMiniapp on-read backstop", () => {
  it("returns migrated html even before migrateAllMiniapps runs, while the stored file stays raw", async () => {
    await saveMiniapp({ name: "backstop", html: oldBridgeHtml, meta });

    const stored = readFileSync(join(miniappDir("backstop"), "backstop.html"), "utf8");
    expect(stored).not.toContain(MCP_CLIENT_MARKER); // file untouched

    const read = readMiniapp("backstop");
    expect(read.html).toContain(MCP_CLIENT_MARKER); // but the read is migrated
    expect(read.html).not.toContain("agentgem:request");
  });
});
