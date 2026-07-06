// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export { staticGate, gameGate, type GateResult, type GateOptions } from "./gameGate.js";
export { GENRES, genreFor, type GenreSpec } from "./genres.js";
export { scaffoldFor } from "./scaffolds.js";
export { extractSource, type GenerationInput, type SourceReaders } from "./sourceContext.js";
export { git, ensureRepo, commitAll, setRemote, push } from "./git.js";
