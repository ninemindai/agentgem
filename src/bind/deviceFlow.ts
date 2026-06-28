// src/bind/deviceFlow.ts
// GitHub OAuth device flow (https://docs.github.com/apps/oauth-device-flow). No callback URL,
// no client secret — the CLI requests a code, the user approves in a browser, the CLI polls.
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval: number; }

export async function requestDeviceCode(clientId: string, fetchImpl: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await fetchImpl("https://github.com/login/device/code", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device/code: ${res.status}`);
  const j = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number };
  return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval ?? 5 };
}

export async function pollForToken(
  clientId: string, deviceCode: string,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; intervalSec?: number; maxAttempts?: number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let intervalSec = opts.intervalSec ?? 5;
  const maxAttempts = opts.maxAttempts ?? 60;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = (await res.json()) as { access_token?: string; error?: string };
    if (j.access_token) return j.access_token;
    if (j.error === "authorization_pending") { await sleep(intervalSec * 1000); continue; }
    if (j.error === "slow_down") { intervalSec += 5; await sleep(intervalSec * 1000); continue; }
    throw new Error(`device flow: ${j.error ?? "unknown error"}`); // access_denied, expired_token, …
  }
  throw new Error("device flow: timed out waiting for authorization");
}
