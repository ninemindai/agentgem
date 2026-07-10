# Miniapp Runtime v2 — MCP Apps Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AgentGem miniapp `ui/*` wire conformant with the MCP Apps extension (`modelcontextprotocol/ext-apps`, MVP 2026-01-26), supply real host context (theme/sizing/display-mode), extend the capability model to govern three new egress methods, and port four ext-apps examples into a no-build template library — without changing one line of any stored miniapp's game logic.

**Architecture:** Four sequential PRs off freshly-fetched `origin/main`. PR 1 splits the capability model (pure, no runtime change). PR 2 rewrites the transport shim + host router to the real wire, versioning the shim marker while freezing the `window.agentgemApp` API. PR 3 supplies host context and rewrites the Runner's fullscreen/sizing to the spec's model. PR 4 ports the templates and adds a built-in conformance inspector. The design spec is `docs/superpowers/specs/2026-07-10-miniapp-mcp-apps-conformance-design.md`; read it first.

**Tech Stack:** TypeScript (ESM), Zod schemas, React (console), vitest (dist-run), the hand-rolled `mcpAppClient` shim (no SDK dependency in the artifact — see spec F4).

## Global Constraints

Every task's requirements implicitly include these:

- **Node floor `>=24`.** ESM throughout. No CommonJS.
- **Play tests are a dist-run.** vitest `include` is `dist/**/__tests__/**/*.test.js`. Write tests in `packages/play/src/**/__tests__/*.test.ts`, compile with `pnpm -C packages/play build` (or root `tsc -b`), then run the compiled `dist/**/__tests__/*.test.js`. NEVER author a package-local `vitest.config`. NEVER run `src/…*.test.ts` directly.
- **Console tests are NOT in CI.** `packages/console/src/panels/Play/__tests__/*` must be run locally before each PR: `pnpm -C packages/console exec vitest run`. A fresh worktree's root `pnpm test` also fails `consoleMount.test.ts` until `node scripts/build-console.mjs` has run once — unrelated to this work.
- **The seal's word list.** `gameGate`'s `NETWORK_CALL` regex scans `scannableCode(html)` (which strips only `type="application/json"` script bodies). The literal tokens `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `navigator.sendBeacon` fail the gate **even inside strings and comments**. Any template/inspector HTML must avoid these words in executable script.
- **Baked data needs BOTH attributes.** `<script id="game-data" type="application/json">` — `id="game-data"` for `portability.ts`'s `hasBakedTimeline`, `type="application/json"` for `gameGate`'s `JSON_TYPE` exemption. One without the other is a bug.
- **`window.agentgemApp` is a frozen public API.** Its method signatures and the shapes it delivers to games (`{toolName, chunk}` on notifications; `callTool(name, args) → Promise`; `onNotification(method, cb)`) MUST NOT change. The shim's internals may change freely.
- **`saveMiniapp` calls `ensureClientShim`, NEVER `migrateMiniappHtml`** (the codemod injects a capability — widening a grant on the save path is a security bug).
- **Git identity:** commits are `Raymond Feng <raymond@ninemind.ai>`. End commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Reverse-DNS namespace is `ai.agentgem/*`** (not `io.agentgem`). The stream `_meta` key is `ai.agentgem/stream`; the host block is `ai.agentgem/host`.

---

## File Structure

**PR 1 — model + scan**
- Modify: `packages/model/src/types.ts` — split `GameCapability` into `ToolCapability | ActionCapability`.
- Modify: `packages/model/src/capabilities.ts` — narrow `CAP_TOOL` to `ToolCapability`; add `CAP_METHOD` + `METHOD_CAP`.
- Modify: `packages/play/src/portability.ts` — `CAP_CLASS` gains three `"enhancement"` entries.
- Modify: `packages/play/src/capabilityScan.ts` — `deriveNeeds` gains a method matcher.
- Modify: `packages/play/src/miniapps.ts:130` — fix the `CAP_TOOL[c]` undefined bug (F7).
- Modify: `packages/console/src/panels/Play/consent.ts` — browser-safe mirror gains method caps + labels.
- Modify: `src/schemas.ts` — widen `GameArtifactSchema.needs` and `PlayNeedsSchema` enums (gem-archive contract change).
- Tests: `packages/play/src/__tests__/capabilityScan.methods.test.ts`, `packages/console/src/panels/Play/__tests__/capTool.drift.test.ts` (existing, extend).

**PR 2 — wire**
- Modify: `packages/play/src/mcpAppClient.ts` — shim v2: real `ui/initialize` params, `_meta` unwrap, new inbound handlers, new outbound methods, versioned marker.
- Modify: `packages/play/src/migrate.ts` — `MCP_CLIENT_MARKER` bump + `ensureClientShim`/backstop match `agentgem:mcp-app-client*`.
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts` — conformant `ui/initialize` result, `CallToolResult + _meta` streaming, `tool-input`, `resource-teardown`.
- Modify: `packages/console/src/panels/Play/mcpHostTools.ts` — no shape change; verify tool descriptors.
- Tests: `packages/play/src/__tests__/mcpApp.conformance.test.ts` (extend), `packages/play/src/__tests__/shimV2.frozen.test.ts` (new), `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts` (extend).

**PR 3 — host context**
- Create: `packages/play/src/hostStyles.ts` — string-emitting `applyDocumentTheme`/`applyHostStyleVariables` + the `McpUiStyleVariableKey` list.
- Modify: `packages/play/src/mcpAppClient.ts` — call host-style helpers on `host-context-changed`; conditional resize observer.
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts` — populate `hostContext`; handle `ui/request-display-mode`; push `host-context-changed`.
- Modify: `packages/console/src/panels/Play/Runner.tsx` — display-mode wire; container-dimensions; theme variable map.
- Tests: `packages/console/src/panels/Play/__tests__/Runner.test.tsx` (extend), `packages/play/src/__tests__/hostStyles.test.ts` (new).

**PR 4 — templates + inspector**
- Modify: `packages/play/src/scaffolds.ts` — `minimalTemplate` replaces `sealedTemplate`; add `heatmap`, `modeler`.
- Create: `packages/play/src/inspector.ts` — `INSPECTOR_HTML` + `INSPECTOR_META` constants.
- Modify: `packages/model/src/types.ts` — `GameGenre` gains `session-heatmap`, `scenario-modeler`.
- Modify: `packages/play/src/genres.ts` — two new `GenreSpec` entries.
- Modify: `packages/play/src/sourceContext.ts` — two new `extractSource` branches.
- Modify: `src/schemas.ts` — widen genre enums (×2).
- Modify: `src/play.controller.ts` — `GET /play/inspector`; `mcp-app?name=__inspector` synthesizes.
- Modify: `packages/play/src/builderBrief.ts` — new rules; regenerate `skills/agentgem-miniapp/SKILL.md`.
- Tests: `packages/play/src/__tests__/inspector.gate.test.ts` (new), `packages/play/src/__tests__/builderBrief.test.ts` (existing, regenerate guard), interop test extension.

---

# PR 1 — Capability model + scan

**Branch:** `feat/miniapp-cap-split` off freshly-fetched `origin/main`.
**Deliverable:** `GameCapability` splits into two unions; `deriveNeeds` sees the three new action methods; no runtime behavior changes yet (the new caps are declarable but nothing emits them). Pure model + scan.

### Task 1.1: Split the capability union

**Files:**
- Modify: `packages/model/src/types.ts:55-58`

**Interfaces:**
- Produces: `ToolCapability`, `ActionCapability`, `GameCapability = ToolCapability | ActionCapability`.

- [ ] **Step 1: Read the current union**

Run: `sed -n '50,60p' packages/model/src/types.ts`
Confirm it matches the `old_string` below before editing.

- [ ] **Step 2: Replace the union**

Replace:
```ts
export type GameCapability =
  | "session-data"          // read-only: the game's own source-session transcript ({meta,timeline}), host-brokered on demand
  | "live-session-events"   // read-only: streamed live session events (host -> /api/watch/stream)
  | "local-project-access"  // read-only: local projects / setup / inventory (host-brokered)
  | "invoke-agent";         // privileged: host runs a local ACP agent in the sandbox; game gets the transcript
```
With:
```ts
// Brokered by a host MCP tool. deriveNeeds() matches these by TOOL NAME (capabilities.ts CAP_TOOL).
export type ToolCapability =
  | "session-data"          // read-only: the game's own source-session transcript ({meta,timeline}), host-brokered on demand
  | "live-session-events"   // read-only: streamed live session events (host -> /api/watch/stream)
  | "local-project-access"  // read-only: local projects / setup / inventory (host-brokered)
  | "invoke-agent";         // privileged: host runs a local ACP agent in the sandbox; game gets the transcript

// A ui/* method on window.agentgemApp with no backing tool. deriveNeeds() matches these by METHOD NAME
// (capabilities.ts CAP_METHOD). Egress channels out of the sealed frame — see the design spec F5.
export type ActionCapability =
  | "open-link"             // ui/open-link: navigate the user to an external URL (consent-gated, URL shown)
  | "send-message"          // ui/message: speak into the conversation as the user (local-only)
  | "update-model-context"; // ui/update-model-context: push structured state into the model (local-only)

export type GameCapability = ToolCapability | ActionCapability;
```

- [ ] **Step 3: Compile the model package**

Run: `pnpm -C packages/model build`
Expected: FAIL. `capabilities.ts` `CAP_TOOL: Record<GameCapability, string>` now lacks the three action keys — a compile error. This is the F6 guard firing correctly. Proceed to Task 1.2.

- [ ] **Step 4: Commit after Task 1.2 compiles** (this task's change is not independently green; commit with 1.2).

### Task 1.2: Add the method-capability map

**Files:**
- Modify: `packages/model/src/capabilities.ts`

**Interfaces:**
- Consumes: `ToolCapability`, `ActionCapability` (Task 1.1).
- Produces: `CAP_TOOL: Record<ToolCapability, string>`, `CAP_METHOD: Record<ActionCapability, string>`, `METHOD_CAP: Record<string, ActionCapability>` (inverse), `TOOL_CAP` unchanged.

- [ ] **Step 1: Replace the map definitions**

Replace:
```ts
import type { GameCapability } from "./types.js";

export const CAP_TOOL: Record<GameCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
};

export const TOOL_CAP: Record<string, GameCapability> = Object.fromEntries(
  (Object.entries(CAP_TOOL) as [GameCapability, string][]).map(([cap, tool]) => [tool, cap]),
);
```
With:
```ts
import type { ToolCapability, ActionCapability } from "./types.js";

// ToolCapability <-> host MCP tool name. Keyed by ToolCapability so adding a tool cap without naming its
// tool is a COMPILE error (the guard portability.ts's CAP_CLASS also relies on).
export const CAP_TOOL: Record<ToolCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
};

export const TOOL_CAP: Record<string, ToolCapability> = Object.fromEntries(
  (Object.entries(CAP_TOOL) as [ToolCapability, string][]).map(([cap, tool]) => [tool, cap]),
);

// ActionCapability <-> window.agentgemApp method name. deriveNeeds() matches `agentgemApp.<method>` in
// game source. Keyed by ActionCapability: adding an action cap without naming its method is a compile error.
export const CAP_METHOD: Record<ActionCapability, string> = {
  "open-link": "openLink",
  "send-message": "sendMessage",
  "update-model-context": "updateModelContext",
};

export const METHOD_CAP: Record<string, ActionCapability> = Object.fromEntries(
  (Object.entries(CAP_METHOD) as [ActionCapability, string][]).map(([cap, m]) => [m, cap]),
);
```

- [ ] **Step 2: Compile the model package**

Run: `pnpm -C packages/model build`
Expected: PASS (`capabilities.ts` and `types.ts` now consistent). Other packages may still fail — that's Tasks 1.3-1.5.

- [ ] **Step 3: Commit Tasks 1.1 + 1.2 together**

```bash
git add packages/model/src/types.ts packages/model/src/capabilities.ts
git commit -m "feat(model): split GameCapability into ToolCapability | ActionCapability

Adds open-link/send-message/update-model-context as ActionCapability — ui/* egress
methods with no backing host tool. CAP_METHOD/METHOD_CAP mirror CAP_TOOL/TOOL_CAP so
deriveNeeds can match them by method name. Both maps stay keyed by their capability
sub-union, keeping the add-a-cap-without-naming-it-a-compile-error guard.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Classify the new caps in portability

**Files:**
- Modify: `packages/play/src/portability.ts:16-21`

**Interfaces:**
- Consumes: `GameCapability` (now 7 members).
- Produces: no new exports; `CAP_CLASS` covers all 7.

- [ ] **Step 1: Extend CAP_CLASS**

Replace:
```ts
const CAP_CLASS: Record<GameCapability, "content" | "enhancement"> = {
  "session-data": "content",
  "live-session-events": "enhancement",
  "local-project-access": "enhancement",
  "invoke-agent": "enhancement",
};
```
With:
```ts
const CAP_CLASS: Record<GameCapability, "content" | "enhancement"> = {
  "session-data": "content",
  "live-session-events": "enhancement",
  "local-project-access": "enhancement",
  "invoke-agent": "enhancement",
  "open-link": "enhancement",            // egress, never a game's primary content
  "send-message": "enhancement",
  "update-model-context": "enhancement",
};
```

- [ ] **Step 2: Compile**

Run: `pnpm -C packages/play build 2>&1 | head -30`
Expected: FAIL, but now the ONLY error is in `capabilityScan.ts`/`miniapps.ts` (Tasks 1.4, 1.5), not `portability.ts`. If `portability.ts` still errors, `CAP_CLASS` is missing a key.

### Task 1.4: Teach deriveNeeds the method matcher

**Files:**
- Modify: `packages/play/src/capabilityScan.ts`
- Test: `packages/play/src/__tests__/capabilityScan.methods.test.ts`

**Interfaces:**
- Consumes: `TOOL_CAP`, `METHOD_CAP` from `@agentgem/model`; `scannableCode` from `./gameGate.js`.
- Produces: `deriveNeeds(html) → GameCapability[]` now includes action caps found as `agentgemApp.<method>`.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/__tests__/capabilityScan.methods.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveNeeds } from "../capabilityScan.js";

const wrap = (body: string) => `<!doctype html><html><body><script>${body}</script></body></html>`;

describe("deriveNeeds — action capabilities", () => {
  it("derives open-link from an agentgemApp.openLink call", () => {
    expect(deriveNeeds(wrap(`window.agentgemApp.openLink("https://x.test")`))).toContain("open-link");
  });
  it("derives send-message and update-model-context", () => {
    const html = wrap(`agentgemApp.sendMessage({}); agentgemApp.updateModelContext({});`);
    expect(deriveNeeds(html)).toEqual(expect.arrayContaining(["send-message", "update-model-context"]));
  });
  it("does NOT derive send-message from a game-local function named sendMessage", () => {
    const html = wrap(`function sendMessage(x){ return x } sendMessage(1)`);
    expect(deriveNeeds(html)).not.toContain("send-message");
  });
  it("still derives tool caps by tool name", () => {
    const html = wrap(`agentgemApp.callTool("agentgem_get_session_data")`);
    expect(deriveNeeds(html)).toContain("session-data");
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/capabilityScan.methods.test.js`
Expected: FAIL — `open-link`/`send-message`/`update-model-context` not derived (build may also fail on the F7 error in miniapps.ts; if so do Task 1.5 first, then return here).

- [ ] **Step 3: Implement the method matcher**

In `packages/play/src/capabilityScan.ts`, change the import:
```ts
import type { GameCapability } from "@agentgem/model";
import { TOOL_CAP, METHOD_CAP } from "@agentgem/model";
```
Replace `deriveNeeds`:
```ts
export function deriveNeeds(html: string): GameCapability[] {
  const code = scannableCode(html);
  const tool = Object.keys(TOOL_CAP).filter((t) => code.includes(t)).map((t) => TOOL_CAP[t]);
  // Anchor on `agentgemApp.` — a bare `sendMessage` is a plausible game-local function name, and a bare
  // match would over-declare (then reconcileNeeds prunes it, or the Runner prompts for consent the game
  // never needs). The bridge cannot be aliased without naming `agentgemApp` at least once (see migrate.ts
  // HOST_API), so anchoring loses nothing a total scan would keep. KNOWN GAP: `var a = agentgemApp; a.openLink`
  // aliases past it — closed by convention in MINIAPP_BUILDER_BRIEF + the save-time missing-cap error, the
  // same way hasDynamicToolCall handles dynamic tool names.
  const method = Object.keys(METHOD_CAP)
    .filter((m) => code.includes(`agentgemApp.${m}`))
    .map((m) => METHOD_CAP[m]);
  return [...tool, ...method].sort();
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/capabilityScan.methods.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** (with Task 1.3 and 1.5, since 1.5 is what makes the build green).

### Task 1.5: Fix the F7 undefined-tool-name bug

**Files:**
- Modify: `packages/play/src/miniapps.ts:128-132`

**Interfaces:**
- Consumes: `CAP_TOOL`, `CAP_METHOD` from `@agentgem/model`.

- [ ] **Step 1: Read the current missing-cap error block**

Run: `sed -n '128,132p' packages/play/src/miniapps.ts`
Confirm the `rec.missing.map((c) => \`${CAP_TOOL[c]} (declare "${c}")\`)` line.

- [ ] **Step 2: Add the CAP_METHOD import**

Find the model import at `packages/play/src/miniapps.ts:10` and add `CAP_METHOD`:
```ts
import type { Gem, GameArtifact, GameGenre, GameSource, GameCapability } from "@agentgem/model";
import { CAP_TOOL, CAP_METHOD } from "@agentgem/model";
```
(If `CAP_TOOL` is already value-imported elsewhere in the file, add `CAP_METHOD` to that import instead of duplicating.)

- [ ] **Step 3: Branch the error string on which map holds the cap**

Replace:
```ts
  if (rec.missing.length) {
    const detail = rec.missing.map((c) => `${CAP_TOOL[c]} (declare "${c}")`).join("; ");
    throw new Error(`miniapp calls a host tool it does not declare: ${detail} — add it to meta.json "needs"`);
  }
```
With:
```ts
  if (rec.missing.length) {
    const detail = rec.missing.map((c) => {
      const via = (CAP_TOOL as Record<string, string>)[c] ?? `agentgemApp.${(CAP_METHOD as Record<string, string>)[c]}`;
      return `${via} (declare "${c}")`;
    }).join("; ");
    throw new Error(`miniapp uses a capability it does not declare: ${detail} — add it to meta.json "needs"`);
  }
```

- [ ] **Step 4: Compile the whole repo**

Run: `pnpm -C packages/play build && pnpm -C packages/model build`
Expected: PASS.

- [ ] **Step 5: Commit Tasks 1.3 + 1.4 + 1.5**

```bash
git add packages/play/src/portability.ts packages/play/src/capabilityScan.ts packages/play/src/miniapps.ts packages/play/src/__tests__/capabilityScan.methods.test.ts
git commit -m "feat(play): derive action capabilities from agentgemApp method calls

deriveNeeds now matches agentgemApp.openLink/sendMessage/updateModelContext, anchored
on the receiver so a game-local sendMessage() doesn't over-declare. CAP_CLASS classifies
all three as enhancement. Fixes the latent CAP_TOOL[c]=undefined error string for a
missing action cap (F7) by branching on CAP_TOOL vs CAP_METHOD.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.6: Widen the Zod contract + console mirror

**Files:**
- Modify: `src/schemas.ts:114` (`GameArtifactSchema.needs`), `src/schemas.ts:993` (`PlayNeedsSchema`)
- Modify: `packages/console/src/panels/Play/consent.ts`
- Test: `packages/console/src/panels/Play/__tests__/capTool.drift.test.ts` (existing — extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: the wire schemas accept the 7-member `needs`. **This widens the published `GameArtifactSchema` (gem-archive contract) — deliberate and additive; older consumers gain no obligation, but a v1 consumer will reject a v2 archive that declares an action cap. Acceptable: action caps are local-only or host-brokered, never present in a marketplace archive that a v1 consumer would fetch.**

- [ ] **Step 1: Define a shared needs enum in schemas.ts**

At `src/schemas.ts`, just above `GameArtifactSchema` (line ~99), add:
```ts
// The GameCapability union (packages/model types.ts) as a wire enum. Kept in lockstep by
// __tests__ drift guard. Widening this widens the gem-archive contract — additive only.
export const GameCapabilityEnum = z.enum([
  "session-data", "live-session-events", "local-project-access", "invoke-agent",
  "open-link", "send-message", "update-model-context",
]);
```

- [ ] **Step 2: Replace both inline enums**

At `src/schemas.ts:114`, replace:
```ts
  needs: z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).optional(),
```
With:
```ts
  needs: z.array(GameCapabilityEnum).optional(),
```
At `src/schemas.ts:993`, replace:
```ts
const PlayNeedsSchema = z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).optional();
```
With:
```ts
const PlayNeedsSchema = z.array(GameCapabilityEnum).optional();
```
At `src/schemas.ts:980` (inside `PlaySaveRequestSchema`), replace the same 4-member `z.array(z.enum([...]))` with `z.array(GameCapabilityEnum)` (keep its `.optional()` if present).

- [ ] **Step 3: Mirror the three new caps into the console's browser-safe copy**

In `packages/console/src/panels/Play/consent.ts`, extend `CAP_LABEL` and add method-cap awareness. Add to `CAP_LABEL`:
```ts
  "open-link": "open an external link in your browser",
  "send-message": "send a message into your conversation as you",
  "update-model-context": "push structured state into the model's context",
```
Extend `CONSENT_CAPS` to include the three new caps (they are all consent-gated — `open-link` prompts per call, the other two are remembered-but-local-only; the local-only enforcement lands in PR 3 Task 3.5, so here they are simply declarable):
```ts
export const CONSENT_CAPS = [
  "local-project-access", "live-session-events", "invoke-agent",
  "open-link", "send-message", "update-model-context",
] as const;
```
Do NOT add the caps to `CAP_TOOL`/`TOOL_CAP` in consent.ts — those stay tool-only (they mirror `@agentgem/model`'s `CAP_TOOL`, now `ToolCapability`-keyed).

- [ ] **Step 4: Extend the drift guard**

Run: `sed -n '1,40p' packages/console/src/panels/Play/__tests__/capTool.drift.test.ts`
The guard pins consent.ts's `CAP_TOOL` to the canonical map. It should still pass unchanged (tool map is unchanged). Add an assertion that consent.ts `CONSENT_CAPS` covers every model `ActionCapability`:
```ts
import { CAP_METHOD } from "@agentgem/model";
import { CONSENT_CAPS } from "../consent.js";
it("CONSENT_CAPS covers every ActionCapability", () => {
  for (const cap of Object.keys(CAP_METHOD)) expect(CONSENT_CAPS).toContain(cap);
});
```

- [ ] **Step 5: Typecheck root + console**

Run: `pnpm -C packages/console exec tsc --noEmit && node scripts/build-console.mjs`
Then: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/capTool.drift.test.tsx` (adjust extension to the file's actual `.ts`/`.tsx`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts packages/console/src/panels/Play/consent.ts packages/console/src/panels/Play/__tests__/capTool.drift.test.ts
git commit -m "feat(schemas,console): accept action capabilities on the wire and in consent

Widens GameArtifactSchema.needs / PlayNeedsSchema via a shared GameCapabilityEnum to the
7-member union. Mirrors the three action caps into the console's consent labels and
CONSENT_CAPS. Additive gem-archive contract change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### PR 1 finish

- [ ] Run full play dist-suite: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run`
- [ ] Run console Play tests: `pnpm -C packages/console exec vitest run src/panels/Play`
- [ ] Push branch, open PR, `gh run watch <id> --exit-status`, merge `--rebase --delete-branch` once `test (24)`+`test (26)` green. Verify each commit's marker is on `origin/main` after merge (`git fetch && git grep -c ActionCapability origin/main -- packages/model/src/types.ts`).

---

# PR 2 — Wire conformance

**Branch:** `feat/miniapp-wire-v2` off freshly-fetched `origin/main` (after PR 1 merged).
**Deliverable:** The shim and host speak the real MCP Apps wire; `window.agentgemApp` is byte-frozen; a v1-shim fixture heals to v2 on read with identical game logic. **Atomic — shim and host must land together.**

### Task 2.1: Version the marker; match any shim version in migrate

**Files:**
- Modify: `packages/play/src/mcpAppClient.ts:14` (marker), `packages/play/src/migrate.ts`

**Interfaces:**
- Produces: `MCP_CLIENT_MARKER = "agentgem:mcp-app-client:2"`; `ensureClientShim`/`migrateMiniappHtml` replace ANY `agentgem:mcp-app-client*` region.

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/__tests__/shimV2.frozen.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ensureClientShim } from "../migrate.js";
import { MCP_CLIENT_MARKER } from "../mcpAppClient.js";

// A stored v1 miniapp: old marker, game logic that reads agentgemApp.
const V1 = `<!doctype html><html><head><script>
// agentgem:mcp-app-client
(function(){ window.agentgemApp = { callTool(){}, onNotification(){} }; })();
</script></head><body><script>
window.agentgemApp.onNotification("ui/notifications/tool-result", function (p) {
  if (p && p.toolName === "agentgem_get_session_data") { boot(p.chunk); }
});
</script></body></html>`;

describe("shim v2 migration", () => {
  it("uses a versioned marker", () => {
    expect(MCP_CLIENT_MARKER).toBe("agentgem:mcp-app-client:2");
  });
  it("replaces a v1 shim region with v2, leaving game logic byte-identical", () => {
    const out = ensureClientShim(V1);
    expect(out).toContain("agentgem:mcp-app-client:2");
    expect(out).not.toContain("// agentgem:mcp-app-client\n"); // the old marker line is gone
    // The game-logic script (the onNotification block) is untouched.
    expect(out).toContain(`if (p && p.toolName === "agentgem_get_session_data") { boot(p.chunk); }`);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/shimV2.frozen.test.js`
Expected: FAIL — marker is still `agentgem:mcp-app-client`, and `ensureClientShim` no-ops on a doc that already contains the (old) marker.

- [ ] **Step 3: Bump the marker and generalize the match**

In `packages/play/src/mcpAppClient.ts`:
```ts
export const MCP_CLIENT_MARKER = "agentgem:mcp-app-client:2";
// Matches any shim version so the on-read backstop can replace an older one wholesale.
export const MCP_CLIENT_MARKER_RE = /agentgem:mcp-app-client(?::\d+)?/;
```
Change the emitted comment line inside `mcpAppClient()` from `// ${MCP_CLIENT_MARKER}` — it already interpolates the constant, so it now emits `:2`. No further change there.

In `packages/play/src/migrate.ts`, import the regex and make `ensureClientShim` replace an existing older shim rather than no-op:
```ts
import { MCP_CLIENT_MARKER, MCP_CLIENT_MARKER_RE, mcpAppClient } from "./mcpAppClient.js";

export function ensureClientShim(html: string): string {
  if (!html.includes(HOST_API)) return html;                 // talks to no host — nothing to do
  if (html.includes(MCP_CLIENT_MARKER)) return html;         // already current
  if (MCP_CLIENT_MARKER_RE.test(html)) return replaceShim(html); // an OLDER shim — swap it wholesale
  return injectClientShim(html);                             // no shim at all — inject
}

// Replace the <script>…older marker…</script> element with the current shim script. The shim is always a
// single <script> whose body carries the marker comment; walk from its <script open to the matching close.
function replaceShim(html: string): string {
  const markerIdx = html.search(MCP_CLIENT_MARKER_RE);
  if (markerIdx === -1) return injectClientShim(html);
  const open = html.lastIndexOf("<script", markerIdx);
  const closeToken = "</script>";
  const close = html.indexOf(closeToken, markerIdx);
  if (open === -1 || close === -1) return injectClientShim(html);
  return html.slice(0, open) + mcpAppClient().trim() + html.slice(close + closeToken.length);
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/shimV2.frozen.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/mcpAppClient.ts packages/play/src/migrate.ts packages/play/src/__tests__/shimV2.frozen.test.js 2>/dev/null; git add packages/play/src/__tests__/shimV2.frozen.test.ts
git commit -m "feat(play): version the client shim marker; replace older shims on read

MCP_CLIENT_MARKER -> agentgem:mcp-app-client:2. ensureClientShim now swaps an older shim
region wholesale instead of no-opping, so readMiniapp's on-read backstop heals a v1 miniapp
to v2. One marker, one region, one migration.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Shim v2 — conformant ui/initialize params + _meta unwrap

**Files:**
- Modify: `packages/play/src/mcpAppClient.ts` (the emitted script body)
- Test: `packages/play/src/__tests__/mcpApp.conformance.test.ts` (extend)

**Interfaces:**
- Produces: the shim sends `ui/initialize` with `{appInfo, appCapabilities, protocolVersion}`; unwraps `ui/notifications/tool-result` `CallToolResult` into the frozen `{toolName, chunk}`; `window.agentgemApp` API unchanged.

- [ ] **Step 1: Write the failing conformance test**

Add to `packages/play/src/__tests__/mcpApp.conformance.test.ts` (create if the harness there doesn't already parse the shim; use a jsdom or regex assertion consistent with the existing file's style):
```ts
import { mcpAppClient } from "../mcpAppClient.js";

describe("shim v2 wire", () => {
  const src = mcpAppClient();
  it("sends ui/initialize with appInfo + appCapabilities + protocolVersion", () => {
    expect(src).toContain('method: "ui/initialize"');
    expect(src).toMatch(/appInfo\s*:/);
    expect(src).toMatch(/appCapabilities\s*:/);
    expect(src).toMatch(/protocolVersion\s*:\s*"2026-01-26"/);
  });
  it("unwraps tool-result _meta stream identity into {toolName, chunk}", () => {
    expect(src).toContain('ai.agentgem/stream');
    expect(src).toContain("structuredContent");
  });
  it("does not read a top-level `tools` off the initialize result", () => {
    // v2 reads granted tools from _meta['ai.agentgem/host'], not result.tools.
    expect(src).toContain('ai.agentgem/host');
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js`
Expected: FAIL.

- [ ] **Step 3: Rewrite the shim body**

Replace the `sendInit` and the message handler in `packages/play/src/mcpAppClient.ts` with the v2 logic. The full emitted script (preserving the frozen API and the bounded-retry handshake):

```js
window.addEventListener("message", function (e) {
  if (e.source !== host) return;
  var d = e.data;
  if (!d || d.jsonrpc !== "2.0") return;
  if (d.id != null && initIds[d.id] && d.result && !api.ready) {  // ui/initialize result
    api.ready = true;
    var hostMeta = (d.result._meta || {})["ai.agentgem/host"] || {};
    api.hostTools = hostMeta.tools || [];                          // granted tools ride _meta now, not result.tools
    api.hostContext = d.result.hostContext || {};
    if (api.hostContext) applyHostContext(api.hostContext);        // PR 3 wires applyHostContext; PR 2 defines a no-op
    if (iv) { clearInterval(iv); iv = null; }
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    for (var qi = 0; qi < queue.length; qi++) post(queue[qi]);
    queue = [];
    return;
  }
  if (d.id != null && pending[d.id]) {                             // tools/call reply
    var p = pending[d.id]; delete pending[d.id];
    if (d.error) p.reject(new Error((d.error && d.error.message) || "tool error"));
    else p.resolve(d.result);
    return;
  }
  if (d.method === "ui/notifications/tool-result" && d.params) {   // spec: params IS a CallToolResult
    var s = (d.params._meta || {})["ai.agentgem/stream"] || {};
    var evt = { toolName: s.toolName, chunk: d.params.structuredContent };  // FROZEN shape the games expect
    dispatch("ui/notifications/tool-result", evt);
    return;
  }
  if (d.method === "ui/notifications/tool-input" && d.params) {    // launcher args (host->app)
    dispatch("ui/notifications/tool-input", d.params.arguments || {});
    return;
  }
  if (d.method === "ui/notifications/tool-cancelled") { dispatch("ui/notifications/tool-cancelled", d.params || {}); return; }
  if (d.method === "ui/notifications/host-context-changed" && d.params) {
    api.hostContext = Object.assign(api.hostContext || {}, d.params);
    applyHostContext(d.params);                                    // PR 3
    dispatch("ui/notifications/host-context-changed", d.params);
    return;
  }
  if (d.method === "ui/resource-teardown") {                       // REQUEST — must reply
    var res = {};
    try { dispatch("ui/resource-teardown", d.params || {}); } catch (err) { /* handler threw */ }
    post({ jsonrpc: "2.0", id: d.id, result: res });
    return;
  }
});
```
And `sendInit`:
```js
function sendInit() {
  var id = nextId++; initIds[id] = 1;
  post({ jsonrpc: "2.0", id: id, method: "ui/initialize", params: {
    appInfo: { name: "agentgem-miniapp", version: "2" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: "2026-01-26",
  }});
}
```
Add a `dispatch` helper and generalize `onNotification` subscriptions (the old code inlined the loop):
```js
function dispatch(method, payload) {
  var list = (subs[method] || []).concat(subs["*"] || []);
  for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (err) { /* subscriber threw */ } }
}
```
Add a **no-op** `applyHostContext` for PR 2 (PR 3 Task 3.2 replaces it with the real body):
```js
function applyHostContext(ctx) { /* PR 3 fills this in (theme/styles/size) */ }
```
Keep `api.hostContext = {}` initialized on the `api` object. Everything else (`callTool`, `onNotification`, the queue, the bounded retry, `window.agentgemApp = api`) stays byte-identical.

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js dist/**/__tests__/shimV2.frozen.test.js`
Expected: PASS (both — the frozen test proves game logic is preserved; the conformance test proves the wire).

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/mcpAppClient.ts packages/play/src/__tests__/mcpApp.conformance.test.ts
git commit -m "feat(play): shim v2 speaks conformant ui/initialize and unwraps CallToolResult

