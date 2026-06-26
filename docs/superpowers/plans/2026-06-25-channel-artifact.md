# Channel Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a neutral `channel` artifact to the Gem archive that declares how a Gem wants to be reached (Slack/Telegram/Discord/Teams/Twilio/GitHub); the Eve target renders each natively, every other target skips-with-reason.

**Architecture:** A new `channel` member of the closed `ArtifactType` union, carried in the manifest+lock like skill/mcp/hook. A built-in `CHANNEL_REGISTRY` (new `src/gem/channels.ts`) maps each platform → (Eve factory import, env-var secret names, scaffold). Channels are *declared* at gem-build time (not introspected); `buildGem` constructs the artifacts and aggregates their secrets into `requiredSecrets`. Materialize gains a `channel` per-type renderer on `TargetSpec`; Eve emits `agent/channels/<name>.ts`, all others fall through `skipAll`.

**Tech Stack:** TypeScript (ESM, `tsc -b`), Zod schemas, Vitest (runs compiled `dist/**/__tests__/**/*.test.js`), AgentBack REST controller.

## Global Constraints

- `formatVersion` stays **1**. New clients are safe via the strict unknown-type guard (Task 2). Known limitation: an *older* published client reading a new channel-bearing Gem misparses the channel as a hook; a `formatVersion` reject-check is filed as separate hardening, not this feature (spec §Cross-version compatibility). Do not bump the version or add a version check in this plan.
- Channel artifact shape is **minimal**: `{ type, name, platform, secretRefs, description? }`. No per-channel config blob is frozen into the archive (spec decision A).
- v1 platforms: **slack, telegram, discord, teams, twilio, github**. `web`/`eve` is NOT a `ChannelPlatform` — the existing always-on `agent/channels/eve.ts` auth file is untouched.
- Channels are **declared**, never introspected. Nothing is scanned from the source dir.
- `secretRefs` use the exact env-var names the Eve factory reads (env-derived per Eve Concepts docs).
- No silent drops: non-Eve targets record a skip reason via the existing `skipAll`/`skipped` mechanism.
- Tests are compiled first. Run cycle is `pnpm build && npx vitest run dist/<...>.test.js`. For a brand-new symbol the red step may surface as a `tsc -b` compile error (stated per step); once it compiles, red is a vitest assertion failure.
- Git author for every commit: `Raymond Feng <raymond@ninemind.ai>`. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Work on branch `feat/channel-artifact` (already created).

---

## File Structure

- `src/gem/types.ts` — extend `ArtifactType`, add `ChannelPlatform`, `ChannelArtifact`, extend `GemArtifact`. (Task 1)
- `src/gem/channels.ts` — **new.** `CHANNEL_REGISTRY`, `ChannelPlatformSpec`, `channelScaffold`, `makeChannelArtifact`. (Task 1)
- `src/gem/archive.ts` — write + read dispatch for `channel`; tighten unknown-type fallthrough. (Task 2)
- `src/schemas.ts` — `ChannelArtifactSchema`, add to `GemArtifactSchema`, `ChannelPlatformSchema`, two enum sites, `GemRequestSchema.channels`. (Task 3, Task 6)
- `src/gem/buildGem.ts` — accept declared `channels`, build artifacts, aggregate secrets. (Task 4)
- `src/gem/targets.ts` — `TargetSpec.channel` hook, `channelEve` renderer, Eve registry wiring, materialize dispatch. (Task 5)
- `src/gem.controller.ts` — pass `channels` through to `buildGem`. (Task 6)
- `src/public/index.html` — Channels picker in the gem-build stage. (Task 7)

Tests live beside their module in `src/gem/__tests__/*.test.ts` and `src/__tests__/*.test.ts`.

---

## Task 1: Channel types + registry

**Files:**
- Modify: `src/gem/types.ts:2` (ArtifactType), `:44` (GemArtifact)
- Create: `src/gem/channels.ts`
- Test: `src/gem/__tests__/channels.test.ts`

**Interfaces:**
- Produces:
  - `type ChannelPlatform = "slack" | "telegram" | "discord" | "teams" | "twilio" | "github"`
  - `interface ChannelArtifact { type: "channel"; name: string; platform: ChannelPlatform; secretRefs: SecretRef[]; description?: string }`
  - `interface ChannelPlatformSpec { platform: ChannelPlatform; label: string; eveImport: string; factory: string; secrets: string[] }`
  - `const CHANNEL_REGISTRY: Record<ChannelPlatform, ChannelPlatformSpec>`
  - `function channelScaffold(platform: ChannelPlatform): string`
  - `function makeChannelArtifact(platform: ChannelPlatform, name?: string): ChannelArtifact`

