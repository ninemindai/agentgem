import type { RubricCheck } from "./types";

/** Compact ring showing how many rubric checks pass (of total). Brand-green fill on a neutral track. */
export function RubricRing({ checks }: { checks: RubricCheck[] }) {
  const total = checks.length;
  const pass = checks.filter((c) => c.pass).length;
  const pct = total ? Math.round((pass / total) * 100) : 0;
  const label = `${pass} of ${total} checks pass`;
  return (
    <span
      className="ex-rubric-ring"
      title={label}
      aria-label={label}
      style={{ background: `conic-gradient(#3a7d44 ${pct}%, #e6e8eb ${pct}%)` }}
    >
      <span className="ex-rubric-ring-num">{pass}/{total}</span>
    </span>
  );
}
