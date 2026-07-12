// Per-type OG metadata providers. game/gem/profile read real catalog/profile data (mirroring
// AggregatorController.gameMeta / .profile); skill is pure string derivation. Returns null for a
// missing/private entity (caller falls through to the plain shell / placeholder). imageUrl is null
// in V1 — the phase-2 hook for captured screenshots.
import type { AppDb } from "@agentgem/aggregator";
import { buildProfile, getGemArchive, latestGemVersion, archiveOnlyVersion, gemAccessInfo } from "@agentgem/aggregator";
import { importGem } from "@agentgem/distribute";
import type { Card } from "./resolve.js";

export interface OgMeta { title: string; description: string; imageUrl: string | null }

type Artifact = { type: string; title?: unknown; genre?: unknown };

async function loadGemArtifacts(db: AppDb, key: string): Promise<Artifact[] | null> {
  const version = (await latestGemVersion(db, key)) ?? (await archiveOnlyVersion(db, key));
  if (!version) return null;
  if ((await gemAccessInfo(db, key, version))?.visibility === "private") return null;
  const a = await getGemArchive(db, key, version);
  if (!a) return null;
  const { gem } = importGem(Buffer.from(a.bytes));
  return (gem as unknown as { artifacts: Artifact[] }).artifacts;
}

async function gameMeta(db: AppDb, key: string): Promise<OgMeta | null> {
  const arts = await loadGemArtifacts(db, key);
  if (!arts) return null;
  const game = arts.find((x) => x.type === "game");
  if (!game || typeof game.title !== "string") return null;
  const genre = typeof game.genre === "string" ? game.genre : null;
  return { title: game.title, description: genre ? `Play on AgentGem · ${genre}` : "Play on AgentGem", imageUrl: null };
}

async function gemMeta(db: AppDb, key: string): Promise<OgMeta | null> {
  const arts = await loadGemArtifacts(db, key);
  if (!arts) return null;
  const kinds = [...new Set(arts.map((x) => x.type))];
  return { title: key, description: kinds.length ? `${kinds.join(" · ")} on AgentGem` : "A gem on AgentGem", imageUrl: null };
}

async function profileMeta(db: AppDb, login: string): Promise<OgMeta | null> {
  const p = await buildProfile(db, login);
  if (!p) return null;
  return { title: `@${p.login}`, description: `${p.gems.length} apps · ${p.reviews.length} reviews on AgentGem`, imageUrl: null };
}

function skillMeta(key: string): OgMeta {
  const i = key.indexOf("/");
  const sourceId = i >= 0 ? key.slice(0, i) : key;
  const path = i >= 0 ? key.slice(i + 1) : "";
  const name = (path.split("/").pop() || path || key).replace(/\.md$/, "");
  return { title: name, description: `Skill · ${sourceId} on AgentGem`, imageUrl: null };
}

export async function buildOgMeta(db: AppDb, card: Card): Promise<OgMeta | null> {
  switch (card.type) {
    case "game": return gameMeta(db, card.key);
    case "gem": return gemMeta(db, card.key);
    case "profile": return profileMeta(db, card.key);
    case "skill": return skillMeta(card.key);
  }
}