- [ ] **Step 0: Verify the Eve channel factory signatures (gate — do this first)**

The registry scaffolds below assume each platform exports `<platform>Channel` and is
callable zero-arg (`slackChannel()`), reading secrets from the environment. This is
**not yet confirmed** and some platforms may require a config argument. Confirm before
writing the registry:

Run: `npm view eve dist-tags.latest && npm view eve` to confirm the package, then add it
as a devDependency for type resolution: `pnpm add -D eve` and inspect the channel exports:

```bash
ls node_modules/eve/dist/channels 2>/dev/null || find node_modules/eve -name '*.d.ts' -path '*channels*'
grep -rn "export function .*Channel\|export const .*Channel" node_modules/eve 2>/dev/null | grep -iE "slack|telegram|discord|teams|twilio|github"
```

For each platform, record the **exact exported factory name** and whether it takes a
required config argument. If a factory requires config (e.g. Slack signing secret, Twilio
numbers), adjust that platform's `channelScaffold` output in Step 4 to pass the minimal
config reading from `process.env[...]`, and keep the env-var names in `secrets`. If the
`eve` package cannot be resolved (private/unpublished), fall back to the `vercel/eve`
GitHub source for the same signatures and note in the registry comment that the shapes are
source-derived. Do not proceed to Step 4 with unconfirmed factory names.

- [ ] **Step 1: Extend the artifact type union in `src/gem/types.ts`**

Change line 2:
```ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel";
```

Add after the `HookArtifact` interface (after line 42), before `GemArtifact`:
```ts
export type ChannelPlatform = "slack" | "telegram" | "discord" | "teams" | "twilio" | "github";

// A channel declares how the Gem wants to be reached by end users. Neutral + minimal: the
// platform plus the env-var secrets it needs. The "how it's wired" lives in CHANNEL_REGISTRY.
export interface ChannelArtifact {
  type: "channel";
  name: string;             // path segment -> agent/channels/<name>.ts on the Eve target
  platform: ChannelPlatform;
  secretRefs: SecretRef[];  // resolved from the registry at build time (env-var names)
  description?: string;     // optional; for discovery / Card
}
```

Change the `GemArtifact` union (line 44):
```ts
export type GemArtifact = SkillArtifact | McpServerArtifact | InstructionsArtifact | HookArtifact | ChannelArtifact;
```

- [ ] **Step 2: Write the failing test `src/gem/__tests__/channels.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { CHANNEL_REGISTRY, channelScaffold, makeChannelArtifact } from "../channels.js";
import type { ChannelPlatform } from "../types.js";

const PLATFORMS: ChannelPlatform[] = ["slack", "telegram", "discord", "teams", "twilio", "github"];

describe("CHANNEL_REGISTRY", () => {
  it("has a complete entry for every platform", () => {
    for (const p of PLATFORMS) {
      const spec = CHANNEL_REGISTRY[p];
      expect(spec.platform).toBe(p);
      expect(spec.eveImport).toMatch(/^eve\/channels\//);
      expect(spec.factory).toMatch(/Channel$/);
      expect(spec.secrets.length).toBeGreaterThan(0);
    }
  });

  it("registry key matches the spec.platform field (no copy-paste drift)", () => {
    for (const p of PLATFORMS) expect(CHANNEL_REGISTRY[p].platform).toBe(p);
  });
});

describe("channelScaffold", () => {
  it("imports the factory and references each env var", () => {
    const out = channelScaffold("slack");
    expect(out).toContain('from "eve/channels/slack"');
    expect(out).toContain("slackChannel");
    expect(out).toContain("export default slackChannel()");
    expect(out).toContain("SLACK_BOT_TOKEN");
  });
});

describe("makeChannelArtifact", () => {
  it("builds a channel artifact with env-located secretRefs from the registry", () => {
    const a = makeChannelArtifact("slack");
    expect(a.type).toBe("channel");
    expect(a.name).toBe("slack");
    expect(a.platform).toBe("slack");
    expect(a.secretRefs).toContainEqual({ name: "SLACK_BOT_TOKEN", location: "env.SLACK_BOT_TOKEN" });
  });

  it("honors an explicit name", () => {
    expect(makeChannelArtifact("telegram", "tg").name).toBe("tg");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/channels.test.js`
