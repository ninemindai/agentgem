import { useEffect, useState } from "react";
import { makeClient, reviewInboxRoute } from "../../api/routes.js";

/** Exported so the test can reference the interval without waiting on it for real. */
export const REVIEW_POLL_MS = 45_000;

interface ReviewRequestSummary { unread: boolean }

// Drives the unread-count pill on the Reviews nav item (wired via ConsolePage.badge).
// Polls the inbox on mount + every REVIEW_POLL_MS, following the NotificationsProvider
// setInterval/alive idiom. Best-effort: a failed poll just leaves the last count in place.
export function ReviewBadge({ apiBase }: { apiBase: string }) {
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

  if (count === 0) return null;
  return <span className="nav-badge">{count}</span>;
}
