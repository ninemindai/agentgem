// src/gem/__tests__/share.test.ts
import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { exportGem, importGem } from "@agentgem/distribute";
import { packTar, unpackTar } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const demoGem: Gem = {
  name: "github-search",
  createdFrom: "/tmp/.claude",
  checks: [],
  requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\nFind things.\n" }],
};

describe("exportGem", () => {
  it("produces a single .gem buffer named <name>-<version>.gem", () => {
    const out = exportGem(demoGem, { version: "1.2.0" });
    expect(out.filename).toBe("github-search-1.2.0.gem");
    expect(out.bytes[0]).toBe(0x1f); // gzip magic
    expect(out.bytes[1]).toBe(0x8b);
  });

  it("defaults the version when none is given", () => {
    expect(exportGem(demoGem).filename).toBe("github-search-0.1.0.gem");
  });

  it("embeds a verifiable archive (gem.json + gem.lock) inside the .gem", () => {
    const files = unpackTar(exportGem(demoGem).bytes);
    expect(files["gem.json"]).toBeDefined();
    expect(files["gem.lock"]).toBeDefined();
    expect(files["skills/search/SKILL.md"]).toContain("Find things.");
  });
});

describe("importGem", () => {
  it("round-trips: a shared .gem installs back to an equal Gem", () => {
    const { bytes } = exportGem(demoGem, { version: "1.2.0" });
    const { gem, meta } = importGem(bytes);
    expect(gem).toEqual(demoGem);
    expect(meta).toMatchObject({ name: "github-search", version: "1.2.0" });
  });

  it("rejects a tampered .gem (lock verification fails)", () => {
    const files = unpackTar(exportGem(demoGem).bytes);
    files["skills/search/SKILL.md"] = "# Search\nMALICIOUS PAYLOAD\n"; // mutate without re-locking
    const tampered = packTar(files);
    expect(() => importGem(tampered)).toThrow(/verification failed/i);
  });

  it("rejects bytes that are not a valid .gem", () => {
    expect(() => importGem(gzipSync(Buffer.from("not a tar")))).toThrow();
  });
});