Expected: `tsc -b` FAILS with "Cannot find module '../channels.js'" (the module doesn't exist yet).

- [ ] **Step 4: Create `src/gem/channels.ts`**

```ts
// src/gem/channels.ts
// The single place that knows how each platform maps onto Eve's channel factories. Generalizes the
// old hard-coded eveChannelTs scaffold. Adding a platform = one entry here; the archive never changes.
import type { ChannelArtifact, ChannelPlatform, SecretRef } from "./types.js";

export interface ChannelPlatformSpec {
  platform: ChannelPlatform;
  label: string;
  eveImport: string;   // e.g. "eve/channels/slack"
  factory: string;     // e.g. "slackChannel"
  secrets: string[];   // exact env-var names the Eve factory reads
}

export const CHANNEL_REGISTRY: Record<ChannelPlatform, ChannelPlatformSpec> = {
  slack:    { platform: "slack",    label: "Slack",    eveImport: "eve/channels/slack",    factory: "slackChannel",    secrets: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] },
  telegram: { platform: "telegram", label: "Telegram", eveImport: "eve/channels/telegram", factory: "telegramChannel", secrets: ["TELEGRAM_BOT_TOKEN"] },
  discord:  { platform: "discord",  label: "Discord",  eveImport: "eve/channels/discord",  factory: "discordChannel",  secrets: ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"] },
  teams:    { platform: "teams",    label: "Teams",    eveImport: "eve/channels/teams",    factory: "teamsChannel",    secrets: ["MICROSOFT_APP_ID", "MICROSOFT_APP_PASSWORD"] },
  twilio:   { platform: "twilio",   label: "Twilio",   eveImport: "eve/channels/twilio",   factory: "twilioChannel",   secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] },
  github:   { platform: "github",   label: "GitHub",   eveImport: "eve/channels/github",   factory: "githubChannel",   secrets: ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] },
};

// The agent/channels/<name>.ts file Eve materialization emits. Eve channel factories read their
// secrets from the environment, so the scaffold is the import + a zero-arg factory default export.
export function channelScaffold(platform: ChannelPlatform): string {
  const spec = CHANNEL_REGISTRY[platform];
  return (
    `import { ${spec.factory} } from ${JSON.stringify(spec.eveImport)};\n\n` +
    `// Reads ${spec.secrets.join(", ")} from the environment (set them as project env vars).\n` +
    `// See https://vercel.com/docs/eve/concepts#channels\n` +
    `export default ${spec.factory}();\n`
  );
}

// Build a neutral channel artifact, resolving the platform's env-var secrets into secretRefs.
export function makeChannelArtifact(platform: ChannelPlatform, name?: string): ChannelArtifact {
  const spec = CHANNEL_REGISTRY[platform];
  const secretRefs: SecretRef[] = spec.secrets.map((s) => ({ name: s, location: `env.${s}` }));
  return { type: "channel", name: name ?? platform, platform, secretRefs };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/channels.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/gem/types.ts src/gem/channels.ts src/gem/__tests__/channels.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): channel artifact type + platform registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Archive write + read for `channel`

**Files:**
- Modify: `src/gem/archive.ts:4` (import), `:106-119` (write dispatch), `:166-188` (read dispatch)
- Test: `src/gem/__tests__/archive.test.ts` (add cases)

**Interfaces:**
- Consumes: `ChannelArtifact` (Task 1), `makeChannelArtifact` (Task 1).
- Produces: archive round-trips a `channel` artifact; unknown artifact types now throw on read instead of silently becoming a hook.

- [ ] **Step 1: Add the import in `src/gem/archive.ts`**

The existing import block (around line 4) pulls from `./types.js`. Add `ChannelArtifact` and `SecretRef` to it:
```ts
import type {
  Gem, GemArtifact, ArtifactType, ChannelArtifact, SecretRef,
  // ...keep all existing names already imported here...
} from "./types.js";
```
(Keep every name currently imported; only add `ChannelArtifact` and `SecretRef` if not already present.)

- [ ] **Step 2: Write the failing test (append to `src/gem/__tests__/archive.test.ts`)**

