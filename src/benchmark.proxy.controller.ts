// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Same-origin proxy the console calls for the Benchmark tab. Forwards to the hosted aggregator
// via benchmarkClient (server-side, anonymous). Mirrors ShareProxyController: keeps the browser
// same-origin and the base resolution server-side. Response schema is permissive — the hosted
// side already validated, and the console re-validates against its own BenchmarkSchema.
import { z } from "zod";
import { api, get } from "@agentback/openapi";
import { benchmarks, effectiveness } from "./gem/benchmarkClient.js";

const Rows = z.array(z.record(z.string(), z.unknown()));
const EffQuery = z.object({
  sort: z.enum(["producers", "score"]).optional(),
  minConfidence: z.coerce.number().optional(),
  gemName: z.string().optional(),
});
const BenchQuery = z.object({ gemDigest: z.string().optional() });

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
}
