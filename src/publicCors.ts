// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/publicCors.ts
//
// Shared credentialed-CORS + preflight for the PUBLIC, cross-site API surface
// (stars/reviews/catalog/groups/usage/handles/account/orgs/registry). These routes are
// mounted on raw express — outside the framework controller dispatch — because they are
// reachable from the marketplace SPA origins: each reflects the request Origin with
// Access-Control-Allow-Credentials (never "*" — the credentialed-CORS spec forbids the
// wildcard) and is exempt from originGuard (which blocks cross-site browser calls to the
// loopback API). Every such module used to copy-paste these two functions plus its own
// Req/Res/ExpressApp shim: ten byte-identical `cors()` copies and ten hand-kept
// `preflight()` strings are exactly the drift surface a shared helper removes — a CORS
// fix now lands in one place, while each route's Allow-Methods/Allow-Headers stays
// explicit at its own call.
//
// Not for auth/mount (better-auth's own inline wildcard handler) or account/connect (an
// OAuth callback with no CORS) — both are structurally different and stay as they are.

// Structural supersets of the express req/res/app shapes these handlers touch. The real
// express objects satisfy them (index.ts passes `expressApp as never`; tests fake `req`/
// `res` as `any`), so a handler simply ignores the fields it doesn't use.
export interface Req {
  method: string;
  path?: string;
  params?: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  headers: Record<string, string | undefined>;
  get?(name: string): string | undefined;
}
export interface Res {
  status(code: number): Res;
  set(key: string, value: string): Res;
  setHeader(key: string, value: string): Res;
  type(value: string): Res;
  json(body: unknown): Res;
  send(body: unknown): Res;
}
export type Handler = (req: Req, res: Res) => unknown;
export type ExpressApp = {
  get(path: string, handler: Handler): unknown;
  post(path: string, handler: Handler): unknown;
  put(path: string, handler: Handler): unknown;
  patch(path: string, handler: Handler): unknown;
  delete(path: string, handler: Handler): unknown;
  options(path: string, handler: Handler): unknown;
};

// Reflect an allow-listed Origin with credentials. No-op for an absent or disallowed
// Origin, so same-origin UI and non-browser callers (CLI/tests) are unaffected.
export function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}

// Answer an OPTIONS preflight with a 204. `methods` is the route's exact Allow-Methods
// list; `headers` defaults to "content-type" (pass "content-type, authorization" for a
// route whose real request also carries an Authorization header).
export function preflight(res: Res, methods: string, headers = "content-type"): void {
  res.set("Access-Control-Allow-Methods", methods).set("Access-Control-Allow-Headers", headers).status(204).send("");
}
