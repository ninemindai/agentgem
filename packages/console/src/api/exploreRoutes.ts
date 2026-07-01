// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Explore connect (GitHub device flow) + identity routes. Mirrors src/explore.controller.ts.
import { z } from "zod";
import { defineRoute } from "@agentback/client";

export const connectStartRoute = defineRoute("POST", "/api/explore/connect/start", {
  response: z.object({ deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), interval: z.number() }),
});
export const connectFinishRoute = defineRoute("POST", "/api/explore/connect/finish", {
  body: z.object({ deviceCode: z.string(), interval: z.number() }),
  response: z.object({ connected: z.boolean(), login: z.string().optional(), rejected: z.string().optional() }),
});
export const identityRoute = defineRoute("GET", "/api/explore/identity", {
  response: z.object({ connected: z.boolean(), login: z.string().optional() }),
});
