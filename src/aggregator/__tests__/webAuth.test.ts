// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@agentgem/aggregator";
import { upsertAccount } from "@agentgem/aggregator";

// generateSessionToken/createSession/deleteSession/resolveLegacySession (the `web_sessions`-backed
// session mint) were deleted at cutover (Plan 1b-Task 5) — better-auth's own `session` table is now
// authoritative; see resolveSession in webAuth.ts. `accounts` and upsertAccount stay live: every
// legacy FK still points at accounts.id, preserved as user.id by the migration.
describe("webAuth store", () => {
  it("upsertAccount inserts then is idempotent on (provider, accountId)", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "42", login: "octocat", avatarUrl: "http://x/a.png" });
    expect(a.login).toBe("octocat");
    const b = await upsertAccount(db, { provider: "github", accountId: "42", login: "octocat-renamed" });
    expect(b.id).toBe(a.id);             // same row
    expect(b.login).toBe("octocat-renamed"); // login refreshed
  });
});