ui/initialize now carries {appInfo, appCapabilities, protocolVersion}. Granted tools read
from result._meta['ai.agentgem/host'], not an invented top-level tools field. tool-result
params is a real CallToolResult; the shim unwraps _meta['ai.agentgem/stream'] +
structuredContent back into the frozen {toolName, chunk} the games consume. Adds handlers
for tool-input, tool-cancelled, host-context-changed, and the resource-teardown request.
window.agentgemApp is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Host router — conformant initialize result + _meta streaming

**Files:**
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts`
- Test: `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts` (extend)

**Interfaces:**
- Consumes: `HOST_TOOLS`, `TOOL_CAP` (mcpHostTools).
- Produces: `ui/initialize` reply of the spec shape; `notify()` emits a `CallToolResult` with `_meta["ai.agentgem/stream"]`.

- [ ] **Step 1: Write the failing test**

Add to `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts` a case that drives `handleMessage` with a `ui/initialize` and asserts the reply shape, and one that captures a streamed `notify` and asserts `params` is a `CallToolResult` with `_meta`:
```ts
it("ui/initialize reply is spec-shaped (no top-level tools, tools under _meta)", () => {
  const posted: any[] = [];
  const target = { postMessage: (m: any) => posted.push(m) } as any;
  const host = createUiHost({ apiBase: "", name: "g", needs: ["session-data"], interactive: true, target, requestConsent: async () => true });
  host.handleMessage({ source: target, data: { jsonrpc: "2.0", id: 1, method: "ui/initialize" } } as any);
  const r = posted[0].result;
  expect(r).toHaveProperty("hostInfo");
  expect(r).toHaveProperty("hostCapabilities");
  expect(r).not.toHaveProperty("tools");
  expect(r._meta["ai.agentgem/host"].tools.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/mcpUiHost.test.ts`
Expected: FAIL — current reply has a top-level `tools` and no `hostInfo`/`hostCapabilities`.

- [ ] **Step 3: Rewrite the initialize reply and notify**

In `mcpUiHost.ts`, replace the `notify` definition:
```ts
// Spec: a tool-result notification's params IS a CallToolResult. Stream identity + sequencing ride the
// spec's sanctioned _meta passthrough, so a conformant external host relays it and a conformant client
// ignores it. Our shim unwraps it back to {toolName, chunk}.
const notify = (toolName: string, chunk: unknown) => post({
  jsonrpc: "2.0", method: "ui/notifications/tool-result",
  params: {
    content: [],
    structuredContent: chunk,
    _meta: { "ai.agentgem/stream": { toolName } },
  },
});
```
Replace the `ui/initialize` branch in `handleMessage`:
```ts
if (d.method === "ui/initialize") {
  const tools = HOST_TOOLS.filter((t) => deps.needs.includes(TOOL_CAP[t.name]));
  reply(d.id, {
    protocolVersion: PROTOCOL_VERSION,
    hostInfo: { name: "agentgem-console", version: "2" },
    hostCapabilities: { serverTools: {}, openLinks: {}, sandbox: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } },
    hostContext: deps.hostContext ? deps.hostContext() : {},   // PR 3 supplies hostContext(); PR 2 leaves {} via optional dep
    _meta: { "ai.agentgem/host": { tools } },
  });
  return;
}
```
Add `hostContext?: () => Record<string, unknown>` to `UiHostDeps` (optional so PR 2 compiles without PR 3):
```ts
export interface UiHostDeps {
  apiBase: string;
  name: string;
  needs: string[];
  interactive: boolean;
  target: Window;
  requestConsent: (cap: string) => Promise<boolean>;
  hostContext?: () => Record<string, unknown>;   // PR 3 wires the Runner's live theme/size; PR 2: absent -> {}
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/mcpUiHost.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/mcpUiHost.ts packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts
git commit -m "feat(console): host emits spec-shaped ui/initialize result and CallToolResult streams

Drops the invented top-level tools field; granted tools ride _meta['ai.agentgem/host'].
tool-result notifications now send a real CallToolResult with stream identity in
_meta['ai.agentgem/stream']. Adds an optional hostContext() dep (PR 3 fills it).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: tool-input makes the launcher parameterizable

**Files:**
- Modify: `packages/play/src/mcpApp.ts:73-80` (`mcpToolFor` inputSchema)

**Interfaces:**
- Produces: `play_<name>` tool carries a real (if minimal) input schema, so an external host can pass `tool-input`.

- [ ] **Step 1: Write the failing test**

Add to `packages/play/src/__tests__/mcpApp.conformance.test.ts`:
```ts
it("launcher tool declares an input schema (not empty)", () => {
  const app = mcpAppFor({ name: "g", html: "<html></html>", meta: { title: "T", genre: "replay", createdFrom: { kind: "blank", title: "T" }, engineVersion: "2" } as any });
  expect(app.tool.inputSchema.type).toBe("object");
  // A minimal but present property, so a host has something to stream as tool-input.
  expect(app.tool.inputSchema.properties).toHaveProperty("view");
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js`
Expected: FAIL — `properties` is `{}`.

- [ ] **Step 3: Give the launcher a minimal input schema**

In `packages/play/src/mcpApp.ts`, replace `mcpToolFor`'s `inputSchema`:
```ts
    inputSchema: {
      type: "object",
      properties: {
        // Optional focus hint an external host may stream via ui/notifications/tool-input. The shim
        // dispatches it on "ui/notifications/tool-input"; a game may ignore it (our own Runner does).
        view: { type: "string", description: "optional initial view/state hint" },
      },
    },
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/mcpApp.ts packages/play/src/__tests__/mcpApp.conformance.test.ts
git commit -m "feat(play): give the launcher tool a minimal input schema

An empty inputSchema made play_<name> unparameterizable from an external host. A single
optional 'view' hint lets a host stream ui/notifications/tool-input; the shim dispatches it
and games may ignore it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.5: Schema-validated conformance (vendor the spec schema)

**Files:**
- Modify: `packages/play/package.json` (devDependency on `@modelcontextprotocol/ext-apps` for its `schema.json` export)
- Test: `packages/play/src/__tests__/mcpApp.conformance.test.ts` (extend)

**Interfaces:**
- Consumes: `@modelcontextprotocol/ext-apps/schema.json`.

- [ ] **Step 1: Add the devDependency**

Run: `pnpm -C packages/play add -D @modelcontextprotocol/ext-apps@1.7.4`
Note: this is a **dev/test-only** dependency, never bundled into an artifact (spec F4 — the SDK is not inlined). Confirm it lands under `devDependencies`.

- [ ] **Step 2: Write the schema-validation test**

Add to `mcpApp.conformance.test.ts`:
```ts
import Ajv from "ajv";
import schema from "@modelcontextprotocol/ext-apps/schema.json" assert { type: "json" };
// Validate our emitted ui/initialize request against the spec's McpUiInitializeRequest definition.
it("shim's ui/initialize request validates against the published schema", () => {
  const ajv = new Ajv({ strict: false });
  // Extract the request literal the shim posts (parse it out of the emitted script, or duplicate the
  // object here and assert the shim contains it — whichever the existing test file already does).
  const req = { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
    appInfo: { name: "agentgem-miniapp", version: "2" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: "2026-01-26",
  }};
  const validate = ajv.getSchema("#/definitions/McpUiInitializeRequest") ?? ajv.compile((schema as any).definitions.McpUiInitializeRequest);
  expect(validate(req)).toBe(true);
});
```
If `ajv` is not already a dependency, add it: `pnpm -C packages/play add -D ajv`. (Adjust the `$ref`/definition name to the actual key in the vendored `schema.json` — inspect with `node -e "console.log(Object.keys(require('@modelcontextprotocol/ext-apps/schema.json').definitions))"`.)

- [ ] **Step 3: Run it**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js`
Expected: PASS. If the definition name differs, fix the ref and re-run.

- [ ] **Step 4: Confirm CI won't try to bundle the SDK**

Run: `grep -n "ext-apps" packages/play/package.json`
Expected: appears only under `devDependencies`. The publish bundler keeps root deps external; a devDependency is never in the tarball. Confirm no `import ... from "@modelcontextprotocol/ext-apps"` exists in any non-test `src/` file: `grep -rn "ext-apps" packages/play/src | grep -v __tests__` → no output.

- [ ] **Step 5: Commit**

```bash
git add packages/play/package.json packages/play/src/__tests__/mcpApp.conformance.test.ts ../../pnpm-lock.yaml 2>/dev/null; git add pnpm-lock.yaml
git commit -m "test(play): validate emitted wire messages against the published MCP Apps schema

Vendors @modelcontextprotocol/ext-apps as a dev-only dependency purely for its schema.json
export, and validates our ui/initialize request against it. Converts 'we read the spec' into
a test that fails when the spec moves. Never bundled into an artifact (SDK is not inlined).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.6: Verify `_meta` passthrough in the reference host

**Files:**
- Test: `packages/play/src/__tests__/mcpApp.conformance.test.ts` or the existing interop harness under `packages/play/src/play/__tests__/`.

**Interfaces:** none — this is the risk-retiring check for D1.

- [ ] **Step 1: Locate the existing interop harness**

Run: `ls packages/play/src/play/__tests__/ 2>/dev/null; grep -rln "mcp-ui/client\|AppBridge\|AppRenderer" packages/play`
The prior stack built `mcpApp.conformance.test.ts` with a `@mcp-ui/client` render. Reuse it.

- [ ] **Step 2: Assert `_meta` survives a round-trip through AppBridge**

Extend the interop harness: after `initialized`, have the fake server push a `ui/notifications/tool-result` with `params._meta["ai.agentgem/stream"] = {toolName:"agentgem_get_session_data"}` and `structuredContent`, and assert the view (our shim) received `{toolName:"agentgem_get_session_data", chunk:<structuredContent>}`. If `@mcp-ui/client`'s AppBridge strips `_meta`, this fails — that is the D1 risk, and the fallback is the namespaced method.

- [ ] **Step 3: Run it**

Run: per the harness's documented command (it is a dist-run browser test — see the file header; do NOT invent a package-local vitest.config).
Expected: PASS. **If it FAILS because `_meta` is stripped:** implement the fallback — add a `ai.agentgem/notifications/stream` branch to the shim (Task 2.2) and switch `notify` (Task 2.3) to that method. Because the API is frozen, no game changes. Document the fallback in the spec's Open Risks. Then re-run.

- [ ] **Step 4: Commit** (fold into 2.5's commit if trivial, else its own).

### Task 2.7: readMiniapp heals a stored v1 fixture end-to-end

**Files:**
- Test: `packages/play/src/__tests__/shimV2.frozen.test.ts` (extend with a `readMiniapp` round-trip)

- [ ] **Step 1: Extend the frozen test with a filesystem round-trip**

Add a case that writes a v1 fixture into a temp miniapps root, calls `readMiniapp(name)`, and asserts the returned html carries `:2` and byte-identical game logic. Follow the existing pattern for temp-root miniapp tests in the play suite (`grep -rn "miniappsRoot\|mkdtemp" packages/play/src/__tests__`). If no such pattern exists, assert at the `ensureClientShim`/`migrateMiniappHtml` layer only (Task 2.1 already covers that) and note the filesystem round-trip is covered by the existing `migrate` suite.

- [ ] **Step 2: Run the whole play + console Play suites**

Run:
```bash
pnpm -C packages/play build && pnpm -C packages/play exec vitest run
pnpm -C packages/console exec vitest run src/panels/Play
```
Expected: PASS. No stored-miniapp game logic changed anywhere.

- [ ] **Step 3: Commit, then PR 2 finish** (push, watch CI, rebase-merge, verify every commit's marker on `origin/main`).

---

# PR 3 — Host context, sizing, display mode

**Branch:** `feat/miniapp-host-context` off freshly-fetched `origin/main` (after PR 2 merged).
**Deliverable:** Games receive real theme/CSS-variables/container-dimensions and a working display-mode round-trip; the Runner's fullscreen stops magnifying; the `applyHostContext` no-op from PR 2 becomes real.

### Task 3.1: Port the host-style helpers

**Files:**
- Create: `packages/play/src/hostStyles.ts`
- Test: `packages/play/src/__tests__/hostStyles.test.ts`

**Interfaces:**
- Produces: `hostStyleScript(): string` — an emittable JS fragment defining `applyDocumentTheme(theme)` and `applyHostStyleVariables(vars)` for injection into the shim. Also `MCP_UI_STYLE_KEYS: string[]` (the `McpUiStyleVariableKey` subset the console maps).

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/__tests__/hostStyles.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hostStyleScript, MCP_UI_STYLE_KEYS } from "../hostStyles.js";

describe("hostStyles", () => {
  it("emits applyDocumentTheme and applyHostStyleVariables", () => {
    const s = hostStyleScript();
    expect(s).toContain("function applyDocumentTheme");
    expect(s).toContain("function applyHostStyleVariables");
    expect(s).toContain("data-theme");
    expect(s).toContain("color-scheme");
  });
  it("lists the standardized color keys the console maps", () => {
    expect(MCP_UI_STYLE_KEYS).toContain("--color-background-primary");
    expect(MCP_UI_STYLE_KEYS).toContain("--color-text-primary");
  });
  it("does NOT emit applyHostFonts (sealed CSP forbids @font-face URLs)", () => {
    expect(hostStyleScript()).not.toContain("applyHostFonts");
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/hostStyles.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement hostStyles.ts**

Create `packages/play/src/hostStyles.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// String-emitting port of ext-apps/src/styles.ts — applyDocumentTheme + applyHostStyleVariables, injected
// into the sealed shim so a miniapp themes to the host with no code. applyHostFonts is deliberately NOT
// ported: it injects @font-face with a URL, and SEALED_CSP.resourceDomains is [] (no font-src origin).
// Pure string. No imports, no I/O.

// The standardized keys the console maps from its warm-paper palette. A subset of McpUiStyleVariableKey;
// the shim writes whatever the host sends, this list documents what the console actually provides.
export const MCP_UI_STYLE_KEYS = [
  "--color-background-primary", "--color-background-secondary",
  "--color-text-primary", "--color-border-primary",
];

export function hostStyleScript(): string {
  return `
function applyDocumentTheme(theme) {
  if (!theme) return;
  var el = document.documentElement;
  el.setAttribute("data-theme", theme);
  el.style.colorScheme = theme;
}
function applyHostStyleVariables(vars) {
  if (!vars) return;
  var root = document.documentElement;
  for (var k in vars) { if (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null) root.style.setProperty(k, vars[k]); }
}`;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/hostStyles.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/hostStyles.ts packages/play/src/__tests__/hostStyles.test.ts
git commit -m "feat(play): port ext-apps style helpers as an emittable script (no fonts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Wire applyHostContext + conditional resize in the shim

**Files:**
- Modify: `packages/play/src/mcpAppClient.ts` — replace the PR-2 no-op `applyHostContext`; import + inline `hostStyleScript()`.

**Interfaces:**
- Consumes: `hostStyleScript` (Task 3.1).
- Produces: shim applies theme+vars on initialize and on `host-context-changed`; installs a `size-changed` observer only when the host left sizing unspecified.

- [ ] **Step 1: Write the failing test**

Add to `mcpApp.conformance.test.ts`:
```ts
it("shim inlines the host-style helpers and applies context", () => {
  const src = mcpAppClient();
  expect(src).toContain("applyDocumentTheme");
  expect(src).toContain("applyHostStyleVariables");
  // Only observes size when the host did not fix dimensions.
  expect(src).toContain("containerDimensions");
});
```

- [ ] **Step 2: Run, watch fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js`
Expected: FAIL (the PR-2 `applyHostContext` is a no-op with none of these strings).

- [ ] **Step 3: Inline the helpers and implement applyHostContext**

At the top of the emitted script in `mcpAppClient.ts`, inline `hostStyleScript()` (import it and interpolate: `${hostStyleScript()}`). Replace the no-op:
```js
function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
}
```
Add the conditional resize observer, run once after the initialize result resolves:
```js
function maybeObserveSize(ctx) {
  var cd = (ctx && ctx.containerDimensions) || {};
  if (cd.width != null && cd.height != null) return;       // host fixed our size (our Runner does) — do not report
  if (typeof ResizeObserver === "undefined") return;
  var report = function () {
    var h = document.documentElement.scrollHeight, w = window.innerWidth;
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: w, height: h } });
  };
  try { new ResizeObserver(report).observe(document.documentElement); report(); } catch (e) { /* no-op */ }
}
```
Call `maybeObserveSize(api.hostContext)` right after `applyHostContext(api.hostContext)` in the initialize-result branch.

- [ ] **Step 4: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/mcpApp.conformance.test.js dist/**/__tests__/shimV2.frozen.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/mcpAppClient.ts packages/play/src/__tests__/mcpApp.conformance.test.ts
git commit -m "feat(play): shim applies host theme/styles and reports size only when unfixed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Runner supplies hostContext + display-mode round-trip

**Files:**
- Modify: `packages/console/src/panels/Play/Runner.tsx`
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts`
- Test: `packages/console/src/panels/Play/__tests__/Runner.test.tsx` (extend)

