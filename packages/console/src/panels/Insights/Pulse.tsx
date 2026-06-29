import type { AggOverview } from "../../api/routes.js";
import { verifiedShare } from "./data.js";

export function Pulse({ data, loading }: { data: AggOverview | null; loading: boolean }) {
  if (loading || !data) return <div className="ins-pulse is-loading">Loading network pulse…</div>;
  if (data.producers === 0) return <div className="ins-pulse is-empty">Not enough producers yet — the network is below the k-anonymity floor.</div>;
  const pct = Math.round(verifiedShare(data.producers, data.verifiedProducers) * 100);
  return (
    <div className="ins-pulse">
      <span className="ins-pulse-label">Network pulse</span>
      <strong className="ins-stat">{data.ingredients.toLocaleString()}</strong><span className="ins-stat-unit">ingredients</span>
      <strong className="ins-stat">{data.producers.toLocaleString()}</strong><span className="ins-stat-unit">producers</span>
      <span className="ins-pulse-verified">{data.verifiedProducers.toLocaleString()} verified ✓ · {pct}%</span>
      <span className="ins-vshare ins-vshare-lg"><span className="ins-vshare-fill" style={{ width: `${pct}%` }} /></span>
      <span className="ins-stat-unit">{data.invocations.toLocaleString()} invocations</span>
    </div>
  );
}
