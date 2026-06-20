# AgentCore harness target — design

**Status:** approved (pre-implementation)
**Date:** 2026-06-20
**Topic:** Add Amazon Bedrock **AgentCore harness** as an agentgem target — a materialize target that emits a runnable `agentcore` CLI project, a deploy runner that ships it, and a publish backend that calls `CreateHarness` directly.

Relates to / reference patterns: [[eve-target-fast-follow]] (the code-gen materialize pattern + `compose` hook), [[flue-target-fast-follow]], [[openai-sandbox-target-fast-follow]], [[publish-registry-and-bedrock-fast-follow]] (the `DEPLOY_REGISTRY` this completes), [[gem-archive-format-spec]].

Supersedes the old assumption in [[publish-registry-and-bedrock-fast-follow]] that Bedrock would be **publish-only** ("no on-disk project"). AgentCore GA ships a real on-disk project + CLI, so the primary integration is a **materialize target** (eve pattern); the publish backend is the secondary path.

---

## 1. Background (verified against AWS docs, 2026-06-20)

The **AgentCore managed harness** (GA) is config-based: you declare an agent (model, system prompt, tools, skills, memory) and AWS runs the loop (powered by Strands). Two interfaces: the **AgentCore CLI** (`@aws/agentcore`, emits a project) and the **API/SDK** (`CreateHarness`/`InvokeHarness`, no files).

**Harness config = `app/<name>/harness.json`** (managed by `agentcore add/remove`; also expressible as `CreateHarness` params). Documented fields:
- **`systemPrompt`**: `[{ "text": "…" }]` — the instructions.
- **`model`**: `{ "bedrockModelConfig": { "modelId", "apiFormat"? } }` (or `openAiModelConfig`/`liteLlmModelConfig`). Default if omitted: Claude Sonnet 4.6 on Bedrock (`global.anthropic.claude-sonnet-4-6`).
- **`tools`**: array of `{ type, name, config }`. Relevant types:
  - `remote_mcp` → `{ config: { remoteMcp: { url, headers? } } }` — **remote MCP by URL** (http/sse). Header values may use `${arn:aws:bedrock-agentcore:…:token-vault/…}` to reference an AgentCore Identity credential, resolved at invoke time. **No stdio support.**
  - `agentcore_gateway`, `agentcore_browser`, `agentcore_code_interpreter`, `agentcore_web_search`, `inline_function`. Built-ins `shell` + `file_operations` always present; restrict via `allowedTools`.
- **`skills`**: array of source objects, AgentSkills.io format (`SKILL.md` + YAML frontmatter + optional `scripts/`/`references/`/`assets/`):
  - `{ "awsSkills": { "paths": […] } }`, `{ "git": { "url", "path"?, "auth"? } }`, `{ "s3": { "uri" } }`, `{ "path": ".agents/skills/<name>" }` (filesystem; **must be on the harness FS — baked into a container image or installed at session start**).
- **Limits**: `maxIterations`, `maxTokens`, `timeoutSeconds`, truncation.
- **Credentials**: `agentcore add credential --type api-key --name X --api-key …` → token vault, referenced via `${arn:…}`.

CLI lifecycle: `agentcore create` → `agentcore add harness --name --model-id --system-prompt --tools` → `agentcore dev` (local) → `agentcore deploy` → `agentcore invoke`. Project tree: `agentcore/agentcore.json` (project + resources), `agentcore/aws-targets.json` (account/region), `app/<name>/` (harness.json or code).

> **Open item (must verify during impl):** the exact `agentcore/agentcore.json` schema is not fully documented in the public pages read. `app/<name>/harness.json` field-level shape **is** documented (above) and is the load-bearing artifact. De-risk by running `agentcore create --name … --model-provider bedrock` once and diffing the scaffold, then having agentgem emit/patch `harness.json` into it (rather than synthesizing every project file blind). See §6.

---

## 2. Decisions (locked from brainstorming)