**Interfaces:**
- Consumes: `createUiHost` `hostContext?` dep (PR 2 Task 2.3); `UiHost` gains `pushHostContext(partial)`.
- Produces: Runner passes a `hostContext()` returning `{theme, styles:{variables}, displayMode, availableDisplayModes, containerDimensions}`; handles `ui/request-display-mode`; pushes `host-context-changed` on fullscreen toggle.

- [ ] **Step 1: Write the failing test**

Add to `Runner.test.tsx` a test that mounts an interactive Runner, simulates the iframe posting `ui/request-display-mode {mode:"fullscreen"}`, and asserts (a) the Runner enters fullscreen and (b) a `host-context-changed` with `displayMode:"fullscreen"` is posted back. Follow the existing Runner.test wiring for faking `iframe.contentWindow` + message events.

- [ ] **Step 2: Run, watch fail**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Runner.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add request-display-mode + host-context push to the router**

In `mcpUiHost.ts`, extend `UiHost`:
```ts
export interface UiHost {
  handleMessage(e: MessageEvent): void;
  dispose(): void;
  bumpGeneration(): void;
  feedSessionData(sessionId: string, agent: string): void;
  pushHostContext(partial: Record<string, unknown>): void;   // NEW
}
```
Add the notification helper + method impl:
```ts
const notifyCtx = (partial: Record<string, unknown>) =>
  post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: partial });
function pushHostContext(partial: Record<string, unknown>): void { notifyCtx(partial); }
```
Add a `ui/request-display-mode` branch in `handleMessage` that calls an injected `deps.onDisplayMode(mode)` and replies with the applied mode:
```ts
if (d.method === "ui/request-display-mode") {
  const req = (d.params as { mode?: string } | undefined)?.mode ?? "inline";
  const applied = deps.onDisplayMode ? deps.onDisplayMode(req) : "inline";
  reply(d.id, { mode: applied });
  return;
}
```
Add `onDisplayMode?: (mode: string) => string` to `UiHostDeps`, and return `pushHostContext` from `createUiHost`.

