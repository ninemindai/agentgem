// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Same-origin proxy the console calls for the Benchmark tab. Forwards to the hosted aggregator
// via benchmarkClient (server-side, anonymous). Mirrors ShareProxyController: keeps the browser
// same-origin and the base resolution server-side. Response schema is permissive — the hosted
// side already validated, and the console re-validates against its own BenchmarkSchema.
import { z } from "zod";
import { api, get, post, AgentError } from "@agentback/openapi";
import { benchmarks, effectiveness } from "./gem/benchmarkClient.js";
import { benchmarkContribute, setBenchmarkContribute } from "./benchmark/config.js";
// Aliased: the route method below is `contribute()` — calling a bare `contribute()` inside it
// would recurse into itself instead of running the core contribution flow.
import { contribute as runContribute } from "./benchmark/contributeCore.js";

const Rows = z.array(z.record(z.string(), z.unknown()));
const EffQuery = z.object({
  sort: z.enum(["producers", "score"]).optional(),
  minConfidence: z.coerce.number().optional(),
  gemName: z.string().optional(),
});
const BenchQuery = z.object({ gemDigest: z.string().optional() });
const ContributeSetting = z.object({ enabled: z.boolean() });
const ContributeResponse = z.object({
  results: z.array(z.object({
    gem: z.string(),
    status: z.enum(["ingested", "updated", "skipped", "failed"]),
    reason: z.string().optional(),
  })),
});

@api({ basePath: "/api/benchmark" })
export class BenchmarkProxyController {
  @get("/", { query: BenchQuery, response: Rows })
  async benchmarks(input: { query: z.infer<typeof BenchQuery> } = { query: {} }): Promise<z.infer<typeof Rows>> {
    return benchmarks({ gemDigest: input.query.gemDigest }) as Promise<z.infer<typeof Rows>>;
  }

  @get("/effectiveness", { query: EffQuery, response: Rows })
  async effectiveness(input: { query: z.infer<typeof EffQuery> } = { query: {} }): Promise<z.infer<typeof Rows>> {
    return effectiveness({ sort: input.query.sort, minConfidence: input.query.minConfidence, gemName: input.query.gemName }) as Promise<z.infer<typeof Rows>>;
  }

  @get("/contribute-setting", { response: ContributeSetting })
  async getContributeSetting(): Promise<z.infer<typeof ContributeSetting>> {
    return { enabled: benchmarkContribute() };
  }

  @post("/contribute-setting", { body: ContributeSetting, response: ContributeSetting })
  async setContributeSetting(input: { body: z.infer<typeof ContributeSetting> }): Promise<z.infer<typeof ContributeSetting>> {
    setBenchmarkContribute(input.body.enabled);
    return { enabled: input.body.enabled };
  }

  @post("/contribute", { response: ContributeResponse })
  async contribute(): Promise<z.infer<typeof ContributeResponse>> {
    if (!benchmarkContribute()) {
      throw new AgentError("benchmark contribution is disabled", { status: 409, code: "contribute_disabled", retryable: false });
    }
    return { results: (await runContribute()).results };
  }
}
