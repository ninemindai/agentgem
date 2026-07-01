// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Same-origin endpoints the LOCAL console calls to connect GitHub (device flow) and read identity.
// The browser stays same-origin; this controller forwards to the hosted aggregator's /bind.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "@agentgem/model";
import { requestDeviceCode, pollForToken } from "./bind/deviceFlow.js";
import { startConnect, finishConnect } from "./explore/connectCore.js";
import { readBinding, writeBinding } from "./explore/bindingFile.js";

const DeviceCodeSchema = z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number() });
const FinishBody = z.object({ deviceCode: z.string(), interval: z.number() });
const FinishResult = z.object({ connected: z.boolean(), login: z.string().optional(), rejected: z.string().optional() });
const IdentityResult = z.object({ connected: z.boolean(), login: z.string().optional() });

// Test seam: override the ~/.agentgem dir. Mirrors loadOrCreateIdentity's default.
const agentgemDir = (): string => process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem");
const aggregatorBase = (): string => process.env.AGENTGEM_AGGREGATOR_URL ?? "https://api.agentgem.ai";
function clientId(): string {
  const id = process.env.AGENTGEM_GITHUB_CLIENT_ID;
  if (!id) throw new Error("set AGENTGEM_GITHUB_CLIENT_ID to connect GitHub");
  return id;
}

@api({ basePath: "/api/explore" })
export class ExploreController {
  @post("/connect/start", { response: DeviceCodeSchema })
  async connectStart(): Promise<z.infer<typeof DeviceCodeSchema>> {
    return startConnect({ clientId: clientId(), requestDeviceCode });
  }

  @post("/connect/finish", { body: FinishBody, response: FinishResult })
  async connectFinish(input: { body: z.infer<typeof FinishBody> }): Promise<z.infer<typeof FinishResult>> {
    const dir = agentgemDir();
    const r = await finishConnect({
      clientId: clientId(), deviceCode: input.body.deviceCode, interval: input.body.interval,
      base: aggregatorBase(), identity: loadOrCreateIdentity(dir),
      pollForToken, http: async (url, i) => { const res = await fetch(url, i); return { status: res.status, json: () => res.json() }; },
      now: () => Date.now(), write: (b) => { writeBinding(b, dir); },
    });
    return r.connected ? { connected: true, login: r.login } : { connected: false, rejected: r.rejected };
  }

  @get("/identity", { response: IdentityResult })
  identity(): z.infer<typeof IdentityResult> {
    const b = readBinding(agentgemDir());
    return b ? { connected: true, login: b.login } : { connected: false };
  }
}
