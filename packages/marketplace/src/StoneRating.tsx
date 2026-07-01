import { cutMeta } from "./gems/cuts";
import { stoneRating } from "./gems/rating";

const NEUTRAL = { fg: "#8a8f98", bg: "#e6e8eb" };

/** N filled gemstones (of 5) in the cut's color — the gem's Stone rating. */
export function StoneRating({ cut, grade, stars, installs }: { cut?: string; grade?: number; stars: number; installs?: number }) {
  const m = cutMeta(cut);
  const fg = m?.fg ?? NEUTRAL.fg;
  const bg = m?.bg ?? NEUTRAL.bg;
  const n = stoneRating(grade, stars, installs ?? 0);
  const label = `${n} of 5 · ${m?.gemstone ?? "gem"}`;
  return (
    <span className="ex-stones" title={label} aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => {
        const filled = i < n;
        return (
          <span
            key={i}
            data-stone={filled ? "filled" : "empty"}
            className="ex-stone"
            style={{ color: filled ? fg : bg }}
          >
            ◆
          </span>
        );
      })}
    </span>
  );
}
