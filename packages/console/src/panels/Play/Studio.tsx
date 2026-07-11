// packages/console/src/panels/Play/Studio.tsx
import { useEffect, useRef, useState } from "react";
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute, publishSetupRoute, shareMiniappRoute, revokeMiniappRoute } from "../../api/routes.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { CapabilityStrip } from "./CapabilityStrip.js";
import { Runner } from "./Runner.js";
import { openStudioStream } from "./studioStream.js";
import { genre as genreOf, parseGateFailure, fixSealPrompt } from "./playMeta.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
import { useSplit } from "../../shell/useSplit.js";

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

// Structured chat log entries so we can render bubbles + tool chips instead of one rolling string.
type Msg = { role: "user" | "agent"; text: string } | { role: "tool"; title: string; failed?: boolean };
type StoredTurn = { turnId: string; message: string };

export function Studio({
  apiBase,
  name,
  seedPrompt,
  agents,
  agentId,
  onAgentIdChange,
  onBack,
}: {
  apiBase: string;
  name: string;
  // When a blank miniapp was created with a description, it's auto-sent as the first build prompt.
  seedPrompt?: string;
  agents: PlayAgent[] | null;
  agentId: string;
  onAgentIdChange: (agentId: string) => void;
  onBack: () => void;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState("");
  const [html, setHtml] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);   // preview fetch failed → say so, don't fake it
  const [meta, setMeta] = useState<{ title: string; genre: string; needs?: string[] } | null>(null);
  const [pruned, setPruned] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [gate, setGate] = useState<string[] | null>(null);       // seal failures → actionable banner
  const [share, setShare] = useState<{ gemUrl: string; cardUrl?: string } | null>(null);
  const [pendingPublish, setPendingPublish] = useState(false);   // Share clicked while unbound
  const [shareLink, setShareLink] = useState<string | null>(null);   // light unlisted share; persists via the miniapp read's `share`
  const [pendingShare, setPendingShare] = useState(false);   // Copy-share clicked while unbound
  const [sharing, setSharing] = useState(false);   // in-flight guard: blocks a double-mint from orphaning an un-revokable link
  const { status: identity } = useIdentity();
  const closeRef = useRef<null | (() => void)>(null);
  const mountedRef = useRef(false);
  const busyRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [plateMax, setPlateMax] = useState<number | undefined>(undefined);
  const seededRef = useRef(false);   // guards the one-shot seed-prompt auto-send
  const split = useSplit("studio", { initial: 560, min: 360, max: 900, side: "start" });
  const chatStoreKey = agentId ? `agentgem:play:chat:${name}:${agentId}` : "";
  const turnStoreKey = agentId ? `agentgem:play:turn:${name}:${agentId}` : "";

  function markBusy(next: boolean) {
    busyRef.current = next;
    if (mountedRef.current) setBusy(next);
  }

  function rememberChat(id: string) {
    if (!chatStoreKey) return;
    try { localStorage.setItem(chatStoreKey, id); } catch { /* disabled storage */ }
  }

  function forgetChat(idKey = chatStoreKey) {
    if (!idKey) return;
    try { localStorage.removeItem(idKey); } catch { /* disabled storage */ }
  }

  function newTurnId(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function rememberTurn(turn: StoredTurn) {
    if (!turnStoreKey) return;
    try { localStorage.setItem(turnStoreKey, JSON.stringify(turn)); } catch { /* disabled storage */ }
  }

  function readTurn(): StoredTurn | null {
    if (!turnStoreKey) return null;
    try {
      const raw = localStorage.getItem(turnStoreKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredTurn>;
      return parsed.turnId && parsed.message ? { turnId: parsed.turnId, message: parsed.message } : null;
    } catch { return null; }
  }

  function forgetTurn(idKey = turnStoreKey) {
    if (!idKey) return;
    try { localStorage.removeItem(idKey); } catch { /* disabled storage */ }
  }

  // Resume the publish the user already asked for. `login` comes straight from
  // bindComplete — reading it off the refreshed identity context would race the
  // React render that applies the refresh, and resume could see a stale null.
  const bind = useGitHubBind(apiBase, {
    onBound: (login) => {
      if (pendingPublish) { setPendingPublish(false); void publishWorkspace(login); }
      if (pendingShare) { setPendingShare(false); void mintShare(); }
    },
  });

  // Never swallow this: html="" renders as a sealed-but-empty iframe, which reads as a working preview of
  // an empty app rather than as a failure. Keep the last good html on a refresh error — a failed reload
  // after a build shouldn't blank a preview that is still on screen and still correct.
  const refresh = () =>
    playMiniappRoute.call(makeClient(apiBase), { query: { name } })
      .then((r) => { setHtml(r.html); setMeta(r.meta); setLoadErr(null); setShareLink(r.share?.url ?? null); })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      // If the agent is mid-turn, leave the stream alive so the server-side turn can finish and
      // checkpoint the miniapp. The terminal stream event closes itself; returning to Studio reloads
      // the latest saved HTML. If idle, close normally.
      if (!busyRef.current) closeRef.current?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, name]);

  useEffect(() => {
    if (!chatStoreKey) { setChatId(null); return; }
    let storedChatId: string | null = null;
    try { storedChatId = localStorage.getItem(chatStoreKey) || null; setChatId(storedChatId); } catch { setChatId(null); }
    const storedTurn = readTurn();
    if (!storedChatId || !storedTurn) return;
    markBusy(true);
    setWorking("finishing in background…");
    setMsgs((m) => m.length ? m : [{ role: "user", text: storedTurn.message }]);
    closeRef.current?.();
    closeRef.current = openStudioStream(
      apiBase,
      storedChatId,
      storedTurn.message,
      streamHandlers(turnStoreKey),
      { turnId: storedTurn.turnId, resume: true },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, chatStoreKey, turnStoreKey]);

  // Kick off the build from the blank-tab description: send it as the first chat message, once an agent
  // is ready. One-shot (seededRef) so it never re-fires when the agent list resolves or agent changes.
  useEffect(() => {
    if (seededRef.current || !seedPrompt || !agentId || busyRef.current || readTurn()) return;
    seededRef.current = true;
    send(seedPrompt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPrompt, agentId]);

  useEffect(() => { logRef.current?.scrollTo?.({ top: logRef.current.scrollHeight }); }, [msgs, working]); // scrollTo absent in jsdom

  // Grow the composer with its content, up to the max-height at which CSS makes it scroll. Reset to
  // auto first, else scrollHeight only ever reports the taller of (content, current height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !el.scrollHeight) return;   // jsdom reports 0
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Budget the preview's height so the composer always stays on the first screen: whatever is left
  // between the top of the plate and the composer (which grows as you type). Re-measured on resize,
  // on composer growth, and whenever a banner shifts the plate down.
  useEffect(() => {
    const calc = () => {
      const top = plateRef.current?.getBoundingClientRect().top;
      if (top == null) return;
      const reserve = (composerRef.current?.offsetHeight ?? 120) + 40;  // composer + its margin + breathing room
      setPlateMax(Math.max(240, Math.round(window.innerHeight - top - reserve - 16))); // 16 = plate padding + border
    };
    calc();
    window.addEventListener("resize", calc);
    const ro = typeof ResizeObserver !== "undefined" && composerRef.current ? new ResizeObserver(calc) : null;
    if (composerRef.current) ro?.observe(composerRef.current);
    return () => { window.removeEventListener("resize", calc); ro?.disconnect(); };
  }, [gate, share]);

  function pushDelta(t: string) {
    setMsgs((m) => {
      const last = m[m.length - 1];
      if (last && last.role === "agent") return [...m.slice(0, -1), { role: "agent", text: last.text + t }];
      return [...m, { role: "agent", text: t }];
    });
  }
  function activity(tool: { kind?: string; title?: string }): string {
    switch (tool.kind) { case "execute": return "running a command…"; case "read": return "reading files…"; case "edit": return "editing the miniapp…"; default: return "working…"; }
  }

  function streamHandlers(activeTurnKey = turnStoreKey, retryExpired?: { message: string }) {
    return {
      onDelta: (t: string) => { if (!mountedRef.current) return; setWorking("responding…"); pushDelta(t); },
      onTool: (tool: { kind?: string; title?: string; status?: string }) => {
        if (!mountedRef.current) return;
        setWorking(activity(tool)); setMsgs((m) => [...m, { role: "tool", title: tool.title ?? tool.kind ?? "tool", failed: tool.status === "failed" }]);
      },
      onDone: async () => {
        closeRef.current = null;
        forgetTurn(activeTurnKey);
        if (!mountedRef.current) return;
        markBusy(false); setWorking(""); await refresh();
      },
      onFailed: (e: string) => {
        closeRef.current = null; forgetTurn(activeTurnKey); forgetChat();
        if (!mountedRef.current) return;
        setChatId(null);
        const expired = /^unknown chat\b/i.test(e);
        if (expired && retryExpired) {
          markBusy(false); setWorking(""); setStatus("Previous agent session expired; starting a fresh one…");
          setTimeout(() => { void send(retryExpired.message, { echo: false, retryExpired: false, forceNewChat: true }); }, 0);
          return;
        }
        markBusy(false); setWorking(""); setMsgs((m) => [...m, { role: "tool", title: `failed: ${e}`, failed: true }]);
      },
      onLost: (e: string) => {
        closeRef.current = null;
        if (!mountedRef.current) return;
        setWorking(`${e}; run may still be finishing…`);
        setStatus("Reopen this miniapp to reconnect to the active agent run.");
      },
    };
  }

  function changeAgent(nextAgentId: string) {
    if (nextAgentId === agentId) return;
    closeRef.current?.();
    closeRef.current = null;
    forgetChat();
    forgetTurn();
    setChatId(null);
    setMsgs([]);
    setWorking("");
    setGate(null);
    setShare(null);
    setStatus(chatId ? "switched coding agent; next message starts a new studio chat" : "");
    onAgentIdChange(nextAgentId);
  }

  async function send(text: string, opts: { echo?: boolean; retryExpired?: boolean; forceNewChat?: boolean } = {}) {
    const message = text.trim();
    if (!message || busyRef.current || !agentId) return;
    markBusy(true); setWorking("thinking…"); setGate(null); setShare(null); setStatus("");
    if (opts.echo !== false) setMsgs((m) => [...m, { role: "user", text: message }]);
    try {
      let id = opts.forceNewChat ? null : chatId;
      if (!id) {
        const res = await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, miniapp: name }) }).then(j);
        id = res.chatId as string;
        rememberChat(id);
        if (mountedRef.current) setChatId(id);
      }
      const turn = { turnId: newTurnId(), message };
      rememberTurn(turn);
      closeRef.current = openStudioStream(apiBase, id, message, streamHandlers(turnStoreKey, opts.retryExpired === false ? undefined : { message }), { turnId: turn.turnId });
    } catch (e) {
      forgetTurn();
      markBusy(false); setWorking(""); setStatus(`error: ${(e as Error).message}`);
    }
  }

  function submit() { send(input); setInput(""); }

  // Save gates the seal; a gate failure becomes an actionable banner (offer to have the agent fix it).
  async function save(): Promise<boolean> {
    setStatus("saving…"); setGate(null);
    try {
      const cur = await playMiniappRoute.call(makeClient(apiBase), { query: { name } });
      const res = await playSaveRoute.call(makeClient(apiBase), { body: { name, html: cur.html, meta: {
        title: cur.meta.title, genre: cur.meta.genre as "replay" | "skill-run" | "project-fun" | "session-heatmap",
        createdFrom: cur.meta.createdFrom, engineVersion: cur.meta.engineVersion,
        ...(cur.meta.needs ? { needs: cur.meta.needs } : {}),
      } } });
      // The save is the reconciliation. Adopt the meta we just read and stored, minus what the save
      // pruned, so the strip tells the truth and <Runner needs> renegotiates on the correct set.
      //
      // Adopting only the PRUNE was a one-way street: a capability ADDED to meta.json (by the agent or by
      // hand) never reached `meta` state, so <Runner needs> stayed stale, the host never attached, and the
      // miniapp ran host-less until an unmount/remount. There is no reload control to escape that with.
      setPruned(res.prunedNeeds);
      const needs = (cur.meta.needs ?? []).filter((n) => !(res.prunedNeeds as string[]).includes(n));
      setMeta({ title: cur.meta.title, genre: cur.meta.genre, ...(needs.length ? { needs } : {}) });
      setStatus("saved ✓"); return true;
    } catch (e) {
      const failures = parseGateFailure((e as Error).message);
      if (failures) { setGate(failures); setStatus(""); } else setStatus(`save failed: ${(e as Error).message}`);
      return false;
    }
  }

  async function pushGit() {
    setStatus("pushing…");
    try { await playPublishRoute.call(makeClient(apiBase), { body: {} }); setStatus("pushed to git ✓"); }
    catch (e) { setStatus(`push failed: ${(e as Error).message}`); }
  }

  // The actual publish. Takes `login` explicitly (see the onBound comment above) and
  // deliberately does NOT save: the caller already did, and the workspace + seal exist.
  async function publishWorkspace(login: string) {
    setStatus("publishing to app.agentgem.ai…");
    try {
      const g = genreOf(meta?.genre ?? "project-fun");
      const pub = await publishSetupRoute.call(makeClient(apiBase), { body: {
        workspace: name, scope: login, name, version: "0.1.0", provenance: "play",
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun"],
      } });
      // Link the gem's marketplace page (installable / playable), not just the OG teaser card.
      setShare({ gemUrl: `https://app.agentgem.ai/gems/${encodeURIComponent(pub.exploreRef)}`, cardUrl: pub.shareUrl }); setStatus("");
    } catch (e) {
      const body = (e as Record<string, unknown>).body;
      setStatus(`share failed: ${typeof body === "string" ? body : (e as Error).message}`);
    }
  }

  // Share to Explore (app.agentgem.ai): Save (creates the game-gem workspace + enforces
  // the seal), then publish. Unbound → offer the inline connect and resume afterwards.
  async function shareToExplore() {
    setStatus("preparing…"); setShare(null);
    if (!(await save())) return; // gate failure already surfaced as the banner
    if (identity?.bound && identity.login) { await publishWorkspace(identity.login); return; }
    setStatus("");
    setPendingPublish(true);
  }

  // A latent resume flag that fires on some later, unrelated bind is worse than no
  // resume at all — dropping the banner drops the pending publish with it.
  function dismissConnect() {
    setPendingPublish(false);
    bind.reset();
  }

  // Light unlisted share: mint (or copy, once minted) a /games/<id> link. Save first —
  // readWorkspace only works once saveMiniapp has dual-written the workspace, exactly
  // as shareToExplore saves before publishing.
  async function copyShareLink() {
    if (shareLink) { navigator.clipboard?.writeText(shareLink); setStatus("link copied ✓"); return; }
    if (sharing) return;   // a mint is already in flight; don't re-enter and risk a second mint
    setStatus("minting link…");
    if (!(await save())) return; // gate failure already surfaced as the banner
    if (!(identity?.bound && identity.login)) { setStatus(""); setPendingShare(true); return; }
    await mintShare();
  }

  // Re-entrant-safe: two rapid callers (the bound copyShareLink path and the post-bind onBound
  // resume) must never both reach shareMiniappRoute, or the server mints two shareIds and
  // writeMiniappShare keeps only the second — orphaning the first as a live, un-revokable link.
  async function mintShare() {
    if (sharing || shareLink) return;
    setSharing(true);
    try {
      const r = await shareMiniappRoute.call(makeClient(apiBase), { body: { name } });
      setShareLink(r.url);
      navigator.clipboard?.writeText(r.url);
      setStatus("link copied ✓");
    } catch (e) {
      setStatus(`share failed: ${(e as Error).message}`);
    } finally {
      setSharing(false);
    }
  }

  async function revokeShareLink() {
    setStatus("revoking…");
    try {
      await revokeMiniappRoute.call(makeClient(apiBase), { body: { name } });
      setShareLink(null);
      setStatus("link revoked ✓");
    } catch (e) {
      setStatus(`revoke failed: ${(e as Error).message}`);
    }
  }

  function dismissShareConnect() {
    setPendingShare(false);
    bind.reset();
  }

  const g = genreOf(meta?.genre ?? "");
  return (
    <section className="analyze">
      <div className="play-studio-head">
        <button className="play-btn play-btn--ghost" onClick={onBack}>← Arcade</button>
        <span className="play-studio-title">{meta?.title ?? name}</span>
        <span className="play-pill"><span className="play-pill__dot" style={{ background: g.tint }} />{g.icon} {g.label}</span>
        <span className="sp" />
        {status && <span className="play-intro" style={{ margin: 0 }}>{status}</span>}
        <button className="play-btn" onClick={save}>Save</button>
        <button className="play-btn play-btn--ghost" onClick={pushGit} title="git push the miniapps registry to your git remote">Push to git</button>
        <button className="play-btn" disabled={sharing} onClick={copyShareLink}>Copy share link</button>
        <button className="play-btn play-btn--primary" onClick={shareToExplore}>Share to app.agentgem.ai</button>
      </div>

      <CapabilityStrip needs={meta?.needs} pruned={pruned} />

      {share && (
        <div className="play-banner play-banner--ok">
          <span className="play-banner__ico">🌐</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Published to app.agentgem.ai</div>
            <div className="play-banner__detail">{share.gemUrl}{share.cardUrl ? ` · share card: ${share.cardUrl}` : ""}</div>
          </div>
          <button className="play-btn" onClick={() => navigator.clipboard?.writeText(share.gemUrl)}>Copy</button>
          <button className="play-btn play-btn--ghost" onClick={() => window.open(share.gemUrl, "_blank", "noopener")}>Open</button>
        </div>
      )}
      {shareLink && (
        <div className="play-banner">
          <span className="play-banner__ico">🔗</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Share link</div>
            <div className="play-banner__detail">{shareLink}</div>
          </div>
          <button className="play-btn" onClick={() => navigator.clipboard?.writeText(shareLink)}>Copy</button>
          <button className="play-btn play-btn--ghost" onClick={revokeShareLink}>Revoke link</button>
        </div>
      )}
      {pendingShare && (
        <div className="play-banner">
          <span className="play-banner__ico">🔑</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Connect GitHub to share</div>
            <ConnectGitHub bind={bind} idleHint={<p className="play-banner__detail">Sharing continues automatically once you authorize.</p>} />
          </div>
          <button className="play-btn play-btn--ghost" onClick={dismissShareConnect}>Dismiss</button>
        </div>
      )}
      {gate && (
        <div className="play-banner">
          <span className="play-banner__ico">🔒</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Not sealed yet — can't save</div>
            <div className="play-banner__detail">{gate.join("; ")}</div>
          </div>
          <button className="play-btn play-btn--primary" disabled={busy} onClick={() => { const f = gate; setGate(null); send(fixSealPrompt(f)); }}>Fix with agent</button>
        </div>
      )}
      {pendingPublish && (
        <div className="play-banner">
          <span className="play-banner__ico">🔑</span>
          <div className="play-banner__body">
            <div className="play-banner__title">Connect GitHub to publish</div>
            <ConnectGitHub bind={bind} idleHint={<p className="play-banner__detail">Publishing continues automatically once you authorize.</p>} />
          </div>
          <button className="play-btn play-btn--ghost" onClick={dismissConnect}>Dismiss</button>
        </div>
      )}

      <AgentSelector
        agents={agents}
        agentId={agentId}
        disabled={busy}
        onChange={changeAgent}
        note={chatId ? "Changing agent starts a fresh studio chat." : "This agent will build/edit the miniapp."}
      />

      <div
        className={"play-grid-2" + (split.containerProps.className ? " " + split.containerProps.className : "")}
        style={split.containerProps.style}
      >
        <div className="play-stage">
          <div className="play-cap-row"><span className="play-cap">Preview</span><span className="play-cap__rule" /></div>
          <div className="play-plate" ref={plateRef}>
            {html ? <Runner html={html} name={name} apiBase={apiBase} needs={meta?.needs} maxHeight={plateMax} />
              : loadErr ? (
                <div className="play-plate__state">
                  <b>Couldn't load the preview</b>
                  <span>{loadErr}</span>
                  <button className="play-btn" onClick={() => { setLoadErr(null); refresh(); }}>Retry</button>
                </div>
              ) : <div className="play-plate__state"><span>Loading the preview…</span></div>}
          </div>
        </div>
        {split.handle}
        <div className="play-chat">
          <div className="play-cap-row"><span className="play-cap">Studio chat</span><span className="play-cap__rule" /></div>
          <div className="play-log" ref={logRef}>
            {msgs.length === 0 && (
              <div className="play-log__empty">
                <b>Nothing built yet</b>
                <span>Describe a change below and the agent will edit the miniapp in place.</span>
              </div>
            )}
            {msgs.map((m, i) => m.role === "tool"
              ? <div key={i} className={`play-tool${m.failed ? " is-failed" : ""}`}>🔧 <b>{m.title}</b></div>
              : <div key={i} className={`play-msg play-msg--${m.role}`}>{m.text}</div>)}
            {busy && <div className="studio-thinking"><span className="dots"><i /><i /><i /></span><span>{working || "working…"}</span></div>}
          </div>
        </div>
      </div>

      <div className="play-composer-in" ref={composerRef}>
        <textarea ref={inputRef} className="play-input play-input--chat" rows={3}
          placeholder="ask the agent to build/edit the miniapp…" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <div className="play-composer-foot">
          <span className="play-composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
          <button className="play-btn play-btn--primary" disabled={busy || !input.trim() || !agentId} onClick={submit}>{busy ? "…" : "Send"}</button>
        </div>
      </div>
    </section>
  );
}
