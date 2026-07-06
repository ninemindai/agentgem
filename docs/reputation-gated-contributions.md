# Reputation-gated contributions — relevance to AgentGem

Findings from reviewing SkillGem's *AgentGem concept* doc
(`skillgem:docs/plans/2026-02-25-agentgem-concept.md`) against the in-flight GitHub App
(`docs/superpowers/specs/2026-07-05-github-app-design.md`). This note ports the *idea*, not
its economic layer.

## What the concept argues

"Don't ban AI contributors — make them **accountable**." Against "AI Slopageddon" (cURL shutting
its bug bounty after AI submissions hit 20% volume / 5% valid; Ghostty, Gentoo, NetBSD banning
AI contributions outright), blanket bans throw out legitimate AI-assisted work and manual triage
doesn't scale. The missing piece is accountability: today an agent submits with zero identity,
zero track record, zero consequence.

The fix is a governance layer — projects configure **reputation gates** that any contributor
(human or agent) must clear before a contribution reaches review. Three mechanisms:

- **Identity** — one persistent, portable identity per contributor (human or agent).
- **Reputation** — earned via merged PRs / accepted reports, decays for rejected/spam, time-weighted.
- **Gates** — per-action thresholds declared in a repo `.agentgem.yml`:

| Action | Example gate |
|---|---|
| Open an issue | ≥ 10 |
| Bug report | ≥ 1 accepted contribution anywhere |
| Doc PR | ≥ 50 |
| Code PR | ≥ 200 |
| CI/security-sensitive PR | ≥ 500 |

The concept's economic layer is **ERC-8004 on-chain identity + reputation**. That is the one
piece we do **not** port.

## The core substitution: chain → OAuth + behavioral signal

| Concept (SkillGem) | AgentGem adaptation |
|---|---|
| ERC-8004 wallet identity | **GitHub OAuth** — already our identity; "identity stays on the OAuth app" is a settled decision in the App design |
| On-chain reputation ledger | **Derived server-side** from data the aggregator already holds — confidence-weighted gem effectiveness, adoption counts, membership tenure/role, trust rubric — k-anonymized, tamper-evident via signed attestations |
| Portable `.agentgem.yml` gates | Same file, but the threshold is resolved against the OAuth identity + the derived score, not a wallet balance |

The on-chain ledger's only real job — *portable, earned, tamper-evident* reputation — is already
served by AgentGem's signed-attestation + k-anon aggregate spine. The chain adds nothing we need.

## Where AgentGem already stands

The concept's identity-and-accountability spine is **already built**. The GitHub App *is* the
accountability infrastructure the doc asks for:

- **Persistent, portable identity** = GitHub OAuth (device flow + web code flow, unified session
  bridge). Done.
- **App-authoritative membership** = installing the App yields private-inclusive org membership +
  role; gates (`/api/usage/org`, publish-ownership, admin writes) already key off it. This is a
  **binary** gate ("member? admin?"); the reputation concept is the same idea *generalized to a
  graduated threshold*.
- **A reputation signal is now accruing** — the aggregator's confidence-weighted effectiveness
  score, adoption counts, and trust rubric are exactly the "track record" the concept wants:
  earned from behavior, cross-producer k-anonymized, no ledger required.

## What's genuinely missing — and the real tension

Two gaps, and neither is small:

1. **Gating contributions ≠ gating access.** Today's gates decide who may *read* an org dashboard
   or *publish* under a scope. The concept gates *inbound PRs/issues on third-party repos* — a
   PR-time check. That needs GitHub permissions the App **deliberately excludes**: Pull requests
   (read) + Checks / Commit statuses (**write**). The design's hard rule is *"additions require
   re-approval by every installed org,"* and today's App is Members-read + Contents-read only. A
   contribution-gating check is a **different permission tier and a different install motion.**

2. **Different audience.** The shipped App is enterprise-**inward** — an org installs it to see its
   *own* members and index its *own* internal skills. The concept is OSS-maintainer-**outward** — a
   project gates *strangers*. Same identity spine, different product. This is closer to the
   explicitly-deferred **P3 (bot-identity registry publish)** than to the approved P1/P2 scope.

## Recommendation

- **Do NOT bolt contribution-gating onto the current App.** It would break the minimal-permission
  promise (re-approval churn for every enterprise installer who wants none of it) and conflate two
  audiences — a textbook second-system over-reach (cf. the same discipline in
  `agent-identity-access.md`).
- **Sequence it as a follow-on that reuses the spine.** The prerequisite — a portable,
  behavior-derived reputation score — is the valuable, in-scope work, and it is *already underway*
  via the aggregator. Ship and harden that first; it stands alone (effectiveness leaderboards, trust
  surfaces) regardless of whether contribution-gating is ever built.
- **When the OSS-governance product is greenlit**, build it as a *separate* GitHub App (or a distinct
  opt-in permission tier), not an expansion of this one. Its loop: read the contributor's OAuth
  identity → resolve their aggregate reputation → write a **Commit Status / Check** on the PR, with
  the `.agentgem.yml` gate table resolved server-side. The membership/installation-token plumbing
  built here is directly reusable; only the write scope + maintainer-facing install are new.

## Bottom line

- **Identity + accountability = already built** (OAuth + App-authoritative membership). The concept
  is the brand thesis; the plumbing is here.
- **Reputation signal = accruing now** (aggregator effectiveness / adoption / trust). Keep
  investing — it is the real prerequisite, and it is chain-free.
- **Contribution-gating = a distinct, later product** needing new GitHub write scopes and a
  maintainer-facing install. Do not fold it into the enterprise-inward App; reuse the spine when
  it's greenlit.
- **ERC-8004 = do not port.** OAuth identity + signed / k-anon aggregates already deliver portable,
  earned reputation.
