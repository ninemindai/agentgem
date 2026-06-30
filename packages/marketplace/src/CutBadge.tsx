import { cutMeta } from "./gems/cuts";

/** A gemstone-colored pill for a gem's cut. Renders nothing for an unknown/absent cut. */
export function CutBadge({ cut }: { cut?: string }) {
  const m = cutMeta(cut);
  if (!m) return null;
  return (
    <span className="ex-cut" style={{ background: m.bg, color: m.fg }} title={`${m.gemstone} · ${m.label}`}>
      {m.label}
    </span>
  );
}
