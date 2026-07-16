// packages/console/src/panels/Play/__tests__/mcpErrors.drift.test.ts
import { describe, it, expect } from "vitest";
import { MCP_ERROR_CODES as MIRROR } from "../mcpErrors.js";
import { MCP_ERROR_CODES as CANON } from "@agentgem/model";

describe("console MCP_ERROR_CODES mirrors @agentgem/model", () => {
  it("is identical to the canonical union (order included)", () => {
    expect([...MIRROR]).toEqual([...CANON]);
  });
});
