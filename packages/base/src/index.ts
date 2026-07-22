// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// @agentgem/base — cross-cutting shared helpers: workspace fs, deploy records,
// ACP session, redaction. Used across run/insight/deploy/capture.
export * from "./workspaces.js";
export * from "./deployRecord.js";
export * from "./acpSession.js";
export * from "./acpUpdates.js";
export * from "./acpTurn.js";
export * from "./acpErrors.js";
export * from "./redact.js";
// Moved to @agentgem/model so the egress packages (distribute, deploy) can gate on the canary
// without depending on base. Re-exported here so existing `@agentgem/base` importers still work.
export {
  REDACTED,
  redactStrongCredentials,
  findStrongCredentials,
  scanGemForLeaks,
  assertGemSafe,
  GemLeakError,
} from "@agentgem/model";
export type { StrongCredentialHit, LeakFinding, LeakReport } from "@agentgem/model";
export * from "./agents.js";
export * from "./agentTasks.js";
export * from "./log.js";
export * from "./adapters.js";
export * from "./concurrency.js";
