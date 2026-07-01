import { cutMeta } from "./gems/cuts";
import { stoneRating, isDiamond } from "./gems/rating";

const NEUTRAL = { fg: "#8a8f98", bg: "#e6e8eb" };
const DIAMOND = { fg: "#7fd7ff", bg: "#e8f7ff" }; // crystal-blue apex (cross-type, not a cut color)

/** N filled gemstones (of 5) in the cut's color — the gem's Stone rating. */
export function StoneRating({ cut, grade, stars, installs }: { cut?: string; grade?: number; stars: number; installs?: number }) {
  const m = cutMeta(cut);
  const fg = m?.fg ?? NEUTRAL.fg;
  const bg = m?.bg ?? NEUTRAL.bg;
  const n = stoneRating(grade, stars, installs ?? 0);
  const diamond = isDiamond(grade, stars, installs ?? 0);
  const label = diamond ? `Diamond · apex · ${m?.gemstone ?? "gem"}` : `${n} of 5 · ${m?.gemstone ?? "gem"}`;
  const fillFg = diamond ? DIAMOND.fg : fg;
  const fillBg = diamond ? DIAMOND.bg : bg;
  return (
    <span className={"ex-stones" + (diamond ? " ex-stones--diamond" : "")} data-diamond={diamond ? "true" : undefined} title={label} aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => {
        const filled = diamond || i < n;
        return (
          <span
            key={i}
            data-stone={filled ? "filled" : "empty"}
            className="ex-stone"
            style={{ color: filled ? fillFg : fillBg }}
          >
            {diamond ? "♦" : "◆"}
          </span>
        );
      })}
    </span>
  );
}
