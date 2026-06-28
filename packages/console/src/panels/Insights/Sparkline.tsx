import { sparkPoints } from "./data.js";

/** Hand-rolled SVG line chart. Producers in terracotta; optional verified overlay in
 *  emerald, drawn on the producers' scale (verified <= producers). No dependencies. */
export function Sparkline({ values, verified, width = 220, height = 48 }: {
  values: number[]; verified?: number[]; width?: number; height?: number;
}) {
  if (values.length === 0) return <div className="ins-spark-empty">no data yet</div>;
  const max = Math.max(1, ...values);
  return (
    <svg className="ins-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="adoption trend">
      <polyline points={sparkPoints(values, width, height, max)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {verified && verified.length > 0 && (
        <polyline points={sparkPoints(verified, width, height, max)} fill="none" stroke="var(--emerald)" strokeWidth="1.5" strokeDasharray="3 2" strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}
