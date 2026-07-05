# Deploy: Fly.io (compute) + Neon (Postgres)

Run the agentgem API as an always-on Fly Machine, replacing the Render free-tier web
service (which spins down after 15 idle minutes → 30–50 s cold starts). Only the API
moves:

- **api.agentgem.ai** → Fly (`fly.toml` at the repo root, reuses the `Dockerfile` as-is).
- **app.agentgem.ai** (marketplace static site) → **stays on Render** (free, CDN-served,
  never sleeps). Its `VITE_API_BASE` points at `https://api.agentgem.ai`, which moves
  *with* the API — no marketplace rebuild needed.
- **Neon Postgres** → unchanged; same `DATABASE_URL` (see `render-neon.md` Step 1 for
  connection-string guidance — direct endpoint, `?sslmode=require`). The live database
  is in **aws-us-east-1**, hence `primary_region = "iad"` in fly.toml.

Cost: one `shared-cpu-1x` / 512 MB machine ≈ $3.20/mo, billed per second. No dedicated
IPv4 needed (a CNAME'd subdomain works on Fly's free shared IPv4).

## One-time setup

```sh
fly auth login
fly apps create agentgem-api

# Secrets — never in fly.toml. The LIVE Render service carries more secrets than
# render.yaml declares (added via the dashboard over time); copy ALL of them:
# DATABASE_URL, AGGREGATOR_ADMIN_TOKEN, AGENTGEM_SESSION_SECRET,
# AGENTGEM_GITHUB_CLIENT_ID, AGENTGEM_GITHUB_CLIENT_SECRET, ORIGIN_SHARED_SECRET,
# GITHUB_TOKEN. Pull them with the Render API (GET /v1/services/{id}/env-vars,
# key from ~/.render/cli.yaml) or copy from the dashboard, then:
fly secrets import < render-env-file   # KEY=VALUE lines, one per secret

fly deploy   # remote build of the Dockerfile, then boots with the /healthz check
```

Smoke-test on the Fly URL **before** touching DNS:

```sh
curl https://agentgem-api.fly.dev/healthz            # {"status":"ok"}
curl https://agentgem-api.fly.dev/api/registry/gems  # public read, no auth
```

## Cutover

```sh
fly certs add api.agentgem.ai
```

Then change the `api` DNS record to `CNAME agentgem-api.fly.dev` (**DNS-only / gray
cloud** — `fly.toml` sets `CLIENT_IP_HEADER=fly-client-ip`, which is only correct when
Fly terminates the client connection; behind an orange-clouded Cloudflare proxy, switch
it back to `cf-connecting-ip`). Watch `fly certs check api.agentgem.ai` until the cert
issues, then re-run the smoke tests against the real domain.

## Continuous deploys

Render auto-deployed on push; Fly needs `.github/workflows/fly-deploy.yml` (already in
this repo). Mint its token and add it as a repo secret:

```sh
fly tokens create deploy -a agentgem-api
# → GitHub repo → Settings → Secrets and variables → Actions → FLY_API_TOKEN
```

## Decommission Render (after ~a week of quiet)

Keep the Render web service **suspended, not deleted**, as the rollback path — undo is
flipping the CNAME back. Once confident: delete the `agentgem` web service in the Render
dashboard and trim `render.yaml` down to just the `agentgem-app` static site.

## Operations

```sh
fly logs                  # tail the machine
fly status                # machine health + region
fly machine status <id>   # memory use — if RSS sits well under 200 MB for days,
                          # `fly scale memory 256` halves the bill (~$1.94/mo)
fly ssh console           # shell into the machine
```

Gotchas carried over from the Render deploy that still apply: the server binds
`HOST=0.0.0.0`/`PORT=4317` from the Dockerfile (Fly does **not** inject `PORT`);
`ensureSchema` bootstraps the DB on first boot (no migration step); `/healthz` is the
unauthenticated liveness route.
