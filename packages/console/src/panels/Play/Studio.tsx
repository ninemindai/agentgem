// packages/console/src/panels/Play/Studio.tsx
import { useEffect, useRef, useState } from "react";
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute, publishSetupRoute, publishStatusRoute, reviewGroupsRoute, reviewRequestRoute } from "../../api/routes.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { CapabilityStrip } from "./CapabilityStrip.js";
import { RequestReviewModal } from "./RequestReviewModal.js";
import { Runner, type RunnerHandle } from "./Runner.js";
import { openStudioStream } from "./studioStream.js";
import { genre as genreOf, parseGateFailure, fixSealPrompt } from "./playMeta.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import { useGitHubBind } from "../../identity/useGitHubBind.js";
import { ConnectGitHub } from "../../identity/ConnectGitHub.js";
import { useSplit } from "../../shell/useSplit.js";
import { setStudioChat, clearChatId, clearStudioChat } from "./studioChatStore.js";
import { loadStudioSession } from "./studioResume.js";
import { resolvePublishAction, type PublishAction } from "./publishAction.js";
import { parseTags } from "./parseTags.js";

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

// Mirrors the server's 512 KB binary cap (src/og/coverDataUrl.ts's COVER_MAX_BYTES) — checked against
// the base64 data-URL *text* length (~700 KB of base64 ≈ 512 KB decoded), so an oversized cover is
// rejected client-side and never round-trips to /api/publish-setup. Duplicated as a literal rather than
// imported: that file lives in the root package, which @agentgem/console has no workspace dependency on.
const COVER_MAX_DATA_URL_LEN = 700_000;

