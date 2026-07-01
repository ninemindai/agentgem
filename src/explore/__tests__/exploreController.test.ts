import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExploreController } from "../../explore.controller.js";
import { writeBinding } from "../bindingFile.js";

describe("ExploreController.identity", () => {
  const prev = process.env.AGENTGEM_HOME;
  afterEach(() => { process.env.AGENTGEM_HOME = prev; });

  it("reports connected when a binding file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "aghome-"));
    process.env.AGENTGEM_HOME = dir;
    writeBinding({ provider: "github", login: "octocat", accountId: "42", boundAt: "t" }, dir);
    const c = new ExploreController();
    expect(c.identity()).toEqual({ connected: true, login: "octocat" });
  });

  it("reports not connected when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "aghome-"));
    process.env.AGENTGEM_HOME = dir;
    const c = new ExploreController();
    expect(c.identity()).toEqual({ connected: false });
  });
});
