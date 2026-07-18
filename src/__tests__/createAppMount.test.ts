import { describe, it, expect, afterEach } from "vitest";
import type { RestApplication } from "@agentback/rest";
import { createApp, type AggregatorMount } from "../index.js";

describe("createApp aggregator-mount seam", () => {
  let app: RestApplication | undefined;
  afterEach(async () => { await app?.stop().catch(() => {}); app = undefined; });

  it("invokes the injected mount hook exactly once with (app, server, env)", async () => {
    const calls: Array<{ hasApp: boolean; hasServer: boolean; envIsProcess: boolean }> = [];
    const spyMount: AggregatorMount = async (a, s, env) => {
      calls.push({ hasApp: !!a, hasServer: !!s, envIsProcess: env === process.env });
    };
    app = await createApp(0, spyMount);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ hasApp: true, hasServer: true, envIsProcess: true });
  });
});
