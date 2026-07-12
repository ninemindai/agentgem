import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import {
  makeClient,
  reviewInboxRoute, reviewGetRoute, reviewApproveRoute, reviewChangesRoute,
  reviewWithdrawRoute, reviewMessageRoute, reviewInstallRoute, reviewResubmitRoute, reviewPlayRoute,
} from "../../api/routes.js";
import { ReviewBadge } from "./badge.js";
import { PlayModal } from "./PlayModal.js";

// The list-item and detail shapes are z.any() on the wire (routes.ts) — real fields come from
// ReviewRequestSummary/ReviewRequestDetail (packages/aggregator/src/reviewStaging.ts). Narrowed
// here so the panel isn't reading `any` everywhere.
interface ReviewRequestSummary {
  id: string; groupName: string; gemKey: string; version: string;
  authorLogin: string | null; status: string; description: string | null;
  createdAtMs: number; messageCount: number; unread: boolean;
}
interface ReviewMessage { id: string; authorLogin: string | null; body: string; createdAtMs: number }
interface ReviewRequestDetail {
  id: string; gemKey: string; version: string; authorLogin: string | null;
  status: string; description: string | null; manifest: unknown; messages: ReviewMessage[];
}

const ageLabel = (ms: number): string => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

function RequestDetail({
  apiBase, summary, onChanged,
}: { apiBase: string; summary: ReviewRequestSummary; onChanged: (notice?: string) => void }) {
  const { status: identity } = useIdentity();
  const [detail, setDetail] = useState<ReviewRequestDetail | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installConsent, setInstallConsent] = useState(false);
  const [installWorkspace, setInstallWorkspace] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [playBusy, setPlayBusy] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const [playHtml, setPlayHtml] = useState<string | null>(null);

  const load = () => {
    setDetail(null);
    setError(null);
    reviewGetRoute
      .call(makeClient(apiBase), { query: { requestId: summary.id } })
      .then((r) => setDetail((r.request as ReviewRequestDetail) ?? null))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(load, [apiBase, summary.id]);

  // Role selection: author-only actions (Withdraw/Resubmit) vs reviewer actions (Approve/Request
  // changes), keyed on the stable login identity — an author stays the author even if their session
  // has lapsed. Session-freshness is NOT gated here: a stale session's action call fails auth
  // server-side (and surfaces a reject), rather than us guessing at ownership from a display flag.
  // (bound stays true through a lapse — only sessionActive flips — so bound is the wrong signal here.)
  const isAuthor = Boolean(identity?.login) && identity?.login === summary.authorLogin;

  // `label` becomes the confirmation banner text once the action succeeds. The request
  // drops out of listInbox right after (status leaves open/changes-requested) and this
  // detail unmounts with it, so the confirmation is handed up to the parent (onChanged)
  // rather than rendered here — it must survive the row vanishing.
  const runAction = (action: () => Promise<{ ok: boolean; rejected?: string; gemKey?: string; version?: string }>, label: string) => {
    setBusy(true);
    setError(null);
    action()
      .then((r) => {
        if (!r.ok) { setError(r.rejected ?? "action rejected"); return; }
        load();
        const target = r.gemKey && r.version ? `${r.gemKey}@${r.version}` : `${summary.gemKey}@${summary.version}`;
        onChanged(`${label} ${target}`);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const sendComment = () => {
    const body = comment.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    reviewMessageRoute
      .call(makeClient(apiBase), { body: { requestId: summary.id, body } })
      .then((r) => {
        if (!r.ok) { setError(r.rejected ?? "action rejected"); return; }
        setComment("");
        load();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!detail && !error) return <p className="ledger-empty">Loading…</p>;
  if (!detail) return <p className="ledger-error" role="alert">{error}</p>;

  // Install-to-test: all gem types install to a local workspace in this MVP (routing game gems to
  // the miniapp player is a documented follow-on, not done here). The server 409s with
  // consent_required when the gem has executable artifacts — flip to a confirm and retry with
  // consent:true; a 404 means the staged archive expired.
  const install = (consent?: boolean) => {
    setInstallBusy(true);
    setInstallError(null);
    reviewInstallRoute
      .call(makeClient(apiBase), { body: consent ? { requestId: summary.id, consent: true } : { requestId: summary.id } })
      .then((r) => { setInstallWorkspace(r.workspace); setInstallConsent(false); })
      .catch((e) => {
        const status = e && typeof e === "object" && "status" in e ? (e as { status?: number }).status : undefined;
        if (!consent && status === 409) { setInstallConsent(true); return; }
        if (status === 404) { setInstallError("archive no longer available"); return; }
        setInstallError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setInstallBusy(false));
  };

  // Play-to-test: game/miniapp gems can't be meaningfully tested by installing them to a workspace, so a
  // staged game gets a sealed-play modal instead of Install. `manifest` is z.any() on the wire — narrow
  // just the field this needs.
  const manifest = detail.manifest as { artifactKinds?: unknown } | null;
  const isGame = Array.isArray(manifest?.artifactKinds) && manifest.artifactKinds.includes("game");
  const play = () => {
    setPlayBusy(true);
    setPlayError(null);
    reviewPlayRoute
      .call(makeClient(apiBase), { body: { requestId: summary.id } })
      .then((r) => setPlayHtml(r.html))
      .catch((e) => {
        const status = e && typeof e === "object" && "status" in e ? (e as { status?: number }).status : undefined;
        if (status === 404) { setPlayError("archive no longer available"); return; }
        setPlayError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPlayBusy(false));
  };

  // Resubmit (author only, changes-requested only): re-runs Studio's request build path against the
  // existing requestId. MVP gate: derive scope/name from gemKey and assume the local workspace name
  // matches (Studio's request always builds gemKey as `${scope}/${workspace}`, see Studio.tsx) — if
  // that workspace is gone locally, the server call fails and we hint at reopening it in Studio.
  const [gemScope, gemName] = detail.gemKey.split("/");
  const canResubmit = isAuthor && detail.status === "changes-requested" && Boolean(gemScope && gemName);
  const resubmit = () => runAction(() =>
    reviewResubmitRoute
      .call(makeClient(apiBase), { body: { workspace: gemName, scope: gemScope, name: gemName, version: detail.version, requestId: summary.id } })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`${msg} — reopen this gem in Studio to resubmit.`);
      }),
  "Resubmitted");

  return (
    <div className="review-detail">
      <div className="analyze-row-head">
        <span className="analyze-name">{detail.gemKey}@{detail.version}</span>
        <span className="ws-chip">{detail.status}</span>
      </div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        {detail.authorLogin ?? "unknown"} · {summary.groupName}
      </div>
      {detail.description && <p>{detail.description}</p>}

      <ul className="analyze-list" style={{ marginTop: 12 }}>
        {detail.messages.map((m) => (
          <li key={m.id} className="analyze-row" style={{ display: "block" }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{m.authorLogin ?? "unknown"} · {ageLabel(m.createdAtMs)}</div>
            <div>{m.body}</div>
          </li>
        ))}
        {detail.messages.length === 0 && <li className="ledger-empty">No messages yet.</li>}
      </ul>

      {error && <p className="ledger-error" role="alert">{error}</p>}

      <div className="run-status" style={{ marginTop: 12, gap: 8 }}>
        <input
          className="ledger-search"
          type="text"
          placeholder="Add a comment…"
          aria-label="comment"
          value={comment}
          disabled={busy}
          style={{ flex: 1, marginBottom: 0 }}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendComment(); } }}
        />
        <button type="button" className="ledger-view" disabled={busy || !comment.trim()} onClick={sendComment}>Comment</button>
      </div>

      <div className="run-status" style={{ marginTop: 12, gap: 8 }}>
        {isAuthor ? (
          <>
            <button type="button" className="ledger-view" disabled={busy} onClick={() => runAction(() => reviewWithdrawRoute.call(makeClient(apiBase), { body: { requestId: summary.id } }), "Withdrew")}>
              Withdraw
            </button>
            {canResubmit && (
              <button type="button" className="ledger-view" disabled={busy} onClick={resubmit}>
                Resubmit
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="ledger-view" disabled={busy} onClick={() => runAction(() => reviewApproveRoute.call(makeClient(apiBase), { body: { requestId: summary.id } }), "Approved")}>
              Approve
            </button>
            <button type="button" className="ledger-view" disabled={busy} onClick={() => runAction(() => reviewChangesRoute.call(makeClient(apiBase), { body: { requestId: summary.id } }), "Requested changes on")}>
              Request changes
            </button>
          </>
        )}
      </div>

      <div className="run-status" style={{ marginTop: 12, gap: 8 }}>
        {isGame ? (
          <button type="button" className="ledger-view" disabled={playBusy} onClick={play}>
            {playBusy ? "Loading…" : "Play to test"}
          </button>
        ) : installWorkspace ? (
          <span className="getgems-done">Installed to workspace <code>{installWorkspace}</code></span>
        ) : installConsent ? (
          <span className="getgems-consent">
            This gem runs executable artifacts — install anyway?
            <button type="button" className="ledger-sort" disabled={installBusy} onClick={() => install(true)}>Install anyway</button>
            <button type="button" className="ledger-sort" onClick={() => setInstallConsent(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="ledger-view" disabled={installBusy} onClick={() => install()}>
            {installBusy ? "Installing…" : "Install to test"}
          </button>
        )}
        {isGame ? (playError && <span className="ledger-error" role="alert">{playError}</span>)
          : (installError && <span className="ledger-error" role="alert">{installError}</span>)}
      </div>
      {playHtml != null && (
        <PlayModal html={playHtml} gemKey={detail.gemKey} version={detail.version} onClose={() => setPlayHtml(null)} />
      )}
    </div>
  );
}

export function Reviews({ apiBase }: { apiBase: string }) {
  const [requests, setRequests] = useState<ReviewRequestSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Transient success confirmation: the acted-on request drops out of listInbox right
  // after (status leaves open/changes-requested), so its detail unmounts with no other
  // trace the action even happened. Lives here (not in RequestDetail) so it survives
  // that unmount, and clears itself after a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current); }, []);

  const load = () => {
    reviewInboxRoute
      .call(makeClient(apiBase))
      .then((r) => setRequests(r.requests as ReviewRequestSummary[]))
      .catch(() => setRequests([]));
  };

  useEffect(load, [apiBase]);

  const onChanged = (msg?: string) => {
    load();
    if (!msg) return;
    setNotice(msg);
    if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = setTimeout(() => setNotice(null), 5000);
  };

  const selectedSummary = requests?.find((r) => r.id === selected) ?? null;

  return (
    <section className="analyze">
      <div className="obs-head"><h2 className="obs-title">Reviews</h2></div>
      <p className="analyze-intro">Gems submitted for review by your teams — comment, approve, request changes, or withdraw.</p>
      {notice && <p className="getgems-done" role="status">{notice}</p>}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 320px", minWidth: 260 }}>
          <div className="run-status" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontWeight: 600 }}>Open requests</span>
            <button type="button" className="ledger-view" onClick={load}>Refresh</button>
          </div>
          <ul className="analyze-list" style={{ maxHeight: 520, overflowY: "auto" }}>
            {requests === null && <li className="ledger-empty">Loading…</li>}
            {requests !== null && requests.length === 0 && (
              <li className="ledger-empty">No open review requests.</li>
            )}
            {(requests ?? []).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={"analyze-row" + (selected === r.id ? " is-active" : "")}
                  style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer" }}
                  onClick={() => setSelected(r.id)}
                >
                  <div className="analyze-row-head">
                    <span className="analyze-name">
                      {r.unread && <span aria-label="unread" title="unread" style={{ marginRight: 6 }}>●</span>}
                      {r.gemKey}@{r.version}
                    </span>
                    <span className="ws-chip">{r.status}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {r.authorLogin ?? "unknown"} · {r.groupName} · {ageLabel(r.createdAtMs)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ flex: "2 1 460px", minWidth: 320 }}>
          {!selectedSummary && <p className="ledger-empty">Select a request to view it.</p>}
          {selectedSummary && (
            <RequestDetail key={selectedSummary.id} apiBase={apiBase} summary={selectedSummary} onChanged={onChanged} />
          )}
        </div>
      </div>
    </section>
  );
}

export const reviewsPage = defineConsolePage({
  id: "reviews",
  title: "Reviews",
  icon: "📝",
  order: 40,
  phase: "build", category: "projects",
  route: "#/reviews",
  component: ({ apiBase }) => <Reviews apiBase={apiBase} />,
  badge: (apiBase) => <ReviewBadge apiBase={apiBase} />,
});
