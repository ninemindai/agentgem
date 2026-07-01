# Verify-Identity (bind-on-install) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A console Settings "Verify identity" control that drives the existing GitHub device-flow bind (local pubkey → `account_bindings` row), after which the `verifiedInstalls` JOIN retroactively verifies all the user's adoptions.

**Architecture:** Extract a shared `bindCore` from the CLI; expose it via three local-console endpoints; add a Settings section that drives them. No emit/event/aggregate change — the pubkey→account JOIN is retroactive.

**Tech Stack:** server (`src/`) + `@agentgem/console` (React). Server tests in the ROOT suite (`src/**/__tests__/`) via `pnpm test`; console tests via `pnpm --filter @agentgem/console test`.

## Global Constraints

- MIT header (3 lines) on new server files; match the console's no-header style.
- **Never sign/log/persist the raw GitHub token** beyond what `bindCore` needs to POST it once (the aggregator hashes it; `binding.json` stores only provider/login/accountId). Mirror `cli.ts`.
- **Degrade, never error, when unconfigured:** missing `AGENTGEM_GITHUB_CLIENT_ID`/`AGENTGEM_AGGREGATOR_URL` → the endpoints report `configured:false` and the UI shows "Verification unavailable (not configured)".
- **No self-reported account on the adoption event** — binding creates a real `account_bindings` row; do NOT touch `emitAdoption`/`GemAdoption`/`gemAdoption`.
- Reuse `requestDeviceCode`/`pollForToken` (`src/bind/deviceFlow.ts`), `bindSigningPayload` + `recordBinding` (`@agentgem/aggregator`, via the aggregator `/bind` endpoint), `loadOrCreateIdentity` (`@agentgem/model`).
- Additive/surgical; the `agentgem bind` CLI must keep working after the refactor.
- Commit identity: `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit`; messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show HEAD --stat`.

---

### Task 1: shared `bindCore` + console bind endpoints

**Files:**
- Create: `src/bind/bindCore.ts`
- Modify: `src/bind/cli.ts` (use the core), `src/gem.controller.ts` (three endpoints)
- Test: `src/bind/__tests__/bindCore.test.ts` (new), `src/gem/__tests__/bindEndpoints.test.ts` (new)

**Interfaces — Produces:**
- `bindConfig(): { clientId?: string; base?: string }`
- `startDeviceBind(cfg, deps?): Promise<{ userCode; verificationUri; deviceCode; interval }>`
- `completeDeviceBind(cfg, { deviceCode; interval }, deps?): Promise<{ bound: true; provider; login; accountId } | { bound: false; rejected: string }>`
- `readBindingStatus(): { bound: boolean; login?: string; provider?: string }`
- Console routes: `POST /bind/start`, `POST /bind/complete`, `GET /bind/status`.

- [ ] **Step 1: Write the failing tests** — `src/bind/__tests__/bindCore.test.ts` (inject deps so no real network/home):
```ts
// - startDeviceBind: stub requestDeviceCode → returns { userCode, verificationUri, deviceCode, interval }
// - completeDeviceBind (bound): stub pollForToken→"tok", a fake identity {publicKey:"ed25519:x", sign:()=>"sig"},
//   a fake fetch capturing the POST → assert URL endsWith /api/aggregator/bind, body has pubkey/signedAt/signature and token==="tok",
//   server returns {bound:true, provider:"github", login:"alice", accountId:"1"} → binding.json written (hermetic home) → returns bound
// - completeDeviceBind (rejected): server {bound:false, rejected:"bad-signature"} → NO binding.json, returns {bound:false, rejected}
// - readBindingStatus: after a bound write → {bound:true, login:"alice"}; empty home → {bound:false}
// - bindConfig: unset env → {}
```
`src/gem/__tests__/bindEndpoints.test.ts`:
```ts
// construct the controller like other GemController tests; stub bindCore via injected deps or env:
// - /bind/start with config → { configured:true, userCode, verificationUri, deviceCode, interval } (stub startDeviceBind)
// - /bind/start WITHOUT config → { configured:false }
// - /bind/complete → threads {deviceCode,interval} to completeDeviceBind (stub → {bound:true, login})
// - /bind/status → readBindingStatus()
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec tsc -b && pnpm exec vitest run dist/bind/__tests__/bindCore.test.js dist/gem/__tests__/bindEndpoints.test.js` → FAIL.

- [ ] **Step 3: Implement**

`src/bind/bindCore.ts` — extract from `cli.ts`:
```ts
// <MIT header>
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, type Identity } from "@agentgem/model";
import { bindSigningPayload } from "@agentgem/aggregator";
import { requestDeviceCode, pollForToken } from "./deviceFlow.js";

