import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemMeta } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const gem: Gem = {
  name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }],
};

describe("archive dependencies + readGemMeta", () => {
  it("records dependencies in the manifest and reads them back", () => {
    const { files } = writeGemArchive(gem, { version: "1.2.0", dependencies: ["@acme/http-base@^1.0.0"] });
    const meta = readGemMeta(files);
    expect(meta).toEqual({
      name: "github-search",
      version: "1.2.0",
      dependencies: ["@acme/http-base@^1.0.0"],
      gemDigest: expect.stringMatching(/^sha256:[0-9a-f]+$/),
    });
  });
  it("defaults dependencies to [] when absent (backward-compatible)", () => {
    const { files } = writeGemArchive(gem, { version: "0.1.0" });
    expect(readGemMeta(files).dependencies).toEqual([]);
  });
});
