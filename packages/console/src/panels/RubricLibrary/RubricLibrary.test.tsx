import { describe, it, expect, beforeEach } from "vitest";
import { getKeys, setKeys, resetGem } from "../../activeGem.js";
import { selKey } from "../Curate/selection.js";
import { bundleRubric } from "./index.js";

describe("bundleRubric", () => {
  beforeEach(() => resetGem());
  it("adds the rubric's selection key (additive) and targets curate", () => {
    setKeys(new Set([selKey("skills", "existing")]));
    const hash = bundleRubric("team-hygiene");
    expect(getKeys().has(selKey("rubrics", "team-hygiene"))).toBe(true);
    expect(getKeys().has(selKey("skills", "existing"))).toBe(true); // additive, not replace
    expect(hash).toBe("#/curate");
  });
});
