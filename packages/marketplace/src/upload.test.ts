import { describe, it, expect, vi, afterEach } from "vitest";
import { makeUpload, NotSignedIn } from "./upload";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) }) as Response;
// a fake File whose base64 we control via a stubbed FileReader
class FakeReader { result = ""; onload: (() => void) | null = null;
  readAsDataURL() { this.result = "data:application/octet-stream;base64,QUJD"; this.onload?.(); } }

describe("makeUpload", () => {
  it("base64s the file + credentialed POST, returns the ref", async () => {
    vi.stubGlobal("FileReader", FakeReader as never);
    let opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { opts = o; return res({ ref: "@alice/g", version: "1.0.0", path: "p" }); }));
    const r = await makeUpload("https://api").publish({ file: { name: "g.gem" } as File, scope: "alice", version: "1.0.0" });
    expect(r.ref).toBe("@alice/g");
    expect(opts?.credentials).toBe("include");
    const sent = JSON.parse(String(opts?.body));
    expect(sent.bytesBase64).toBe("QUJD");
    expect(sent.publishedBy).toBeUndefined(); // never client-supplied — the server derives it from the session (unforgeable)
  });
  it("throws NotSignedIn on 401", async () => {
    vi.stubGlobal("FileReader", FakeReader as never);
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "sign in required" }, false, 401)));
    await expect(makeUpload("https://api").publish({ file: { name: "g.gem" } as File, scope: "a", version: "1.0.0" })).rejects.toBeInstanceOf(NotSignedIn);
  });
});
