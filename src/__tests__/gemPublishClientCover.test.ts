import { describe, it, expect } from "vitest";
import { postGemPublish } from "@agentgem/app/gem/gemPublishClient";
import type { Identity } from "@agentgem/model";

const identity = { publicKey: "pk", sign: () => "sig" } as unknown as Identity;
const manifest = { gemKey: "@a/g", version: "1.0.0" } as never;

describe("postGemPublish coverDataUrl", () => {
  it("includes coverDataUrl in the POST body when provided", async () => {
    let sent: Record<string, unknown> = {};
    const http = async (_url: string, init: { body: string }) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ shared: true, publishedBy: "a" }) }; };
    await postGemPublish({ manifest, archiveBase64: "AAA", identity, http: http as never, now: () => 1, coverDataUrl: "data:image/png;base64,AAAA" });
    expect(sent.coverDataUrl).toBe("data:image/png;base64,AAAA");
    expect(sent.manifest).toBeDefined(); // manifest still sent alongside (cover is NOT in the signed payload)
  });
  it("omits coverDataUrl when not provided", async () => {
    let sent: Record<string, unknown> = {};
    const http = async (_url: string, init: { body: string }) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ shared: true, publishedBy: "a" }) }; };
    await postGemPublish({ manifest, archiveBase64: "AAA", identity, http: http as never, now: () => 1 });
    expect("coverDataUrl" in sent).toBe(false);
  });
});