export interface BindConfig { clientId?: string; base?: string }
export function bindConfig(): BindConfig {
  return { clientId: process.env.AGENTGEM_GITHUB_CLIENT_ID, base: process.env.AGENTGEM_AGGREGATOR_URL };
}
const bindingPath = () => join(homedir(), ".agentgem", "binding.json");

export interface StartDeps { requestCode?: typeof requestDeviceCode }
export async function startDeviceBind(cfg: BindConfig, deps: StartDeps = {}) {
  if (!cfg.clientId) throw new Error("not configured");
  return (deps.requestCode ?? requestDeviceCode)(cfg.clientId);
}

export interface CompleteDeps { poll?: typeof pollForToken; identity?: Identity; fetchImpl?: typeof fetch; now?: number }
export async function completeDeviceBind(
  cfg: BindConfig, args: { deviceCode: string; interval?: number }, deps: CompleteDeps = {},
): Promise<{ bound: true; provider: string; login: string; accountId: string } | { bound: false; rejected: string }> {
  if (!cfg.clientId || !cfg.base) return { bound: false, rejected: "not-configured" };
  const token = await (deps.poll ?? pollForToken)(cfg.clientId, args.deviceCode, { intervalSec: args.interval ?? 5 });
  const id = deps.identity ?? loadOrCreateIdentity();
  const signedAt = deps.now ?? Date.now();
  const signature = id.sign(bindSigningPayload(id.publicKey, token, signedAt));
  const res = await (deps.fetchImpl ?? fetch)(new URL("/api/aggregator/bind", cfg.base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.publicKey, token, signedAt, signature }),
  });
  const out = (await res.json()) as { bound: boolean; provider?: string; login?: string; accountId?: string; rejected?: string };
  if (!out.bound) return { bound: false, rejected: out.rejected ?? "unknown" };
  const dir = join(homedir(), ".agentgem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(bindingPath(), JSON.stringify({ provider: out.provider, login: out.login, accountId: out.accountId, boundAt: new Date().toISOString() }), { mode: 0o600 });
  return { bound: true, provider: out.provider!, login: out.login!, accountId: out.accountId! };
}

export function readBindingStatus(): { bound: boolean; login?: string; provider?: string } {
  try {
    if (!existsSync(bindingPath())) return { bound: false };
    const j = JSON.parse(readFileSync(bindingPath(), "utf8")) as { login?: string; provider?: string };
    return j.login ? { bound: true, login: j.login, provider: j.provider } : { bound: false };
  } catch { return { bound: false }; }
}
```
(NOTE: `new Date().toISOString()` — if the project bans `new Date()` in some contexts, use the `boundAt` the CLI already used; the CLI uses `new Date().toISOString()` so it's fine here.)

`src/bind/cli.ts` — replace the inline device-code + poll + post + write with `startDeviceBind`/`completeDeviceBind` (print the code between them). Keep the same console output + exit codes.

`src/gem.controller.ts` — add (behind the same `originGuard` as other console routes; import `bindConfig`/`startDeviceBind`/`completeDeviceBind`/`readBindingStatus`; define Zod schemas):
```ts
@post("/bind/start", { body: <empty obj schema>, response: BindStartSchema })
async bindStart(): Promise<z.infer<typeof BindStartSchema>> {
  const cfg = bindConfig();
  if (!cfg.clientId) return { configured: false };
  const dc = await startDeviceBind(cfg);
  return { configured: true, ...dc };
}
@post("/bind/complete", { body: BindCompleteBody, response: BindCompleteSchema })
async bindComplete(input: { body: z.infer<typeof BindCompleteBody> }): Promise<z.infer<typeof BindCompleteSchema>> {
  return completeDeviceBind(bindConfig(), { deviceCode: input.body.deviceCode, interval: input.body.interval });
}
@get("/bind/status", { query: PickQuerySchema, response: BindStatusSchema })
async bindStatus(): Promise<z.infer<typeof BindStatusSchema>> { return readBindingStatus(); }
```
`BindStartSchema = z.object({ configured: z.boolean(), userCode: z.string().optional(), verificationUri: z.string().optional(), deviceCode: z.string().optional(), interval: z.number().optional() })`; `BindCompleteBody = z.object({ deviceCode: z.string(), interval: z.number().optional() })`; `BindCompleteSchema = z.object({ bound: z.boolean(), provider: z.string().optional(), login: z.string().optional(), accountId: z.string().optional(), rejected: z.string().optional() })`; `BindStatusSchema = z.object({ bound: z.boolean(), login: z.string().optional(), provider: z.string().optional() })`.

- [ ] **Step 4: Run to verify** — `pnpm exec tsc -b && pnpm exec vitest run dist/bind/__tests__/bindCore.test.js dist/gem/__tests__/bindEndpoints.test.js` → PASS. Also confirm any existing `src/bind` CLI test still passes.

- [ ] **Step 5: Commit**
```bash
git add src/bind/bindCore.ts src/bind/cli.ts src/gem.controller.ts src/bind/__tests__/bindCore.test.ts src/gem/__tests__/bindEndpoints.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(bind): shared bindCore + console /bind/start|complete|status endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: console Settings "Verify identity" section

