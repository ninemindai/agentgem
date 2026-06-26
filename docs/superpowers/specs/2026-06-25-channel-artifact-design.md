# Channel artifact — design

**Date:** 2026-06-25
**Status:** Approved design, pending implementation plan

## Summary

Add a neutral **`channel`** artifact to the Gem archive that declares how a Gem
wants to be reached by end users (Slack, Telegram, Discord, …). Channels are a
first-class, portable capability carried in the manifest+lock — a discovery /
marketplace signal ("this Gem speaks Slack"), not an Eve-only deploy flag.

The Eve materialization target renders each channel natively by emitting an
`agent/channels/<name>.ts` file built from Eve's own channel factories
(`slackChannel`, `telegramChannel`, …). Every other target records a skip reason.
We do **not** build a chat loop: Eve's session/turn runtime *is* the loop; a
channel only adapts a platform onto it.

## Motivation

- Eve already models **channels** as "entry points into the same agent runtime"
  that "start sessions, route platform events into turns, and apply
  platform-specific authentication or formatting" (Eve Concepts docs). Built-in
  factories exist for `eve/channels/{slack,discord,teams,telegram,twilio,github}`
  plus `eve/channels/eve` (web/HTTP).
- AgentGem's design principle is a **neutral archive that every target consumes**
  (see eve/flue/openai-sandbox/a2a targets). A channel is exactly the kind of
  portable capability the archive is meant to carry.
- Today the Eve target only ever emits the single `agent/channels/eve.ts` auth
  file (`src/gem/targets.ts:547`). This generalizes that one hard-coded scaffold
  into a registry-driven set of channels.

## Decisions (locked during brainstorming)

1. **Neutral Gem primitive**, not an Eve-only feature. Channels live in the
   manifest+lock and travel with the Gem.
2. **Declared** during gem build — not introspected. A `.claude/` testbed has
   nothing to scan; channels are a forward-looking declaration of reachability.
3. **Minimal shape** — the artifact stores `{ platform, secretRefs }` only. No
   per-channel config blob is frozen into the archive. The "how Slack is wired"
   knowledge lives in a per-platform **channel registry** in AgentGem code (the
   same place the current `eveChannelTs` scaffold lives).
4. **All Eve platforms in v1**: slack, telegram, discord, teams, twilio, github.
   (`web`/`eve` stays the always-on auth entry point — see below.)
5. **`formatVersion` stays 1** — additive within this repo; all readers are
   updated together.

## Data model

New artifact type, parallel to the existing four:

```ts
// src/gem/types.ts
export type ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel";

export type ChannelPlatform =
  | "slack" | "telegram" | "discord" | "teams" | "twilio" | "github";

export interface ChannelArtifact {
  type: "channel";
  name: string;             // path segment → agent/channels/<name>.ts
  platform: ChannelPlatform;
  secretRefs: SecretRef[];  // resolved from the registry at build time
  description?: string;     // optional; for Card / discovery
}
```

Note: `web`/`eve` is **not** a `ChannelPlatform`. The Eve web channel
(`agent/channels/eve.ts`, with its `eveAuth` posture) remains an always-on
compose default, unchanged. Channel artifacts are *additional* files alongside it.

## Archive layout

One JSON file per channel, mirroring `mcp/<seg>.json` and `hooks/<seg>.json`:

```
channels/<name>.json   →  { platform, secretRefs, description? }
```

- Captured in `manifest.artifacts[]` as `{ type:"channel", name, path }`.
- Hashed into `gem.lock` like every other file (no special casing).
- Each channel's `secretRefs` aggregate into `manifest.requiredSecrets` so the
  deploy prompt stays accurate.

### Archive reader/writer touch points (closed-union, must update together)

The artifact type is a closed union and `readGemArchive` currently **falls
through to `hook`** for any unrecognized type. `channel` must be wired
explicitly at every site or it will misparse:

- `src/gem/types.ts:2` — extend `ArtifactType`; add `ChannelArtifact` to the
  `GemArtifact` union.
- `src/schemas.ts` — four `z.enum([...])` sites (lines ~148, 168, 288, 423) plus
  add a `ChannelArtifactSchema` literal block alongside the existing
  skill/mcp/instructions/hook literals (~lines 10–33).
- `src/gem/archive.ts` write dispatch (~line 96–118) — add a `channel` branch
  that serializes `{ platform, secretRefs, description? }` to `channels/<name>.json`.
