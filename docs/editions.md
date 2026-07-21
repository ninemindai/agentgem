# Editions

AgentGem comes in two editions that share one archive format and one community
marketplace.

## AgentGem OSS

**MIT-licensed, local-first, free.** `npx @ninemind/agentgem` (or the native
[desktop app](desktop.md)) runs a small server on your machine and opens the
console. Everything that reads your agent setup and session history, builds and
composes Gems, and shares them runs locally:

- **Mine your work** — [Analyze](analyze.md) workflow-aware Gem recommendations
  and distilled draft skills, [Recall](recall.md) cross-session search + the
  `agentgem-goldmine` MCP server, [context hygiene](context-hygiene.md) scoring
  and live nudges, and [Chat](chat.md) grounded in your transcripts.
- **Build & compose Gems** — the [manifest + lock archive](archive-format.md),
  [testbed install/merge](testbed-and-run.md), and [materialize targets](targets.md)
  (Eve, Flue, OpenAI Sandbox, Bedrock AgentCore, editor formats + A2A) with
  **Run app** locally from the Materialize panel.
- **Play** — [AI-authored mini-apps](play.md), sealed to run anywhere and
  versioned as `game` Gems.
- **The marketplace client** — `agentgem get` to install a published Gem,
  publish-to-Explore, `agentgem send` / `receive` for an encrypted one-time
  hand-off, and `agentgem verify`. See [Sharing](sharing.md).

The OSS package carries **no accounts, no hosted server, no cloud deploy** — it
talks to the community marketplace as a pure client.

## The community marketplace

**[app.agentgem.ai](https://app.agentgem.ai) — a free hosted service operated by
ninemind, shared by both editions.** It's where published Gems live:

- Sign in with **GitHub, Google, X, or a passkey**; each account gets a tabbed
  **`/@handle`** profile hub.
- **Publish** a Gem Public, Unlisted, or Private; cut versions; **star** and
  **review**.
- The **arcade** — AI-authored mini-apps as installable, offline-playable PWAs,
  searchable by genre and tag.
- Every shareable link unfurls with a
  [branded preview card](sharing.md#branded-link-previews).

The hosted marketplace is an **early testbed**: treat it as a preview, and expect
accounts, stars, and reviews to be reset occasionally.

## AgentGem Enterprise

**For teams that need the platform under their control.** Enterprise is in
**early access** — a design-partner program, not a self-serve product yet. It adds:

- **Teams & governance** — **groups** (share a private Gem, run peer review) and
  **review-gated releases** (request review → a member installs to test → an
  approval publishes); **orgs** with a scorecard, team-usage dashboard, and
  **benchmark governance** over what's contributed.
- **Cloud miniapp builds** — build Play mini-apps on managed cloud agents instead
  of a local coding agent.
- **The GitHub App** — repo-native capture and enterprise onboarding.
- **Self-host** — deploy the hosted service into your own AWS account via
  Terraform, or run it fully air-gapped.
- **Support** — a direct line to the team.

**Interested? Email [raymond@ninemind.ai](mailto:raymond@ninemind.ai).**

## At a glance

| | OSS | Enterprise |
| --- | --- | --- |
| License | MIT, free | Commercial (early access) |
| Runs | Locally (`npx` / desktop) | Hosted — cloud or your own AWS |
| Mine, build, compose, materialize, Play | ✓ | ✓ |
| Marketplace client (`get` / publish / `send` / `verify`) | ✓ | ✓ |
| Community marketplace (accounts, `/@handle`, publish, star, review, arcade) | ✓ (shared service) | ✓ |
| Groups & review-gated releases | — | ✓ |
| Orgs, scorecards, benchmark governance | — | ✓ |
| Cloud miniapp builds | — | ✓ |
| GitHub App | — | ✓ |
| Self-host / air-gap | — | ✓ |
| Support | Community | Direct |

Email **[raymond@ninemind.ai](mailto:raymond@ninemind.ai)** to join the Enterprise
early-access program.
