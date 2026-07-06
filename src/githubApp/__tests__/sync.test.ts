// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, listInstallations, appOrgRole, listOrgSkills, upsertInstallation, replaceOrgMembers,
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
  it("adopts remote installations, syncs them, and drops local ones GitHub no longer has", async () => {
    const deps = await makeDeps(baseState());
    // Local drift: a stale installation GitHub doesn't know about + stale member state.
    await upsertInstallation(deps.db, { installationId: 99, orgScope: "gone", repoSelection: "all", suspended: false });
    await replaceOrgMembers(deps.db, "gone", [{ login: "zed", role: "member" }]);
    const out = await reconcileAll(deps);
    expect(out.installations).toBe(1);
    expect((await listInstallations(deps.db)).map((i) => i.installationId)).toEqual([7]);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBe("admin");
    expect(await appOrgRole(deps.db, "zed", "gone")).toBeNull();
  });
});
