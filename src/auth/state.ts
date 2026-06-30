// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// OAuth `state`: a signed, time-boxed token carrying the post-login return URL. HMAC prevents
// tampering; the timestamp bounds replay. This is the CSRF defense for the redirect leg.
import { createHmac, timingSafeEqual } from "node:crypto";

interface StatePayload { returnTo: string; iat: number }

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signState(payload: { returnTo: string }, secret: string, nowMs: number): string {
  const body = Buffer.from(JSON.stringify({ returnTo: payload.returnTo, iat: nowMs } satisfies StatePayload)).toString("base64url");
  return `${body}.${hmac(body, secret)}`;
}

export function verifyState(state: string, secret: string, nowMs: number, maxAgeMs: number): { returnTo: string } | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = hmac(body, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
    if (typeof p.returnTo !== "string" || typeof p.iat !== "number") return null;
    if (nowMs - p.iat > maxAgeMs || nowMs < p.iat) return null;
    return { returnTo: p.returnTo };
  } catch { return null; }
}
