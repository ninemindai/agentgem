// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/rubric.controller.ts
//
// The rubric catalog + authoring REST surface, on the AgentBack decorator
// dispatch (was four raw `server.expressApp` routes in index.ts). Moving them
// here buys Zod input validation, OpenAPI emission, and the framework's
// originGuard — which is mounted as framework middleware (index.ts), so it runs
// before controller dispatch and these routes need no per-route guard.
//
// The validate/save bodies stay PERMISSIVE (z.unknown()): the editor posts an
// arbitrary draft and the endpoint answers 200 with inline errors — a strict body
// schema would 422 a malformed draft before validateRubricInput could describe
// what's wrong. The real, structural validation lives in rubricCore.validateRubric.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { listRubricsWithMeta, validateRubricInput, saveRubric, deleteRubric } from "./rubricCore.js";

// The Rubric shape (packages/insight/src/rubrics.ts), mirrored so /openapi.json
// describes the catalog + validation payloads. Response validation is advisory
// (rest.server logs a debug on mismatch, never strips), so this documents the
// contract without any risk to the body the console consumes.
const RubricFactorRefSchema = z.object({ factor: z.string(), weight: z.number().optional() });
const LlmCriterionSchema = z.object({
  id: z.string(),
  title: z.string(),
  question: z.string(),
  severity: z.enum(["info", "warn"]).optional(),
  advice: z.string(),
  granularity: z.enum(["session", "aggregate"]).optional(),
});
const RubricSchema = z.object({
  id: z.string(),
  title: z.string(),
  target: z.string(),
  naturalScope: z.enum(["session", "project", "all"]).optional(),
  factors: z.array(RubricFactorRefSchema),
  criteria: z.array(LlmCriterionSchema).optional(),
});
// listRubricsWithMeta adds the `builtin` flag the picker gates edit/delete on.
const RubricWithBuiltinSchema = RubricSchema.extend({ builtin: z.boolean() });
const FactorKindSchema = z.object({
  factor: z.string(),
  kind: z.enum(["detector", "rule", "criterion", "unknown"]),
});
// The RubricValidation contract (rubricCore.ts): valid + the resolved rubric, its
// factor-kind preview, and unknown-factor warnings; `saved` set by the save path.
const RubricValidationSchema = z.object({
  valid: z.boolean(),
  error: z.string().optional(),
  rubric: RubricSchema.optional(),
  factors: z.array(FactorKindSchema).optional(),
  unknownFactors: z.array(z.string()).optional(),
  saved: z.boolean().optional(),
});

const RubricListQuerySchema = z.object({ dir: z.string().optional() });
const RubricListResponseSchema = z.object({ rubrics: z.array(RubricWithBuiltinSchema) });
const RubricDeleteBodySchema = z.object({ id: z.string() });
const RubricDeleteResponseSchema = z.object({ deleted: z.boolean(), error: z.string().optional() });

@api({ basePath: "/api" })
export class RubricController {
  // GET /api/rubrics?dir= — built-in + user rubrics for the picker.
  @get("/rubrics", { query: RubricListQuerySchema, response: RubricListResponseSchema })
  async list(input: { query: z.infer<typeof RubricListQuerySchema> }): Promise<z.infer<typeof RubricListResponseSchema>> {
    return { rubrics: listRubricsWithMeta(input.query.dir) };
  }

  // POST /api/rubrics/validate — dry-run for the live editor; always 200 with the
  // result (valid:false + error for a bad draft), never a 422. Body stays z.unknown().
  @post("/rubrics/validate", { body: z.unknown(), response: RubricValidationSchema })
  async validate(input: { body: unknown }): Promise<z.infer<typeof RubricValidationSchema>> {
    return validateRubricInput(input.body);
  }

  // POST /api/rubrics — validate + write a user rubric to ~/.agentgem/rubrics/<id>.json.
  @post("/rubrics", { body: z.unknown(), response: RubricValidationSchema })
  async save(input: { body: unknown }): Promise<z.infer<typeof RubricValidationSchema>> {
    return saveRubric(input.body);
  }

  // POST /api/rubrics/delete — remove a user rubric (built-ins are protected). Unlike
  // the raw route it replaced, a missing/blank id is now a 422 (schema-gated) rather
  // than a 200 {deleted:false}; the console always sends a concrete id.
  @post("/rubrics/delete", { body: RubricDeleteBodySchema, response: RubricDeleteResponseSchema })
  async remove(input: { body: z.infer<typeof RubricDeleteBodySchema> }): Promise<z.infer<typeof RubricDeleteResponseSchema>> {
    return deleteRubric(input.body.id);
  }
}
