// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export { staticGate, gameGate, type GateResult, type GateOptions } from "./gameGate.js";
export { GENRES, genreFor, type GenreSpec } from "./genres.js";
export { scaffoldFor } from "./scaffolds.js";
export { extractSource, compactTurns, type GenerationInput, type SourceReaders } from "./sourceContext.js";
export { git, ensureRepo, commitAll, setRemote, push } from "./git.js";
export { miniappsRoot, miniappDir, saveMiniapp, readMiniapp, listMiniapps, type MiniappMeta, type SaveMiniappInput } from "./miniapps.js";
export { studioCwd, studioBrief, seedStudio, importStudio, blankStudio } from "./studio.js";
export { redactForBake } from "./redact.js";
export { assertPortable, type PortabilityResult } from "./portability.js";
export { resolveSessionRef, type SessionRef } from "./sessionRef.js";
