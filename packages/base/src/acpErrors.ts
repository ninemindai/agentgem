// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/acpErrors.ts
//
// Uniform classification of ACP failures, borrowed from acpx's error strategy:
// JSON-RPC -32603 (internal — usually a wrapped model-API failure) and -32700
// (parse) are worth retrying; method/param/auth errors are permanent; a dead
// adapter process is never retryable at the prompt level (the connection is gone).
// Callers use `kind` for messaging and `retryable` for policy — no retry loop
// lives here (YAGNI until a caller wants one).

export type AcpErrorKind = "auth" | "protocol" | "crash" | "timeout" | "unknown";

export interface NormalizedAcpError {
  kind: AcpErrorKind;
  retryable: boolean;
  code?: number;
  message: string;
}

const RETRYABLE_RPC = new Set([-32603, -32700]);
const PERMANENT_RPC = new Set([-32601, -32602, -32001, -32002]);
const AUTH_HINT = /auth(entication|orization)? required|not (?:logged|signed) in|login required/i;

export function normalizeAcpError(err: unknown): NormalizedAcpError {
  const e = err as { message?: string; code?: unknown; data?: { authRequired?: unknown } } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  const code = typeof e?.code === "number" ? e.code : undefined;
  if (code !== undefined) {
    if (e?.data?.authRequired === true || AUTH_HINT.test(message)) return { kind: "auth", retryable: false, code, message };
    if (RETRYABLE_RPC.has(code)) return { kind: "protocol", retryable: true, code, message };
    if (PERMANENT_RPC.has(code)) return { kind: "protocol", retryable: false, code, message };
    return { kind: "protocol", retryable: false, code, message };
  }
  if (/^agent process (exited|error)/.test(message)) return { kind: "crash", retryable: false, message };
  if (/timed? ?out/i.test(message)) return { kind: "timeout", retryable: false, message };
  return { kind: "unknown", retryable: false, message };
}
