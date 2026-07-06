# GitHub App — registration & deploy runbook

The AgentGem GitHub App is the enterprise org integration: authoritative membership sync
(private members included) and members-only indexing of internal SKILL.md repos.
Design: `docs/superpowers/specs/2026-07-05-github-app-design.md`.

## Register the App (once, under the ninemindai org)

github.com → ninemindai org → Settings → Developer settings → GitHub Apps → New GitHub App:

- **Name**: AgentGem (slug `agentgem`; if taken, adjust the install CTA URL in
  `packages/marketplace/src/pages/OrgCatalog.tsx`)
- **Homepage URL**: https://agentgem.ai
- **Webhook URL**: https://api.agentgem.ai/api/github/webhook
- **Webhook secret**: generate (`openssl rand -hex 32`) — this becomes `GITHUB_APP_WEBHOOK_SECRET`
- **Permissions** (nothing else — additions force per-org re-approval):
  - Organization permissions → Members: **Read-only**
  - Repository permissions → Contents: **Read-only** (Metadata: Read-only is automatic)
- **Subscribe to events**: check **Organization** and **Push**. (`Installation` and
  `Installation repositories` events are always delivered to GitHub Apps — no checkbox.)
- **Where can this App be installed?** Any account.
- **Setup URL** (post-install redirect): https://app.agentgem.ai/orgs/:org?installed=1 —
  GitHub doesn't substitute :org; leave Setup URL as https://app.agentgem.ai and rely on the
  marketplace org page. (Optional improvement later: a /api/github/setup redirect handler.)
- After creation: note the **App ID** (`GITHUB_APP_ID`) and generate a **private key** (.pem
  download — its full contents are `GITHUB_APP_PRIVATE_KEY`).

## Deploy secrets (Fly)

```bash
fly secrets set -a agentgem-api \
  GITHUB_APP_ID=<app id> \
  GITHUB_APP_WEBHOOK_SECRET=<webhook secret> \
  GITHUB_APP_PRIVATE_KEY="$(cat agentgem.private-key.pem)"
```

All three unset/partial → the subsystem is dormant: `POST /api/github/webhook` answers 503,
no reconcile loop runs, org gates fall back to captured account_scopes exactly as before.

## How it works (operator view)

- Webhooks are the primary sync (member add/remove lands in seconds). GitHub does NOT
  auto-retry failed deliveries; a daily `reconcileAll` (plus a 30s post-boot kick) re-lists
  installations/members/repos and heals drift.
- Installation tokens are minted on demand (RS256 app JWT → `POST /app/installations/{id}/access_tokens`),
  cached in memory ~55 min, never persisted or logged.
- Uninstall deletes the installation row, synced members, and indexed private skill metadata.
- Private skill BODIES are never stored: `GET /api/orgs/skill-body` proxies from GitHub per
  request, member-gated, `(source, path)` pinned to the org via `orgSkillExists`.

## Local development

- Unit tests are fully offline (fake fetch/Http + pglite).
- To exercise real webhooks locally: `smee.io` channel → set the App's webhook URL to the
  smee proxy → `GITHUB_APP_*` in your shell → smee client forwarding to
  http://localhost:<port>/api/github/webhook. Or skip webhooks and rely on the reconcile path.
