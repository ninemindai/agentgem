// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import {
  makeTestDb, listInstallations, appOrgRole, listOrgSkills, upsertInstallation, replaceOrgMembers, orgMembers,
} from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { InstallationTokens } from "../client.js";
import { handleWebhookEvent, reconcileAll, type GithubAppDeps } from "../sync.js";
import { generateKeyPairSync } from "node:crypto";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const cfg = { appId: "1", privateKey: pem, webhookSecret: "s" };
const b64 = (s: string) => Buffer.from(s).toString("base64");

// One fake GitHub covering REST (fetch) + Contents (Http): acme has alice(admin)+bob, one repo
// with one skill. Mutate `state` between calls to simulate change.
function fakeGithub(state: { members: { login: string; role: "admin" | "member" }[]; repos: { repo: string; defaultBranch: string }[]; files: Record<string, string> }) {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    const j = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
    if (u.includes("/access_tokens")) return j({ token: "itok", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (u.includes("role=admin")) return j(state.members.filter((m) => m.role === "admin").map((m) => ({ login: m.login })));
    if (u.includes("role=member")) return j(state.members.filter((m) => m.role === "member").map((m) => ({ login: m.login })));
    if (u.includes("/installation/repositories")) return j({ repositories: state.repos.map((r) => ({ full_name: r.repo, default_branch: r.defaultBranch })) });
    if (u.includes("/app/installations")) return j([{ id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null }]);
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  const http: Http = async (u) => {
    if (u.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree: Object.keys(state.files).map((path) => ({ path, type: "blob" })) }) };
    const path = decodeURIComponent(u.split("/contents/")[1]?.split("?")[0] ?? "");
    if (state.files[path]) return { status: 200, text: async () => JSON.stringify({ content: b64(state.files[path]), encoding: "base64" }) };
    return { status: 404, text: async () => "{}" };
  };
  return { fetchImpl, http };
}

async function makeDeps(state: Parameters<typeof fakeGithub>[0]): Promise<GithubAppDeps> {
  const db = await makeTestDb();
  const { fetchImpl, http } = fakeGithub(state);
  return { db, cfg, tokens: new InstallationTokens(cfg, fetchImpl), http, fetchImpl };
}

const baseState = () => ({
  members: [{ login: "alice", role: "admin" as const }, { login: "bob", role: "member" as const }],
  repos: [{ repo: "acme/skills", defaultBranch: "main" }],
  files: { "eng/deploy/SKILL.md": "---\nname: deploy\ndescription: d\n---\n" },
});
const installPayload = { action: "created", installation: { id: 7, account: { login: "Acme", type: "Organization" }, repository_selection: "selected" } };

describe("handleWebhookEvent", () => {
  it("installation.created syncs members and indexes repos", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    expect(await listInstallations(deps.db)).toEqual([{ installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false }]);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBe("admin");
    expect((await listOrgSkills(deps.db, "acme")).map((s) => s.name)).toEqual(["deploy"]);
  });

  it("installation.deleted forgets everything; suspend flips the flag", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "installation", { action: "suspend", installation: installPayload.installation });
    expect((await listInstallations(deps.db))[0].suspended).toBe(true);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBeNull(); // suspended blocks the gate
    await handleWebhookEvent(deps, "installation", { action: "deleted", installation: installPayload.installation });
    expect(await listInstallations(deps.db)).toEqual([]);
    expect(await listOrgSkills(deps.db, "acme")).toEqual([]);
    expect(await deps.db.select().from(orgMembers)).toEqual([]); // cascade pinned at row level
  });

  it("installation_repositories replay does not un-suspend a suspended installation", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "installation", { action: "suspend", installation: installPayload.installation });
    await handleWebhookEvent(deps, "installation_repositories", {
      action: "added_repositories", installation: installPayload.installation,
      repositories_added: [{ full_name: "acme/skills" }], repositories_removed: [],
    });
    expect((await listInstallations(deps.db))[0].suspended).toBe(true); // replay must not re-activate
  });

  it("organization member events apply single-row deltas", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "organization", { action: "member_removed", organization: { login: "acme" }, membership: { user: { login: "Bob" } } });
    expect(await appOrgRole(deps.db, "bob", "acme")).toBeNull();
    await handleWebhookEvent(deps, "organization", { action: "member_added", organization: { login: "acme" }, membership: { user: { login: "Carol" }, role: "member" } });
    expect(await appOrgRole(deps.db, "carol", "acme")).toBe("member");
  });

  it("push on the default branch reindexes; other refs are ignored", async () => {
    const state = baseState() as { members: { login: string; role: "admin" | "member" }[]; repos: { repo: string; defaultBranch: string }[]; files: Record<string, string> };
    const deps = await makeDeps(state);
    await handleWebhookEvent(deps, "installation", installPayload);
    state.files["eng/newskill/SKILL.md"] = "---\nname: newskill\ndescription: n\n---\n";
    await handleWebhookEvent(deps, "push", { ref: "refs/heads/side", repository: { full_name: "acme/skills", default_branch: "main", owner: { login: "acme" } } });
    expect((await listOrgSkills(deps.db, "acme")).length).toBe(1); // non-default ref ignored
    await handleWebhookEvent(deps, "push", { ref: "refs/heads/main", repository: { full_name: "acme/skills", default_branch: "main", owner: { login: "acme" } } });
    expect((await listOrgSkills(deps.db, "acme")).map((s) => s.name).sort()).toEqual(["deploy", "newskill"]);
  });

  it("installation_repositories removes deselected repos' skills", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "installation_repositories", {
      action: "removed_repositories", installation: installPayload.installation,
      repositories_added: [], repositories_removed: [{ full_name: "acme/skills" }],
    });
    expect(await listOrgSkills(deps.db, "acme")).toEqual([]);
  });
});