This repo is ESM (`"type":"module"`); use a top-of-file `import`, never `require`. The
unknown-type test needs `computeLock` to re-derive the lock after tampering with the
manifest — check it is exported first: `grep -n "computeLock" src/gem/archive.ts`. If it
is declared but not exported, add `export` to its declaration as part of this task, then
import it here.

```ts
import { makeChannelArtifact } from "../channels.js";
import { computeLock } from "../archive.js"; // add `export` to its declaration if missing
// (writeGemArchive/readGemArchive are already imported at the top of this file)

describe("channel artifact round-trip", () => {
  it("writes channels/<name>.json and reads it back as a ChannelArtifact", () => {
    const gem = {
      name: "demo", createdFrom: "test", checks: [], requiredSecrets: [],
      artifacts: [makeChannelArtifact("slack")],
    };
    const { files } = writeGemArchive(gem);
    expect(files["channels/slack.json"]).toBeDefined();
    const back = readGemArchive(files);
    const ch = back.artifacts.find((a) => a.type === "channel");
    expect(ch).toMatchObject({ type: "channel", name: "slack", platform: "slack" });
    expect((ch as any).secretRefs).toContainEqual({ name: "SLACK_BOT_TOKEN", location: "env.SLACK_BOT_TOKEN" });
  });

  it("throws on an unknown artifact type instead of misparsing it as a hook", () => {
    const gem = {
      name: "demo", createdFrom: "test", checks: [], requiredSecrets: [],
      artifacts: [makeChannelArtifact("slack")],
    };
    const { files } = writeGemArchive(gem);
    const manifest = JSON.parse(files["gem.json"]);
    manifest.artifacts[0].type = "bogus";
    files["gem.json"] = JSON.stringify(manifest, null, 2);
    // re-lock so verification passes and we reach the artifact dispatch
    files["gem.lock"] = JSON.stringify(computeLock(files), null, 2);
    expect(() => readGemArchive(files)).toThrow(/unknown artifact type/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/archive.test.js`
Expected: FAIL — round-trip returns the channel misparsed as a hook (no `platform`), and the unknown-type case does not throw.

- [ ] **Step 4: Add the write branch in `writeGemArchive`**

In the `for (const a of gem.artifacts)` loop, insert a `channel` branch **before** the final `else` (the hook fallthrough at ~line 112). Change the final `} else {` to `} else if (a.type === "channel") {` … then keep hook as the closing `else`:

```ts
    } else if (a.type === "channel") {
      const path = `channels/${withExt(seg, ".json")}`;
      const body: Record<string, unknown> = { platform: a.platform, secretRefs: a.secretRefs };
      if (a.description !== undefined) body.description = a.description;
      if (place(path, JSON.stringify(body, null, 2), a.name, "channel")) artifacts.push({ type: "channel", name: a.name, path });
    } else {
      // hook (unchanged)
      const path = `hooks/${withExt(seg, ".json")}`;
      // ...existing hook body...
    }
```

- [ ] **Step 5: Add the read branch + tighten the fallthrough in `readGemArchive`**

In the `manifest.artifacts.map(...)` callback, add a `channel` branch before the final hook fallthrough (before line ~182), and make the fallthrough strict:

```ts
    if (e.type === "channel") {
      const o = JSON.parse(body(e.path)) as { platform: ChannelArtifact["platform"]; secretRefs: SecretRef[]; description?: string };
      const a: ChannelArtifact = { type: "channel", name: e.name, platform: o.platform, secretRefs: o.secretRefs };
      if (o.description !== undefined) a.description = o.description;
      return a;
    }
    if (e.type !== "hook") throw new Error(`unknown artifact type '${e.type}' in manifest`);
    const o = JSON.parse(body(e.path)) as { event: string; matcher?: string; config: Record<string, unknown>; source?: string; secretRefs?: HookArtifact["secretRefs"] };
    // ...existing hook construction unchanged...
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/archive.test.js`
Expected: PASS (both new cases plus all pre-existing archive tests).

- [ ] **Step 7: Commit**

