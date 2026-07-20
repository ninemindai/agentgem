import { describe, it, expect } from "vitest";
import { GemManifestSchema, GemSchema } from "@agentgem/app/schemas";

// The contract facet is archived (it rides the manifest), and a shared gem must carry it —
// so, like the loop facet, it must survive the Zod schemas that gate the transfer ticket and
// the /scorecard/build response, not be silently stripped as an unknown key.
const contract = { task: "run qa", expect: { tools: ["qa"], text: "ok", forbidToolFailures: true } };

describe("contract facet survives the schema boundary", () => {
  it("GemManifestSchema preserves a contract instead of stripping it", () => {
    const manifest = {
      formatVersion: 1, name: "c-gem", version: "0.1.0", createdFrom: "test",
      artifacts: [], requiredSecrets: [], checks: [], contract,
    };
    expect(GemManifestSchema.parse(manifest).contract).toEqual(contract);
  });

  it("GemSchema preserves a contract instead of stripping it", () => {
    const gem = {
      name: "c-gem", createdFrom: "test", artifacts: [], checks: [], requiredSecrets: [], contract,
    };
    expect(GemSchema.parse(gem).contract).toEqual(contract);
  });
});
