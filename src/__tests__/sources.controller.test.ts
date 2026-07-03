// src/__tests__/sources.controller.test.ts
import { describe, it, expect } from "vitest";
import { InvalidInputError } from "@agentgem/model";
import { CURATED_SOURCES } from "@agentgem/distribute";
import { SourcesController } from "../sources.controller.js";

// Network-backed happy paths (divisions/agents/agent/import) are covered at the adapter layer
// (agencyAgents.test.ts, with an injected fake Http). Here we exercise the controller's own
// logic: the curated list and the input-containment guards — none of which touch the network.
const c = new SourcesController();

describe("SourcesController.list", () => {
  it("returns the curated sources verbatim", async () => {
    const { sources } = await c.list();
    expect(sources).toEqual(CURATED_SOURCES);
    expect(sources.some((s) => s.id === "agency-agents")).toBe(true);
  });
});

describe("unknown source is rejected", () => {
  it("divisions", async () => {
    await expect(c.divisions({ query: { source: "nope" } })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it("agents", async () => {
    await expect(c.agents({ query: { source: "nope", division: "engineering" } })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it("import", async () => {
    await expect(c.import({ body: { source: "nope", path: "engineering/x.md" } })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it("importGet (the GET variant, reachable cross-origin)", async () => {
    await expect(c.importGet({ query: { source: "nope", path: "engineering/x.md" } })).rejects.toBeInstanceOf(InvalidInputError);
  });
  it("install", async () => {
    await expect(c.install({ body: { source: "nope", path: "engineering/x.md" } })).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("input containment guards (checked before any fetch)", () => {
  const source = "agency-agents";

  it("rejects a traversal path on import", async () => {
    await expect(c.import({ body: { source, path: "../../etc/passwd" } })).rejects.toThrow(/Invalid agent path/);
  });
  it("rejects a traversal path on importGet", async () => {
    await expect(c.importGet({ query: { source, path: "../../etc/passwd" } })).rejects.toThrow(/Invalid agent path/);
  });
  it("rejects a traversal path on install (before any fetch or write)", async () => {
    await expect(c.install({ body: { source, path: "../../etc/passwd" } })).rejects.toThrow(/Invalid agent path/);
  });
  it("rejects a non-.md or non-division-scoped path", async () => {
    await expect(c.agent({ query: { source, path: "README.md" } })).rejects.toThrow(/Invalid agent path/);
    await expect(c.agent({ query: { source, path: "engineering/sub/dir/x.md" } })).rejects.toThrow(/Invalid agent path/);
  });
  it("rejects a division with illegal characters", async () => {
    await expect(c.agents({ query: { source, division: "../secrets" } })).rejects.toThrow(/Invalid division/);
    await expect(c.agents({ query: { source, division: "Engineering!" } })).rejects.toThrow(/Invalid division/);
  });
});
