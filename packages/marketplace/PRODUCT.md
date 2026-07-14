# PRODUCT.md — AgentGem (marketplace)

**Register:** product. This is a public discovery *tool* — the design serves the task (find trusted agent ingredients & gems), it isn't the product. Bar: earned familiarity; the UI disappears into browsing.

**What it is:** the public web front-end at `app.agentgem.ai` for AgentGem's data moat and Gem exchange. The home surface (`/`) is **Miniapps** — an arcade of AI-authored, sealed, offline-installable mini-games. Around it:
- **Ingredients** (`/ingredients`, `/ingredient/:id`) — a trusted-adoption leaderboard of skills/MCPs (k-anonymized), with per-ingredient co-occurrence + adoption.
- **Gems** (`/gems`, `/gems/:key`) — composable bundles of ingredients, publishable **Public / Unlisted / Private**, **versioned**, and gated behind **group review**; each gem cross-links to its ingredients' live adoption.
- **Sources**, **Publish**, **My apps**, **Offline** (installed PWA library), and **Groups** (share a private gem, run peer review).
- **Profiles** at `/@handle` (apps · reviews · orgs · groups) and **orgs** at `/orgs/:scope` (catalog · team usage · benchmark + governance).
Sign in with **GitHub, Google, or a passkey** (better-auth). Credential-light, fast; installable as a PWA.

**Who uses it:** developers evaluating which agent capabilities are actually adopted/verified before installing, publishing and reviewing gems with their team, and playing/installing miniapps — scanning ranked lists and detail pages, mid-task, on desktop and mobile.

**Identity (committed — preserve):** terracotta **`#b4543a`** is the primary brand accent (ranking bars, active nav, links, hover); forest green **`#3a7d44`** is the *verified* signal only. Strategy: **Restrained** — tinted-neutral surfaces, the two brand colors used for meaning (rank intensity, verification, current selection), never decoration. One sans family, fixed rem scale, dense-but-legible.

**Voice:** quiet, factual, trustworthy ("trusted-adoption data, k-anonymized"). No marketing flourish; numbers carry the page.
