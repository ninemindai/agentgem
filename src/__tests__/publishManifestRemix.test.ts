// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// buildPublishManifest is the pure helper extracted from GemController#publishSetup so the
// manifest content (esp. the new allowRemix/remixOf lineage fields) is unit-testable without
// standing up the whole controller + archive round-trip.
import { describe, it, expect } from "vitest";
import { buildPublishManifest } from "@agentgem/app/gem.controller";
import type { Gem, RemixRef } from "@agentgem/model";

const gameArtifact = (remixOf?: RemixRef): Gem["artifacts"][number] => ({
  type: "game", name: "snake", title: "Snake", genre: "project-fun",
  html: "<html></html>", createdFrom: { kind: "blank", title: "snake" }, engineVersion: "1",
  ...(remixOf ? { remixOf } : {}),
});

const gemWith = (remixOf?: RemixRef): Gem => ({
  name: "snake", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
  artifacts: [gameArtifact(remixOf)],
});

const body = (extra: { allowRemix?: boolean } = {}) => ({
  scope: "bob", name: "snake", workspace: "snake", version: "0.1.0",
  description: "a game", tags: ["game"], visibility: "public" as const,
  ...extra,
});

describe("buildPublishManifest", () => {
  it("(a) a gem whose game artifact carries remixOf yields a manifest with it", () => {
    const remixOf: RemixRef = { gemKey: "@alice/original", version: "1.0.0" };
    const manifest = buildPublishManifest(body(), gemWith(remixOf), "digest123");
    expect(manifest.remixOf).toEqual(remixOf);
  });

  it("(b) a gem without lineage yields none", () => {
    const manifest = buildPublishManifest(body(), gemWith(), "digest123");
    expect(manifest.remixOf).toBeUndefined();
    expect("remixOf" in manifest).toBe(false);
  });

  it("(c) allowRemix: false passes through", () => {
    const manifest = buildPublishManifest(body({ allowRemix: false }), gemWith(), "digest123");
    expect(manifest.allowRemix).toBe(false);
  });

  it("(d) omitted allowRemix stays absent (old-body shape preserved)", () => {
    const manifest = buildPublishManifest(body(), gemWith(), "digest123");
    expect("allowRemix" in manifest).toBe(false);
    expect(manifest).toEqual({
      gemKey: "bob/snake", version: "0.1.0", visibility: "public",
      description: "a game", tags: ["game"], grade: undefined,
      artifactKinds: ["game"], artifacts: [{ name: "snake", type: "game" }],
      gemDigest: "digest123",
    });
  });
});
