// src/play/__tests__/readMiniapp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp, miniappDir, MCP_CLIENT_MARKER } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "T", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };

describe("readMiniapp", () => {
  it("returns the html + meta for a saved miniapp", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const r = readMiniapp("g1");
    expect(r.name).toBe("g1");
    expect(r.html).toContain("canvas");
    expect(r.meta.title).toBe("T");
  });
  it("throws for an unknown miniapp", () => { expect(() => readMiniapp("nope")).toThrow(); });

  // The studio agent rewrites index.html wholesale and drops the <head> the scaffold shipped, so html
  // that calls the bridge reaches saveMiniapp with nothing that defines it. The stored bytes must carry
  // the transport, or the host attaches (meta declares needs) to a frame that can never answer.
  it("stores the host bridge for a bundle that calls it but arrived without the shim", async () => {
    const html = `<!doctype html><html><head><title>t</title></head><body><canvas></canvas><script>
      (async function () { const inv = await window.agentgemApp.callTool("agentgem_get_inventory", {}); })();
    </script></body></html>`;
    await saveMiniapp({ name: "g2", html, meta: { ...meta, needs: ["local-project-access"] } });

    const stored = readFileSync(join(miniappDir("g2"), "index.html"), "utf8");
    expect(stored).toContain(MCP_CLIENT_MARKER);
    expect(readMiniapp("g2").meta.needs).toEqual(["local-project-access"]);
  });

  // A sealed bundle that talks to no host needs no transport — injecting one would be noise.
  it("leaves a bundle that never touches the bridge untouched", async () => {
    await saveMiniapp({ name: "g3", html: "<!doctype html><body><canvas></canvas></body>", meta });
    expect(readMiniapp("g3").html).not.toContain(MCP_CLIENT_MARKER);
  });
});
