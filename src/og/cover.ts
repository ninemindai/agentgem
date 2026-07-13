// The captured cover screenshot for a game card, as a data URI (or null). Resolves the same latest/
// archive version gameMeta does, honors the private-visibility gate, and only ever returns for games.
import type { AppDb } from "@agentgem/aggregator";
import { getGemCover, latestGemVersion, archiveOnlyVersion, gemAccessInfo } from "@agentgem/aggregator";
import type { Card } from "./resolve.js";
import { toDataUrl } from "./coverDataUrl.js";

export async function getCoverDataUri(db: AppDb, card: Card): Promise<string | null> {
  if (card.type !== "game") return null;
  const version = (await latestGemVersion(db, card.key)) ?? (await archiveOnlyVersion(db, card.key));
  if (!version) return null;
  if ((await gemAccessInfo(db, card.key, version))?.visibility === "private") return null;
  const cover = await getGemCover(db, card.key, version);
  return cover ? toDataUrl(cover.contentType, cover.bytes) : null;
}
