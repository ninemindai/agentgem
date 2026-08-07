// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import AjvImport from "ajv/dist/2020.js";
import { writeGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";
import { pluginSchema, mcpSchema } from "./fixtures/agentPluginSchemas.js";

// CJS/ESM interop: under node ESM the class may arrive as the module or as .default.
const Ajv = ((AjvImport as unknown as { default?: unknown }).default ?? AjvImport) as new (o: object) => {
  compile(s: object): ((d: unknown) => boolean) & { errors?: unknown };
};

const gem: Gem = {
  name: "Conformance Gem", createdFrom: "unit test", checks: [], requiredSecrets: [],
  artifacts: [
    { type: "skill", name: "summarize", source: "standalone", content: "# S" },
    { type: "mcp_server", name: "db", transport: "stdio", config: { command: "npx", args: ["db-mcp"], env: { MODE: "ro" }, cwd: "./cfg" } },
    { type: "mcp_server", name: "api", transport: "http", config: { url: "https://x.example/mcp" } },
    { type: "mcp_server", name: "events", transport: "sse", config: { url: "https://x.example/sse" } },
  ],
};

describe("generated files conform to the official Agent Plugins schemas", () => {
  const ajv = new Ajv({ strict: false });
  it("plugin.json validates", () => {
    const validate = ajv.compile(pluginSchema);
    const { files } = writeGemArchive(gem);
    expect(validate(JSON.parse(files["plugin.json"])), JSON.stringify(validate.errors)).toBe(true);
  });
  it("mcp.json validates", () => {
    const validate = ajv.compile(mcpSchema);
    const { files } = writeGemArchive(gem);
    expect(validate(JSON.parse(files["mcp.json"])), JSON.stringify(validate.errors)).toBe(true);
  });
  it("a gem with no portable servers writes no mcp.json at all", () => {
    const { files } = writeGemArchive({ ...gem, artifacts: [gem.artifacts[0]] });
    expect(files["mcp.json"]).toBeUndefined();
  });
});
