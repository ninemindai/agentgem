// Group + gem-sharing client. Credentialed so the parent-domain session cookie travels; every
// write 401s when signed out (NotSignedIn), mirroring stars.ts.
import { NotSignedIn } from "./stars";

export type GroupRole = "admin" | "member";
export interface GroupSummary { id: string; kind: string; installationId: number | null; scope: string | null; name: string; role: GroupRole }
export interface GroupMember { accountId: string; login: string | null; avatarUrl: string | null; role: GroupRole; viaSync: boolean; viaInvite: boolean }
export interface GroupInvite { id: string; role: GroupRole; expiresAt: string; revokedAt: string | null }
export interface MintedInvite { id: string; token: string; expiresAt: string }
export interface GroupGem { gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }
export interface GemShareRef { groupId: string; name: string }

async function jsonOrThrow<T>(r: Response, what: string): Promise<T> {
  if (r.status === 401) throw new NotSignedIn();
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    const err = new Error(body.error ?? `${what} -> ${r.status}`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json()) as T;
}
const q = (o: Record<string, string>) => "?" + new URLSearchParams(o).toString();

export function makeGroups(base: string) {
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const del = (path: string) => fetch(base + path, { method: "DELETE", credentials: "include" });
  const getc = (path: string) => fetch(base + path, { credentials: "include" });
  return {
    list: async (): Promise<GroupSummary[]> => (await jsonOrThrow<{ groups: GroupSummary[] }>(await getc("/api/catalog/groups"), "groups")).groups,
    create: async (name: string): Promise<GroupSummary> => (await jsonOrThrow<{ group: GroupSummary }>(await post("/api/catalog/groups", { name }), "create group")).group,
    remove: async (id: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/groups" + q({ id })), "delete group"); },
    members: async (id: string): Promise<GroupMember[]> => (await jsonOrThrow<{ members: GroupMember[] }>(await getc("/api/catalog/group-members" + q({ id })), "members")).members,
    removeMember: async (id: string, account: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/group-members" + q({ id, account })), "remove member"); },
    invites: async (id: string): Promise<GroupInvite[]> => (await jsonOrThrow<{ invites: GroupInvite[] }>(await getc("/api/catalog/group-invites" + q({ id })), "invites")).invites,
    createInvite: async (id: string, opts: { role?: GroupRole; ttlDays?: number } = {}): Promise<MintedInvite> =>
      jsonOrThrow<MintedInvite>(await post("/api/catalog/group-invites" + q({ id }), opts), "mint invite"),
    revokeInvite: async (id: string, invite: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/group-invites" + q({ id, invite })), "revoke invite"); },
    redeem: async (token: string): Promise<void> => { await jsonOrThrow(await post("/api/catalog/group-invite-redeem", { token }), "join group"); },
    groupGems: async (id: string): Promise<GroupGem[]> => (await jsonOrThrow<{ gems: GroupGem[] }>(await getc("/api/catalog/group-gems" + q({ id })), "group gems")).gems,
    listGemShares: async (key: string): Promise<GemShareRef[]> => (await jsonOrThrow<{ shares: GemShareRef[] }>(await getc("/api/catalog/gem-shares" + q({ key })), "gem shares")).shares,
    shareGem: async (key: string, groupId: string): Promise<void> => { await jsonOrThrow(await post("/api/catalog/gem-shares", { key, groupId }), "share gem"); },
    unshareGem: async (key: string, groupId: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/gem-shares" + q({ key, groupId })), "unshare gem"); },
  };
}