```bash
git add src/gem/archive.ts src/gem/__tests__/archive.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): archive read/write for channel artifacts; strict unknown-type guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Zod schemas for `channel`

**Files:**
- Modify: `src/schemas.ts:9-47` (artifact schemas + union), `:148`, `:168`
- Test: `src/__tests__/schemas.test.ts` (add cases)

**Interfaces:**
- Produces: `ChannelArtifactSchema`, `ChannelPlatformSchema`; `GemArtifactSchema` accepts a channel; `SkippedArtifactSchema` and `GemManifestArtifactSchema` accept `"channel"`.

- [ ] **Step 1: Write the failing test (append to `src/__tests__/schemas.test.ts`)**

```ts
import { GemArtifactSchema, SkippedArtifactSchema } from "../schemas.js";

describe("channel schema", () => {
  it("GemArtifactSchema parses a channel artifact", () => {
    const ok = GemArtifactSchema.safeParse({
      type: "channel", name: "slack", platform: "slack",
      secretRefs: [{ name: "SLACK_BOT_TOKEN", location: "env.SLACK_BOT_TOKEN" }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown platform", () => {
    const bad = GemArtifactSchema.safeParse({ type: "channel", name: "x", platform: "myspace", secretRefs: [] });
    expect(bad.success).toBe(false);
  });

  it("SkippedArtifactSchema accepts a channel skip", () => {
    expect(SkippedArtifactSchema.safeParse({ artifact: "slack", type: "channel", reason: "unsupported" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build && npx vitest run dist/__tests__/schemas.test.js`
Expected: FAIL — channel is not part of the discriminated union; the channel-skip parse fails the enum.

- [ ] **Step 3: Add the schemas in `src/schemas.ts`**

After `HookArtifactSchema` (line 40), add:
```ts
export const ChannelPlatformSchema = z.enum(["slack", "telegram", "discord", "teams", "twilio", "github"]);

export const ChannelArtifactSchema = z.object({
  type: z.literal("channel"),
  name: z.string(),
  platform: ChannelPlatformSchema,
  secretRefs: z.array(z.object({ name: z.string(), location: z.string() })),
  description: z.string().optional(),
});
```

Add `ChannelArtifactSchema` to the `GemArtifactSchema` discriminated union (line 42):
```ts
export const GemArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
  HookArtifactSchema,
  ChannelArtifactSchema,
]);
```

Update the two enums where channels actually appear:
- Line 148 (`SkippedArtifactSchema.type`): `z.enum(["skill", "mcp_server", "instructions", "hook", "channel"])`
- Line 168 (`GemManifestArtifactSchema.type`): `z.enum(["skill", "mcp_server", "instructions", "hook", "channel"])`

Leave `RecommendedItemSchema` (line 288) and `ImportedRefSchema` (line 423) unchanged — channels are never introspected, recommended, or imported, so they must not appear there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm build && npx vitest run dist/__tests__/schemas.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): zod schemas for channel artifact + manifest/skip enums

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `buildGem` accepts declared channels

**Files:**
- Modify: `src/gem/buildGem.ts:1-2` (imports), `:23-27` (opts), `:84-93` (artifact assembly + secrets)
- Test: `src/gem/__tests__/buildGem.test.ts` (add cases)

**Interfaces:**
- Consumes: `makeChannelArtifact`, `ChannelPlatform` (Task 1).
- Produces: `buildGem(..., { channels?: { platform: ChannelPlatform; name?: string }[] })` appends channel artifacts and folds their secrets into `requiredSecrets`.

- [ ] **Step 1: Write the failing test (append to `src/gem/__tests__/buildGem.test.ts`)**

```ts
describe("declared channels", () => {
  const emptyInv = { skills: [], mcpServers: [], instructions: [], hooks: [] };

  it("adds a channel artifact and aggregates its secrets into requiredSecrets", () => {
    const gem = buildGem(emptyInv, { all: false }, { channels: [{ platform: "slack" }] });
    const ch = gem.artifacts.find((a) => a.type === "channel");
    expect(ch).toMatchObject({ type: "channel", platform: "slack", name: "slack" });
    expect(gem.requiredSecrets).toContainEqual({ name: "SLACK_BOT_TOKEN", artifact: "slack", location: "env.SLACK_BOT_TOKEN" });
  });

  it("adds no channels when none are declared", () => {
    const gem = buildGem(emptyInv, { all: false }, {});
    expect(gem.artifacts.some((a) => a.type === "channel")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/buildGem.test.js`
Expected: `tsc -b` FAILS — `channels` is not a known property of the opts object.

- [ ] **Step 3: Implement in `src/gem/buildGem.ts`**

Extend the imports (line 2):
```ts
import type { ConfigInventory, Gem, GemArtifact, GemCheck, SecretRequirement, ChannelPlatform } from "./types.js";
import { makeChannelArtifact } from "./channels.js";
```

Extend the `opts` parameter (line 26):
```ts
  opts: { name?: string; createdFrom?: string; checks?: GemCheck[]; channels?: { platform: ChannelPlatform; name?: string }[] } = {},
```

Append channel artifacts after the `guarded` re-assembly (right after line 86, before the `requiredSecrets` loop):
```ts
  for (const ch of opts.channels ?? []) artifacts.push(makeChannelArtifact(ch.platform, ch.name));
```

Extend the secrets aggregation condition (line 90) to include channels:
```ts
    if ((a.type === "mcp_server" || a.type === "hook" || a.type === "channel") && a.secretRefs) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/buildGem.test.js`
Expected: PASS (and all pre-existing buildGem tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/buildGem.ts src/gem/__tests__/buildGem.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): buildGem accepts declared channels and aggregates their secrets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Eve renderer + materialize dispatch

**Files:**
- Modify: `src/gem/targets.ts:6-9` (import), `:23-31` (TargetSpec), `:808` (Eve registry entry), `:836-866` (materialize dispatch); add `channelEve` near the Eve renderers (~after line 558)
- Test: `src/gem/__tests__/targets.channels.test.ts` (new) — or append to an existing targets test if one exists (`grep -l materialize src/gem/__tests__`).

**Interfaces:**
- Consumes: `ChannelArtifact` (Task 1), `channelScaffold` (Task 1), `makeChannelArtifact` (Task 1).
- Produces: `TargetSpec.channel?: (channels: ChannelArtifact[]) => MaterializeResult`; Eve emits `agent/channels/<name>.ts`; non-Eve targets skip with reason `channel unsupported on <target>`.

- [ ] **Step 1: Write the failing test `src/gem/__tests__/targets.channels.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { materialize } from "../targets.js";
import { makeChannelArtifact } from "../channels.js";

const gemWith = (...platforms) => ({
  name: "demo", createdFrom: "test", checks: [], requiredSecrets: [],
  artifacts: platforms.map((p) => makeChannelArtifact(p)),
});

describe("channel materialize", () => {
  it("Eve emits agent/channels/<name>.ts from the registry scaffold", () => {
    const r = materialize(gemWith("slack"), "eve");
    expect(r.files["agent/channels/slack.ts"]).toContain("slackChannel");
    expect(r.skipped.find((s) => s.type === "channel")).toBeUndefined();
  });

  it("Eve still emits the always-on web channel eve.ts alongside declared channels", () => {
    const r = materialize(gemWith("telegram"), "eve");
    expect(r.files["agent/channels/eve.ts"]).toBeDefined();
    expect(r.files["agent/channels/telegram.ts"]).toBeDefined();
  });

  it("a non-Eve target skips the channel with a reason and emits no channel file", () => {
    const r = materialize(gemWith("slack"), "flue");
    expect(Object.keys(r.files).some((p) => p.includes("channels/slack"))).toBe(false);
    expect(r.skipped).toContainEqual(expect.objectContaining({ artifact: "slack", type: "channel" }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build && npx vitest run dist/gem/__tests__/targets.channels.test.js`
Expected: FAIL — Eve emits no `agent/channels/slack.ts`; channels are not yet dispatched at all.

- [ ] **Step 3: Add the import and `channelEve` renderer in `src/gem/targets.ts`**

Extend the types import (lines 6-9) to add `ChannelArtifact`:
```ts
import type {
  Gem, ArtifactType, SecretRequirement, SecretRef, ChannelArtifact,
  SkillArtifact, McpServerArtifact, InstructionsArtifact, HookArtifact,
} from "./types.js";
import { channelScaffold } from "./channels.js";
```

Add the renderer after `eveComposeProject` (~after line 558). The name `eve` is reserved for the always-on web channel emitted by `eveComposeProject`, so reject a declared channel that collides with it:
```ts
// Eve channel files: one agent/channels/<name>.ts per declared channel, from the platform registry
// scaffold. "eve" is reserved for the always-on web/auth channel that eveComposeProject emits.
const channelEve = (channels: ChannelArtifact[]): MaterializeResult => {
  const files: FileTree = {};
  const skipped: SkippedArtifact[] = [];
  for (const c of channels) {
    const seg = eveSegment(c.name);
    const path = `agent/channels/${seg}.ts`;
    if (seg === "eve") { skipped.push({ artifact: c.name, type: "channel", reason: "channel name 'eve' is reserved for the web channel" }); continue; }
    if (path in files) { skipped.push({ artifact: c.name, type: "channel", reason: `path collision with an earlier channel at ${path}` }); continue; }
    files[path] = channelScaffold(c.platform);
  }
  return { files, skipped };
};
```

- [ ] **Step 4: Add the `channel` hook to `TargetSpec` and wire the Eve entry**

In `TargetSpec` (line 29-30), add:
```ts
  channel?: (channels: ChannelArtifact[]) => MaterializeResult;
```

In the Eve registry entry (line 808), add `channel: channelEve`:
```ts
  eve:    { id: "eve",    label: "Eve",    skill: skillEveMd, instructions: concatInstructions("agent/instructions.md"), mcp: mcpEveConnections, channel: channelEve, compose: eveComposeProject },
```

- [ ] **Step 5: Add the materialize dispatch for channels in `src/gem/targets.ts`**

After the `hooks` filter (line 840) add:
```ts
  const channels = gem.artifacts.filter((a): a is ChannelArtifact => a.type === "channel");
```

After the hooks dispatch block (after line 860), before the `if (spec.compose)` block, add:
```ts
  if (channels.length) {
    if (spec.channel) {
      const result = spec.channel(channels);
      merge(result.files, channels.map((c) => c.name).join(", "), "channel");
      skipped.push(...result.skipped);
    }
    else skipAll(channels, "channel");
  }
```
(`skipAll` already produces the reason `channel unsupported on <target>`; `merge`/`skipped` already accept `"channel"` now that `ArtifactType` includes it.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm build && npx vitest run dist/gem/__tests__/targets.channels.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full suite (channels touch `compatibility`, archive, schemas)**

Run: `pnpm test`
Expected: PASS — no regressions. `compatibility()` now counts channel skips on non-Eve targets; if any existing snapshot/count test asserts exact skip totals for a gem that includes channels, update it. (A plain gem with no channels is unaffected.)

- [ ] **Step 8: Commit**

```bash
git add src/gem/targets.ts src/gem/__tests__/targets.channels.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): Eve channel renderer + materialize dispatch (skip-with-reason elsewhere)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire channels through the build request + controller

**Files:**
- Modify: `src/schemas.ts` (`GemRequestSchema`, line 126), `src/gem.controller.ts:74-83`
- Test: `src/__tests__/gem.controller.test.ts` (add a case) or `src/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: `ChannelPlatformSchema` (Task 3), `buildGem` channels opt (Task 4).
- Produces: `POST /api/gem` accepts an optional `channels: { platform, name? }[]` and threads it into `buildGem`.

- [ ] **Step 1: Write the failing test (append to `src/__tests__/gem.controller.test.ts`)**

Follow the existing supertest pattern in that file (it already builds an app + client). Add:
```ts
it("POST /api/gem includes a declared channel in the gem", async () => {
  const r = await client.post("/api/gem").send({ selection: { all: false }, channels: [{ platform: "slack" }] }).expect(200);
  expect(r.body.artifacts.some((a: any) => a.type === "channel" && a.platform === "slack")).toBe(true);
  expect(r.body.requiredSecrets.some((s: any) => s.name === "SLACK_BOT_TOKEN")).toBe(true);
});
```
(If the test file's request body needs a `dir`, mirror what the neighboring `/api/gem` tests pass.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build && npx vitest run dist/__tests__/gem.controller.test.js`
Expected: FAIL — `channels` is stripped by the schema (unknown key) so no channel artifact appears.

- [ ] **Step 3: Add `channels` to `GemRequestSchema` in `src/schemas.ts`**

In the `GemRequestSchema` object (line 126), add a field:
```ts
  channels: z.array(z.object({ platform: ChannelPlatformSchema, name: z.string().optional() })).optional(),
```

- [ ] **Step 4: Thread it through the controller in `src/gem.controller.ts`**

In the `gem()` handler (line 78-82), pass `channels`:
```ts
    return buildGem(inventory, input.body.selection, {
      name: input.body.name ?? "gem",
      createdFrom: dirs.claudeDir,
      checks: input.body.checks,
      channels: input.body.channels,
    });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm build && npx vitest run dist/__tests__/gem.controller.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): accept declared channels on POST /api/gem

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Channels picker in the live UI

**Files:**
- Modify: `src/public/index.html` (gem-build stage controls + the function that assembles the `POST /api/gem` body)
- Test: manual (the UI is a hand-written single file with no unit harness); verify in-browser.

**Interfaces:**
- Consumes: `POST /api/gem` `channels` field (Task 6).
- Produces: a Channels multi-select whose chosen platforms are sent as `channels: [{ platform }]` in the gem build request.

- [ ] **Step 1: Locate the gem-build request assembly**

Run: `grep -n "/api/gem\|selection:" src/public/index.html`
Identify the function that builds the body posted to `/api/gem` (it sends `{ selection, ... }`).

- [ ] **Step 2: Add the Channels control**

Near the skills/MCP/hooks selection controls in the gem-build stage, add a labelled group of six checkboxes (one per platform). Use the platform ids as values:
```html
<fieldset id="channelPicker" class="pgroup">
  <legend>Channels <span class="d">(how this Gem is reached)</span></legend>
  <label><input type="checkbox" class="ch" value="slack"> Slack</label>
  <label><input type="checkbox" class="ch" value="telegram"> Telegram</label>
  <label><input type="checkbox" class="ch" value="discord"> Discord</label>
  <label><input type="checkbox" class="ch" value="teams"> Teams</label>
  <label><input type="checkbox" class="ch" value="twilio"> Twilio</label>
  <label><input type="checkbox" class="ch" value="github"> GitHub</label>
</fieldset>
```

- [ ] **Step 3: Include selected channels in the request body**

In the function found in Step 1, gather the checked platforms and add them to the body:
```js
const channels = Array.from(document.querySelectorAll("#channelPicker .ch:checked"))
  .map((el) => ({ platform: el.value }));
// then include `channels` in the JSON.stringify({ selection, ..., channels }) body
```

- [ ] **Step 4: Manual verification**

Run: `pnpm dev` (builds + serves on the configured port). In the browser: select a couple of channels, build the gem, and confirm the live Gem preview shows the channel artifacts and the required secrets (e.g. `SLACK_BOT_TOKEN`). Materialize to Eve and confirm `agent/channels/slack.ts` appears; materialize to Flue and confirm the channel shows as skipped.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(channel): Channels picker in the gem-build UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §Data model → Task 1 (types) + Task 3 (schemas). ✓
- §Archive layout + reader/writer touch points → Task 2 (write/read branches, strict fallthrough). ✓
- §Channel registry → Task 1 (`CHANNEL_REGISTRY`, `channelScaffold`, env-var secrets). ✓
- §Build path (declared) → Task 4 (`buildGem` channels opt) + Task 6 (request wiring). ✓
- §Materialize (Eve native, others skip) → Task 5. ✓
- §Secrets & deploy → Task 4 aggregates into `requiredSecrets`; no new plumbing. ✓
- §UI → Task 7. ✓
- §Testing bullets → covered across Tasks 1-6 (registry exhaustiveness, round-trip, unknown-type throw, Eve emit + eve.ts present, non-Eve skip, buildGem secrets). ✓
- All six platforms in v1 → Task 1 registry has all six. ✓
- `formatVersion` stays 1 → no change to `ARCHIVE_FORMAT_VERSION`. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"write tests for the above". Every code step shows the code. The one external uncertainty — exact Eve factory names/config across the six platforms — is handled by the **Task 1 Step 0 verification gate** (resolve real signatures from the `eve` package/source before writing the registry) plus a concrete documented default in the registry as the single point of adjustment. Not a placeholder; a gated verification.

**Type consistency:** `ChannelArtifact`, `ChannelPlatform`, `CHANNEL_REGISTRY`, `channelScaffold`, `makeChannelArtifact` are defined in Task 1 and consumed with the same names/signatures in Tasks 2/4/5/6. `TargetSpec.channel` (Task 5) matches the `channelEve` signature. `secretRefs` location format `env.<NAME>` is identical in Task 1 (`makeChannelArtifact`) and asserted in Tasks 1/2/4.
