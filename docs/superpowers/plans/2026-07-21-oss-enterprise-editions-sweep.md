# OSS + Enterprise Editions Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align docs/website/README with the 0.9.0 local-first split, fix the broken site build, and introduce the dual OSS + Enterprise offering (marketplace shared, groups → Enterprise, early-access CTA).

**Architecture:** Copy/content sweep across `docs/*.md`, `website/*.html`, `website/build.mjs`, and `README.md`, plus one new `docs/editions.md`. The through-line is **re-attribution, not deletion**: hosted-service features are true of the service the console connects to, false of the local OSS package — so most edits change the subject, not the facts. Groups/orgs/review-gating move to the Enterprise column; accounts/publish/star/review/arcade stay in the shared community-marketplace column.

**Tech Stack:** Markdown, hand-authored HTML + `website/styles.css` design tokens (no CSS framework), `website/build.mjs` (marked + highlight.js static renderer → `website/dist/`), pnpm.

## Global Constraints

- Enterprise CTA is exactly `mailto:raymond@ninemind.ai`; frame Enterprise as **early access** — no pricing, no GA claims. (spec §Decisions 3)
- Two offerings only: **AgentGem OSS** and **AgentGem Enterprise**. The **community marketplace** (app.agentgem.ai) is the shared service both use, *not* a third tier. (spec §Decisions 2)
- **Groups, review-gated releases, orgs, benchmark governance, cloud builds, GitHub App, AWS self-host** are Enterprise. Community column = accounts / `/@handle` / publish / star / review / arcade. (spec §Decisions 4)
- Re-attribution rule: hosted features are described as capabilities **of the hosted service you connect to**, never as routes/modules of the local OSS server. (spec §The story)
- Do **not** touch any `skills/*/SKILL.md` (audit-clean; miniapp skill only changes via `MINIAPP_BUILDER_BRIEF`). (spec §Out of scope)
- Reuse existing website CSS classes — **add no new className** without a matching `styles.css` rule. The OSS-vs-Enterprise comparison reuses `.compare` / `.vs.old` / `.vs.new`; cards reuse `.card` / `.cards` / `.chip`. (CLAUDE.md UI rule)
- Desktop download pointer stays `desktop-v0.8.0` (no new desktop release). (spec §Website)
- Work on branch `editions-sweep` in worktree `../agentgem-worktrees/editions-sweep`. Commit per task.

---

### Task 1: Fix the broken site build (remove deleted `docs/registry.md`)

`docs/registry.md` was deleted in `1c81d94f` but is still in `build.mjs`'s allow-list, so `pnpm build:site` throws ENOENT on it. This is the regression test: the build currently fails and must pass.

**Files:**
- Modify: `website/build.mjs` (DOC_PAGES ~line 56; NAV_SECTIONS ~line 98; doc-shell footer template ~line 235)

**Interfaces:**
- Produces: a buildable site (`pnpm build:site` exits 0). Later tasks add `docs/editions.md` to these same two lists.

- [ ] **Step 1: Reproduce the failure**

Run: `cd ../agentgem-worktrees/editions-sweep && pnpm build:site`
Expected: FAIL — `ENOENT ... docs/registry.md` (thrown from the `fs.readFileSync` over DOC_PAGES).

- [ ] **Step 2: Remove `docs/registry.md` from `DOC_PAGES`**

In `website/build.mjs`, delete this line from the `DOC_PAGES` array:

```js
  'docs/registry.md',
```

- [ ] **Step 3: Remove the Registry nav entry from `NAV_SECTIONS`**

In the `Distribution` section of `NAV_SECTIONS`, delete this line:

```js
      ['docs/registry.md', 'Registry'],
```

- [ ] **Step 4: Remove the dead Registry link from the doc-shell footer template**

In the footer template string (~line 235), delete this line:

```js
      <a href="${rel}docs/registry.html">Registry</a>
```

- [ ] **Step 5: Verify the build passes and emits no registry artifact**

