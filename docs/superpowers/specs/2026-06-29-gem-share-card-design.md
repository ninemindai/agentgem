# Gem Share Card (fast-follow) — design

_Spec 2026-06-29. The deferred **Gem-card** fast-follow from `2026-06-29-share-card-og-design.md`.
The certificate card shares the goldmine *scorecard*; this adds a second share **kind** for a
*Gem/workflow*, and moves the per-item "Share" buttons off the old local-canvas path onto the
hosted `/share` flow + the polished share row._

## Goal

The Mine panel has two share mechanisms today. The hero ("Share your goldmine") uses the
Milestone-C **hosted** flow (mint `/share/:id`, polished row, OG card). The **per-workflow "Share"**
and **per-build "Share gem"** buttons still use the **pre-Milestone-C local-canvas** path
(`shareCard.ts`: `drawWorkflowCard`/`drawGemCard` → `canvas.toBlob` → `navigator.share`/download a
PNG file) — unpolished, no hosted URL, and they still surface a dismissed `navigator.share` as an
error. This spec brings per-item share to parity: a hosted, link-unfurlable Gem share with the same
polished UI.

Success criterion: clicking "Share" on a workflow (or "Share gem" on a build) mints
`https://agentgem.ai/share/:id`; pasting it into X/Slack/LinkedIn renders a link preview with the
Gem's name + provenance; the console shows the same Copy-link + platform-intent row the hero has.

## Decisions (locked during brainstorming, 2026-06-29)

1. **No per-gem image.** The Gem card's content is text (name + provenance), which unfurls fine as a
   small **`twitter:card=summary`** (no `og:image`). The certificate needed an image because the
   counts *are* the content; a Gem doesn't. → no gem SVG variant, no edge rasterization, no `og.png`
   for gems.
2. **Teaser + invite CTA.** The `/share` page shows name + provenance + the same "Value your own
   agent goldmine → agentgem.ai" invite. **No actual install** of the gem, **no registry publish**
   (both deferred — see Non-goals).
3. **Reuse the certificate `/share` spine** end-to-end; add a second card `kind`. Same hosted
   aggregator, same proxy, same rate-limit + origin-secret, same Worker route.
4. **`provenance` is one client-formatted string** (e.g. "Distilled from 5 sessions", "5 skills"),
   stored as-is (capped + sanitized). No per-source structured fields server-side.
5. **Extract a shared `ShareLinks` component** so the hero and per-item share render an identical
   polished row (copy + intents + spinner/pending), instead of duplicating markup.

## Non-goals (this slice)

- **No per-gem image** (decision 1).
- **No real install / no gem bytes carried** — the recipient gets a teaser page, not the gem.
- **No registry publish** — no `@scope/name@version`, no install coordinate.
- **No delete/revoke.** Create-only, like the certificate.
- Per-workflow share does **not** build a Gem artifact; it shares the workflow's name + provenance
  directly. ("Build a 1-skill Gem → publish → share" from the roadmap is the install slice, deferred.)

## Architecture & data flow

```
console Workflows.tsx
  shareWorkflow(wf)  → createGemShareRoute { kind:"gem", name: wf.name,  provenance: "Distilled from N sessions" }
  shareGem(result)   → createGemShareRoute { kind:"gem", name: result.name, provenance: "N skills" }
        │ same-origin POST /api/share  (browser stays same-origin)
        ▼
  ShareProxyController  → shareClient.postShare(body)  → api.agentgem.ai (default) / AGENTGEM_AGGREGATOR_URL
        │ server-to-server (CF injects X-Origin-Auth; rate-limited)
        ▼
  ShareController.create  → shareStore  → share_cards row (kind:"gem", payload:{name,provenance})
        ← { id, url:"https://agentgem.ai/share/<id>" }
  console: render <ShareLinks url=… />  (copy + X/LinkedIn/Facebook + spinner/pending)

Worker GET /share/:id → fetch record → branch on kind:
  "certificate" → existing HTML + og.png   (unchanged)
  "gem"         → HTML: og:title=name, og:description=provenance, twitter:card=summary, NO og:image;
                  visible page: name, provenance, "Value your own agent goldmine → agentgem.ai".
  GET /share/:id/og.png → certificate-only; for a gem id, 404 (no image).
```

The create path already defaults to `https://api.agentgem.ai` (shareClient) and is protected by the
existing rate-limit + origin-secret — the gem kind rides all of it for free.

## Backend

**Schema** (`src/aggregator/schema.ts`, `share_cards`). The live table has `counts jsonb NOT NULL`.
Generalize without breaking existing certificate rows, via idempotent DDL in `ensureSchema`:
- `ALTER TABLE share_cards ADD COLUMN IF NOT EXISTS payload jsonb;`  (gem `{name, provenance}`)
- `ALTER TABLE share_cards ALTER COLUMN counts DROP NOT NULL;`  (certificates keep using `counts`)
Add `payload` to the Drizzle table def (`jsonb("payload").$type<{name:string;provenance:string}>()`,
nullable). Certificate rows: `counts` set, `payload` null. Gem rows: `payload` set, `counts` null.

