# Publish a Gem to Managed Agents — Design

**Date:** 2026-06-17
**Status:** Implemented, including managed cloud environment creation, retry idempotency, and rollback
**Project:** `agentgem`
**Scope:** Render a Gem into a Claude **Managed Agent** config and **publish** it (create the agent, its skills, and a limited-network managed cloud environment via the Anthropic API).

---

## 1. Why this isn't a `materialize` FileTree target

Managed Agents has **no on-disk layout** — it's an API object created via `client.beta.agents.create({...})` plus prerequisite Skills-API calls. So it does **not** fit the existing `targets.ts` FileTree model. It's a **publish operation**, added alongside materialize, not inside it.

## 2. Authoritative bindings (from the claude-api skill)

```ts
// 1) each local skill must be registered first → skill_id
const sk = await client.beta.skills.create({ /* display title + SKILL.md content; exact body WebFetched at build */ });
// 2) create the agent (persistent, versioned)
const agent = await client.beta.agents.create({
  name, model: "claude-opus-4-8",
  system,                                  // instructions concatenated
  mcp_servers: [{ type: "url", name, url }],   // URL transport only; NO auth here
  skills: [{ type: "custom", skill_id, version }],   // max 20
  tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name }],
});
// → { id: "agent_…", version }
```

## 3. Mapping — what publishes, what's skipped (honest compatibility)

| Gem artifact | Managed Agents | Result |
| --- | --- | --- |
| **skill** | Skills API create → `skills:[{type:custom,skill_id}]` | ✅ published (cap 20; warn over) |
| **instructions** (CLAUDE.md / SOUL.md / rules / AGENTS.md) | concatenated into `system` (≤100K) | ✅ |
| **mcp_server, http/sse** | `mcp_servers:[{type:url,name,url}]` + `mcp_toolset` (cap 20) | ✅ |
| **mcp_server, stdio (command)** | Managed Agents needs a URL endpoint | ⛔ **skipped** (with reason) |
| **hook** | no Managed-Agents hook concept | ⛔ **skipped** |
| **requiredSecrets** | MCP auth uses **vaults** (OAuth), set post-publish | surfaced as names to add to a vault — **never sent** |

Reuses the existing `compatibility`/`skipped` shape so the UI shows exactly what will/won't go.

## 4. Endpoints

- `POST /api/publish-preview` (pure, offline) → the `agents.create` payload (redacted, secrets never present) + `skipped[]` + `requiredSecrets[]` + a `skills[]` list (names that will be created). Drives a preview pane; no network.
- `POST /api/publish` (network, gated and idempotent by `requestId`) → checks `ANTHROPIC_API_KEY`; creates skills, a limited-network cloud environment, then the agent; returns `{ agentId, environmentId, version, registeredSkills, skipped, vaultSecrets }`. Failed publishes delete the environment and any skills created by that attempt. **400 with a clear message if the key is absent** — never a silent no-op.

## 5. Security / trust boundary

- **Explicit, gated action.** A "Publish to Managed Agents" button with a confirm ("creates an agent, cloud sandbox, and uploaded skills in your Anthropic org"). Never auto-fires. Retries reuse the same request ID so a lost response cannot duplicate resources.
- **Key stays server-side.** `ANTHROPIC_API_KEY` read from the server env; never sent to the browser, never logged.
- **No secrets leave the boundary.** The gem is already redacted; publish sends redacted MCP configs + skill bodies + instructions only. MCP credentials are added by the operator to a **vault** afterward (we surface names only). The preview asserts no secret values are present before any network call.
- **Outward-facing confirm.** Because publish sends config to Anthropic, the UI requires the explicit click; the server requires the key.

## 6. Stack

- Add `@anthropic-ai/sdk` (dep). New `src/gem/publish.ts` (pure render: gem → agent payload + skip/secret/skill lists) and `src/publish.ts` (the network publish: skills.create → environments.create → agents.create, with rollback and request deduplication; isolated so the pure render is unit-tested without network).
- Controller: `/api/publish-preview` + `/api/publish`. Zod schemas (`ManagedAgentPayloadSchema`, `PublishResultSchema`).
- UI: in the right pane, a "Managed Agents" mode showing the preview (payload + skipped + skills-to-create + vault-secrets) and a **Publish** button (disabled until the server reports a key present via a small `GET /api/publish/ready`).
- Model default `claude-opus-4-8`.

## 7. Out of scope (later)

Sessions and scheduled deployments (they require a user task or schedule), agent **update** (v1 creates a new agent per intentional publish), vault credential creation (we surface names), OpenClaw publish (separate target — no on-disk config found; treat as a deploy destination later), Anthropic prebuilt-skill mapping.

## 8. Build plan

Subagent-driven, TDD: (1) `publish.ts` pure render + tests (mapping, skips, secrets-never-present, caps); (2) schemas + `/api/publish/preview` + controller test; (3) `@anthropic-ai/sdk` wiring + `/api/publish` + `/api/publish/ready` (Skills-API create body WebFetched at build); (4) UI preview + gated Publish; (5) review (focus: key never client-side, no secret egress, skip correctness).
