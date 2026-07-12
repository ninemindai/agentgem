import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { useIdentity } from "../../identity/IdentityProvider.js";
import {
  makeClient,
  reviewInboxRoute, reviewGetRoute, reviewApproveRoute, reviewChangesRoute,
  reviewWithdrawRoute, reviewMessageRoute,
} from "../../api/routes.js";

// The list-item and detail shapes are z.any() on the wire (routes.ts) — real fields come from
// ReviewRequestSummary/ReviewRequestDetail (packages/aggregator/src/reviewStaging.ts). Narrowed
// here so the panel isn't reading `any` everywhere.
interface ReviewRequestSummary {
  id: string; groupName: string; gemKey: string; version: string;
  authorLogin: string | null; status: string; description: string | null;
  createdAtMs: number; messageCount: number; unread: boolean;
}
interface ReviewMessage { authorLogin: string | null; body: string; createdAtMs: number }
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
}: { apiBase: string; summary: ReviewRequestSummary; onChanged: () => void }) {
  const { status: identity } = useIdentity();
  const [detail, setDetail] = useState<ReviewRequestDetail | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setDetail(null);
    setError(null);
    reviewGetRoute
      .call(makeClient(apiBase), { query: { requestId: summary.id } })
      .then((r) => setDetail((r.request as ReviewRequestDetail) ?? null))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(load, [apiBase, summary.id]);

  const isAuthor = Boolean(identity?.login) && identity?.login === summary.authorLogin;

  const runAction = (action: () => Promise<{ ok: boolean; rejected?: string }>) => {
    setBusy(true);
    setError(null);
    action()
      .then((r) => {
        if (!r.ok) { setError(r.rejected ?? "action rejected"); return; }
        load();
        onChanged();
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
        {detail.messages.map((m, i) => (
          <li key={i} className="analyze-row" style={{ display: "block" }}>
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
          <button type="button" className="ledger-view" disabled={busy} onClick={() => runAction(() => reviewWithdrawRoute.call(makeClient(apiBase), { body: { requestId: summary.id } }))}>
            Withdraw
          </button>
        ) : (
          <>
            <button type="button" className="ledger-view" disabled={busy} onClick={() => runAction(() => reviewApproveRoute.call(makeClient(apiBase), { body: { requestId: summary.id } }))}>
              Approve
            </button>
            <button type="button" className="ledger-view" disabled={busy} onClick={() => runAction(() => reviewChangesRoute.call(makeClient(apiBase), { body: { requestId: summary.id } }))}>
              Request changes
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function Reviews({ apiBase }: { apiBase: string }) {
  const [requests, setRequests] = useState<ReviewRequestSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => {
    reviewInboxRoute
      .call(makeClient(apiBase))
      .then((r) => setRequests(r.requests as ReviewRequestSummary[]))
      .catch(() => setRequests([]));
  };

  useEffect(load, [apiBase]);

  const selectedSummary = requests?.find((r) => r.id === selected) ?? null;

  return (
    <section className="analyze">
      <div className="obs-head"><h2 className="obs-title">Reviews</h2></div>
      <p className="analyze-intro">Gems submitted for review by your teams — comment, approve, request changes, or withdraw.</p>

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
            <RequestDetail key={selectedSummary.id} apiBase={apiBase} summary={selectedSummary} onChanged={load} />
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
});