- [ ] **Step 4: Wire the Runner**

In `Runner.tsx`:
- Build a `hostContext()` callback returning the live context. Map the console palette to standardized keys:
```ts
const hostContext = useCallback(() => ({
  theme: "light",
  styles: { variables: {
    "--color-background-primary": "var(--paper)",
    "--color-background-secondary": "var(--paper-2)",
    "--color-text-primary": "var(--ink)",
    "--color-border-primary": "var(--line)",
  }},
  displayMode: fs ? "fullscreen" : "inline",
  availableDisplayModes: ["inline", "fullscreen"],
  containerDimensions: { width: vw, height: vh },
}), [fs, vw, vh]);
```
  **Note:** the CSS variable *values* must resolve to concrete colors inside the sealed frame, which cannot see the console's stylesheet. Resolve them at call time with `getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()` and send the resolved hex, not the `var(...)` reference. Update the map accordingly.
- Pass `hostContext` and `onDisplayMode: (m) => { const ok = interactive && m === "fullscreen"; setFs(ok); return ok ? "fullscreen" : "inline"; }` into `createUiHost`.
- In the existing `setFs` effect/handler, after toggling, call `hostRef.current?.pushHostContext({ displayMode: fs ? "fullscreen" : "inline", containerDimensions: fs ? { width: window.innerWidth, height: window.innerHeight } : { width: vw, height: vh } })`. Ensure this fires on BOTH button-toggle and request-driven toggle (drive it off a `useEffect` on `fs`).

