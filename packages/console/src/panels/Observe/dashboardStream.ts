// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/dashboardStream.ts
//
// Session-dashboard render stream (named events start/delta/done/failed, one
// discriminated union). Consumed via @agentback/client's typed `route.stream()`
// over the server's `streamOf:` route — mirrored here because the console can't
// import root `src/` (same arrangement as panels/Rubrics/rubricStream.ts).
import { z } from "zod";
import { defineRoute, type Client } from "@agentback/client";

export type SessionDashboardEvent =
  | { type: "start"; cached: boolean; events: number }
  | { type: "delta"; text: string }
  | { type: "done"; html: string; cached: boolean; updatedAt: number }
  | { type: "failed"; message: string };

const WireEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), cached: z.boolean(), events: z.number() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done"), html: z.string(), cached: z.boolean(), updatedAt: z.number() }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);

export type SessionDashboardKind = "summary" | "report";

const sessionDashboardRoute = defineRoute("GET", "/api/inspect/session/dashboard", {
  query: z.object({ id: z.string(), agent: z.string(), fresh: z.string().optional(), kind: z.enum(["summary", "report"]).optional() }),
  streamOf: WireEvent,
});

/** Open the session-dashboard stream. Same `(onEvent) => cleanup` contract as
 *  openRubricStream. */
export function openSessionDashboardStream(
  client: Client,
  params: { id: string; agent: string; fresh?: boolean; kind?: SessionDashboardKind },
  onEvent: (e: SessionDashboardEvent) => void,
): () => void {
  const ctrl = new AbortController();
  const query: { id: string; agent: string; fresh?: string; kind?: SessionDashboardKind } = { id: params.id, agent: params.agent };
  if (params.fresh) query.fresh = "true";
  if (params.kind && params.kind !== "summary") query.kind = params.kind;
  void (async () => {
    try {
      for await (const e of sessionDashboardRoute.stream(client, { query }, { signal: ctrl.signal })) onEvent(e);
    } catch {
      if (!ctrl.signal.aborted) onEvent({ type: "failed", message: "stream connection error" });
    }
  })();
  return () => ctrl.abort();
}
