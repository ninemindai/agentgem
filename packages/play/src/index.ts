// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export { staticGate, gameGate, type GateResult, type GateOptions } from "./gameGate.js";
export { GENRES, genreFor, type GenreSpec } from "./genres.js";
export { scaffoldFor, minimalTemplate } from "./scaffolds.js";
export { extractSource, compactTurns, type GenerationInput, type SourceReaders } from "./sourceContext.js";
export { git, ensureRepo, commitAll, commitWithLock, setRemote, push } from "./git.js";
export { miniappsRoot, miniappDir, miniappHtmlPath, MINIAPP_HTML, claimMiniappDir, saveMiniapp, deleteMiniapp, checkpointMiniapp, readMiniapp, listMiniapps, migrateAllMiniapps, type MiniappMeta, type SaveMiniappInput, type SaveMiniappResult } from "./miniapps.js";
export { MCP_APP_MIME, uiUri, mcpResourceFor, mcpToolFor, mcpAppFor, type McpUiCsp, type AgentGemGameMeta, type McpUiResource, type McpUiTool, type McpApp } from "./mcpApp.js";
export { mcpAppClient, MCP_CLIENT_MARKER } from "./mcpAppClient.js";
export { hostStyleScript, MCP_UI_STYLE_KEYS } from "./hostStyles.js";
export { migrateMiniappHtml, ensureClientShim, type MigrateOutcome } from "./migrate.js";
export { studioCwd, studioBrief, seedStudio, importStudio, blankStudio, slugify, addUploadsToMiniapp } from "./studio.js";
export { writeUploads, sanitizeUploadName, type UploadFile, type UploadRole, type UploadCounts, type StoredUpload, type UploadResult } from "./uploads.js";
export { readMiniappShare, writeMiniappShare, clearMiniappShare, type MiniappShare } from "./miniappShare.js";
export { MINIAPP_BUILDER_BRIEF } from "./builderBrief.js";
export { redactForBake } from "./redact.js";
export { assertPortable, type PortabilityResult } from "./portability.js";
export { resolveSessionRef, type SessionRef } from "./sessionRef.js";
// Re-exported so packages/console — which depends on @agentgem/play, not @agentgem/model — can share
// the one capability<->tool map instead of keeping a second copy.
export { CAP_TOOL, TOOL_CAP, CAP_METHOD, METHOD_CAP, AUTO_CAPS } from "@agentgem/model";
export { deriveNeeds, reconcileNeeds, hasDynamicToolCall, deriveMcpNeeds, mergeMcpNeeds, mcpUsageWarnings, type Reconciled } from "./capabilityScan.js";
export { buildSpawnEnv } from "./mcpEnv.js";
export { mcpServerConfigDigest } from "./mcpDigest.js";
export {
  ConnectorError,
  resolveConnectorGem,
  resolveConnectorDigest,
  listConnectorTools,
  listConnectorCandidates,
  callConnectorTool,
  __setConnectorReaderForTest,
  __resetConnectorsForTest,
} from "./mcpConnectors.js";
export { INSPECTOR_HTML, INSPECTOR_META } from "./inspector.js";
export { EMBER_HTML, EMBER_META } from "./ember.js";
export { REPO_PULSE_HTML, REPO_PULSE_META } from "./repoPulse.js";