describe("reconcileAll", () => {
  it("prunes ghost skills of repos GitHub no longer lists (delete/rename/transfer heal)", async () => {
    const state = baseState();
    const deps = await makeDeps(state);
    await handleWebhookEvent(deps, "installation", installPayload);
    expect((await listOrgSkills(deps.db, "acme")).length).toBe(1);
    // The repo vanishes upstream with NO webhook (deleted/renamed/transferred).
    state.repos = [];
    state.files = {} as typeof state.files;
    await reconcileAll(deps);
    expect(await listOrgSkills(deps.db, "acme")).toEqual([]); // ghost pruned
  });

  it("repos deselected while suspended are pruned after unsuspend", async () => {
    const state = baseState();
    const deps = await makeDeps(state);
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "installation", { action: "suspend", installation: installPayload.installation });
    state.repos = []; // deselected during suspension — the removal event was skipped by design
    state.files = {} as typeof state.files;
    await handleWebhookEvent(deps, "installation", { action: "unsuspend", installation: installPayload.installation });
    expect(await listOrgSkills(deps.db, "acme")).toEqual([]); // unsuspend sync pruned the stale rows
  });

  it("a truncated remote installation list skips stray-installation deletes", async () => {
    const db = await makeTestDb();
    // Fake GitHub with 10 full pages of suspended org installs (cap exhausted → truncated).
    // Suspended keeps reconcile from fanning out member/repo syncs for 1000 orgs.
    const bigFetch = (async (url: string | URL) => {
      const u = String(url);
      const j = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
      if (u.includes("/app/installations")) {
        const page = Number(new URL(u).searchParams.get("page") ?? "1");
        return j(Array.from({ length: 100 }, (_, i) => ({
          id: page * 1000 + i, account: { login: `org${page}-${i}`, type: "Organization" },
          repository_selection: "all", suspended_at: "2026-01-01T00:00:00Z",
        })));
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    const deps: GithubAppDeps = { db, cfg, tokens: new InstallationTokens(cfg, bigFetch), http: async () => ({ status: 404, text: async () => "{}" }), fetchImpl: bigFetch };
    // A local installation GitHub's (truncated) list doesn't include — must SURVIVE.
    await upsertInstallation(db, { installationId: 42, orgScope: "keepme", repoSelection: "all", suspended: false });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await reconcileAll(deps);
    errorSpy.mockRestore();
    expect((await listInstallations(db)).some((i) => i.installationId === 42)).toBe(true);
  });

  it("adopts remote installations, syncs them, and drops local ones GitHub no longer has", async () => {
    const deps = await makeDeps(baseState());
    // A second remote installation that's suspended: reconcile must adopt it (so it's gated
    // everywhere else) but must NOT sync its members.
    const baseFetch = deps.fetchImpl;
    deps.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/app/installations")) {
        return {
          ok: true, status: 200,
          json: async () => [
            { id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null },
            { id: 8, account: { login: "globex", type: "Organization" }, repository_selection: "all", suspended_at: "2026-01-01T00:00:00Z" },
          ],
        } as unknown as Response;
      }
      return baseFetch(url, init);
    }) as typeof fetch;
    // Local drift: a stale installation GitHub doesn't know about + stale member state.
    await upsertInstallation(deps.db, { installationId: 99, orgScope: "gone", repoSelection: "all", suspended: false });
    await replaceOrgMembers(deps.db, "gone", [{ login: "zed", role: "member" }]);
    const out = await reconcileAll(deps);
    expect(out.installations).toBe(2);
    expect((await listInstallations(deps.db)).map((i) => i.installationId).sort()).toEqual([7, 8]);
    expect((await listInstallations(deps.db)).find((i) => i.installationId === 8)?.suspended).toBe(true);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBe("admin");
    expect(await appOrgRole(deps.db, "zed", "gone")).toBeNull();
    // The fake's member routes aren't org-specific, so alice would leak into globex if sync ran.
    expect(await appOrgRole(deps.db, "alice", "globex")).toBeNull();
  });
});
