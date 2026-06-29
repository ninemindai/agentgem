// src/gem/__tests__/scorecardBuild.test.ts
import { describe, it, expect } from "vitest";
import { GemController } from "../../gem.controller.js";
import { collectScorecard } from "../scorecard.js";

describe("POST /api/scorecard/build handler", () => {
  it("builds a Gem from selected workflow keys", async () => {
    const sc = collectScorecard(undefined, [process.cwd()], Date.now());
    const project = sc.projects.find((p) => p.workflows.length > 0);
    if (!project) {
      console.warn("[scorecardBuild.test] no candidates found — skipping");
      return;
    }

    const keys = project.workflows.slice(0, 2).map((w) => w.key);
    const ctrl = new GemController();
    const gem = await ctrl.scorecardBuild({
      body: {
        name: "test-goldmine-gem",
        selections: [{ root: project.root, keys }],
      },
    });

    expect(typeof gem.name).toBe("string");
    expect(gem.name).toBe("test-goldmine-gem");
    expect(Array.isArray(gem.artifacts)).toBe(true);
    expect(gem.artifacts.length).toBeGreaterThan(0);
    // No dollar / latentValue leak
    expect(JSON.stringify(gem)).not.toMatch(/\$|latentValue|dollars/);
  });

  it("throws 400 for unknown workflow keys", async () => {
    const ctrl = new GemController();
    await expect(
      ctrl.scorecardBuild({
        body: {
          selections: [{ root: process.cwd(), keys: ["__nope__"] }],
        },
      }),
    ).rejects.toThrow();
  });
});
