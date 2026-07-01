// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT

export async function publishPlaybookCore(deps: {
  publish: () => Promise<{ ref: string; version: string }>;
  share: () => Promise<{ id: string; url: string }>;
}): Promise<{ exploreRef: string; version: string; shareUrl: string }> {
  const pub = await deps.publish();                  // data-critical: must succeed
  let shareUrl = "";
  try { shareUrl = (await deps.share()).url; } catch { /* best-effort teaser */ }
  return { exploreRef: pub.ref, version: pub.version, shareUrl };
}
