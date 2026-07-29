// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/bind/deviceFlow.ts
// GitHub OAuth device flow (https://docs.github.com/apps/oauth-device-flow). No callback URL,
// no client secret — the CLI requests a code, the user approves in a browser, the CLI polls.
// `verificationUriComplete` is GitHub's verification URL with the user code
// pre-filled — landing the user on a "just click Authorize" page (no manual entry).
export interface DeviceCode {
  deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete?: string;
  interval: number;
  /** How long GitHub will honour this code, from its `expires_in` (~900s). We used to discard
   *  it and impose a 300s deadline of our own, so a user who took six minutes was told the
   *  flow "timed out" while the code had nine minutes of life left. */
  expiresInSec: number;
}

export async function requestDeviceCode(clientId: string, fetchImpl: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await fetchImpl("https://github.com/login/device/code", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    // read:org lets /user/orgs return PRIVATE org memberships too (public-only without it),
    // so team-usage membership gating works for the GitHub default of private membership.
    body: JSON.stringify({ client_id: clientId, scope: "read:user read:org" }),
  });
  if (!res.ok) throw new Error(`device/code: ${res.status}`);
  const j = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; interval?: number; expires_in?: number };
  return {
    deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval ?? 5,
    expiresInSec: j.expires_in ?? 900,
    ...(j.verification_uri_complete ? { verificationUriComplete: j.verification_uri_complete } : {}),
  };
}

/** Poll until GitHub hands over a token, the code dies, or we run out of patience.
 *
 *  `budgetSec` is how long THIS caller is willing to wait, which is deliberately not the same
 *  as how long the code lives. A CLI is a foreground process with a human watching it, so it
 *  should wait for the code's real expiry. The console's `POST /bind/complete` polls inside an
 *  HTTP request, so it must NOT — a 15-minute request dies in a proxy or a browser idle
 *  timeout, and the answer is lost even if the bind succeeded. Hence the 300s default here:
 *  it keeps that route's behaviour exactly as it was, and the CLIs opt into longer.
 *
 *  Elapsed time is counted from the intervals we sleep rather than read off a clock. That keeps
 *  the tests hermetic (no fake timers) and costs nothing in correctness, because the budget is
 *  only a backstop — GitHub's own `expired_token` is the authority on when a code is dead, and
 *  request latency makes our count run slightly behind the wall clock, never ahead of it.
 *
 *  `onPending` fires after each unsuccessful poll so a caller can prove it is still alive. */
export async function pollForToken(
  clientId: string, deviceCode: string,
  opts: {
    fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; intervalSec?: number;
    budgetSec?: number; onPending?: (p: { elapsedSec: number; remainingSec: number }) => void;
  } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Floor at 1s: the interval comes from GitHub's JSON, and a 0 would turn this into a hot
  // loop hammering someone else's endpoint.
  let intervalSec = Math.max(1, opts.intervalSec ?? 5);
  const budgetSec = opts.budgetSec ?? 300;
  let elapsedSec = 0;
  for (;;) {
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = (await res.json()) as { access_token?: string; error?: string };
    if (j.access_token) return j.access_token;
    if (j.error === "slow_down") intervalSec += 5;
    else if (j.error !== "authorization_pending") throw new Error(`device flow: ${j.error ?? "unknown error"}`); // access_denied, expired_token, …
    if (elapsedSec + intervalSec > budgetSec) break; // the next sleep would overrun the budget
    await sleep(intervalSec * 1000);
    elapsedSec += intervalSec;
    opts.onPending?.({ elapsedSec, remainingSec: budgetSec - elapsedSec });
  }
  throw new Error("device flow: timed out waiting for authorization");
}