// Structured chat log entries so we can render bubbles + tool chips instead of one rolling string.
type Msg = { role: "user" | "agent"; text: string } | { role: "tool"; title: string; failed?: boolean };

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
  const [share, setShare] = useState<{ gemUrl: string; cardUrl?: string; message?: string } | null>(null);
  const [pendingPublish, setPendingPublish] = useState(false);   // Share clicked while unbound
  const [pendingVersion, setPendingVersion] = useState<{ latestVersion: string; nextVersion: string; login: string } | null>(null);
  const [scope, setScope] = useState<"public" | "unlisted" | "private">("public");
  const [tags, setTags] = useState("");   // free-form publish tags (comma separated), parsed via parseTags
  // The accepted coverDataUrl, threaded into publish. A ref, not state: it's never rendered, only
  // read inside publishWorkspace — reading it as state there would close over the value as of the
  // render that created the handler (e.g. Use this's onClick), which is stale by one setCover call.
  const coverRef = useRef<string | null>(null);
  // "confirm" = the banner is open, pausing the publish until the author picks a cover (or skips).
  // We ALWAYS enter it once a capture attempt completes — even on failure/oversized — so Upload and
  // Skip (the spec's manual-cover fallback) are reachable regardless of the capture outcome.
  const [coverStage, setCoverStage] = useState<"idle" | "confirm">("idle");
  const [coverPreview, setCoverPreview] = useState<string | null>(null); // an accepted-size capture, shown as the banner thumbnail
  const [captureBusy, setCaptureBusy] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);   // oversized/failed capture note, shown in the banner
  const [pendingReview, setPendingReview] = useState(false);   // Request review clicked while unbound
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewGroups, setReviewGroups] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [reviewGroupId, setReviewGroupId] = useState("");
  const [reviewDescription, setReviewDescription] = useState("");   // optional note to reviewers, sent at submit
  const [reviewSubmitting, setReviewSubmitting] = useState(false);   // in-flight guard: save→publish-status→request chain
  const { status: identity } = useIdentity();
  const runnerRef = useRef<RunnerHandle>(null);
  const closeRef = useRef<null | (() => void)>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [plateMax, setPlateMax] = useState<number | undefined>(undefined);
  const seededRef = useRef(false);   // guards the one-shot seed-prompt auto-send
  const split = useSplit("studio", { initial: 560, min: 360, max: 900, side: "start" });

  // Resume the publish the user already asked for. `login` comes straight from
  // bindComplete — reading it off the refreshed identity context would race the
  // React render that applies the refresh, and resume could see a stale null.
  const bind = useGitHubBind(apiBase, {
    onBound: (login) => {
      if (pendingPublish) { setPendingPublish(false); void checkAndPublish(login); }
      if (pendingReview) { setPendingReview(false); void openReviewGroupPicker(); }
    },
  });

  // Never swallow this: html="" renders as a sealed-but-empty iframe, which reads as a working preview of
  // an empty app rather than as a failure. Keep the last good html on a refresh error — a failed reload
  // after a build shouldn't blank a preview that is still on screen and still correct.
  const refresh = () =>
    playMiniappRoute.call(makeClient(apiBase), { query: { name } })
      .then((r) => { setHtml(r.html); setMeta(r.meta); setLoadErr(null); })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e)));

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    refresh();
    let cancelled = false;
    (async () => {
      const r = await loadStudioSession(apiBase, name);
      if (cancelled) return;
      if (r.msgs.length) setMsgs(r.msgs);
      if (r.chatId) setChatId(r.chatId);
      // eng-review NEW P3: dead session with history → tell the user the old thread is
      // archived and the next message starts fresh, so restored-but-read-only doesn't read as data loss.
      if (!r.chatId && r.msgs.length) setStatus("previous chat archived — a new message starts a fresh session");
      if (r.running) { setBusy(true); setWorking("resuming…"); pollWhileRunning(r.chatId!); }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      closeRef.current?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, name]);

  // Poll /state until the background turn finishes, then refresh history + preview.
  // eng-review C2: cap the poll so a genuinely wedged turn doesn't spin a silent spinner forever —
  // after the cap, surface an actionable "still running — Stop?" instead. Guard against a 2nd loop.
  const POLL_MS = 1500;
  const POLL_MAX = Math.round((10 * 60_000) / POLL_MS); // ~10 min
  function pollWhileRunning(id: string) {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } // never run two loops
    let ticks = 0;
    const tick = async () => {
      try {
        const st = await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}/state`).then((r) => r.ok ? r.json() : { alive: false });
        if (!st.alive || !st.running) {
          setBusy(false); setWorking("");
          const r = await loadStudioSession(apiBase, name);
          setMsgs(r.msgs);
          await refresh();
          return;
        }
      } catch { /* transient — keep polling */ }
      if (++ticks >= POLL_MAX) { setWorking(""); setStatus("agent still running — press Stop to end it"); return; }
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
  }

  // Kick off the build from the blank-tab description: send it as the first chat message, once an agent
  // is ready. One-shot (seededRef) so it never re-fires when the agent list resolves or agent changes.
  useEffect(() => {
    if (seededRef.current || !seedPrompt || !agentId) return;
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

  function changeAgent(nextAgentId: string) {
    if (nextAgentId === agentId) return;
    closeRef.current?.();
    closeRef.current = null;
    setChatId(null);
    setMsgs([]);
    setWorking("");
    setGate(null);
    setShare(null);
    setStatus(chatId ? "switched coding agent; next message starts a new studio chat" : "");
    clearStudioChat(name); // old session belonged to the previous agent; drop the whole pointer
    onAgentIdChange(nextAgentId);
  }

  // eng-review C2/A3 follow-up: let the user free a live-but-idle (or running) session's slot
  // without waiting it out. Keeps sessionId so restored history still renders after stopping.
  async function stop() {
    const id = chatId;
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    closeRef.current?.(); closeRef.current = null;
    setBusy(false); setWorking("");
    setChatId(null);
    clearChatId(name); // keep sessionId so history still renders
    if (id) { try { await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* best-effort */ } }
    setStatus("session stopped");
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !agentId) return;
    setBusy(true); setWorking("thinking…"); setGate(null); setShare(null);
    setMsgs((m) => [...m, { role: "user", text: message }]);
    try {
      let id = chatId;
      if (!id) {
        const res = await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, miniapp: name }) }).then(j);
        id = res.chatId as string; setChatId(id);
        setStudioChat(name, { chatId: id, sessionId: res.sessionId as string, agent: agentId });
      }
      closeRef.current = openStudioStream(apiBase, id, message, {
        onDelta: (t) => { setWorking("responding…"); pushDelta(t); },
        onTool: (tool) => { setWorking(activity(tool)); setMsgs((m) => [...m, { role: "tool", title: tool.title ?? tool.kind ?? "tool", failed: tool.status === "failed" }]); },
        onDone: async () => { setBusy(false); setWorking(""); await refresh(); },
        onFailed: (e) => {
          // A turn stays alive server-side after a stream drop (Task 3). "already running" (another
          // tab/reload owns it) and a transient transport drop ("connection lost", emitted by
          // studioStream.ts's EventSource error handler) both mean: reconcile via /state, don't fail.
          if (id && (/already running/i.test(e) || e === "connection lost")) {
            setWorking("resuming…"); pollWhileRunning(id);
            return;
          }
          setBusy(false); setWorking("");
          setMsgs((m) => [...m, { role: "tool", title: `failed: ${e}`, failed: true }]);
        },
      });
    } catch (e) { setBusy(false); setWorking(""); setStatus(`error: ${(e as Error).message}`); }
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
      const prunedNeeds = (res.prunedNeeds ?? []) as string[];
      setPruned(prunedNeeds);
      const needs = (cur.meta.needs ?? []).filter((n) => !prunedNeeds.includes(n));
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
  async function publishWorkspace(login: string, version: string, visibility: "public" | "unlisted" | "private") {
    setStatus("publishing to app.agentgem.ai…");
    try {
      const g = genreOf(meta?.genre ?? "project-fun");
      const pub = await publishSetupRoute.call(makeClient(apiBase), { body: {
        workspace: name, scope: login, name, version, provenance: "play", visibility,
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun", ...parseTags(tags)],
        coverDataUrl: coverRef.current ?? undefined,
      } });
      // Link the gem's marketplace page (installable / playable), not just the OG teaser card.
      // Unlisted publishes aren't in Explore, so point straight at the playable /games/ link instead.
      // Private publishes aren't Explore-listed OR reachable by a bare /games/ link (owner-only,
      // session-gated) — point at My apps, the only place the owner can find and play it.
      const gemUrl = visibility === "unlisted"
        ? `https://app.agentgem.ai/games/${pub.exploreRef}`
        : visibility === "private"
        ? `https://app.agentgem.ai/my-apps`
        : `https://app.agentgem.ai/gems/${encodeURIComponent(pub.exploreRef)}`;
      const message = visibility === "private" ? "Published privately — find it in My apps." : undefined;
      setShare({ gemUrl, cardUrl: pub.shareUrl, message }); setStatus("");
    } catch (e) {
      const body = (e as Record<string, unknown>).body;
      setStatus(`share failed: ${typeof body === "string" ? body : (e as Error).message}`);
    }
  }

  // Pre-flight + publish, given a verified login. Split out from shareToExplore so the
  // post-connect resume (below) can re-enter the check without re-saving and without
  // reading `identity.login` — see the onBound comment: that context read can race the
  // render that applies the refresh, and resume could see a stale null.
  async function checkAndPublish(login: string) {
    setStatus("checking app.agentgem.ai…");
    let action: PublishAction;
    try {
      const st = await publishStatusRoute.call(makeClient(apiBase), { query: { workspace: name, scope: login, name } });
      action = resolvePublishAction(st);
    } catch (e) {
      setStatus(`could not check for an existing app: ${(e as Error).message}`); return;
    }
    if (action.kind === "publish") { await publishWorkspace(login, action.version, scope); return; }
    if (action.kind === "taken") { setStatus(`“${name}” is already published by another account — choose a different name.`); return; }
    setStatus(""); setPendingVersion({ latestVersion: action.latestVersion, nextVersion: action.nextVersion, login });
  }

  // Accept a captured/uploaded cover only if it's under the client-side cap mirroring the server's
  // (COVER_MAX_BYTES in src/og/coverDataUrl.ts) — an oversized cover is rejected here rather than
  // round-tripping all the way to /api/publish-setup before being rejected there.
  function withinCoverCap(dataUrl: string): boolean {
    if (dataUrl.length > COVER_MAX_DATA_URL_LEN) {
      setCoverError("Cover image is too large (max ~512 KB) — try Re-capture or a smaller upload.");
      return false;
    }
    setCoverError(null);
    return true;
  }

  // Re-capture button in the confirm banner: same one-shot request as the initial capture, but
  // user-triggered and shown busy while in flight. Keeps the banner open (never resumes publish);
  // a within-cap result becomes the new thumbnail, a failed/oversized one clears it and leaves the
  // failure/too-large note so Upload/Skip stay the way forward.
  async function recaptureCover() {
    setCaptureBusy(true);
    const c = await runnerRef.current?.requestCapture();
    setCaptureBusy(false);
    if (c?.ok && c.dataUrl) {
      if (withinCoverCap(c.dataUrl)) setCoverPreview(c.dataUrl);   // good → new thumbnail
      else setCoverPreview(null);                                  // oversized → withinCoverCap set the too-large note
    } else { setCoverPreview(null); setCoverError(null); }         // failed → neutral "couldn't capture" state
  }

  // Close the confirm banner and clear its transient state. Called by every terminal banner action
  // (Use this / Upload / Skip) right before proceedToPublish resumes the paused publish.
  function closeBanner() {
    setCoverStage("idle"); setCoverPreview(null); setCoverError(null);
  }

  // Manual upload: FileReader.readAsDataURL, same as packages/marketplace/src/upload.ts's
  // fileToBase64 — but keeps the FULL data URL (data:type;base64,...) rather than stripping the
  // prefix, since the server (parseImageDataUrl) parses the whole thing. On a within-cap file it
  // accepts the cover, closes the banner, and resumes the paused publish; an oversized file leaves
  // the banner open with the "too large" note (withinCoverCap sets it) so the author can retry.
  function onCoverFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      // Oversized → withinCoverCap sets the too-large note; leave the banner (and any prior capture
      // thumbnail) in place so the author can pick a smaller file, re-capture, or skip.
      if (withinCoverCap(dataUrl)) { coverRef.current = dataUrl; closeBanner(); void proceedToPublish(); }
    };
    reader.onerror = () => setCoverError("Could not read the file.");
    reader.readAsDataURL(file);
  }

  // Resolves the identity gate and publishes. Shared by the confirm banner's Use this/Upload/Skip
  // buttons (once the cover decision is made) — split out so the banner's pause doesn't need its own
  // copy of this gate.
  async function proceedToPublish() {
    if (!(identity?.bound && identity.login)) { setStatus(""); setPendingPublish(true); return; }
    await checkAndPublish(identity.login);
  }

  // Share to Explore (app.agentgem.ai): Save (creates the game-gem workspace + enforces the seal),
  // then request a best-effort screenshot of the sealed preview for the OG card. Whatever the capture
  // yields — a good thumbnail, an oversized frame, or an outright failure (timeout/no-frame/no-canvas)
  // — we ALWAYS open the confirm banner and PAUSE here rather than publishing on the capture result.
  // That keeps the manual Upload/Skip controls reachable in every case (the spec's fallback for a game
  // that can't be auto-captured) and makes the too-large/failed note visible. The banner's buttons are
  // what resume publishing (via proceedToPublish); capture never blocks publish because Skip is always
  // one click away, and a failed capture never aborts the flow.
  async function shareToExplore() {
    setStatus("preparing…"); setShare(null); setPendingVersion(null); coverRef.current = null; setCoverPreview(null); setCoverError(null);
    if (!(await save())) return; // gate failure already surfaced as the banner
    setCaptureBusy(true);
    const cap = await runnerRef.current?.requestCapture();
    setCaptureBusy(false);
    if (cap?.ok && cap.dataUrl) {
      if (withinCoverCap(cap.dataUrl)) setCoverPreview(cap.dataUrl);   // good → thumbnail
      else setCoverPreview(null);                                      // oversized → withinCoverCap set the too-large note
    } else { setCoverPreview(null); setCoverError(null); }             // failed/timeout/no-frame → neutral "couldn't capture" banner
    setCoverStage("confirm"); setStatus("");
  }

  // A latent resume flag that fires on some later, unrelated bind is worse than no
  // resume at all — dropping the banner drops the pending publish with it.
  function dismissConnect() {
    setPendingPublish(false);
    setPendingReview(false);
    bind.reset();
  }

  // Request review: gate on identity first (like shareToExplore), then open the group
  // picker, fetching the group list only once (cached in reviewGroups for the session).
  async function requestReview() {
    setStatus("");
    setReviewOpen(true);   // the modal is the single surface — it shows the connect step when unbound
    if (!(identity?.bound && identity.login)) { setPendingReview(true); return; }
    await openReviewGroupPicker();
  }

  function closeReview() {
    setReviewOpen(false);
    setPendingReview(false);
    bind.reset();   // clear any in-progress connect so reopening starts clean
  }

  async function openReviewGroupPicker() {
    setReviewOpen(true);
    if (reviewGroups != null) return;
    try {
      const r = await reviewGroupsRoute.call(makeClient(apiBase));
      // A lapsed session (local identity still says bound, server session expired) looks
      // identical to a real 0-teams account unless we check `authenticated` — route it into
      // the SAME reconnect flow as the unbound case instead of the "join or create a team"
      // hint, which would be misleading (this isn't a teams problem, it's an auth problem).
      if (!r.authenticated) {
        setPendingReview(true);   // lapsed session → swap the modal to the connect step, don't close it
        return;
      }
      setReviewGroups(r.groups);
    } catch {
      setReviewGroups([]); // degrade to the empty-groups hint rather than hard-failing the picker
    }
  }

  // Submit: save (the archive request builds from the current workspace state), resolve
  // the version the same way publish does, then request review with the chosen group.
  async function submitReview() {
    if (reviewSubmitting) return; // guard double-submit across the multi-step save→request chain
    setReviewSubmitting(true);
    try { await doSubmitReview(); }
    finally { setReviewSubmitting(false); }
  }

  async function doSubmitReview() {
    if (!reviewGroupId || !(identity?.bound && identity.login)) return;
    if (!(await save())) return; // gate failure already surfaced as the banner
    let action: PublishAction;
    try {
      const st = await publishStatusRoute.call(makeClient(apiBase), { query: { workspace: name, scope: identity.login, name } });
      action = resolvePublishAction(st);
    } catch (e) {
      setStatus(`could not check for an existing app: ${(e as Error).message}`); return;
    }
    if (action.kind === "taken") { setStatus(`“${name}” is already published by another account — choose a different name.`); return; }
    const version = action.kind === "publish" ? action.version : action.nextVersion;
    try {
      const r = await reviewRequestRoute.call(makeClient(apiBase), { body: { workspace: name, scope: identity.login, name, version, groupId: reviewGroupId, description: reviewDescription.trim() || undefined } });
      if (r.ok) { setStatus("In review"); setReviewOpen(false); setReviewDescription(""); }
      else setStatus(`review request rejected: ${r.rejected}`);
    } catch (e) {
      setStatus(`review request failed: ${(e as Error).message}`);
    }
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
        {(busy || chatId) && <button className="play-btn play-btn--ghost" onClick={stop} title="kill the agent session">Stop</button>}
        <button className="play-btn play-btn--ghost" onClick={pushGit} title="git push the miniapps registry to your git remote">Push to git</button>
        <input className="play-tags-input" type="text" aria-label="tags" placeholder="tags, comma separated"
          value={tags} onChange={(e) => setTags(e.target.value)} />
        <div className="play-scope" role="radiogroup" aria-label="Sharing scope">
          <button type="button" className={`play-btn ${scope === "public" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "public"} onClick={() => setScope("public")}>Public</button>
          <button type="button" className={`play-btn ${scope === "unlisted" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "unlisted"} onClick={() => setScope("unlisted")}>Unlisted</button>
          <button type="button" className={`play-btn ${scope === "private" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "private"} onClick={() => setScope("private")}>Private</button>
        </div>
        <button className="play-btn play-btn--primary" onClick={shareToExplore}>Share to app.agentgem.ai</button>
        <button className="play-btn play-btn--ghost" onClick={requestReview}>Request review</button>
      </div>

      <CapabilityStrip needs={meta?.needs} pruned={pruned} />

      {share && (
        <div className="play-banner play-banner--ok">
          <span className="play-banner__ico">🌐</span>
          <div className="play-banner__body">
            <div className="play-banner__title">{share.message ?? "Published to app.agentgem.ai"}</div>
            <div className="play-banner__detail">{share.gemUrl}{share.cardUrl ? ` · share card: ${share.cardUrl}` : ""}</div>
          </div>
          <button className="play-btn" onClick={() => navigator.clipboard?.writeText(share.gemUrl)}>Copy</button>
          <button className="play-btn play-btn--ghost" onClick={() => window.open(share.gemUrl, "_blank", "noopener")}>Open</button>
        </div>
      )}
      {pendingVersion && (
        <div className="play-banner">
          <span className="play-banner__ico">📦</span>
          <div className="play-banner__body">
            <div className="play-banner__title">“{name}” is already published (v{pendingVersion.latestVersion})</div>
            <div className="play-banner__detail">Publish a new version, or overwrite the current one.</div>
          </div>
          <button className="play-btn play-btn--primary" onClick={() => { const p = pendingVersion; setPendingVersion(null); void publishWorkspace(p.login, p.nextVersion, scope); }}>Publish v{pendingVersion.nextVersion}</button>
          <button className="play-btn play-btn--ghost" onClick={() => { const p = pendingVersion; setPendingVersion(null); void publishWorkspace(p.login, p.latestVersion, scope); }}>Overwrite v{pendingVersion.latestVersion}</button>
        </div>
      )}
      {coverStage === "confirm" && (
        <div className="play-banner">
          <span className="play-banner__ico">🖼️</span>
          {coverPreview && (
            <img src={coverPreview} alt="captured cover preview" style={{ width: 96, height: 60, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />
          )}
          <div className="play-banner__body">
            <div className="play-banner__title">{coverPreview ? "Use this as the share card cover?" : "Add a share card cover?"}</div>
            <div className="play-banner__detail">{coverPreview
              ? (coverError ?? "Captured from the preview — swap it for your own image, or skip it for a plain card.")
              : (coverError ?? "Couldn't capture a screenshot — upload an image or skip for a plain card.")}</div>
          </div>
          {coverPreview && (
            <button className="play-btn play-btn--primary" onClick={() => { coverRef.current = coverPreview; closeBanner(); void proceedToPublish(); }}>Use this</button>
          )}
          <button className="play-btn play-btn--ghost" disabled={captureBusy} onClick={recaptureCover}>{captureBusy ? "Capturing…" : "Re-capture"}</button>
          <label className="play-btn play-btn--ghost" style={{ cursor: "pointer" }}>
            Upload
            <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={onCoverFile} />
          </label>
          <button className="play-btn play-btn--ghost" onClick={() => { coverRef.current = null; closeBanner(); void proceedToPublish(); }}>Skip</button>
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
      {reviewOpen && (
        <RequestReviewModal
          connect={pendingReview ? (
            <ConnectGitHub
              bind={bind}
              idleLabel="Connect GitHub to continue"
              idleHint={<p className="review-modal__hint">The review request continues automatically once you authorize.</p>}
            />
          ) : undefined}
          groups={reviewGroups}
          groupId={reviewGroupId}
          onGroupId={setReviewGroupId}
          description={reviewDescription}
          onDescription={setReviewDescription}
          onSubmit={submitReview}
          onClose={closeReview}
          submitting={reviewSubmitting}
        />
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
            {html ? <Runner ref={runnerRef} html={html} name={name} apiBase={apiBase} needs={meta?.needs} maxHeight={plateMax} />
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
