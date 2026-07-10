// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/playScaffoldXss.test.ts
//
// sealedTemplate seeds a blank miniapp from a user-supplied title (blankStudio).
// The title was interpolated raw into an HTML <title> slot AND a JS string literal
// (ctx.fillText("${title}")). A crafted title could inject a <script> into the head
// or break out of the fillText string — a stored XSS baked into the shared bundle,
// outside the AGENTGEM:GAME-LOGIC markers so it survives every later edit. The title
// must be escaped for both contexts. Root-package test so it gates in CI.
import { describe, it, expect } from "vitest";
import { sealedTemplate } from "@agentgem/play";

describe("sealedTemplate title escaping", () => {
  it("escapes an HTML-context breakout in the <title> slot", () => {
    const html = sealedTemplate("</title><script>PWN()</script>", "sub");
    expect(html).not.toContain("<script>PWN()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a JS-string breakout in the fillText slot", () => {
    // Raw, this closes the string and injects a call: fillText("pwn");DANGER//", ...)
    const html = sealedTemplate('pwn");DANGER//', "sub");
    expect(html).not.toContain('ctx.fillText("pwn")');
  });

  it("escapes an HTML-context breakout in the subtitle slot", () => {
    const html = sealedTemplate("t", "</div><script>PWN()</script>");
    expect(html).not.toContain("<script>PWN()</script>");
  });

  it("renders a normal title unchanged in meaning", () => {
    const html = sealedTemplate("My Game", "play");
    expect(html).toContain("<title>My Game</title>");
    expect(html).toContain('ctx.fillText("My Game"');
  });
});
