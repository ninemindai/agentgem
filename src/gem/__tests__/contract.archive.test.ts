import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, computeLock } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const base: Gem = {
  name: "c-gem",
  createdFrom: "test",
  artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
  checks: [],
  requiredSecrets: [],
};

describe("archive round-trip of the contract", () => {
  it("preserves a contract through write → read", () => {
    const gem: Gem = { ...base, contract: { task: "run qa", expect: { tools: ["qa"], forbidToolFailures: true } } };
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["gem.json"]).contract.task).toBe("run qa");
    expect(readGemArchive(files).contract).toEqual(gem.contract);
  });

  it("a gem without a contract reads back without one", () => {
    const { files } = writeGemArchive(base);
    expect("contract" in JSON.parse(files["gem.json"])).toBe(false);
    expect(readGemArchive(files).contract).toBeUndefined();
  });

  it("treats a malformed manifest contract as absent (tolerant reader)", () => {
    const { files } = writeGemArchive(base);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.contract = { task: 42, expect: { tools: "not-an-array" } }; // wrong shapes
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2); // keep the lock honest
    expect(readGemArchive(files).contract).toBeUndefined();
  });

  it("keeps a valid task but drops only the invalid expect fields", () => {
    const { files } = writeGemArchive(base);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.contract = { task: "ok", expect: { tools: "nope", text: "hello" } };
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2);
    expect(readGemArchive(files).contract).toEqual({ task: "ok", expect: { text: "hello" } });
  });
});
