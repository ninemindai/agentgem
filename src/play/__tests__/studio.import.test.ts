// src/play/__tests__/studio.import.test.ts
// importStudio must declare the GATED capabilities the imported html already uses, so the miniapp works
// before its first Save — but must NOT auto-declare AUTO caps (session-data), which bypass the consent
// prompt and would otherwise let imported html read the viewer's sessions silently.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStudio, miniappDir } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-import-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const readNeeds = (name: string): string[] | undefined =>
  JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8")).needs;

describe("importStudio capability declaration", () => {
  it("declares a gated capability the imported html uses (open-link)", async () => {
    const html = `<!doctype html><body><a id="cta">go</a><script>document.getElementById("cta").onclick=function(){window.agentgemApp.openLink("https://ninemind.ai");};</script></body>`;
    const { name } = await importStudio("site", html);
    expect(readNeeds(name)).toEqual(["open-link"]);
  });

  it("does NOT auto-declare an AUTO capability (session-data) — that stays an explicit Save", async () => {
    const html = `<!doctype html><body><script>window.agentgemApp.onNotification("ui/notifications/tool-result",function(p){if(p.toolName==="agentgem_get_session_data"){}});</script></body>`;
    const { name } = await importStudio("replay", html);
    expect(readNeeds(name)).toBeUndefined(); // session-data used but not declared → host stays unwired until Save
  });

  it("declares only the gated caps when html mixes gated + auto", async () => {
    const html = `<!doctype html><body><script>window.agentgemApp.openLink("https://x");var t="agentgem_get_session_data";</script></body>`;
    const { name } = await importStudio("mixed", html);
    expect(readNeeds(name)).toEqual(["open-link"]);
  });

  it("declares no needs for capability-free html", async () => {
    const { name } = await importStudio("plain", `<!doctype html><body><script>const x=1;</script></body>`);
    expect(readNeeds(name)).toBeUndefined();
  });
});
