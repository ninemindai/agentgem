# agentgem — A2A Target: materialize a Gem into an Agent2Agent Agent Card (+ opt-in server) (Design)

**Date:** 2026-06-23
**Status:** **IMPLEMENTED** on branch `a2a-target` — Card primitive *and* opt-in server mode
(`{ a2aServer: true }`). Full suite green (304 passing). SDK surfaces verified via context7 + the
published packages; pins locked against real tarballs: `ai@7.0.0-beta.178` (`stopWhen` helper is
`stepCountIs`), `@ai-sdk/mcp@2.0.0-beta.67` (`createMCPClient`, `./mcp-stdio` →
`Experimental_StdioMCPTransport`), `@a2a-js/sdk@0.3.13` (`./server`, `./server/express`:
`agentCardHandler`/`jsonRpcHandler`/`UserBuilder`/`AGENT_CARD_PATH`).
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Add `a2a` as a `TARGET_REGISTRY` entry. `materialize(gem, "a2a")` always emits a **runtime-free
Agent Card** derived from the Gem (the discovery surface, publishable to the registry). With
`{ a2aServer: true }` it *additionally* emits a runnable A2A **server** wrapping a **Vercel AI SDK v7**
runtime (`ai` + `@ai-sdk/mcp`). A2A is a wholly `compose`-driven target (all per-type renderers are
no-ops). No `TargetSpec` model change beyond one new `MaterializeOpts` flag.

---

## 0. Motivation

A2A and NATS are *runtime interoperability/transport* layers; AgentGem is a *build/distribution* tool —
so neither is consumed internally. But A2A decomposes into two artifacts of very different character:

- **The Agent Card** — pure declaration derived from the Gem (name, skills, capabilities, `url`).
  **Needs no runtime.** This is the part genuinely native to AgentGem's "describe an agent" mission, and
  the natural thing to publish to the registry so a Gem becomes *discoverable* by A2A peers.
- **The A2A server** — answers `message/send`, so it must execute a model + tool loop. A runtime here is
  unavoidable, but it is *incidental* to AgentGem: every other target (eve/flue/sandbox/agentcore)
  already produces a runnable agent. An A2A agent is best understood as "one of those deployments, made
  discoverable" — not a fifth runtime.

**Decision (this revision):** the Card is the **primitive** (always emitted, zero deps); the server is an
**opt-in flavor**. The composition payoff still holds — merging N Gems → one Card advertising the union
of their skills, a multi-agent mesh the runtime-only targets can't express.

NATS stays **out of scope**: a transport one layer below the targets; if relevant it belongs to
AgentBack, not packaging or the (pull-based, immutable) registry.

## 1. A2A conventions (verified against `/a2aproject/a2a-js`, 2026-06-23)

- **Agent Card type:** `import { AgentCard, AGENT_CARD_PATH } from "@a2a-js/sdk"`. Served (server mode)
  by mounting `agentCardHandler({ agentCardProvider: requestHandler })` at `/${AGENT_CARD_PATH}`.
  `protocolVersion: "0.3.0"`.
- **Card fields (verified hello-world card):** `name`, `description`, `protocolVersion`, `version`,
  `url` (the JSON-RPC endpoint, e.g. `.../a2a/jsonrpc`), `skills[]`, `capabilities`
  (`{ pushNotifications: false }`; `streaming` omitted/false), `defaultInputModes`/`defaultOutputModes`
  (`["text"]`), `additionalInterfaces[]` (`{ url, transport: "JSONRPC" | "HTTP+JSON" | "GRPC" }`).
- **AgentSkill:** `{ id, name, description, tags[] }`. `tags` required; A2A wants **≥1 skill**.
- **Server wiring (current API — NOT `A2AExpressApp`):** `DefaultRequestHandler(card, new
  InmemoryTaskStore(), executor)` + `agentCardHandler` / `jsonRpcHandler` from
  `@a2a-js/sdk/server/express`.
- **`AgentExecutor`:** `execute(ctx, bus)` + `cancelTask`. `ctx` already carries
  `{ taskId, contextId, userMessage, task }`. Non-streaming reply: publish one `kind:"message"` then
  `bus.finished()`.
