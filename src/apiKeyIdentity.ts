// Resolves the caller's tier from an API key BEFORE the rate limiters run, so the
// limiters' synchronous keyGenerator/skip can read req.gemTier/req.gemKeyId without an
// async DB hit. Mounted (scoped to /api/aggregator) ahead of the extension-rate-limit mounts.
import type { AppDb } from "@agentgem/aggregator";
import { verifyKey } from "@agentgem/aggregator";

interface IdReq {
  query?: Record<string, unknown>;
  get(name: string): string | undefined;
  gemTier?: "anonymous" | "keyed";
  gemKeyId?: string;
}
interface IdRes { status(code: number): IdRes; type(t: string): IdRes; send(body: string): unknown }
type IdNext = () => void;

export function makeApiKeyIdentity(db: AppDb) {
  return async function apiKeyIdentity(req: IdReq, res: IdRes, next: IdNext): Promise<void> {
    const header = req.get("x-api-key");
    const queried = typeof req.query?.apiKey === "string" ? (req.query.apiKey as string) : undefined;
    const key = header ?? queried;
    if (!key) { req.gemTier = "anonymous"; next(); return; }
    const found = await verifyKey(db, key);
    if (!found) { res.status(401).type("application/json").send(JSON.stringify({ error: "invalid api key" })); return; }
    req.gemTier = "keyed";
    req.gemKeyId = found.id;
    next();
  };
}