- [ ] **Step 5: Run the test**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Runner.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Play/Runner.tsx packages/console/src/panels/Play/mcpUiHost.ts packages/console/src/panels/Play/__tests__/Runner.test.tsx
git commit -m "feat(console): Runner supplies live host context and a display-mode round-trip

hostContext() reports resolved theme colors, availableDisplayModes and containerDimensions
(the virtual vw×vh the game lays out against — the fix for the scale() sizing bug). A game's
ui/request-display-mode enters/exits fullscreen and the reply echoes the applied mode; any
fullscreen toggle pushes host-context-changed so the game re-lays-out at real screen size.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.4: Enforce local-only for send-message / update-model-context

**Files:**
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts` (or `consent.ts` where invoke-agent's local-only rule lives)
- Test: `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts`

**Interfaces:** none new — mirrors the existing `invoke-agent` `permission: deny` for shared/marketplace games.

- [ ] **Step 1: Find how invoke-agent is restricted to local games**

Run: `grep -rn "invoke-agent\|LOCAL_ONLY\|permission\|deny\|shared\|marketplace" packages/console/src/panels/Play/*.ts packages/marketplace/src/GamePlayer.tsx`
The Runner passes `interactive` and a context flag; invoke-agent is denied on non-local. Locate that gate.

- [ ] **Step 2: Write the failing test**

Assert that `open-link` is allowed (consent-gated) but `send-message`/`update-model-context` are denied when the host is constructed in a marketplace/shared context (mirror however the existing invoke-agent test sets that up). If the console has no marketplace context flag on `createUiHost` today (invoke-agent may be gated in the marketplace's own `GamePlayer` rather than the router), gate these two the SAME place invoke-agent is gated — do not invent a new mechanism.

- [ ] **Step 3: Add the two caps to the local-only set**

Wherever `invoke-agent` is listed as local-only, add `send-message` and `update-model-context`. If it is a `Set`/array constant, extend it:
```ts
const LOCAL_ONLY_CAPS = new Set(["invoke-agent", "send-message", "update-model-context"]);
```

- [ ] **Step 4: Run tests**

Run: `pnpm -C packages/console exec vitest run src/panels/Play`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(console): send-message and update-model-context are local-only like invoke-agent

A marketplace miniapp must not speak into the viewer's conversation or feed their model.
Same gate invoke-agent already uses; open-link stays consent-gated (URL shown) and remains
available to shared games.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### PR 3 finish

- [ ] `pnpm -C packages/play build && pnpm -C packages/play exec vitest run`
- [ ] `pnpm -C packages/console exec vitest run src/panels/Play`
- [ ] Manual dogfood: seed a replay, open it, toggle fullscreen — confirm it re-lays-out at screen size (not magnified) and picks up console paper colors. Use the browser-harness or `/run`.
- [ ] Push, watch CI, rebase-merge, verify commits on `origin/main`.

---

# PR 4 — Templates, inspector, brief

**Branch:** `feat/miniapp-templates` off freshly-fetched `origin/main` (after PR 3 merged).
**Deliverable:** `minimalTemplate` replaces `sealedTemplate`; two new genres (`session-heatmap`, `scenario-modeler`) with ported scaffolds; a built-in Protocol Inspector served by a dev route (never saved); the builder brief + generated SKILL.md updated.

### Task 4.1: minimalTemplate replaces sealedTemplate

**Files:**
- Modify: `packages/play/src/scaffolds.ts`
- Test: `packages/play/src/__tests__/scaffolds.gate.test.ts` (create — every scaffold must pass gameGate)

**Interfaces:**
- Produces: `minimalTemplate(title, subtitle)` adopting the handlers-before-connect shape; `SCAFFOLDS` keys unchanged for `skill-run`/`project-fun` (now built by `minimalTemplate`).

- [ ] **Step 1: Write the failing test — every scaffold passes the gate**

Create `packages/play/src/__tests__/scaffolds.gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scaffoldFor } from "../scaffolds.js";
import { gameGate } from "../gameGate.js";

const IDS = ["replay", "skill-run", "project-fun", "heatmap", "modeler"];
describe("scaffolds pass the gate", () => {
  for (const id of IDS) {
    it(`${id} loads sealed`, async () => {
      const r = await gameGate(scaffoldFor(id));
      expect(r.ok, r.failures.join("; ")).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run, watch fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/scaffolds.gate.test.js`
Expected: FAIL — `heatmap`/`modeler` unknown (Tasks 4.2/4.3); rename may also be pending.

- [ ] **Step 3: Add minimalTemplate**

In `scaffolds.ts`, rename `sealedTemplate` to `minimalTemplate` and update its body to the canonical shape (register handlers, then connect, then apply context). Keep the shim first in `<head>`. The game IIFE should demonstrate reading `agentgemApp` context safely with fallbacks:
```ts
export function minimalTemplate(title: string, subtitle: string): string {
  return `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  html,body { height:100%; margin:0;
    background: var(--color-background-primary, #0d1117);
    color: var(--color-text-primary, #e8edf4);
    font:16px/1.4 system-ui, sans-serif; overflow:hidden; }
  #stage { position:fixed; inset:0; display:grid; place-items:center; }
  canvas { max-width:100%; max-height:100%; }
  #hud { position:fixed; top:12px; left:12px; font:600 14px system-ui; opacity:.85; }
</style></head>
<body>
  <div id="hud">${subtitle}</div>
  <div id="stage"><canvas id="c" width="640" height="400"></canvas></div>
  <script>
  (function () {
    "use strict";
    var canvas = document.getElementById("c"), ctx = canvas.getContext("2d");
    var dataEl = document.getElementById("game-data");
    var DATA = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
    // ==== AGENTGEM:GAME-LOGIC START ====
    var t = 0;
    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#3b82f6"; ctx.font = "20px system-ui";
      ctx.fillText(${JSON.stringify(title)}, 24, 40 + Math.sin(t / 20) * 4);
      t++; requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // ==== AGENTGEM:GAME-LOGIC END ====
  })();
  </script>
</body></html>`;
}
```
Update `SCAFFOLDS` to build `skill-run`/`project-fun` from `minimalTemplate` and keep `replay` from `replayScaffold`. (Do NOT remove `replayScaffold`.)

- [ ] **Step 4: Run the non-heatmap/modeler cases**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/scaffolds.gate.test.js -t "skill-run"`
Expected: PASS for `replay`/`skill-run`/`project-fun`; heatmap/modeler still fail (next tasks).

- [ ] **Step 5: Commit with Tasks 4.2 + 4.3** (the gate test needs all five present to be green).

### Task 4.2: heatmap scaffold + session-heatmap genre

**Files:**
- Modify: `packages/model/src/types.ts:48` (GameGenre), `packages/play/src/scaffolds.ts`, `packages/play/src/genres.ts`, `packages/play/src/sourceContext.ts`, `src/schemas.ts` (genre enums ×2)

**Interfaces:**
- Produces: `GameGenre` gains `"session-heatmap"`; `SCAFFOLDS.heatmap`; a `GENRES["session-heatmap"]` entry; a `sourceContext` branch.

- [ ] **Step 1: Widen GameGenre**

`packages/model/src/types.ts:48`:
```ts
export type GameGenre = "replay" | "skill-run" | "project-fun" | "session-heatmap" | "scenario-modeler";
```
(Add both new genres now — Task 4.3 uses `scenario-modeler`.)

- [ ] **Step 2: Widen the genre enums in root schemas.ts**

At `src/schemas.ts:103` and `:977`, replace `z.enum(["replay", "skill-run", "project-fun"])` with:
```ts
z.enum(["replay", "skill-run", "project-fun", "session-heatmap", "scenario-modeler"])
```
(Consider a shared `GameGenreEnum` const like `GameCapabilityEnum` in PR 1 — define once near `GameArtifactSchema`, use in both places.)

- [ ] **Step 3: Add the heatmap scaffold**

In `scaffolds.ts`, add a `heatmapScaffold()` that renders a session-activity heatmap from `DATA.timeline`, using the same broker pattern as `replayScaffold` (baked `game-data` fallback + `agentgemApp.onNotification`/`callTool` for `agentgem_get_session_data`). It MUST: use `<script id="game-data" type="application/json">` for baked data; avoid the seal's word list in executable script; theme with `var(--color-*, fallback)`. Register `heatmap: heatmapScaffold()` in `SCAFFOLDS`. (Full HTML body: a grid of day×hour cells colored by turn count — keep it under the 1.5 MB budget and self-contained.)

- [ ] **Step 4: Add the genre + sourceContext branch**

`genres.ts` GENRES:
```ts
"session-heatmap": {
  id: "session-heatmap", sourceKind: "session", title: "Session Heatmap", scaffold: "heatmap", needs: ["session-data"],
  guidance: "Build a heatmap of session activity from the DATA timeline: cells by time bucket, colored by " +
    "intensity (tool calls, edits, message volume). Clickable cells reveal what happened. Analytical, not a game.",
},
```
`sourceContext.ts` — add a branch mirroring the `replay` session branch but returning `genre: "session-heatmap"` (it reads the same session `data`), with a heatmap-flavored `brief`.

- [ ] **Step 5: Build + run the gate test for heatmap**

Run: `pnpm -C packages/play build && pnpm -C packages/model build && pnpm -C packages/play exec vitest run dist/**/__tests__/scaffolds.gate.test.js -t "heatmap"`
Expected: PASS.

### Task 4.3: modeler scaffold + scenario-modeler genre (local-only)

**Files:**
- Modify: `packages/play/src/scaffolds.ts`, `packages/play/src/genres.ts`, `packages/play/src/sourceContext.ts`

**Interfaces:**
- Produces: `SCAFFOLDS.modeler`; `GENRES["scenario-modeler"]` with `needs: ["update-model-context"]`; a project-source `sourceContext` branch.

- [ ] **Step 1: Add the modeler scaffold**

In `scaffolds.ts`, add `modelerScaffold()` — sliders + numeric inputs that recompute a summary live and, on change, call `window.agentgemApp.updateModelContext({ structuredContent: {...} })`. MUST theme with CSS-var fallbacks, avoid the seal's word list, and (since `update-model-context` is not a `"content"` cap) it needs NO baked timeline to save. Register `modeler: modelerScaffold()`.

- [ ] **Step 2: Add the genre + branch**

`genres.ts`:
```ts
"scenario-modeler": {
  id: "scenario-modeler", sourceKind: "project", title: "Scenario Modeler", scaffold: "modeler", needs: ["update-model-context"],
  guidance: "Build a what-if modeler seeded by the PROJECT: sliders/inputs the user tweaks, a live-recomputed " +
    "summary, and push the current scenario into the model's context so the agent can reason about it. " +
    "Local-only: this genre pushes state into the conversation and cannot be published to the marketplace.",
},
```
`sourceContext.ts` — add a `project`-source branch returning `genre: "scenario-modeler"` (distinct from `project-fun`; decide selection by an explicit caller choice, since one `GameSource` kind now maps to two genres — see the note below).

- [ ] **Step 3: Resolve the source→genre ambiguity**

`extractSource` currently maps `GameSource.kind` 1:1 to a genre. Now `session` → {replay, session-heatmap} and `project` → {project-fun, scenario-modeler}. `extractSource` cannot choose from `kind` alone. Add an optional `genre?: GameGenre` parameter to `extractSource(source, readers, genre?)` and use it when present, else fall back to the current default (`replay`/`skill-run`/`project-fun`). Trace callers (`grep -rn "extractSource" packages src | grep -v dist`) and thread the caller's chosen genre through. Keep the default behavior byte-identical when no genre is passed.

- [ ] **Step 4: Build + run the whole scaffold gate test**

Run: `pnpm -C packages/play build && pnpm -C packages/model build && pnpm -C packages/play exec vitest run dist/**/__tests__/scaffolds.gate.test.js`
Expected: PASS (all five).

- [ ] **Step 5: Commit Tasks 4.1 + 4.2 + 4.3**

```bash
git add packages/model/src/types.ts packages/play/src/scaffolds.ts packages/play/src/genres.ts packages/play/src/sourceContext.ts src/schemas.ts packages/play/src/__tests__/scaffolds.gate.test.ts
git commit -m "feat(play): minimalTemplate + session-heatmap and scenario-modeler genres