- **Hooks:** no native concept.

## 2. Runtime (server mode only): Vercel AI SDK v7 (verified against `/vercel/ai`, 2026-06-23)

Vendor-neutral by choice. Card-only mode pulls in **none** of this.
- **MCP client (`@ai-sdk/mcp`):** remote → `createMCPClient({ transport: { type: "http"|"sse", url,
  headers } })`; stdio → `createMCPClient({ transport: new Experimental_StdioMCPTransport({ command,
  args, env }) })`. `await client.tools()` → tool set; `await client.close()` to clean up.
- **Tool loop:** `generateText({ model, system, tools, stopWhen: isStepCount(10), prompt })`.
- **Model:** gateway string `"anthropic/claude-sonnet-4-6"`; needs `AI_GATEWAY_API_KEY` or a provider key.
- **No "skills" primitive:** AI SDK has no native skill loader, so in server mode skill bodies are folded
  into the `system` prompt (alongside instructions). This is a server-mode limitation — and a reason the
  Card (which advertises skills as metadata) is the cleaner primitive.
- `sandboxMcpServer` is **not** reused (it emits `@openai/agents` instances). Server mode adds its own
  `a2aMcpClient` renderer — the explicit cost of a vendor-neutral runtime.

## 3. Design decisions (locked)

1. **The Agent Card is the always-emitted primitive.** `materialize(gem, "a2a")` → `agent-card.json`
   only, no runtime, no dependencies, nothing skip-reported (a Card can describe any Gem).
2. **A2A is wholly `compose`-driven.** All per-type renderers are no-ops (`skill/instructions/hook →
   () => ({})`, `mcp → empty MaterializeResult`); `compose(gem, opts)` produces everything. This keeps
   per-type artifacts from being auto-skip-reported and centralizes the card/server logic.
3. **Server is opt-in via `MaterializeOpts.a2aServer`** (parallels `eveAuth`). When set, `compose`
   additionally emits `src/server.ts` + `package.json` + `SECRETS.md` and evaluates MCP/hook mappability.
4. **Gem→Agent Card mapping (`a2aAgentCard`)** is the core declarative logic. `skill` → `skills[]`
   (id/name/description/tags); `instructions` → first de-headed line → Card `description`; skill-less
   Gems get a synthesized `chat` skill so the Card stays valid.
5. **Server mode SYSTEM = instructions + skill bodies** (frontmatter-stripped, concatenated), because AI
   SDK has no skills primitive. MCP → AI SDK clients connected at boot, tools shared, `close()` on
   SIGINT/SIGTERM. Card `url` overridden at runtime from `PUBLIC_URL`.
6. **Skip-reporting only in server mode.** Card-only mode reports nothing. Server mode reports unmappable
   MCP (http/sse non-`headers.*` secrets; url-less non-stdio) and **all** hooks (no A2A concept). stdio
   MCP is **supported** (native `Experimental_StdioMCPTransport`).
7. **Non-streaming v1.** Single `message` event; Card `capabilities: { streaming: false,
   pushNotifications: false }`. Streaming (task lifecycle) is v2.
8. **Secret-safe.** `process.env["<NAME>"]` from `secretRefs` (names only). `SECRETS.md` uses a dedicated
   `a2aSecretsMd` (model-access note + plain env listing) — NOT `agentcoreSecretsMd`.

## 4. Support matrix

| artifact | card-only (default) | server mode (`a2aServer: true`) |
|----------|---------------------|---------------------------------|
| skill | `skills[]` entry in the Card | + folded into the executor `system` prompt |
| instructions | first line → Card `description` | + full text in `system` |
| mcp_server | (not modeled by a Card) | AI SDK `createMCPClient` / stdio transport, connected at boot |
| hook | (not modeled) | skipped — A2A has no hook concept |
| requiredSecrets | — | model-access note + env-var names in `SECRETS.md` |

`compatibility(gem)` calls `materialize` with default opts, so the `a2a` column reflects **card-only** —
i.e. A2A can describe any Gem (no skips). Runtime mappability surfaces only under `{ a2aServer: true }`.

