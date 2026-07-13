// Deployment-agnostic OG handlers, wired onto the aggregator's express app. renderCardResponse /
// renderEntityHtml take getMeta + fetch by injection so they unit-test with no DB or network;
// installOg binds them to buildOgMeta(db, …) and the global fetch. Fails open everywhere.
import type { AppDb } from "@agentgem/aggregator";
import { resolveCard, type Card, type CardType } from "./resolve.js";
import { injectHead } from "./inject.js";
import { renderCardSvg, placeholderSvg } from "./card.js";
import { renderCardPng } from "./raster.js";
import { buildOgMeta, type OgMeta } from "./meta.js";
import { getCoverDataUri } from "./cover.js";

export type GetMeta = (card: Card) => Promise<OgMeta | null>;
export type GetCover = (card: Card) => Promise<string | null>;

// Minimal express surface we depend on (avoids importing express types here).
interface OgReq { method: string; path: string; query: Record<string, unknown>; protocol: string; originalUrl: string; get(h: string): string | undefined }
interface OgRes { set(h: string, v: string): OgRes; status(c: number): OgRes; send(b: unknown): void; end(): void }
type OgNext = () => void;
export interface OgExpressApp {
  get(path: string, h: (req: OgReq, res: OgRes) => void): void;
  use(h: (req: OgReq, res: OgRes, next: OgNext) => void): void;
}

const CARD_TYPES: readonly CardType[] = ["game", "gem", "profile", "skill"];
const isCardType = (v: unknown): v is CardType => typeof v === "string" && (CARD_TYPES as readonly string[]).includes(v);

export function cardImageUrl(origin: string, card: Card): string {
  return `${origin}/og/card.png?type=${card.type}&key=${encodeURIComponent(card.key)}`;
}

export async function renderCardResponse(getMeta: GetMeta, getCover: GetCover, card: Card): Promise<Uint8Array> {
  const meta = await getMeta(card).catch(() => null);
  const screenshotDataUri = (await getCover(card).catch(() => null)) ?? undefined;
  const svg = meta
    ? renderCardSvg({ type: card.type, title: meta.title, subtitle: meta.description, screenshotDataUri })
    : placeholderSvg();
  return renderCardPng(svg);
}

export async function renderEntityHtml(
  deps: { getMeta: GetMeta; assetOrigin: string; ogImageOrigin: string; fetchImpl: typeof fetch },
  pathname: string,
  pageUrl: string,
): Promise<string | null> {
  const card = resolveCard(pathname);
  if (!card) return null;
  const meta = await deps.getMeta(card).catch(() => null);
  if (!meta) return null;
  let shell: string;
  try {
    const r = await deps.fetchImpl(`${deps.assetOrigin}/index.html`);
    if (!r.ok) return null;
    shell = await r.text();
  } catch { return null; }
  const image = meta.imageUrl ?? cardImageUrl(deps.ogImageOrigin, card);
  return injectHead(shell, { title: meta.title, description: meta.description, url: pageUrl, image });
}

export function installOg(app: OgExpressApp, deps: { db: AppDb; assetOrigin: string; ogImageOrigin: string }): void {
  const getMeta: GetMeta = (card) => buildOgMeta(deps.db, card);
  const getCover: GetCover = (card) => getCoverDataUri(deps.db, card);

  app.get("/og/card.png", (req, res) => {
    void (async () => {
      const { type, key } = req.query;
      if (!isCardType(type) || typeof key !== "string") { res.status(400).end(); return; }
      try {
        const png = await renderCardResponse(getMeta, getCover, { type, key });
        res.set("Content-Type", "image/png").set("Cache-Control", "public, max-age=300, s-maxage=3600").send(Buffer.from(png));
      } catch {
        try {
          const png = await renderCardPng(placeholderSvg());
          res.set("Content-Type", "image/png").send(Buffer.from(png));
        } catch {
          res.status(500).end(); // last resort — always send SOMETHING, never hang
        }
      }
    })();
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" || !resolveCard(req.path)) { next(); return; }
    void (async () => {
      try {
        const pageUrl = `${deps.ogImageOrigin}${req.originalUrl}`;
        const html = await renderEntityHtml({ getMeta, assetOrigin: deps.assetOrigin, ogImageOrigin: deps.ogImageOrigin, fetchImpl: fetch }, req.path, pageUrl);
        if (html == null) { next(); return; }
        res.set("Content-Type", "text/html; charset=utf-8").send(html);
      } catch { next(); }
    })();
  });
}
