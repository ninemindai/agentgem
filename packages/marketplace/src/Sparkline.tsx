import { sparkPoints } from "./data";

export function Sparkline({ values, verified }: { values: number[]; verified: number[] }) {
  const w = 320, h = 64;
  const max = Math.max(1, ...values, ...verified);
  return (
    <svg className="ex-spark" viewBox={`0 0 ${w} ${h}`} width="100%" height={h} aria-hidden="true">
      <polyline fill="none" stroke="#b4543a" strokeWidth="2" points={sparkPoints(values, w, h, max)} />
      <polyline fill="none" stroke="#3a7d44" strokeWidth="2" strokeDasharray="4 3" points={sparkPoints(verified, w, h, max)} />
    </svg>
  );
}
