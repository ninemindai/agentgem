import { useEffect, useState } from "react";
import { makeClient, reviewInboxRoute } from "../../api/routes.js";

/** Exported so the test can reference the interval without waiting on it for real. */
export const REVIEW_POLL_MS = 45_000;

interface ReviewRequestSummary { unread: boolean }

// Drives the review-unread signal: the count pill on the Reviews nav item AND (lifted
// into Shell) the cross-phase indicator on the Build phase switcher, so the signal is
// visible even while the user is in Observe. Polls the inbox on mount + every
// REVIEW_POLL_MS, following the NotificationsProvider setInterval/alive idiom.
// Best-effort: a failed poll just leaves the last count in place.
export function useReviewUnread(apiBase: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;

    const poll = () => {
      reviewInboxRoute
        .call(makeClient(apiBase))
        .then((r) => {
          if (!alive) return;
          const requests = (r.requests as ReviewRequestSummary[]) ?? [];
          setCount(requests.filter((req) => req.unread).length);
        })
        .catch(() => { /* best-effort — a failed poll leaves the count untouched */ });
    };

    poll();
    const h = setInterval(poll, REVIEW_POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase]);

  return count;
}

// Thin consumer of useReviewUnread — the nav-item pill wired via ConsolePage.badge.
export function ReviewBadge({ apiBase }: { apiBase: string }) {
  const count = useReviewUnread(apiBase);
  if (count === 0) return null;
  return <span className="nav-badge">{count}</span>;
}
