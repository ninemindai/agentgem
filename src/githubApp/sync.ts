// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/sync.ts
// Webhook-event handlers + the daily reconcile. Webhooks are the primary sync path (seconds-level
// offboarding); reconcileAll heals missed deliveries (GitHub does NOT auto-retry webhooks). Every
// handler is an idempotent upsert/delete keyed by natural ids, so redeliveries and reconcile
// overlap are harmless. Per-repo/per-installation failures log and continue (accountVerifier style).
import {
  upsertInstallation, setInstallationSuspended, deleteInstallation, installationForScope, listInstallations,
  replaceOrgMembers, upsertOrgMember, deleteOrgMember, deleteOrgRepoSkills, pruneOrgSkills,
  type AppDb, type AppInstallation,
} from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { listAppInstallations, listOrgMembers, listInstallationRepos, InstallationTokens, type AppConfig } from "./client.js";
import { indexOrgRepo } from "./orgIndexer.js";

export interface GithubAppDeps { db: AppDb; cfg: AppConfig | null; tokens: InstallationTokens | null; http: Http; fetchImpl: typeof fetch }

// Installation shape from webhook payloads (installation.account is the org it's installed on).
function instFromPayload(p: unknown): AppInstallation | null {
  const i = (p as { installation?: { id?: unknown; account?: { login?: unknown; type?: unknown }; repository_selection?: unknown } })?.installation;
  if (!i || typeof i.id !== "number" || typeof i.account?.login !== "string") return null;
  if (i.account.type !== "Organization") return null; // user installs are out of scope
  return { installationId: i.id, orgScope: i.account.login.toLowerCase(), repoSelection: i.repository_selection === "all" ? "all" : "selected", suspended: false };
}

async function syncInstallation(deps: GithubAppDeps, inst: AppInstallation): Promise<void> {
  if (!deps.tokens) return;
  const token = await deps.tokens.tokenFor(inst.installationId);
  const { members, truncated } = await listOrgMembers(token, inst.orgScope, deps.fetchImpl);
  if (truncated) {
    // A truncated replace would REVOKE real members under the App-authoritative gate. Keep the
    // stored set; member_added/member_removed webhooks still apply single-row deltas.
    console.error(`githubApp: ${inst.orgScope} member list truncated — keeping stored members`);
  } else {
    await replaceOrgMembers(deps.db, inst.orgScope, members);
  }
  await indexInstallationRepos(deps, inst);
}

async function indexInstallationRepos(deps: GithubAppDeps, inst: AppInstallation): Promise<void> {
  if (!deps.tokens) return;
  const token = await deps.tokens.tokenFor(inst.installationId);
  const { repos, truncated } = await listInstallationRepos(token, deps.fetchImpl);
  for (const r of repos) {
    try {
      await indexOrgRepo(deps.db, deps.http, token, inst.orgScope, r.repo, r.defaultBranch);
    } catch (e) {
      console.error(`githubApp: index ${r.repo} failed: ${(e as Error).message}`);
    }
  }
  // Ghost-skill prune: repos deleted/renamed/transferred upstream (or deselected while the
  // installation was suspended) never send a removal event this handler processes — the
  // authoritative current list closes the gap. Never prune from a partial (truncated) view.
  // `!truncated` here IS the exhaustiveness proof, so an empty repo list legitimately clears the org.
  if (!truncated) await pruneOrgSkills(deps.db, inst.orgScope, repos.map((r) => r.repo), { exhaustive: true });
}

export async function handleWebhookEvent(deps: GithubAppDeps, event: string, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const action = typeof p.action === "string" ? p.action : "";

  if (event === "installation") {
    const inst = instFromPayload(p);
    if (!inst) return;
    if (action === "created" || action === "unsuspend" || action === "new_permissions_accepted") {
      await upsertInstallation(deps.db, inst);
      await syncInstallation(deps, inst);
    } else if (action === "suspend") {
      await setInstallationSuspended(deps.db, inst.installationId, true);
    } else if (action === "deleted") {
      await deleteInstallation(deps.db, inst.installationId);
    }
    return;
  }

  if (event === "installation_repositories") {
    const inst = instFromPayload(p);
    if (!inst) return;
    // Preserve the stored suspended flag: a replayed/out-of-order repo event must never
    // silently re-activate a suspended installation (upsertInstallation overwrites the column).
    const current = await installationForScope(deps.db, inst.orgScope);
    const suspended = current?.suspended ?? false;
    await upsertInstallation(deps.db, { ...inst, suspended }); // repo_selection may have changed with the event
    if (suspended) return;
    const removed = Array.isArray(p.repositories_removed) ? p.repositories_removed as { full_name?: unknown }[] : [];
    for (const r of removed) {
      if (typeof r.full_name === "string") await deleteOrgRepoSkills(deps.db, inst.orgScope, r.full_name);
    }
    const added = Array.isArray(p.repositories_added) ? p.repositories_added : [];
    // Added repos: re-list via the API (the payload lacks default branches) and index everything.
    if (added.length > 0) await indexInstallationRepos(deps, inst);
    return;
  }

  if (event === "organization") {
    const org = String((p.organization as { login?: unknown })?.login ?? "").toLowerCase();
    const membership = p.membership as { user?: { login?: unknown }; role?: unknown } | undefined;
    const login = String(membership?.user?.login ?? "").toLowerCase();
    if (!org || !login) return;
    if (action === "member_added") await upsertOrgMember(deps.db, org, login, membership?.role === "admin" ? "admin" : "member");
    else if (action === "member_removed") await deleteOrgMember(deps.db, org, login);
    return;
  }

  if (event === "push") {
    const repoInfo = p.repository as { full_name?: unknown; default_branch?: unknown; owner?: { login?: unknown } } | undefined;
    const repo = String(repoInfo?.full_name ?? "");
    const org = String(repoInfo?.owner?.login ?? "").toLowerCase();
    const defaultBranch = String(repoInfo?.default_branch ?? "main");
    if (!repo || !org || p.ref !== `refs/heads/${defaultBranch}`) return; // only the default branch is indexed
    const inst = await installationForScope(deps.db, org);
    if (!inst || inst.suspended || !deps.tokens) return;
    const token = await deps.tokens.tokenFor(inst.installationId);
    await indexOrgRepo(deps.db, deps.http, token, org, repo, defaultBranch);
  }
}

/** Daily backstop: adopt GitHub's installation list as truth, resync each active install, and
 *  forget local installations GitHub no longer reports. */
export async function reconcileAll(deps: GithubAppDeps): Promise<{ installations: number }> {
  if (!deps.cfg) return { installations: 0 };
  const { installations: remote, truncated } = await listAppInstallations(deps.cfg, deps.fetchImpl);
  if (truncated) {
    // A partial remote list must never drive deletes: a "stray" might just be on a page we
    // couldn't fetch, and deleteInstallation cascades members + skills.
    console.error("githubApp: reconcile skipping stray-installation deletes — remote list truncated");
  } else {
    for (const local of await listInstallations(deps.db)) {
      if (remote.some((r) => r.installationId === local.installationId)) continue;
      try {
        await deleteInstallation(deps.db, local.installationId);
      } catch (e) {
        console.error(`githubApp: reconcile stray #${local.installationId} delete failed: ${(e as Error).message}`);
      }
    }
  }
  for (const r of remote) {
    await upsertInstallation(deps.db, r);
    if (r.suspended) continue;
    try {
      await syncInstallation(deps, r);
    } catch (e) {
      console.error(`githubApp: reconcile ${r.orgScope} (#${r.installationId}) failed: ${(e as Error).message}`);
    }
  }
  return { installations: remote.length };
}
