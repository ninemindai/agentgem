// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export { staticGate, gameGate, type GateResult, type GateOptions } from "./gameGate.js";
export { GENRES, genreFor, type GenreSpec } from "./genres.js";
export { scaffoldFor } from "./scaffolds.js";
export { extractSource, compactTurns, type GenerationInput, type SourceReaders } from "./sourceContext.js";
export { git, ensureRepo, commitAll, commitWithLock, setRemote, push } from "./git.js";
export { miniappsRoot, miniappDir, saveMiniapp, checkpointMiniapp, readMiniapp, listMiniapps, type MiniappMeta, type SaveMiniappInput } from "./miniapps.js";
export { MCP_APP_MIME, uiUri, mcpResourceFor, mcpToolFor, mcpAppFor, type McpUiCsp, type AgentGemGameMeta, type McpUiResource, type McpUiTool, type McpApp } from "./mcpApp.js";
export { mcpAppClient, MCP_CLIENT_MARKER } from "./mcpAppClient.js";
export { studioCwd, studioBrief, seedStudio, importStudio, blankStudio } from "./studio.js";
export { redactForBake } from "./redact.js";
export { assertPortable, type PortabilityResult } from "./portability.js";
export { resolveSessionRef, type SessionRef } from "./sessionRef.js";