Run: `pnpm build:site && ls website/dist/docs/registry.html 2>&1; grep -rl "registry.html" website/dist || echo "NO REGISTRY LINKS"`
Expected: build exits 0; `ls` reports the file does **not** exist; grep prints `NO REGISTRY LINKS` (the index/vision footers still referencing it are fixed in Tasks 5–6 — if grep finds them here that's expected until then, so also run `grep -rl "registry.html" website/dist/docs` which must be empty now).

- [ ] **Step 6: Commit**

```bash
git add website/build.mjs
git commit -m "fix(website): drop deleted docs/registry.md from the build allow-list"
```

---

### Task 2: New `docs/editions.md` — the canonical editions page

**Files:**
- Create: `docs/editions.md`
- Modify: `website/build.mjs` (add to DOC_PAGES + NAV_SECTIONS)
- Modify: `docs/index.md` ("Start here" list, ~line 15–24)

**Interfaces:**
- Consumes: the buildable site from Task 1.
- Produces: `agentgem.ai/docs/editions.html` (rendered by the same pipeline; auto-added to `llms.txt`/sitemap via NAV_SECTIONS). Later tasks (README, website) link to it.

- [ ] **Step 1: Write `docs/editions.md`**

Create `docs/editions.md` with exactly this content:

```markdown
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
```

- [ ] **Step 2: Register the page in `build.mjs` DOC_PAGES**

In `website/build.mjs`, add `'docs/editions.md',` to `DOC_PAGES` immediately after `'docs/concepts.md',`:

```js
  'docs/concepts.md',
  'docs/editions.md',
```

- [ ] **Step 3: Register it in NAV_SECTIONS ("Start here")**

In the `Start here` section of `NAV_SECTIONS`, add the Editions item after Concepts:

```js
      ['docs/concepts.md', 'Concepts'],
      ['docs/editions.md', 'Editions'],
```

- [ ] **Step 4: Link it from `docs/index.md` "Start here"**

In `docs/index.md`, after the `**[Concepts](concepts.md)**` bullet in the "Start here" list, add:

```markdown
- **[Editions](editions.md)** — AgentGem OSS vs. Enterprise, and the community
  marketplace both share.
```

- [ ] **Step 5: Build and verify the page renders + is indexed**

Run: `pnpm build:site && ls website/dist/docs/editions.html && grep -c "editions" website/dist/llms.txt && grep -c "editions" website/dist/sitemap.xml`
Expected: `editions.html` exists; both greps return ≥ 1.

- [ ] **Step 6: Commit**

```bash
git add docs/editions.md docs/index.md website/build.mjs
git commit -m "docs(editions): add the OSS + Enterprise editions page and wire it into the site"
```

---

### Task 3: `docs/api-reference.md` — re-attribute the hosted endpoint families

**Files:**
- Modify: `docs/api-reference.md` (~lines 79–93, "Marketplace, benchmark, memory & cards")

**Interfaces:**
- Consumes: nothing from prior tasks (independent doc edit).

- [ ] **Step 1: Replace the section intro and table**

In `docs/api-reference.md`, replace the block starting at `### Marketplace, benchmark, memory & cards` through the end of its table (the `| **OG cards** | ...` row) with:

```markdown
### The hosted marketplace & local memory sync

The **local** OSS server exposes one marketplace-facing read route,
`GET /api/registry/gems` — the cached Explore index the console browses, plus the
**Memory sync** family below. Everything else in this section is served by the
**community marketplace** (`app.agentgem.ai`), a separate hosted service the console
talks to as a client; those routes are **not** part of the local server and several
of them (groups, orgs, review-gating) are [Enterprise](editions.md). The hosted
API is documented by its own OpenAPI document; the groups are:

| Group | Where | What it covers |
| --- | --- | --- |
| **Explore index** | local server | `GET /api/registry/gems` — the cached marketplace catalog the console browses |
| **Memory sync** | local server | Provider config, pull provider memories into recall, consent-gated push outbox (`/api/memory/*`, local-only — gated on `SERVE_CONSOLE`) |
| **Publish & catalog** | hosted marketplace | Publish with a **visibility scope** (Public/Unlisted/Private) + **versioning**, Explore/browse, zero-config install, stars, reviews |
| **Groups & review-gated publishing** *(Enterprise)* | hosted marketplace | Review-request inbox (approve/request-changes/comment/withdraw), groups (create/join/members/invites), group-shared private gems |
| **Identity** | hosted marketplace | better-auth sign-in (GitHub/Google/X/passkeys), account linking, `/@handle` profiles; **orgs + benchmark governance** are [Enterprise](editions.md) |
| **Benchmark contribution** | hosted marketplace | Consent-gated ingest of ingredients-only, k-anonymized attestations; benchmark read-back |
| **OG cards** | hosted marketplace | Branded/screenshot link-preview cards (see [Sharing](sharing.md#branded-link-previews)) |
```

- [ ] **Step 2: Verify no local-route claims remain for removed surfaces**

Run: `grep -nE "server \(and the hosted marketplace it proxies\)|/api/publish-status|/api/install-hosted|/og/card.png" docs/api-reference.md || echo "CLEAN"`
Expected: `CLEAN` (the specific removed local-route strings are gone; the table now attributes them to the hosted service by family, not by local path).

- [ ] **Step 3: Commit**

```bash
git add docs/api-reference.md
git commit -m "docs(api-reference): re-attribute hosted marketplace routes; mark groups/orgs Enterprise"
```

---

### Task 4: `docs/architecture.md`, `docs/index.md`, `docs/sharing.md` — re-attribute hosted features

**Files:**
- Modify: `docs/architecture.md` (~lines 48–53)
- Modify: `docs/index.md` (~lines 63–72)
- Modify: `docs/sharing.md` (~lines 110–119, the "Web accounts" bullet)

**Interfaces:**
- Consumes: `docs/editions.md` exists (Task 2) — these edits link to it.

- [ ] **Step 1: Reframe the architecture "bottom band"**

In `docs/architecture.md`, replace the paragraph beginning `A bottom band — the **hosted marketplace**` through `...with org governance.` with:

```markdown
A bottom band — the **community marketplace** (`app.agentgem.ai`) — is a separate
hosted service (operated by ninemind, shared by both [editions](editions.md)) that
the console signs into and publishes to: better-auth identity (GitHub / Google / X
/ passkeys) with `/@handle` profiles, the catalog and its publish scopes /
versioning, and stars / reviews. **Groups, orgs, review-gating, and the opt-in,
k-anonymized [benchmark feedback loop](diagrams/benchmark-feedback-loop.html) with
governance are [Enterprise](editions.md).** The console (and the desktop app) carry
none of this in-process — they talk to the service as a pure client (see the
[client/server split](diagrams/desktop-client-server-architecture.html)).
```

- [ ] **Step 2: Reframe the `docs/index.md` marketplace + identity bullets**

In `docs/index.md`, replace the `- **The public marketplace...**` bullet and the first sentence of the `- **[Sharing & identity]...**` bullet's account clause. Replace the marketplace bullet with:

```markdown
- **The community marketplace at [app.agentgem.ai](https://app.agentgem.ai)** — a
  free hosted service, shared by both [editions](editions.md), where published Gems
  live: publish composable Gems (Public / Unlisted / Private, versioned), browse,
  star, review, install, and play installable/offline mini-apps. **Groups and
  review-gated releases are [Enterprise](editions.md).** Early testbed — hosted data
  may be reset.
```

Then in the `- **[Sharing & identity]...**` bullet, replace the trailing sentence `Web accounts use **better-auth** (sign in with GitHub, Google, or a passkey) with a **`/@handle`** profile hub;` with:

```markdown
  Accounts on the community marketplace use **better-auth** (GitHub, Google, X, or a
  passkey) with a **`/@handle`** profile hub;
```

- [ ] **Step 3: Reframe the `docs/sharing.md` "Web accounts" bullet**

In `docs/sharing.md`, in the `## Identity` section, replace the `- **Web accounts** on ...` bullet with:

```markdown
- **Accounts on the community marketplace** ([app.agentgem.ai](https://app.agentgem.ai),
  a free hosted service shared by both [editions](editions.md)) run on
  [better-auth](https://better-auth.com): sign in with **GitHub, Google, X, or a
  passkey**, and link more than one provider to the same account. Each account is
  keyed on a stable id with an optional **`@handle`**, and gets a tabbed profile hub
  at [`/@handle`](https://app.agentgem.ai) (apps, reviews). **Groups and orgs are
  [Enterprise](editions.md).**
```

- [ ] **Step 4: Verify the edits reference editions and drop OSS-in-process framing**

Run: `grep -c "editions.md" docs/architecture.md docs/index.md docs/sharing.md && grep -n "signs in, publishes, and contributes" docs/architecture.md || echo "OLD FRAMING GONE"`
Expected: each of the three files returns ≥ 1 for `editions.md`; the old "signs in, publishes, and contributes" phrasing is gone (`OLD FRAMING GONE`).

- [ ] **Step 5: Build to confirm the three docs still render**

Run: `pnpm build:site && ls website/dist/docs/architecture.html website/dist/docs/index.html website/dist/docs/sharing.html`
Expected: build exits 0; all three files listed.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture.md docs/index.md docs/sharing.md
git commit -m "docs: re-attribute hosted marketplace/identity to the shared service; groups/orgs -> Enterprise"
```

---

### Task 5: `website/index.html` — hero, flow, cards, marketplace/editions split, ladder, footer

The largest edit. Reframe removed-surface claims and split the team section into a community-marketplace section + a new OSS/Enterprise editions section reusing `.compare`/`.vs`.

**Files:**
- Modify: `website/index.html` (hero ~55; flow station ~146–150; "Composable registry" card ~201–206; "Deploy anywhere" card ~207–212; marketplace section ~253–282; ladder rung 2 ~317–320; footer ~350–351)

**Interfaces:**
- Consumes: `docs/editions.html` builds (Task 2) — the new section links to it.

- [ ] **Step 1: Fix the hero lede**

Replace `reuse it, deploy it on demand, and sell it per call when the network opens.` (in the hero `<p class="lede">`) with:

```html
reuse it, compose it, materialize it to any target, and run it locally — then publish it to the community marketplace or share it agent-to-agent.
```

- [ ] **Step 2: Retitle the "Deploy it" flow station**

Replace the `Deploy it` station block (the `<span class="label">Deploy it</span>` and its `<span class="sub">`) with:

```html
      <span class="label">Materialize it</span>
      <span class="sub">Render the same Gem to Eve, Flue, OpenAI, AgentCore, and editor formats — then run it locally from the Materialize panel. It isn't locked to one runtime</span>
```

- [ ] **Step 3: Rewrite the "Composable registry" card**

Replace the whole `Composable registry` card (`<h3>Composable registry</h3>` `<p>...</p>` `<div class="chips">...</div>`) with:

```html
      <h3>Composable Gems</h3>
      <p>Install and merge published Gems over one neutral archive format — assembling bigger agents out of smaller, shareable pieces, each with a single re-resolved lock. Publish to the <a href="https://app.agentgem.ai">community marketplace</a> and every shared link unfurls with a branded preview card.</p>
      <div class="chips"><span class="chip">install</span><span class="chip">merge</span><span class="chip">publish</span></div>
```

- [ ] **Step 4: Rewrite the "Deploy anywhere" card**

Replace the `Deploy anywhere` card's `<h3>` and `<p>` (keep the chip row of real targets) with:

```html
      <h3>Materialize anywhere</h3>
      <p>The same neutral Gem feeds multiple code-gen targets — pick one, render it, and run the app locally from the Materialize panel.</p>
```

(Leave the existing `<div class="chips">` with the Eve/Flue/OpenAI/AgentCore/Claude Agents links unchanged.)

- [ ] **Step 5: Rewrite the marketplace section — community column only**

Replace the marketplace section's `<h2>` and its four cards (from `<h2 class="sec-title">Publish it, review it, ship it as a team.` through the closing `</div>\n</section>` of that `.cards` block) with a three-card community section:

```html
  <h2 class="sec-title">Publish it, play it, share it.</h2>
  <div class="cards">
    <div class="card">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg></div>
      <h3>Publish, scoped &amp; versioned</h3>
      <p>Ship a Gem Public, Unlisted, or Private to the community marketplace, cut a new version or overwrite the current one, and star or review what others publish.</p>
      <div class="chips"><span class="chip">Public · Unlisted · Private</span><span class="chip">versioning</span><span class="chip">stars &amp; reviews</span></div>
    </div>
    <div class="card">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
      <h3>Accounts &amp; profiles</h3>
      <p>Sign in with GitHub, Google, X, or a passkey. Each account gets a <code>/@handle</code> profile hub. Teams, groups, and org governance live in <a href="docs/editions.html">Enterprise</a>.</p>
      <div class="chips"><span class="chip">passkeys</span><span class="chip">@handle</span></div>
    </div>
    <div class="card">
      <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 18h6"/></svg></div>
      <h3>Installable miniapps</h3>
      <p>The arcade is a PWA: browse AI-authored mini-games by genre and tag, play them sealed in the page, and pin any one to play offline — no network required.</p>
      <div class="chips"><a class="chip" href="https://app.agentgem.ai">Arcade</a><span class="chip">offline</span><span class="chip">search &amp; tags</span></div>
    </div>
  </div>
```

- [ ] **Step 6: Add the OSS + Enterprise editions section**

Immediately after the `</section>` that closes the marketplace section from Step 5 (and before the `<section class="preview wrap">` "A Gem, with secrets sealed." block), insert a new section reusing the existing `.compare`/`.vs.old`/`.vs.new` classes (note: `.vs.old` here is not "worse", just the free tier — its dashed muted styling reads fine as "free/local"; the darker `.vs.new` reads as the paid tier):

```html
<section class="wrap" style="padding:8px 0 24px">
  <p class="eyebrow">Open source &amp; Enterprise</p>
  <h2 class="sec-title">Yours locally. Ours to run for your team.</h2>
  <p class="lead" style="max-width:620px;margin:0 auto 8px;text-align:center;color:var(--ink-2);font-size:16px">Everything that mines, builds, and ships a Gem is <b>MIT open source</b> and runs on your machine. Teams that need groups, governance, cloud builds, and self-hosting get them in <b>Enterprise</b> — in early access now.</p>
  <div class="compare">
    <div class="vs old">
      <span class="mk">AgentGem OSS · free</span>
      <ul>
        <li>Local-first: <code>npx @ninemind/agentgem</code> or the desktop app.</li>
        <li>Mine, build, compose, materialize, run locally, and Play.</li>
        <li>Marketplace client: <code>get</code>, publish, <code>send</code>/<code>receive</code>, <code>verify</code>.</li>
        <li>Community marketplace: accounts, <code>/@handle</code>, publish, star, review, arcade.</li>
      </ul>
    </div>
    <div class="vs new">
      <span class="mk">AgentGem Enterprise · early access</span>
      <ul>
        <li>Groups &amp; review-gated releases; orgs with scorecards + benchmark governance.</li>
        <li>Cloud miniapp builds on managed agents.</li>
        <li>The GitHub App for repo-native capture.</li>
        <li>Self-host into your own AWS via Terraform, or air-gapped.</li>
      </ul>
    </div>
  </div>
  <div class="cta-row" style="margin-top:24px">
    <a class="btn btn-primary" href="mailto:raymond@ninemind.ai">Talk to us about Enterprise →</a>
    <a class="btn btn-ghost" href="docs/editions.html">Compare editions</a>
  </div>
</section>
```

- [ ] **Step 7: Correct the ladder "Publish" rung**

In the "A Shopify for AI agents" ladder, replace the rung 2 `<div class="desc">` (`Push Gems to the <b>agent service network</b> for others to find and call.`) with:

```html
        <div class="desc">Publish Gems to the <b>community marketplace</b> so others can find, install, and compose them.</div>
```

(Leave the `Shipped` status — publish-to-Explore is real.)

- [ ] **Step 8: Fix the footer**

In the `index.html` footer `.foot-links`, replace the two links `<a href="docs/targets.html">Targets &amp; deploy</a>` + `<a href="docs/registry.html">Registry</a>` with:

```html
      <a href="docs/targets.html">Targets</a>
      <a href="docs/editions.html">Editions</a>
```

- [ ] **Step 9: Build and grep-verify**

Run: `pnpm build:site && grep -c "registry.html" website/dist/index.html; grep -c "rary1\|deploy it on demand\|undeploy\|managed backends" website/dist/index.html; grep -c "editions.html\|raymond@ninemind.ai" website/dist/index.html`
Expected: build exits 0; first grep (`registry.html`) = 0; second grep (removed-surface phrases) = 0; third grep (new links) ≥ 2.

- [ ] **Step 10: Visually verify in a browser (light + dark, mobile width)**

Open `website/dist/index.html`, confirm: the editions `.compare` renders as two styled columns (not raw defaults), the Enterprise CTA button is `var(--grad-gem)`-style primary, no dead Registry link in the footer, and the section flows correctly at ~375px width. (Use the `verify` skill / browser-harness for a screenshot pass.)

- [ ] **Step 11: Commit**

```bash
git add website/index.html
git commit -m "website(index): local-first hero/cards, community marketplace section, OSS+Enterprise editions"
```

---

### Task 6: `website/vision.html` — correct registry claims, split the team ring, fix dead links

The Shopify vision framing stays (it's honestly roadmap). Only the "Shipped"-marked claims that rest on the removed registry, and the team paragraph, and the dead links change.

**Files:**
- Modify: `website/vision.html` (ladder rung 2 ~145–149; "second gap" paragraph ~196; "registry is the network seed" card ~209–213; "See the registry" CTA ~236; footer ~249)

- [ ] **Step 1: Fix ladder rung 2**

Replace the rung 2 `<div class="desc">` (`Push Gems to the <b>agent service network</b> (today, a GitHub-backed registry) so others can find, compose, and call them.`) with:

```html
        <div class="desc">Publish Gems to the <b>community marketplace</b> (today, <a href="https://app.agentgem.ai">app.agentgem.ai</a>) so others can find, install, and compose them.</div>
```

- [ ] **Step 2: Split the "second gap" team paragraph (community vs. Enterprise)**

Replace the trailing sentence of the "second gap" paragraph — `This ring is shipped: <b>share a private Gem with a group</b>, gate releases behind <b>peer review</b>, and give an org a scorecard, team usage, and <b>benchmark governance</b>.` — with:

```html
That’s the second thing a Gem is for: your team <b>runs</b> your best practice, instead of reading a screenshot of it in a group chat. <a href="docs/editions.html"><b>AgentGem Enterprise</b></a> (early access) makes it real — <b>share a private Gem with a group</b>, gate releases behind <b>peer review</b>, and give an org a scorecard, team usage, and <b>benchmark governance</b>.
```

(Delete the now-duplicated leading clause `That’s the second thing a Gem is for: ... group chat.` from the original if it still precedes this — verify the sentence reads once, not twice.)

- [ ] **Step 3: Rewrite the "registry is the network seed" card**

Replace that card's `<h3>` and `<p>` with:

```html
      <h3>The marketplace is the network seed</h3>
      <p>Publish, install, and merge already work over one neutral archive format. Turning that into a live, callable agent service network — A2A-discoverable and transactable — is an extension, not a rebuild.</p>
```

- [ ] **Step 4: Fix the "See the registry" CTA**

Replace `<a class="btn btn-ghost" href="docs/registry.html">See the registry</a>` with:

```html
      <a class="btn btn-ghost" href="docs/editions.html">See the editions</a>
```

- [ ] **Step 5: Fix the footer**

In the `vision.html` footer `.foot-links`, replace `<a href="docs/targets.html">Targets &amp; deploy</a>` + `<a href="docs/registry.html">Registry</a>` with:

```html
      <a href="docs/targets.html">Targets</a>
      <a href="docs/editions.html">Editions</a>
```

- [ ] **Step 6: Build and grep-verify**

Run: `pnpm build:site && grep -c "registry.html" website/dist/vision.html; grep -c "GitHub-backed registry" website/dist/vision.html; grep -c "editions.html" website/dist/vision.html`
Expected: build exits 0; first two greps = 0; third ≥ 1.

- [ ] **Step 7: Commit**

```bash
git add website/vision.html
git commit -m "website(vision): correct registry-shipped claims, split team ring into Enterprise, fix dead links"
```

---

### Task 7: `README.md` — re-attribute marketplace/identity, add an Editions section

**Files:**
- Modify: `README.md` (~lines 81–96: "A public marketplace" + "Identity, profiles, and teams" bullets)

**Interfaces:**
- Consumes: `docs/editions.md` exists (Task 2).

- [ ] **Step 1: Rewrite the "A public marketplace" bullet**

Replace the `- **A public marketplace** — ...reset occasionally.` bullet with:

```markdown
- **A community marketplace** — publish and install composable Gems over the same
  archive format at [app.agentgem.ai](https://app.agentgem.ai), a free hosted
  service shared by both [editions](docs/editions.md). Publish a Gem **Public,
  Unlisted, or Private**, cut a **new version**, and **star or review** what others
  publish. **Rubrics** are a first-class Gem type. Mini-apps are **installable PWAs**
  that **play offline** and are searchable by genre and tag. Every shareable link
  [unfurls with a branded preview card](docs/sharing.md#branded-link-previews).
  **Groups and review-gated releases are [Enterprise](docs/editions.md).** The hosted
  marketplace is an **early testbed** — expect accounts, stars, and reviews to be
  reset occasionally.
```

- [ ] **Step 2: Rewrite the "Identity, profiles, and teams" bullet into an OSS-scoped identity + Editions pointer**

Replace the `- **Identity, profiles, and teams** — ...benchmark governance**.` bullet with:

```markdown
- **Identity & profiles** — marketplace accounts sign in with **GitHub, Google, X,
  or a passkey** ([better-auth](https://better-auth.com) under the hood); each gets a
  tabbed **`/@handle` profile hub**. **Teams (groups, review, orgs, benchmark
  governance) are part of [AgentGem Enterprise](docs/editions.md).**
- **OSS &amp; Enterprise** — the local-first console, Gem building, materialize, Play,
  and the marketplace client are **MIT open source**. Groups, org governance, cloud
  miniapp builds, the GitHub App, and AWS self-host are **AgentGem Enterprise** (early
  access) — see [Editions](docs/editions.md) or email
  [raymond@ninemind.ai](mailto:raymond@ninemind.ai).
```

- [ ] **Step 3: Verify**

Run: `grep -c "docs/editions.md" README.md; grep -c "group review (request review" README.md`
Expected: first grep ≥ 2; second grep = 0 (the old group-review phrasing is gone).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): re-attribute marketplace/identity to shared service; add Editions section"
```

---

### Task 8: Freshness additions — `docs/chat.md` + `docs/play.md`

Small in-scope currency wins for 0.9.0 features the docs don't yet mention.

**Files:**
- Modify: `docs/chat.md` (after the streaming paragraph, before "## Draft a Gem from the conversation")
- Modify: `docs/play.md` (in the Studio actions area, after "## Save, push, and share" region — add a connectors note)

- [ ] **Step 1: Add a chat queue + Interrupt paragraph**

In `docs/chat.md`, immediately before the `## Draft a Gem from the conversation` heading, insert:

```markdown
## Type while it's working

You don't have to wait for the agent to finish. Type and send while a turn is
streaming and your messages **queue** — they coalesce and flush as the next turn
the moment the current one ends. To stop the current turn instead, **Interrupt**
(beside *Attach files* in the composer) cancels it at the ACP `session/cancel`
seam; the stream reports the turn's stop reason, and anything you'd queued is
preserved so you can resume cleanly. The same queue + Interrupt work in Studio.
```

- [ ] **Step 2: Add a miniapp MCP connectors note to `docs/play.md`**

In `docs/play.md`, after the "## Save, push, and share" section's action list (at the end of that section), add:

```markdown
## Connectors

A mini-app can declare **`mcpNeeds`** — MCP tools it wants to call. Nothing is
granted silently: at play time the console shows a **consent** card, and only after
you allow it does the host **broker** those MCP calls to the mini-app. The built-in
**Repo Pulse** demo ships as an `mcpNeeds`-only mini-app you can inspect. The full
connector contract lives in the [miniapp spec](miniapps/spec.md).
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build:site && grep -c "Type while it's working" website/dist/docs/chat.html; grep -c "mcpNeeds" website/dist/docs/play.html`
Expected: build exits 0; both greps ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add docs/chat.md docs/play.md
git commit -m "docs: document the chat queue + turn Interrupt and miniapp MCP connectors"
```

---

### Task 9: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Site builds clean, no dead registry links anywhere in output**

Run: `pnpm build:site && grep -rl "registry.html" website/dist || echo "NO DEAD REGISTRY LINKS"`
Expected: build exits 0; prints `NO DEAD REGISTRY LINKS`.

- [ ] **Step 2: No removed-surface claims survive in shipped HTML**

Run: `grep -rniE "undeploy|managed backends|GitHub-backed registry|deploy it on demand|sell it per call" website/dist/index.html website/dist/vision.html || echo "CLEAN"`
Expected: `CLEAN`.

- [ ] **Step 3: Editions is indexed for humans and LLMs**

Run: `grep -c editions website/dist/llms.txt website/dist/sitemap.xml; grep -rl "raymond@ninemind.ai" website/dist | head`
Expected: both llms/sitemap counts ≥ 1; the mailto appears in at least `index.html`, `docs/editions.html`, and `vision.html`.

- [ ] **Step 4: The repo test suite (incl. the builderBrief drift guard) stays green**

Run: `pnpm test`
Expected: PASS — no skill was touched, so `builderBrief.test.ts` and the rest stay green. (If the full suite is slow/flaky per the repo's known flakes, at minimum run the docs/skills-adjacent tests; the sweep changes no `src/`.)

- [ ] **Step 5: Browser spot-check the three surfaces**

Open `website/dist/index.html`, `website/dist/vision.html`, and `website/dist/docs/editions.html` in a real browser (light + dark, ~375px + desktop). Confirm the editions comparison and CTA render styled, the tables are readable, and nothing overflows horizontally. (Use the `verify` skill or browser-harness.)

- [ ] **Step 6: Confirm branch is ahead of origin/main only**

Run: `git fetch origin && git log --oneline origin/main..HEAD`
Expected: lists exactly the 8 task commits (Tasks 1–8) on top of a clean `origin/main` base — not built on a divergent local `main`.

---

## Handoff / integration

After Task 9 passes, push `editions-sweep` and open a PR gated on `test (24)` per the repo's PR-lifecycle rules (one PR = one settled scope; verify each commit landed on `origin/main` after merge). Since this is a docs/website-only sweep with no `src/` changes, CI risk is low, but do not `--admin`-bypass.

## Self-review notes (author)

- **Spec coverage:** every spec change item maps to a task — build fix + editions page (T1–T2), api-reference (T3), architecture/index/sharing (T4), index.html (T5), vision.html (T6), README (T7), chat/play freshness (T8), verification (T9). Out-of-scope items (skills, pricing page, desktop bump) are honored — no task touches them.
- **Groups→Enterprise amendment** applied consistently: editions.md table, api-reference labels, architecture/index/sharing re-attribution, index.html editions column, vision.html team split, README.
- **No new className without CSS:** the editions section reuses `.compare`/`.vs.old`/`.vs.new`/`.cards`/`.card`/`.chip`/`.cta-row`/`.btn` — all present in `styles.css`. No new rule required.
- **Type/name consistency:** the CTA string `mailto:raymond@ninemind.ai` and the label "AgentGem Enterprise" / "community marketplace" are used identically across all tasks.
