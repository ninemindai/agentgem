// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The two pieces of miniapp machinery that are genuinely host-neutral: the admission gate and the
// bake-time redactor. Everything else about hosting a miniapp — storage, data path, transport,
// authoring brief — is host policy and deliberately lives in the host, not here.
export { staticGate, gameGate, scannableCode, type GateResult, type GateOptions } from "./gameGate.js";
export { redactForBake } from "./redact.js";
