// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { bumpPatch } from "../../util/bumpPatch.js";

export interface GemStatus { exists: boolean; ownedByMe: boolean; latestVersion: string | null }
export type PublishAction =
  | { kind: "publish"; version: string }
  | { kind: "confirm"; latestVersion: string; nextVersion: string }
  | { kind: "taken" };

// Decide what the publish dialog does given the pre-flight status.
export function resolvePublishAction(status: GemStatus): PublishAction {
  if (!status.exists) return { kind: "publish", version: "0.1.0" };
  if (!status.ownedByMe) return { kind: "taken" };
  const latest = status.latestVersion ?? "0.1.0";
  return { kind: "confirm", latestVersion: latest, nextVersion: bumpPatch(latest) };
}