- `src/gem/archive.ts` read dispatch (~line 167–183) — add an explicit `channel`
  branch **before** the hook fallthrough; tighten the fallthrough so an unknown
  type throws rather than silently becoming a hook.

## Channel registry (new — the core of the feature)

A built-in map, keyed by platform, that is the single place that knows how a
platform maps onto Eve. This generalizes today's `eveChannelTs`.

```ts
// src/gem/channels.ts (new)
interface ChannelPlatformSpec {
  platform: ChannelPlatform;
  eveImport: string;          // e.g. "eve/channels/slack"
  factory: string;            // e.g. "slackChannel"
  requiredSecrets: SecretRequirement[];  // exact env-var names Eve reads
  scaffold: (name: string) => string;    // emits agent/channels/<name>.ts
}

export const CHANNEL_REGISTRY: Record<ChannelPlatform, ChannelPlatformSpec>;
```

- `requiredSecrets` use the **exact env var names** the Eve factory reads (Eve
  channel secrets come from environment variables). These are the names copied
  into a `ChannelArtifact.secretRefs` at build time.
- Adding a platform later = one registry entry. No archive/schema change.
- Per-platform secret sketch (to be confirmed against Eve factory signatures
  during implementation):
  - slack → `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
  - telegram → `TELEGRAM_BOT_TOKEN`
  - discord → `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`
  - teams → Azure bot app id/password
  - twilio → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, number config
  - github → app id / private key / webhook secret

## Build path (declared)

- The gem-build selection gains a **Channels** group. The user adds platforms
  explicitly; nothing is introspected from the source dir.
- `buildGem` (`src/gem/buildGem.ts`) creates a `ChannelArtifact` per selection,
  copying `secretRefs` from `CHANNEL_REGISTRY[platform].requiredSecrets`, writes
  `channels/<name>.json`, adds the manifest entry, and folds the secrets into
  `requiredSecrets`.

## Materialize

### Eve target — native render

- New per-type renderer `channelEve(artifacts)` in `src/gem/targets.ts`: for each
  `ChannelArtifact`, emit `agent/channels/<name>.ts` via
  `CHANNEL_REGISTRY[platform].scaffold(name)`.
- Wire it into the Eve `TargetSpec` (new optional `channel?` hook on `TargetSpec`,
  or handle inside the existing renderer set — implementation detail for the plan).
- The existing `agent/channels/eve.ts` web/auth file stays as the always-on
  default (`eveComposeProject`, `eveAuth` posture unchanged).

### All other targets — skip with reason

- flue, a2a, openai-sandbox, claude, codex, agents, agentcore, hermes: each
  `channel` artifact is recorded in `skipped` with a reason like
  `"channel:slack not supported by target flue"`, using the existing skip
  mechanism. No silent drops.
- Future (not v1): A2A could surface channels as Agent Card metadata.

## Secrets & deploy

- `ChannelArtifact.secretRefs` → `manifest.requiredSecrets` → the existing
  deploy/run secret prompt. No new secret plumbing.
- The deployer wires `SLACK_BOT_TOKEN` etc. at deploy time through the flow that
  already exists.

## UI

- Live preview (`src/public/index.html`) gains a **Channels** picker in the
  gem-build stage, alongside skills/MCP/hooks.
- Materialize summary counts channels.
- `.gem` export and registry discovery already serialize manifest artifacts, so
  "speaks Slack" travels with the Gem for free.

## Testing

- `buildGem` adds a `channel` artifact with correct `secretRefs`, and those
  secrets appear in `requiredSecrets` (unit).
- Archive round-trip: write → read → lock hashes verify with a `channel` artifact
  present; the read dispatch returns a `ChannelArtifact` (not a misparsed hook).
- Unknown artifact type now **throws** on read instead of falling through to hook
  (regression guard for the tightened fallthrough).
- Eve materialize emits `agent/channels/slack.ts` from the registry scaffold; the
  web `eve.ts` file is still present.
- A non-Eve target records the skip reason and emits no channel file.
- `CHANNEL_REGISTRY`: every `ChannelPlatform` has import/factory/secrets/scaffold
  (exhaustiveness test).

## Scope guardrails (YAGNI)

Out of scope for v1: introspection round-trip from an Eve project; frozen
per-channel config blobs; non-Eve channel rendering; new secret plumbing.
In scope: one artifact type, one registry, all six Eve platforms, Eve-native
render, skip-with-reason elsewhere.