Ports basic-server-vanillajs (handlers-before-connect, CSS-var theming with fallbacks) as
minimalTemplate, replacing sealedTemplate. Adds two genres: session-heatmap (cohort-heatmap
port over session-data) and scenario-modeler (scenario-modeler port; local-only via
update-model-context). extractSource gains an optional genre selector since one source kind
now maps to two genres.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.4: The Protocol Inspector (built-in, never saved)

**Files:**
- Create: `packages/play/src/inspector.ts`
- Modify: `packages/play/src/index.ts` (export `INSPECTOR_HTML`, `INSPECTOR_META`)
- Test: `packages/play/src/__tests__/inspector.gate.test.ts`

**Interfaces:**
- Produces: `INSPECTOR_HTML: string`, `INSPECTOR_META: MiniappMeta` (name `"__inspector"`).

- [ ] **Step 1: Write the failing test**

Create `packages/play/src/__tests__/inspector.gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { INSPECTOR_HTML, INSPECTOR_META } from "../inspector.js";
import { gameGate } from "../gameGate.js";
import { deriveNeeds } from "../capabilityScan.js";
import { mcpAppFor } from "../mcpApp.js";

describe("protocol inspector", () => {
  it("passes the seal", async () => {
    const r = await gameGate(INSPECTOR_HTML);
    expect(r.ok, r.failures.join("; ")).toBe(true);
  });
  it("exercises every capability (derives all seven)", () => {
    const needs = deriveNeeds(INSPECTOR_HTML);
    expect(needs).toEqual(expect.arrayContaining([
      "session-data", "local-project-access", "live-session-events", "invoke-agent",
      "open-link", "send-message", "update-model-context",
    ]));
  });
  it("mints as an MCP Apps resource", () => {
    const app = mcpAppFor({ name: INSPECTOR_META.name, html: INSPECTOR_HTML, meta: INSPECTOR_META });
    expect(app.resource.uri).toBe("ui://agentgem/__inspector");
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/inspector.gate.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement inspector.ts**

Create `packages/play/src/inspector.ts`. It is a port of `examples/debug-server`'s view: an event log filterable by every callback, a host-info dump, a callback-status table, and buttons firing every method (`callTool` for each of the four tools, `openLink`, `sendMessage`, `updateModelContext`, `requestDisplayMode`). Requirements it MUST meet:
- Carry the shim (`${mcpAppClient()}` first in `<head>`).
- Reference all four tool names as literals and all three `agentgemApp.<method>` names (that is what makes `deriveNeeds` return all seven).
- Avoid the seal's word list in executable script (e.g. label the network cap "connect", never "fetch"/"WebSocket").
- Bake a small demo `<script id="game-data" type="application/json">{"timeline":[...]}</script>` (both attributes) so it is self-contained — even though it is never saved, this keeps it runnable offline.
- Theme with `var(--color-*, fallback)`.
Export:
```ts
export const INSPECTOR_META = {
  name: "__inspector", title: "Protocol Inspector", genre: "replay",
  createdFrom: { kind: "blank", title: "Protocol Inspector" },
  engineVersion: "2",
  needs: ["session-data","local-project-access","live-session-events","invoke-agent","open-link","send-message","update-model-context"],
} as const satisfies MiniappMeta;
```
(Import `MiniappMeta` from `./miniapps.js`.)

- [ ] **Step 4: Export from the barrel**

Add to `packages/play/src/index.ts`: `export { INSPECTOR_HTML, INSPECTOR_META } from "./inspector.js";`

- [ ] **Step 5: Run the test**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/inspector.gate.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/inspector.ts packages/play/src/index.ts packages/play/src/__tests__/inspector.gate.test.ts
git commit -m "feat(play): built-in Protocol Inspector miniapp (debug-server port)

A conformance harness that exercises every callback and every method. Never enters
saveMiniapp — it is a constant, not a user artifact. Derives all seven capabilities by
construction; carries a baked demo timeline so it runs offline.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.5: Dev route serves the inspector

**Files:**
- Modify: `src/play.controller.ts`, `src/schemas.ts` (a tiny raw-html response schema if needed), `packages/console/src/api/routes.ts` (client mirror), and the `mcp-app` route to synthesize `__inspector`.

**Interfaces:**
- Produces: `GET /api/play/inspector` → `{ html }`; `GET /api/play/mcp-app?name=__inspector` → synthesized `mcpAppFor(INSPECTOR)` without disk read.

- [ ] **Step 1: Import the constants + special-case mcp-app**

In `src/play.controller.ts`, import `INSPECTOR_HTML, INSPECTOR_META, mcpAppFor` from `@agentgem/play`. In the `mcpApp` handler, before `readMiniapp`:
```ts
if (input.query.name === "__inspector") return mcpAppFor({ name: INSPECTOR_META.name, html: INSPECTOR_HTML, meta: INSPECTOR_META });
```

- [ ] **Step 2: Add the inspector html route**

Add a route returning the raw html (reuse `PlayMiniappSchema` shape `{ name, html, meta }` or a `{ html }` schema):
```ts
@get("/play/inspector", { response: PlayInspectorSchema })
async inspector(): Promise<z.infer<typeof PlayInspectorSchema>> {
  return { name: INSPECTOR_META.name, html: INSPECTOR_HTML, meta: { title: INSPECTOR_META.title, genre: INSPECTOR_META.genre, createdFrom: INSPECTOR_META.createdFrom, engineVersion: INSPECTOR_META.engineVersion, needs: [...INSPECTOR_META.needs] } };
}
```
Add `PlayInspectorSchema` to `src/schemas.ts` (clone `PlayMiniappSchema`). Add the client mirror in `packages/console/src/api/routes.ts`.

- [ ] **Step 3: Typecheck + a route test**

Run: `pnpm -C . exec tsc --noEmit -p tsconfig.json 2>&1 | head` (or the repo's configured typecheck). Add/extend a controller test if the play.controller has one (`grep -rn "play.controller" src/__tests__ packages`).
Expected: compiles; route returns the inspector.

- [ ] **Step 4: Commit**

```bash
git add src/play.controller.ts src/schemas.ts packages/console/src/api/routes.ts
git commit -m "feat(api): serve the built-in Protocol Inspector (never from disk)

