// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Hosted-aggregator read client for the desktop's Benchmark tab. Mirrors shareClient:
// resolve the base (explicit -> AGENTGEM_AGGREGATOR_URL -> the public default) and GET the
// anonymous, public, k-anonymised roll-ups. Runs in the core, so a server-side fetch passes
// the hosted originGuard as a non-browser client and needs no auth. Any failure degrades to []
// so the panel shows its empty state instead of an error.
import { DEFAULT_AGGREGATOR_URL } from "./shareClient.js";

export type BenchmarkHttp = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: BenchmarkHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

function resolveBase(endpoint?: string): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return DEFAULT_AGGREGATOR_URL;
}

async function getRows(base: string, path: string, http: BenchmarkHttp): Promise<unknown[]> {
  if (!base) return [];
  try {
    const res = await http(`${base}${path}`, { method: "GET", headers: { accept: "application/json" } });
    if (res.status < 200 || res.status >= 300) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

export async function benchmarks(
  args: { gemDigest?: string; endpoint?: string; http?: BenchmarkHttp } = {},
): Promise<unknown[]> {
  const q = args.gemDigest ? `?gemDigest=${encodeURIComponent(args.gemDigest)}` : "";
  return getRows(resolveBase(args.endpoint), `/api/aggregator/benchmarks${q}`, args.http ?? defaultHttp);
}

export async function effectiveness(
  args: { sort?: string; minConfidence?: number; gemName?: string; endpoint?: string; http?: BenchmarkHttp } = {},
): Promise<unknown[]> {
  const p = new URLSearchParams();
  if (args.sort) p.set("sort", args.sort);
  if (args.minConfidence !== undefined) p.set("minConfidence", String(args.minConfidence));
  if (args.gemName) p.set("gemName", args.gemName);
  const q = p.toString() ? `?${p.toString()}` : "";
  return getRows(resolveBase(args.endpoint), `/api/aggregator/effectiveness${q}`, args.http ?? defaultHttp);
}