## 5. Code sketch

### 5.1 TargetId + opts
```ts
export type TargetId = "claude" | "codex" | "agents" | "hermes" | "eve" | "flue" | "openai-sandbox" | "agentcore" | "a2a";
export interface MaterializeOpts { eveAuth?: "placeholder" | "public"; a2aServer?: boolean }
```

### 5.2 Card derivation + secrets doc
```ts
const A2A_PROTOCOL_VERSION = "0.3.0";
const A2A_MODEL = "anthropic/claude-sonnet-4-6";
const a2aSkillCard = (a: SkillArtifact) => ({
  id: safePathSegment(a.name), name: a.name,
  description: a.description?.trim() || `The ${a.name} skill.`, tags: ["skill"],
});
const firstLine = (s: string): string =>
  s.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";

export const a2aAgentCard = (gem: Gem): Record<string, unknown> => {
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr  = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const cardSkills = skills.map(a2aSkillCard);
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: gem.name,
    description: firstLine(instr[0]?.content ?? "") || `An agent packaged by AgentGem from ${skills.length} skill(s).`,
    version: "0.1.0",
    url: "http://localhost:41241/a2a/jsonrpc",      // server mode overrides from PUBLIC_URL
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"], defaultOutputModes: ["text"],
    skills: cardSkills.length ? cardSkills
      : [{ id: "chat", name: "chat", description: `Converse with ${gem.name}.`, tags: ["chat"] }],
  };
};

const a2aSecretsMd = (secrets: SecretRequirement[]): string => {
  const model = `## Model access\n\nThe agent calls \`${A2A_MODEL}\` via the AI SDK. Set \`AI_GATEWAY_API_KEY\` ` +
    `(Vercel AI Gateway) or a direct provider key (e.g. \`ANTHROPIC_API_KEY\`).\n`;
  const mcp = secrets.length
    ? `## MCP credentials\n\nSet these before \`npm start\`:\n\n${secrets.map((s) => `- \`${s.name}\` (for ${s.artifact} at ${s.location})`).join("\n")}\n`
    : `## MCP credentials\n\nThis agent declares no MCP secrets.\n`;
  return `# Secrets\n\n${model}\n${mcp}`;
};
```

### 5.3 AI SDK MCP renderer (server mode)
```ts
type A2AClient = { code: string; stdio: boolean } | { skip: string };
const a2aMcpClient = (s: McpServerArtifact): A2AClient => {
  const url = typeof s.config.url === "string" ? s.config.url : "";
  if (/^https?:\/\//.test(url)) {
    const refs = s.secretRefs ?? [];
    const unsupported = refs.find((r) => !/^headers\./i.test(r.location));
    if (unsupported) return { skip: `A2A (AI SDK) cannot map secret at ${unsupported.location}` };
    const authorization = refs.find((r) => r.location.toLowerCase() === "headers.authorization");
    const headerEntries: (readonly [string, string])[] = [
      ...(authorization ? [["Authorization", authorization.name] as const] : []),
      ...refs.filter((r) => /^headers\./i.test(r.location) && r !== authorization)
            .map((r) => [r.location.slice("headers.".length), r.name] as const),
    ];
    const headers = headerEntries.length
      ? `, headers: { ${headerEntries.map(([h, e]) => `${JSON.stringify(h)}: process.env[${JSON.stringify(e)}]!`).join(", ")} }`
      : "";
    const type = s.transport === "sse" ? "sse" : "http";
    return { code: `  createMCPClient({ transport: { type: ${JSON.stringify(type)}, url: ${JSON.stringify(url)}${headers} } }),`, stdio: false };
  }
  if (s.transport === "stdio" && typeof s.config.command === "string") {
    const args = Array.isArray(s.config.args) ? s.config.args.filter((a): a is string => typeof a === "string") : [];
    const envNames = (s.secretRefs ?? []).map((r) => r.name);
    const envStr = envNames.length ? `, env: { ${envNames.map((n) => `${JSON.stringify(n)}: process.env[${JSON.stringify(n)}]!`).join(", ")} }` : "";
    return { code: `  createMCPClient({ transport: new Experimental_StdioMCPTransport({ command: ${JSON.stringify(s.config.command)}, args: ${JSON.stringify(args)}${envStr} }) }),`, stdio: true };
  }
  return { skip: `${s.transport} MCP has no usable URL or stdio command` };
};
```

### 5.4 Compose (card always; server + skips when `opts.a2aServer`)
```ts
const a2aPackageJson = (gemName: string): string => JSON.stringify({
  name: safePathSegment(gemName).toLowerCase(), version: "0.1.0", private: true, type: "module",
  scripts: { build: "tsc", start: "node dist/server.js", dev: "tsx src/server.ts" },
  dependencies: { "@a2a-js/sdk": "^0.3.4", ai: "7.0.0-beta.178", "@ai-sdk/mcp": "1.0.0-beta.x", express: "^5", uuid: "^11" },
  devDependencies: { "@types/express": "^5", "@types/node": "^24", tsx: "^4", typescript: "^5" },
}, null, 2) + "\n";