GET /play/inspector returns the constant html; /play/mcp-app?name=__inspector synthesizes the
ui:// resource without touching the miniapps registry.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.6: Update the builder brief + regenerate SKILL.md

**Files:**
- Modify: `packages/play/src/builderBrief.ts`
- Modify: `skills/agentgem-miniapp/SKILL.md` (generated)
- Test: `packages/play/src/__tests__/builderBrief.test.ts` (existing guard)

**Interfaces:** none — content only.

- [ ] **Step 1: Add the new rules to MINIAPP_BUILDER_BRIEF**

Append (in the appropriate existing sections):
- **Theming:** "Use the host's CSS variables with a fallback: `background: var(--color-background-primary, #0d1117)`. The host may supply `--color-background-primary/-secondary`, `--color-text-primary`, `--color-border-primary`. On app.agentgem.ai there is no host — the fallback is what renders."
- **Action methods:** "To open a link, send a chat message, or push model context, call `window.agentgemApp.openLink(url)` / `.sendMessage({role,content})` / `.updateModelContext({structuredContent})`. Write the method name as a literal on `agentgemApp.` — Save derives your declared capabilities from the source and cannot see an aliased reference. `openLink` prompts the user with the URL each time; `sendMessage`/`updateModelContext` only work in a locally-authored miniapp, never a shared one."
- **Display mode:** "Call `window.agentgemApp.requestDisplayMode('fullscreen')` to request fullscreen; the host replies with the mode it actually applied and pushes a `host-context-changed` with new `containerDimensions`. Re-read layout from those dimensions rather than measuring the scaled frame."
- **Handlers before connect:** "Register every `onNotification` handler before the first frame; the host may push `tool-input` or a `tool-result` immediately after the handshake."