**`shareStore.ts`** — `createShareCard` accepts a discriminated input:
```ts
type CreateInput =
  | { kind: "certificate"; counts: ShareCounts; generatedAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number };
```
Stores `counts` or `payload` by kind. `getShareCard` returns a discriminated record:
`{ kind:"certificate", counts, generatedAtMs, createdAtMs }` or
`{ kind:"gem", name, provenance, generatedAtMs, createdAtMs }`.

**`ShareController`** — `CreateBody` becomes `z.discriminatedUnion("kind", [CertBody, GemBody])`.
`GemBody = { kind:"gem", name: z.string().min(1).max(120), provenance: z.string().max(200), generatedAtMs }`
`.strict()`; `name`/`provenance` trimmed + control-chars stripped (sanitize helper). `ReadResult`
becomes the discriminated union. The belt-and-suspenders `.parse(input.body)` stays.

## Worker (`website/edge/src/share.js`)

`handleShare` already fetches the record. Branch on `record.kind`:
- `certificate` → unchanged (`renderShareHtml` + og.png).
- `gem` → new pure `renderGemShareHtml(record, { shareUrl })`: `og:title`=name, `og:description`=
  provenance, `og:type=website`, `og:url`, `twitter:card=summary`, **no** `og:image`; visible body =
  name (h1) + provenance + the invite CTA. Escape all interpolated values (reuse `esc`).
- `/share/:id/og.png` for a gem id → `404` (no image for gems).
Cache: same `Cache-Control: max-age=300` + the existing edge Cache API path applies to the gem HTML.

## Console

- **`createGemShareRoute`** in `api/routes.ts`: `POST /api/share`, body
  `{ kind:"gem", name, provenance, generatedAtMs }`, response `{ id, url }`. (The certificate route
  stays; both hit `/api/share` — the proxy/controller discriminate on `kind`.)
- **Extract `ShareLinks`** (`panels/Mine/ShareLinks.tsx`) from `ScorecardHero`: props `{ url }`; owns
  the copy-link (+ "Copied"), the X/LinkedIn/Facebook intents (via `shareIntents`), and the markup/
  classes already styled in `theme.css`. `ScorecardHero` uses it; the per-item share uses it too.
- **`Workflows.tsx`**: replace `shareWorkflow`/`shareGem` (canvas) with calls to `createGemShareRoute`
  + per-row share state (url/busy/slow/err) and `<ShareLinks>` (reuse the hero's spinner/pending
  pattern). `provenance`: workflow → `"Distilled from ${detail.sessions} session${s}"`; build →
  `"${result.skills.length} skill${s}"`.
- **Delete `shareCard.ts`** (`drawWorkflowCard`/`drawGemCard`/`gemCardLines`/`workflowCardLines`/
  `shareCanvas`) + `__tests__/shareCard.test.ts` once `Workflows.tsx` no longer imports them
  (grep first; the hero already doesn't use them).

## Privacy

`name` + `provenance` are **user-intended** — the user explicitly picks the workflow/gem to share.
Capped (name ≤120, provenance ≤200) and control-char-stripped server-side; closed zod rejects extra
fields. **No** raw logs, **no** step dumps, **no** project paths in the stored record. Public read is
the teaser only.

## Testing

- **Backend (pglite)**: `shareStore`/`ShareController` create+read roundtrip for `kind:"gem"`; zod
  rejects empty name / over-length / extra fields / wrong kind; the certificate arm still works
  (regression); schema migration is idempotent (re-run `ensureSchema`, insert a gem + a certificate
  row).
- **Worker**: pure `renderGemShareHtml` (correct meta: title=name, desc=provenance, `summary`, **no**
  og:image; escaping); `handleShare` routes a gem record to gem HTML and a certificate record to the
  existing HTML; `/share/:id/og.png` 404s for a gem record.
- **Console**: `ShareLinks` (copy → "Copied", intents encode the url); `Workflows` per-item share
  calls `createGemShareRoute` with the right `{name, provenance}` and renders `ShareLinks`; no
  dangling `shareCard` imports after deletion.
- **End-to-end (post-merge/deploy)**: real per-item share → `agentgem.ai/share/:id` → crawler fetch
  returns the gem text unfurl.

## Roadmap / deferred follow-ups

- **Real install** (option B): carry the gem bytes in the share record → Download `.gem` + an install
  command on the `/share` page. The supply/usage virality slice.
- **Registry publish** (option C): build a 1-skill Gem → publish → install coordinate.
- **Per-gem image** if a richer unfurl is wanted later (gem-variant SVG + edge raster).
