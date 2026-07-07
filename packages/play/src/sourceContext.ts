// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The ONE genre-aware seam: GameSource → a compact GenerationInput (a human brief + JSON data) that
// seeds the Chat studio. Readers are injected so this is unit-testable without disk/agents.
import type { GameSource, GameGenre } from "@agentgem/model";

export interface GenerationInput { genre: GameGenre; brief: string; data: unknown; createdFrom: GameSource }
export interface SessionData { sessionId: string; meta: unknown; turns: unknown }
export interface SkillData { name: string; content: string; trigger?: unknown }
export interface ProjectData { path: string; flavor: string; files: string[] }
export interface SourceReaders {
  loadSession(sessionId: string, agent: string): Promise<SessionData | null>;
  readSkill(name: string): Promise<SkillData | null>;
  readProject(path: string): Promise<ProjectData | null>;
}

// Trim raw transcript turns to a compact, replay-friendly timeline: one short entry per turn. The raw
// transcript can be hundreds of KB of full message text; the replay only needs role + a snippet + when.
export function compactTurns(turns: unknown): { role: string; tsMs: number; text: string }[] {
  if (!Array.isArray(turns)) return [];
  return turns.map((t) => {
    const turn = t as { role?: unknown; tsMs?: unknown; text?: unknown; spans?: unknown };
    const spans = Array.isArray(turn.spans) ? (turn.spans as { text?: unknown }[]) : [];
    const spanText = spans.find((s) => typeof s?.text === "string")?.text;
    const text = String(turn.text ?? spanText ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return { role: String(turn.role ?? "assistant"), tsMs: Number(turn.tsMs ?? 0), text };
  });
}

export async function extractSource(source: GameSource, readers: SourceReaders): Promise<GenerationInput> {
  if (source.kind === "session") {
    const s = await readers.loadSession(source.sessionId, source.agent);
    if (!s) throw new Error(`session '${source.sessionId}' not found`);
    // Compact: the rich `meta` (stats/tool counts) as-is + a trimmed turn timeline the scaffold replays.
    const data = { meta: s.meta, timeline: compactTurns(s.turns) };
    return { genre: "replay", createdFrom: source, data, brief: `Make a playable replay of this coding session (${source.summary}).` };
  }
  if (source.kind === "skill") {
    const k = await readers.readSkill(source.skillName);
    if (!k) throw new Error(`skill '${source.skillName}' not found`);
    return { genre: "skill-run", createdFrom: source, data: k, brief: `Make a playable challenge that exercises the skill "${source.skillName}".` };
  }
  const p = await readers.readProject(source.path);
  if (!p) throw new Error(`project '${source.path}' not found`);
  return { genre: "project-fun", createdFrom: source, data: p, brief: `Make a light themed mini-game seeded by the project at ${source.path} (${source.flavor}).` };
}
