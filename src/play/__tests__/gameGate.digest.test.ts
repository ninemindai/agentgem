// src/play/__tests__/gameGate.digest.test.ts
//
// The digest is the post-execution view of a bundle: what the DOM looked like once its scripts ran.
// Two things are load-bearing here and neither is about the digest's CONTENT:
//
//   1. The field is never optional. "Nothing was examined" must not be spellable the same way as
//      "examined, nothing wrong" — an optional field makes the silent-skip the easy code to write,
//      and this repo has already shipped that bug once (JudgeCoverage.truncated was added so partial
//      examination could not pass silently, then nothing consulted it).
//   2. "I did not ask for a digest" and "a digest was impossible" are DIFFERENT answers. Collapsing
//      them means an opt-out call site is indistinguishable from a bundle that never ran.
import { describe, it, expect } from "vitest";
import { gameGate, type RenderDigest } from "@agentgem/play";

const good = `<!doctype html><html><body><h1>hi</h1><script>document.title="x";</script></body></html>`;

describe("gameGate digest", () => {
  it("reports not-requested when the caller did not ask for one", async () => {
    // The default. migrateAllMiniapps and the checkpoint gem-write read only `.ok`, so they must not
    // pay for a DOM walk — and what they get back must say WHY it is absent.
    const r = await gameGate(good);
    expect(r.ok).toBe(true);
    expect(r.digest).toBe("not-requested");
  });

  it("reports not-executed when the static gate short-circuits before the smoke", async () => {
    // An external script src never reaches the worker, so no DOM ever existed. This is the case that
    // must never read as clean.
    const r = await gameGate(`<script src="https://cdn.example/x.js"></script>`, { digest: true });
    expect(r.ok).toBe(false);
    expect(r.digest).toBe("not-executed");
  });

  it("distinguishes not-requested from not-executed on the same bundle", async () => {
    // Same failing bundle, both ways round: the reason the digest is missing changes with the ask.
    const bad = `<script src="https://cdn.example/x.js"></script>`;
    expect((await gameGate(bad)).digest).toBe("not-requested");
    expect((await gameGate(bad, { digest: true })).digest).toBe("not-executed");
  });

  it("returns a digest when one is asked for and the bundle runs", async () => {
    const r = await gameGate(good, { digest: true });
    expect(r.ok).toBe(true);
    expect(r.digest).not.toBe("not-requested");
    expect(r.digest).not.toBe("not-executed");
  });
});

/** Narrow the union so a content test reads the digest without repeating the guard. */
async function digestOf(html: string): Promise<RenderDigest> {
  const r = await gameGate(html, { digest: true });
  if (typeof r.digest === "string") throw new Error(`expected a digest, got ${r.digest}: ${r.failures.join("; ")}`);
  return r.digest;
}

describe("RenderDigest content", () => {
  it("describes the DOM the scripts BUILT, not the source markup", async () => {
    // The whole reason the digest is taken inside the worker after the ticks: a report renders itself
    // from #report-data at runtime, so a pre-execution parse would see an empty body.
    const d = await digestOf(`<!doctype html><html><head><title>t</title></head><body>
      <script>document.body.insertAdjacentHTML("beforeend", '<p id="built">from script</p>');</script>
    </body></html>`);
    expect(d.ids).toContain("built");
    expect(d.bodyElementCount).toBeGreaterThan(0);
  });

  it("counts only rendered elements, so a script-only body reads as empty", async () => {
    const d = await digestOf(`<body><script>var x=1;</script><style>p{color:red}</style></body>`);
    expect(d.bodyElementCount).toBe(0);
  });

  it("lists ids in document order so a duplicate can be named", async () => {
    const d = await digestOf(`<body><p id="dup">a</p><p id="other">b</p><p id="dup">c</p></body>`);
    expect(d.ids).toEqual(["dup", "other", "dup"]);
  });

  it("reports whether a json block parses and whether it is empty", async () => {
    const d = await digestOf(`<body>
      <script id="full" type="application/json">{"a":1}</script>
      <script id="empty" type="application/json">{}</script>
      <script id="broken" type="application/json">{not json</script>
    </body>`);
    const by = (id: string) => d.jsonBlocks.find((b) => b.id === id);
    expect(by("full")).toMatchObject({ parses: true, empty: false });
    expect(by("empty")).toMatchObject({ parses: true, empty: true });
    expect(by("broken")).toMatchObject({ parses: false });
  });

  it("collects an approximate name for controls, including aria-labelledby", async () => {
    const d = await digestOf(`<body>
      <button>Save</button>
      <button aria-label="Close dialog"></button>
      <span id="lbl">Retry now</span><button aria-labelledby="lbl"></button>
      <button></button>
    </body>`);
    const hints = d.controls.map((c) => c.nameHint);
    expect(hints).toContain("Save");
    expect(hints).toContain("Close dialog");
    expect(hints).toContain("Retry now");
    expect(hints).toContain("");            // the genuinely unnamed one
  });

  it("records aria references and whether they resolve", async () => {
    const d = await digestOf(`<body><span id="here">x</span>
      <div aria-describedby="here"></div><div aria-describedby="gone"></div></body>`);
    expect(d.ariaRefs).toContainEqual({ attr: "aria-describedby", target: "here", resolves: true });
    expect(d.ariaRefs).toContainEqual({ attr: "aria-describedby", target: "gone", resolves: false });
  });

  it("separates canvas from other vector or image content", async () => {
    const canvas = await digestOf(`<body><canvas></canvas></body>`);
    expect(canvas.hasCanvas).toBe(true);
    expect(canvas.hasVectorOrImageContent).toBe(true);

    const svg = await digestOf(`<body><svg><circle r="1"/></svg></body>`);
    expect(svg.hasCanvas).toBe(false);
    expect(svg.hasVectorOrImageContent).toBe(true);

    const text = await digestOf(`<body><p>words</p></body>`);
    expect(text.hasCanvas).toBe(false);
    expect(text.hasVectorOrImageContent).toBe(false);
  });

  it("sees an external resource a script attached at runtime", async () => {
    // The static scan reads source text, so a URL assembled at runtime is invisible to it. An ATTACHED
    // node is visible here. (A detached `new Image().src` is not — see TODOS.md.)
    const d = await digestOf(`<body><script>
      var i = document.createElement("img");
      i.src = "https:" + "//cdn.example/late.png";
      document.body.appendChild(i);
    </script></body>`);
    expect(d.attachedExternal.some((u) => u.includes("cdn.example"))).toBe(true);
  });

  it("does not flag data: URIs as external", async () => {
    const d = await digestOf(`<body><img alt="x" src="data:image/png;base64,AAAA"></body>`);
    expect(d.attachedExternal).toEqual([]);
  });
});