1. **Both integrations.** A materialize target (TARGET_REGISTRY) **and** a publish backend (DEPLOY_REGISTRY). Built in phases (§3).
2. **Skills: emit files + container-bake.** Emit each skill to `.agents/skills/<name>/SKILL.md` (+ subdirs), wire them as `{ "path": ".agents/skills/<name>" }` in `harness.json`, and emit a `Dockerfile` that `COPY`s `.agents/skills/` so the path-skills exist on the harness FS. (Build type = Container.)
3. **Deploy runner included.** A run module shells the AgentCore CLI (`agentcore deploy`, `agentcore invoke`, status), gated on readiness (CLI present + AWS creds), mirroring the eve run module.

### Gem → AgentCore mapping

| Gem artifact | AgentCore harness | Notes |
|---|---|---|
| `instructions` | `systemPrompt: [{ text: <all instructions concatenated> }]` | same concat convention as eve `instructions.md` |
| `skill` | file `.agents/skills/<seg>/SKILL.md` + `skills: [{ path: ".agents/skills/<seg>" }]` + `Dockerfile` COPY | AgentSkills.io format already matches agentgem skills |
| `mcp_server` (http/sse) | `tools: [{ type:"remote_mcp", name, config:{ remoteMcp:{ url, headers } } }]` | secret header values → `${arn:…}` placeholders |
| `mcp_server` (stdio) | **skip + report** | harness is remote-URL only (eve precedent) |
| `hook` | **skip + report** | no harness equivalent |
| `requiredSecrets` | `${arn:…}` placeholders in headers + a `SECRETS.md`/README note listing `agentcore add credential` commands | values never emitted (redaction holds) |
| model | default `global.anthropic.claude-sonnet-4-6` (Bedrock) | overridable later |

Path segments via `safePathSegment` (or an `agentcore`-specific segmenter mirroring `eveSegment`).

---

## 3. Phasing (each phase independently shippable + testable)

