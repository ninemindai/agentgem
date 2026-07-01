// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/store.ts
//
// Best-effort persistence of the dream queue + diary. A sidecar write failure
// must never block dreaming — callers get a safe empty value back.
// Written to <base>/.agentgem/dream/{queue,diary}.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { DreamQueueEntry, DreamDiaryEntry, DreamStatus } from "./types.js";

const DIARY_MAX = 100;

function dreamDir(base: string): string {
  const dir = join(base, ".agentgem", "dream");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}
function writeJson(path: string, value: unknown): void {
  try { writeFileSync(path, JSON.stringify(value, null, 2), "utf8"); }
  catch (err) { console.error("dream: sidecar write failed (ignored):", (err as Error).message); }
}
const queuePath = (base: string) => join(dreamDir(base), "queue.json");
const diaryPath = (base: string) => join(dreamDir(base), "diary.json");

export function readQueue(base: string = agentgemHome()): DreamQueueEntry[] {
  return readJson<DreamQueueEntry[]>(queuePath(base), []);
}
export function enqueueNew(candidates: DreamQueueEntry[], base: string = agentgemHome()): DreamQueueEntry[] {
  const existing = readQueue(base);
  const seen = new Set(existing.map((e) => e.key));
  const added = candidates.filter((c) => !seen.has(c.key));
  if (added.length) writeJson(queuePath(base), [...existing, ...added]);
  return added;
}
export function setStatus(key: string, status: DreamStatus, nowMs: number, base: string = agentgemHome()): DreamQueueEntry | null {
  const q = readQueue(base);
  const found = q.find((e) => e.key === key);
  if (!found) return null;
  found.status = status;
  found.reviewedMs = nowMs;
  writeJson(queuePath(base), q);
  return found;
}
export function promotedCount(base: string = agentgemHome()): number {
  return readQueue(base).filter((e) => e.status === "accepted").length;
}
export function readDiary(base: string = agentgemHome()): DreamDiaryEntry[] {
  return readJson<DreamDiaryEntry[]>(diaryPath(base), []);
}
export function appendDiary(entry: DreamDiaryEntry, base: string = agentgemHome()): void {
  const next = [entry, ...readDiary(base)].slice(0, DIARY_MAX);
  writeJson(diaryPath(base), next);
}
