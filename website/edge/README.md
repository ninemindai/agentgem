# agentgem.ninemind.ai edge Worker

A Cloudflare Worker that **serves agentgem.ninemind.ai from Workers Static
Assets** and adds **markdown content negotiation**. Mirrors the agentback.dev
edge Worker, adapted for a subdomain.

## What it does

`website/build.mjs` builds the site into `website/dist` and emits an authored
markdown twin next to every docs page, plus `/llms.txt` and `/llms-full.txt`.

`wrangler deploy` uploads `dist` as this Worker's static asset set (the `ASSETS`
binding). The Worker serves those assets directly at the edge and, on a request
with `Accept: text/markdown`, returns the authored twin instead of the HTML — a
local asset lookup, no origin, no second hop.

```
GET /docs/getting-started   Accept: text/html      → HTML  (asset)
GET /docs/getting-started   Accept: text/markdown  → .md   (negotiated)
```

The hand-authored homepage (`/`) has no markdown twin, so it always serves HTML.
Fail-safe: any error, or any path without a twin, serves the normal asset.

## Subdomain difference vs agentback.dev

agentback.dev is an apex that already had a proxied DNS record, so its Worker
used a `zone_name` route. agentgem.ninemind.ai is a **fresh subdomain with no
record**, so this config uses a **Workers Custom Domain**
(`custom_domain = true`): `wrangler deploy` provisions the proxied DNS record
**and** the edge TLS cert automatically — no manual DNS step. The `ninemind.ai`
zone must live in this Cloudflare account.

## Deploy

```bash
cd website/edge
npx wrangler deploy            # builds nothing — run `pnpm build:site` first
npx wrangler deploy --dry-run  # validate config + bundle without publishing
```

Or trigger the **Deploy Worker (Cloudflare)** GitHub Action. It needs the
`CLOUDFLARE_API_TOKEN` repo secret — an account token with **Account → Workers
Scripts → Edit** plus **Zone → DNS → Edit** and **Zone → SSL and Certificates →
Edit** on `ninemind.ai` (the DNS + cert scopes are required to provision the
custom domain).

## Verify

```bash
curl -s "https://agentgem.ninemind.ai/" -o /dev/null -w '%{content_type}\n'        # text/html
curl -s -H 'Accept: text/markdown' "https://agentgem.ninemind.ai/docs/concepts" \
  -o /dev/null -w '%{content_type}\n'                                              # text/markdown
```

## Rollback

`npx wrangler delete` removes the Worker; the custom domain record is removed
with it (or detach it in the dashboard under Workers → agentgem-web → Domains).
