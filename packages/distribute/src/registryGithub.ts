// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/registryGithub.ts
// Isolated GitHub network client. All HTTP goes through the injected `http` fn so logic stays testable.
// Fetch uses the Contents API (token-optional → public + private uniform). Publish builds one atomic
// commit via the Git Data API (blobs → tree → commit → update ref).
import type { RegistryIndex, RegistrySource, RegistryPublisher } from "./registry.js";
import type { FileTree } from "@agentgem/model";

export interface GithubCfg { repo: string; ref: string; token?: string }
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

const API = "https://api.github.com";
const defaultHttp: Http = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { status: res.status, text: () => res.text() };
};

function headers(cfg: GithubCfg): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "agentgem" };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}
async function ghJson(http: Http, cfg: GithubCfg, path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const res = await http(`${API}/repos/${cfg.repo}/${path}`, { ...init, headers: headers(cfg) });
  const body = await res.text();
  if (res.status >= 300) throw new Error(`GitHub ${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

export function githubRegistrySource(cfg: GithubCfg, http: Http = defaultHttp): RegistrySource {
  const contents = (p: string) => ghJson(http, cfg, `contents/${encodeURIComponent(p).replace(/%2F/g, "/")}?ref=${encodeURIComponent(cfg.ref)}`);
  return {
    id: "github", label: `GitHub ${cfg.repo}`,
    ready: () => cfg.repo.length > 0,
    async getIndex(): Promise<RegistryIndex> {
      const node = (await contents("registry.json")) as { content: string; encoding: string };
      return JSON.parse(Buffer.from(node.content, "base64").toString("utf8")) as RegistryIndex;
    },
    async fetchItem(itemPath: string): Promise<FileTree> {
      const files: FileTree = {};
      const walk = async (p: string): Promise<void> => {
        const node = await contents(p);
        if (Array.isArray(node)) {
          for (const e of node as { type: string; path: string }[]) await walk(e.path);
        } else {
          const f = node as { content: string };
          files[p.slice(itemPath.length + 1)] = Buffer.from(f.content, "base64").toString("utf8");
        }
      };
      await walk(itemPath);
      return files;
    },
  };
}

export function githubRegistryPublisher(cfg: GithubCfg, http: Http = defaultHttp): RegistryPublisher {
  if (!cfg.token) throw new Error("publishing requires GITHUB_TOKEN");
  return {
    async putCommit(files: FileTree, message: string): Promise<{ commit: string }> {
      // GitHub API asymmetry: GET a single ref is singular "git/ref/...", PATCH update is plural "git/refs/..." (below). Do not "fix" to plural — plural GET returns an array.
      const ref = (await ghJson(http, cfg, `git/ref/heads/${cfg.ref}`)) as { object: { sha: string } };
      const base = ref.object.sha;
      const baseCommit = (await ghJson(http, cfg, `git/commits/${base}`)) as { tree: { sha: string } };
      const tree = await Promise.all(Object.entries(files).map(async ([path, content]) => {
        const blob = (await ghJson(http, cfg, "git/blobs", { method: "POST", body: JSON.stringify({ content, encoding: "utf-8" }) })) as { sha: string };
        return { path, mode: "100644", type: "blob", sha: blob.sha };
      }));
      const newTree = (await ghJson(http, cfg, "git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) })) as { sha: string };
      const commit = (await ghJson(http, cfg, "git/commits", { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [base] }) })) as { sha: string };
      await ghJson(http, cfg, `git/refs/heads/${cfg.ref}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
      return { commit: commit.sha };
    },
  };
}

export function registryConfigFromEnv(): GithubCfg | null {
  const repo = process.env.AGENTGEM_REGISTRY_REPO;
  if (!repo) return null;
  return { repo, ref: process.env.AGENTGEM_REGISTRY_REF ?? "main", token: process.env.GITHUB_TOKEN };
}
export function registryReady(): boolean {
  return registryConfigFromEnv() !== null;
}
