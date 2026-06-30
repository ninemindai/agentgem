# Agent identity & access — relevance to AgentGem

Findings from reviewing Anthropic's [agent identity & access model](https://claude.com/blog/agent-identity-access-model)
against AgentGem's architecture (notably the in-flight A2A target on branch `a2a-target`).

## What the blog argues

When Claude operates autonomously in shared multiplayer spaces (Slack channels, repos), the
question "what can this **user** do?" stops being the right one. The fix is to give the
**agent its own identity per compartment**:

- Each private channel gets a distinct Claude identity; public channels share a workspace identity.
- Credentials are stored independently and **injected at request time**.
- Revoking the identity ends the agent's access everywhere that identity was used.
- Access (memory, connectors, repos, tools) is scoped per compartment; least privilege at the channel level.
- Everything is audited under agent service accounts.

## The core distinction: two different concerns

The blog bundles two things under "identity & access." They live in **different layers** and
must not be conflated:

| Concern | Direction | Question | Right layer |
|---|---|---|---|
| **Caller authN/authZ** (bearer gate, card `securitySchemes`) | inbound: caller → agent | "Are *you* allowed to invoke me?" | **A2A / protocol** |
| **Agent's own scoped identity** (the blog's real thesis) | outbound: agent → connected systems | "What can *I, the agent,* do here?" | **Harness / execution / host** |

A2A is a *wire protocol*: it can **advertise** a security scheme on the Agent Card and **check**
a bearer token at the JSON-RPC/REST boundary. It has no concept of "this skill may use connector
X but not Y" — that gating only exists where the tool loop actually runs.

## Where AgentGem already stands (and stands correctly)

- **Caller auth → A2A target.** The generated `server.ts` gates the JSON-RPC/REST routes on
  `A2A_API_KEY` (`Authorization: Bearer <key>`), and emits `securitySchemes`/`security[]` on the
  card only when the key is set. `.well-known` discovery stays open. This is the correct layer
  and is effectively done. (`packages/model/src/targets.ts` ~L639, ~L691)
- **Credentials injected at request time.** AgentGem redacts secrets to named refs at capture and
  re-binds them from `process.env` at materialize/boot. Structurally this *is* the blog's
  "credentials injected at request time" pattern — applied to build artifacts rather than channels.
- **Projection model.** `a2aAgentCard()` projects the neutral Gem into A2A's vocabulary, the same
  way skills become A2A skills. Any future identity concept should follow this same project-per-target rule.

## What's genuinely missing — and why we should NOT build it yet

The blog's model needs a primitive AgentGem does not have: **compartments**. AgentGem builds *one*
agent, not a multiplayer deployment, so there is no channel/space to scope an identity against.

Recommendation: **do not add a neutral identity/scope primitive now.**

1. **No compartments exist.** Modeling "identity per compartment" without compartments is a
   second-system over-reach.
2. **Boundary auth is already correctly placed.** Inbound bearer lives in the A2A target. Leave it.
3. **The outbound/scoped half is the host's job.** Once a Gem is deployed, the runtime host
   (Cloudflare, Bedrock AgentCore, the A2A operator) owns credential scoping and audit. AgentGem's
   README commits to being a *neutral source*, not a runtime — growing a permissions engine would
   break that conceptual integrity.

If/when a real multi-compartment use case appears, the principled shape is: **declare scope once**
in the neutral Gem (manifest level), then **project per target** — A2A → card `securitySchemes` +
per-skill `security`; AgentCore → IAM role/ARN; Cloudflare → binding scopes; harness → tool/MCP gating.

## The one cheap, in-scope improvement

Let the A2A card carry **per-skill `security`** so a Gem can *advertise* differing scopes per skill.
A2A skills can each carry their own `security` array. This is a **projection enhancement**, not a new
subsystem, and it stays honest that enforcement happens downstream. It also aligns the card with both
the A2A spec and the blog's least-privilege framing.

Open follow-up: push-notification callbacks (`pushNotifications: true`) fire **outbound** and also need
identity — confirm the generated server treats outbound push auth as a first-class concern, not just
inbound RPC auth.

## Bottom line

- **Caller auth = A2A.** Already there, correctly placed, done.
- **Agent-scoped identity = harness / host.** AgentGem at most *declares* it; it never *enforces* it.
- Most of the blog (channel isolation, RBAC on invocation, memory compartments, JIT grants, audit)
  is **out of scope** for a packaging tool and belongs to the deployed agent's host.