- [ ] **Step 2: Regenerate SKILL.md**

The guard is `SKILL.md.endsWith(MINIAPP_BUILDER_BRIEF)`. Regenerate: run whatever script the repo uses, or reconstruct by hand — `SKILL.md` = its existing frontmatter+heading + the new brief body. Find the generator: `grep -rn "SKILL.md\|MINIAPP_BUILDER_BRIEF" packages/play/src packages/play/scripts scripts 2>/dev/null`. If none, edit `SKILL.md` so its tail is byte-identical to the new `MINIAPP_BUILDER_BRIEF`.

- [ ] **Step 3: Run the guard**

Run: `pnpm -C packages/play build && pnpm -C packages/play exec vitest run dist/**/__tests__/builderBrief.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/play/src/builderBrief.ts skills/agentgem-miniapp/SKILL.md
git commit -m "docs(play): brief the action methods, CSS-var theming, and display mode

Regenerates skills/agentgem-miniapp/SKILL.md from the canonical brief. Tells the Studio agent
to write agentgemApp.<method> as a literal (deriveNeeds reads source), that open-link prompts
per URL and message/context are local-only, and to re-read layout from host containerDimensions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4.7: Interop — the inspector reaches `initialized` in @mcp-ui/client

**Files:**
- Test: the existing interop harness (`grep -rln "mcp-ui/client" packages/play`).

- [ ] **Step 1: Render the inspector, not a sealed scaffold**

Extend the interop harness to load `INSPECTOR_HTML` (an MCP-Apps-aware view) into `@mcp-ui/client` v7.1.1's `AppRenderer`/`AppFrame`/`AppBridge`. Assert it reaches `initialized` and logs a received `tool-input` — the assertion the prior stack never made (it rendered sealed scaffolds that never initialize).

- [ ] **Step 2: Run per the harness's documented command**

Expected: PASS. Capture a screenshot into the scratch/interop dir as the prior stack did.

- [ ] **Step 3: Manual Claude Desktop pass**

Serve `GET /api/play/mcp-app?name=__inspector` to a local Claude Desktop MCP connection and confirm the inspector renders and the buttons fire. Record the result in the spec's testing section. (Manual — not a CI gate.)

- [ ] **Step 4: Commit + PR 4 finish**

```bash
git add -A && git commit -m "test(play): inspector reaches initialized in the reference host

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
- [ ] `pnpm -C packages/play build && pnpm -C packages/play exec vitest run`
- [ ] `pnpm -C packages/console exec vitest run src/panels/Play`
- [ ] Push, watch CI, rebase-merge, verify every commit's marker on `origin/main`.

---

## Self-Review

**Spec coverage:**
- F1 (tool-result) → PR 2 Tasks 2.2, 2.3. ✓
- F2 (ui/initialize) → PR 2 Tasks 2.2, 2.3. ✓
- F3 (unimplemented surface) → PR 2 (tool-input/cancelled/teardown), PR 3 (host-context/display-mode/size). ✓
- F4 (SDK not viable) → design decision; PR 2 Task 2.5 vendors schema as dev-only, never bundled. ✓
- F5 (capability model) → PR 1 Tasks 1.1–1.4. ✓
- F6 (compile guards) → PR 1 Tasks 1.1–1.3 rely on them firing. ✓
- F7 (undefined tool-name bug) → PR 1 Task 1.5. ✓
- F8 (assertPortable at save) → resolved by D8; inspector is built-in (PR 4 Task 4.4), never saved. ✓
- D1 (_meta streaming) → PR 2 Tasks 2.3, 2.6 (with fallback path). ✓
- D3 (freeze API) → PR 2 Task 2.1/2.2/2.7 (frozen test). ✓
- D5 (extend union) → PR 1. ✓
- D6 (enhancement, local-only) → PR 1 Task 1.3 (class), PR 3 Task 3.4 (local-only). ✓
- D7 (one marker) → PR 2 Task 2.1. ✓
- D8 (inspector built-in) → PR 4 Task 4.4. ✓
- Templates (D4) → PR 4 Tasks 4.1–4.3. ✓
- scenario-modeler unpublishable-by-construction → guidance string (Task 4.3) + brief (4.6). ✓

**Placeholder scan:** Two intentional "trace the caller/generator" steps remain (Task 3.4 local-only gate location, Task 4.6 SKILL.md generator, Task 4.3 extractSource callers). These are grep-first steps because the exact mechanism must be read from current code, not guessed — each names the exact grep and the exact change to make once found. Acceptable: they are "find X then apply this specific edit," not "figure out what to do."

**Type consistency:** `ToolCapability`/`ActionCapability`/`CAP_METHOD`/`METHOD_CAP` used consistently across PR 1 tasks. `hostContext()` dep (2.3) → consumed (3.3). `pushHostContext`/`onDisplayMode` defined and consumed within PR 3 Task 3.3. `MCP_CLIENT_MARKER_RE` defined (2.1) and used (2.1). `INSPECTOR_HTML`/`INSPECTOR_META` defined (4.4) → consumed (4.5, 4.7). `applyHostContext` no-op (2.2) → real (3.2). Consistent.

**Known deferrals recorded as risks in the spec:** `deriveNeeds` aliasing gap; `_meta` passthrough unverified until 2.6; two new genres widen a union (verified no exhaustive switch exists).
