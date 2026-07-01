import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createSession, generateSessionToken } from "@agentgem/aggregator";
import { exportGem, type RegistryPublisher, type RegistrySource, type RegistryIndex } from "@agentgem/distribute";
import { uploadPublishHandler } from "../uploadPublish.js";
import { SESSION_COOKIE } from "../../auth/cookie.js";
import { defaultGemTypeRegistry } from "../../gem/gemTypeRegistry.js";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "test-gem", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "t", source: "standalone", content: "# T" }] };
const gemBase64 = () => exportGem(gem, { version: "1.0.0" }).bytes.toString("base64");

function capturing(): { publisher: RegistryPublisher; commits: { files: unknown; message: string }[] } {
  const commits: { files: unknown; message: string }[] = [];
  return { commits, publisher: { async putCommit(files, message) { commits.push({ files, message }); return { commit: "abc" }; } } };
}
const emptySource = (): RegistrySource => ({ id:"t", label:"t", ready:()=>true, async getIndex(){ return { formatVersion:1, items:{} } as RegistryIndex; }, async fetchItem(){ return {}; } });
const mkRes = () => { const r: any = { _s: 200, _h: {}, _b: undefined };
  r.status=(c:number)=>{r._s=c;return r;}; r.set=(k:string,v:string)=>{r._h[k.toLowerCase()]=v;return r;};
  r.json=(b:unknown)=>{r._b=b;return r;}; r.send=(b:unknown)=>{r._b=b;return r;}; return r; };
const mkReq = (over: any = {}) => ({ method:"POST", path:"/api/registry/upload-publish", headers:{}, body:{}, ...over });
const deps = (db: any, publisher: RegistryPublisher) => ({ db, webOrigins:["https://app.agentgem.ai"], source: emptySource(), publisher, gemTypes: defaultGemTypeRegistry });
async function session(db: any, login: string) { const a = await upsertAccount(db, { provider:"github", accountId:"1", login }); const { token } = generateSessionToken(); await createSession(db, a.id, token, 60_000); return token; }

describe("upload-publish", () => {
  it("401s without a session", async () => {
    const db = await makeTestDb(); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ body: { scope:"x", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(401);
  });
  it("403s when scope !== login (the safety rail)", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"bob", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(403);
  });
  it("publishes + stamps publishedBy when scope === login", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher, commits } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"alice", version:"1.0.0", tags:["x"], bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(200);
    expect((res._b as any).ref).toBe("@alice/test-gem");
    const idx = JSON.parse((commits[0].files as any)["registry.json"]);
    expect(idx.items["@alice/test-gem"].discovery.publishedBy).toBe("alice"); // VERIFIED attribution
    expect(res._h["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
    expect(res._h["access-control-allow-credentials"]).toBe("true");
  });
  it("400s on tampered bytes (gem.lock fails)", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}` }, body:{ scope:"alice", version:"1.0.0", bytesBase64: Buffer.from("not a gem").toString("base64") } }) as any, res as any);
    expect(res._s).toBe(400);
  });
  it("500s (generic, no leak) on an infra failure — putCommit throws", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const res = mkRes();
    const throwing: RegistryPublisher = { async putCommit() { throw new Error("github 503: secret-internal-detail"); } };
    await uploadPublishHandler(deps(db, throwing))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"alice", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(500);
    expect((res._b as any).error).toBe("publish failed");                  // generic — internal detail NOT leaked
    expect(JSON.stringify(res._b)).not.toContain("secret-internal-detail");
  });
  it("stamps grade from the archive and ignores a bogus grade in the request body", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher, commits } = capturing(); const res = mkRes();
    const graded: Gem = { ...gem, grade: 2 };
    const gradedBase64 = exportGem(graded, { version: "1.0.0" }).bytes.toString("base64");
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"alice", version:"1.0.0", grade: 5, bytesBase64: gradedBase64 } }) as any, res as any);
    expect(res._s).toBe(200);
    const idx = JSON.parse((commits[0].files as any)["registry.json"]);
    expect(idx.items["@alice/test-gem"].discovery.grade).toBe(2); // from the archive, not the body's bogus 5
  });
  it("OPTIONS preflight → 204 with credentialed CORS", async () => {
    const db = await makeTestDb(); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ method:"OPTIONS", headers:{ origin:"https://app.agentgem.ai" } }) as any, res as any);
    expect(res._s).toBe(204);
    expect(res._h["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
  });
});