**Files:**
- Modify: `packages/console/src/api/routes.ts` (3 routes), `packages/console/src/panels/Settings/index.tsx` (the section)
- Test: `packages/console/src/panels/Settings/Settings.test.tsx` (extend)

**Interfaces:** Consumes the Task 1 endpoints.

- [ ] **Step 1: Write the failing test** — extend `Settings.test.tsx` (mirror its existing route-stub style):
```tsx
// - unbound status (bindStatusRoute → {bound:false}) → renders "Not verified"
// - not-configured (bindStartRoute → {configured:false}) path → "Verification unavailable"
// - click "Connect GitHub": stub bindStartRoute → {configured:true, userCode:"WXYZ", verificationUri:"https://github.com/login/device", deviceCode:"d", interval:5};
//   stub bindCompleteRoute → {bound:true, login:"alice"} → after the flow, shows "WXYZ" then "Verified as @alice"
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @agentgem/console test -- Settings` → FAIL.

- [ ] **Step 3: Implement**

`packages/console/src/api/routes.ts` — add (mirror the file's `defineRoute` pattern + response schemas from Task 1):
```ts
export const bindStatusRoute = defineRoute({ method: "GET", path: "/bind/status",
  response: z.object({ bound: z.boolean(), login: z.string().optional(), provider: z.string().optional() }) });
export const bindStartRoute = defineRoute({ method: "POST", path: "/bind/start",
  response: z.object({ configured: z.boolean(), userCode: z.string().optional(), verificationUri: z.string().optional(), deviceCode: z.string().optional(), interval: z.number().optional() }) });
export const bindCompleteRoute = defineRoute({ method: "POST", path: "/bind/complete",
  body: z.object({ deviceCode: z.string(), interval: z.number().optional() }),
  response: z.object({ bound: z.boolean(), login: z.string().optional(), rejected: z.string().optional() }) });
```
(Match the EXACT `defineRoute` call shape used by the existing routes in this file — read one first.)

`packages/console/src/panels/Settings/index.tsx` — add a `<section className="ledger-group">` "Verify identity" with local state `{ status, code, error }`:
- `useEffect` → `bindStatusRoute.call(makeClient(apiBase))` → set status.
- "Connect GitHub" button → `bindStartRoute.call(...)`; if `!configured` show "Verification unavailable (not configured)"; else show `userCode` + a link to `verificationUri` ("open GitHub and enter this code"), then `bindCompleteRoute.call(makeClient(apiBase), { body: { deviceCode, interval } })` → on `{bound}` set status to verified; on `{rejected}` show it.
- Render: bound → "Verified as @{login}"; unbound → "Not verified — your installs won't count toward verified ratings" + the button; explanatory copy referencing 💎 Diamond.

- [ ] **Step 4: Run to verify + gates** — `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck` → green (+ the console build the CI runs).

- [ ] **Step 5: Commit**
```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Settings/index.tsx packages/console/src/panels/Settings/Settings.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(console): Settings 'Verify identity' — device-flow bind to verify installs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- Server `pnpm exec tsc -b` + full `pnpm test` green (build console first); the `agentgem bind` CLI still works (refactor unchanged behavior).
- Console `test|typecheck` + build clean.
- Whole-branch review (sonnet — a bind/auth flow but reusing verified pieces): the raw token is only used to POST once (never persisted beyond the aggregator's hash); binding creates a real `account_bindings` row (no self-reported account on the event); endpoints degrade to `configured:false` when env is unset; the CLI still works.

## The result this delivers

A one-time "Verify identity" click binds the local key to a GitHub account; the `verifiedInstalls` JOIN then counts all that user's installs as verified — so real adopters accrue verified installs and 💎 Diamond becomes honestly reachable. Closes the loop the sybil hardening opened.