### Phase 1 — `agentcore` materialize target (TARGET_REGISTRY)
Add one `TargetSpec` entry to `TARGET_REGISTRY` in `src/gem/targets.ts`, reusing the shared renderer + `compose` pattern (like `eve`):
- `skill`: a new `skillAgentcoreMd` renderer mirroring `skillSkillMd` but emitting under the `.agents/skills/<seg>/SKILL.md` prefix (do **not** reuse `skillSkillMd` verbatim — its prefix is `skills/`, which path-skills don't expect).
- `instructions`: `() => ({})` (folded into harness.json by compose, like flue/openai-sandbox).
- `mcp`: `() => ({ files:{}, skipped:[] })` (folded into compose; stdio skips recorded there).
- `compose: agentcoreComposeProject(gem)` — the cross-cutting renderer that sees the whole gem and emits:
  - `app/<gemseg>/harness.json` — `{ systemPrompt, model, tools (remote_mcp from http/sse mcp), skills (path entries) }`.
  - `agentcore/agentcore.json` + `agentcore/aws-targets.json` — minimal project config (see §6 open item; emit a documented-minimal version, region as a placeholder).
  - `Dockerfile` — base image + `COPY .agents/skills/ .agents/skills/` (+ any deps).
  - `SECRETS.md` — the `agentcore add credential` checklist for each `requiredSecret`.
  - `skipped[]` — stdio MCP + hooks.
- Register in `schemas.ts` automatically (TargetIdSchema derives from `TARGET_REGISTRY` keys) — no schema edit needed.
- The UI target `<select>` (index.html) gains an `agentcore` option.

**Deliverable:** Materialize tab renders an `agentcore` project from any gem; secrets redacted; stdio/hooks reported as skipped.

### Phase 2 — deploy runner
New module `src/gem/agentcoreRun.ts` (or generalize `run.ts`), mirroring the eve run module:
- `agentcoreReadiness()` → `{ cli: boolean, awsCreds: boolean }` (checks `agentcore --version` and AWS creds/region presence). Booleans only.
- `deployAgentcore(workspaceName)` → shells `agentcore deploy` in the rendered `.targets/agentcore/` dir; captures log tail + state.
- `invokeAgentcore(name, prompt)` / `statusAgentcore` / `stop` as needed.
- Endpoints mirror the eve run endpoints (`/api/run-ready`, `/api/run`, `/api/run-status`, `/api/run/stop`) — generalize them to take `target` (they already take `target` per RunRequestSchema) so eve + agentcore share the runner surface. The runner dispatches on `target`.
- UI: the existing Run section becomes target-aware (shows for eve + agentcore); a "Deploy to AWS" button.

**Deliverable:** From a rendered agentcore workspace, "Deploy to AWS" runs `agentcore deploy` and tails logs; readiness-gated.

### Phase 3 — publish backend (DEPLOY_REGISTRY)
Add an `agentcore` entry to `DEPLOY_REGISTRY` in `src/gem/deploy.ts` (the structural registry already exists):
- `preview(gem)` → the `CreateHarness` payload (`systemPrompt`, `tools`, `skills`) + skipped/secret lists. **Pure.**
- `ready()` → AWS creds present (env/profile) + region set. Reads env only.
- `deploy(gem, requestId)` → calls `CreateHarness` (+ poll `GetHarness` to READY) via AWS SDK; returns a `PublishResult`-shaped record (harness ARN, status).
- **Skills caveat for publish:** the API can't upload local skill files. Publish maps skills to **git/s3 sources only**; local-only skills are skipped-and-reported (or require the user to supply a git/s3 source). Document this asymmetry vs. the materialize path (which container-bakes local skills).
- Requires the generic `DeployPreview`/`DeployResult` union schema deferred in [[publish-registry-and-bedrock-fast-follow]] — add it now (this is "backend #2").

**Deliverable:** Managed-Agents-style publish to AgentCore via `CreateHarness`, gated on AWS creds.

---

## 4. Secrets

Unchanged invariant: agentgem never emits raw secret values. MCP secret headers render as `${arn:…}` token-vault placeholders; `SECRETS.md` lists the `agentcore add credential --type api-key --name <name> --api-key …` command per `requiredSecret`. The gem is already redacted; materialize/publish consume the redacted gem. Add a test asserting no raw value appears in the rendered project or the publish payload.

## 5. Testing
- `targets.test.ts`: `materialize(gem, "agentcore")` emits `app/<seg>/harness.json` with `systemPrompt` from instructions, `tools` from http/sse MCP (stdio skipped + reported), `skills` path entries, skill files under `.agents/skills/`, a `Dockerfile` with the COPY, and no raw secret.
- `agentcoreRun.test.ts`: readiness booleans; deploy shells the CLI via an injected fake ProcessRunner (never spawn real `agentcore`); log/state capture. (Follows the eve run test pattern — injected runner.)
- `deploy.test.ts` / controller: `preview` payload shape + secret-safety; `ready()` boolean; `deploy` gated (no AWS creds → rejected).
- Reuse dist-clean discipline ([[test-setup-runs-compiled-dist]]).

## 6. Open items / risks
- **`agentcore.json` exact schema** — verify by running `agentcore create` once; prefer emitting the well-documented `harness.json` and a minimal project wrapper, or scaffold via CLI then patch. Don't synthesize undocumented fields blind.
- **CLI availability** — `@aws/agentcore` is preview channel for harness; pin/install note in scaffold deps + readiness check (mirrors the microsandbox host-prereq note for eve).
- **AWS deploy is heavyweight** (CDK bootstrap, IAM, creds) — Phase 2/3 are gated + readiness-reported; failures surface as actionable log lines (eve precedent).
- **Skills on the default (non-container) env** — path-skills require container baking; that's why Phase-1 emits a Dockerfile (build type = Container). Note this in the generated README.

## 7. Out of scope
- AgentCore Gateway/Browser/CodeInterpreter/WebSearch tool generation (only `remote_mcp` from gem MCP). Could be a follow-up if gems gain those.
- Memory configuration (gems carry no memory artifact).
- `inline_function` tools, A/B eval, versioning/endpoints.
