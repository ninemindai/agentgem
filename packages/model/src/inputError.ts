// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/inputError.ts
// A rejection of a caller-supplied value by an input-containment guard: an unsafe
// workspace-name path segment, a non-public (SSRF) URL, a malformed credential.
//
// These are NOT server faults — the request was refused on purpose — so the caller
// should learn WHY. @agentback/rest hides the message of any error whose status is
// >= 500 ("Internal Server Error"), but surfaces e.message verbatim for a 4xx. By
// carrying statusCode 400 (read by the framework's buildErrorEnvelope) this turns the
// previously opaque 500 into a 400 whose message names the violated rule — matching
// how the zod body/param validators already report bad input.
export class InvalidInputError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_input";
  // Override the framework's default invalid_input hint, which points at a per-field
  // `issues`/`schema` payload these single-rule guards don't carry.
  readonly hint = "Correct the value to satisfy the rule stated in `message`, then retry.";
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