const a2aComposeProject = (gem: Gem, opts: MaterializeOpts = {}): MaterializeResult => {
  const files: FileTree = { "agent-card.json": JSON.stringify(a2aAgentCard(gem), null, 2) + "\n" };
  if (!opts.a2aServer) return { files, skipped: [] };   // Card primitive: no runtime, nothing skipped

  // ── server mode ──
  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill");
  const instr  = gem.artifacts.filter((a): a is InstructionsArtifact => a.type === "instructions");
  const mcps   = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server");
  const hooks  = gem.artifacts.filter((a): a is HookArtifact => a.type === "hook");

  const instrText = instr.map((i) => `## ${i.name}\n\n${i.content}`).join("\n\n---\n\n");
  const skillText = skills.map((s) => `## Skill: ${s.name}\n\n${stripYamlFrontmatter(s.content)}`).join("\n\n---\n\n");
  const system = [instrText, skillText].filter(Boolean).join("\n\n---\n\n");

  const skipped: SkippedArtifact[] = [];
  const clientCodes: string[] = []; let usesStdio = false;
  for (const s of mcps) {
    const r = a2aMcpClient(s);
    if ("skip" in r) { skipped.push({ artifact: s.name, type: "mcp_server", reason: r.skip }); continue; }
    clientCodes.push(r.code); usesStdio ||= r.stdio;
  }
  for (const h of hooks) skipped.push({ artifact: h.name, type: "hook", reason: "A2A has no hook concept" });

  const mcpImports = clientCodes.length
    ? `import { createMCPClient } from "@ai-sdk/mcp";\n${usesStdio ? `import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";\n` : ""}`
    : "";
  const bootBlock = clientCodes.length
    ? `const mcpClients = await Promise.all([\n${clientCodes.join("\n")}\n]);
const tools = Object.assign({}, ...(await Promise.all(mcpClients.map((c) => c.tools()))));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { Promise.allSettled(mcpClients.map((c) => c.close())).finally(() => process.exit(0)); });`
    : `const tools = {};`;

  const server =
`import express from "express";
import { generateText, isStepCount } from "ai";
${mcpImports}import { type AgentCard, AGENT_CARD_PATH } from "@a2a-js/sdk";
import { type AgentExecutor, type RequestContext, type ExecutionEventBus,
  DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { v4 as uuid } from "uuid";
import cardBase from "../agent-card.json" with { type: "json" };

const MODEL = "anthropic/claude-sonnet-4-6";
const SYSTEM = \`${escapeTemplate(system)}\`;

const port = Number(process.env.PORT ?? 41241);
const baseUrl = process.env.PUBLIC_URL ?? \`http://localhost:\${port}\`;
const card: AgentCard = { ...(cardBase as AgentCard), url: \`\${baseUrl}/a2a/jsonrpc\`,
  additionalInterfaces: [{ url: \`\${baseUrl}/a2a/jsonrpc\`, transport: "JSONRPC" }] };

${bootBlock}

class GemExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const text = (ctx.userMessage.parts ?? []).filter((p: any) => p.kind === "text").map((p: any) => p.text).join("\\n");
    const { text: output } = await generateText({ model: MODEL, system: SYSTEM, tools, stopWhen: isStepCount(10), prompt: text });
    bus.publish({ kind: "message", messageId: uuid(), role: "agent",
      parts: [{ kind: "text", text: output }], contextId: ctx.contextId });
    bus.finished();
  }
  cancelTask = async (): Promise<void> => {};
}

const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new GemExecutor());
const app = express();
app.use(\`/\${AGENT_CARD_PATH}\`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use("/a2a/jsonrpc", jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.listen(port, () => console.log(\`A2A agent "\${card.name}" listening on :\${port}\`));
`;

  return {
    files: { ...files, "src/server.ts": server, "package.json": a2aPackageJson(gem.name), "SECRETS.md": a2aSecretsMd(gem.requiredSecrets) },
    skipped,
  };
};
```

### 5.5 Registry entry — wholly compose-driven (all per-type renderers are no-ops)
```ts
a2a: { id: "a2a", label: "A2A", skill: () => ({}), instructions: () => ({}), mcp: () => ({ files: {}, skipped: [] }), hook: () => ({}), compose: a2aComposeProject },
```

## 6. Testing (mirrors Eve/Flue/openai-sandbox fast-follows)

**Card-only — `materialize(gem, "a2a")`:**
- emits **exactly** `agent-card.json` (no `src/`, `package.json`, `SECRETS.md`).
- card parses; one `skills[]` entry per Gem skill (+ synthesized `chat` when none);
  `capabilities.streaming === false`; `description` = first instruction line.
- `skipped` is **empty** even for a Gem with hooks + an unmappable MCP server (Card models neither).

**Server — `materialize(gem, "a2a", { a2aServer: true })`:**
- adds `src/server.ts` + `package.json` + `SECRETS.md`.
- `src/server.ts`: imports `generateText` always; `createMCPClient` only when MCP maps;
  `Experimental_StdioMCPTransport` only when a stdio server maps; a skill-only Gem renders
  `const tools = {};`. `SYSTEM` contains instruction text and skill bodies.
- a `hook` is skipped ("A2A has no hook concept"); a `stdio` MCP server is **supported**; an `sse`
  server renders `type: "sse"`; an `http` server with a non-header secret is skipped.
- `SECRETS.md` has the model-access note, lists env-var names, and contains **no** `agentcore`/`arn:`
  strings (guards the B1 fix).

## 7. Out of scope (v1)

- NATS / any transport binding (AgentBack, not packaging).
- Streaming / task-lifecycle events, `artifact-update`, multi-turn history (v2).
- A façade adapter that forwards to an already-deployed eve/flue agent (the "Option C" variant) — could
  layer on later as a second server flavor; v1 server mode is self-contained.
- A2A client generation, push notifications, auth beyond `noAuthentication`, gRPC/HTTP+JSON.

## 8. Notes / residual risk

- **Card is the primitive; server is opt-in** (resolves "why a runtime?": the Card needs none; only the
  optional server does, and that runtime is incidental to AgentGem's mission).
- **Vendor-neutral runtime (O1):** AI SDK v7. Cost: no `sandboxMcpServer` reuse; server mode carries
  `a2aMcpClient`. Confined to server mode, so the default path stays dependency-free.
- **Pin two moving names before coding** (server mode only): `@ai-sdk/mcp` version (match the `ai` beta)
  and the `stopWhen` helper (`isStepCount` vs `stepCountIs`) against `ai@7.0.0-beta.178`.
- **AI SDK has no skills primitive:** server mode folds skill bodies into `system` (context cost). The
  Card advertises them as metadata, no execution — another point for the Card-first design.
- **Skill-semantics mismatch (accepted):** A2A `skills[]` advertise peer-callable capabilities; AgentGem
  skills are prompt bundles. `tags:["skill"]` marks provenance.
- **`../agent-card.json` under `dist/`:** server imports the card with `{ type: "json" }`; the `tsc`
  build must keep it resolvable from `dist/server.js`.
