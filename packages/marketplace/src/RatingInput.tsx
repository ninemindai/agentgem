import { useState } from "react";

// Accessible 1-5 star picker: role="radiogroup" with roving tabindex, arrow keys / number keys
// set the value, hover/focus previews the fill. `value` 0 means "unset".
export function RatingInput({ value, onChange, label = "Your rating" }: {
  value: number; onChange: (n: number) => void; label?: string;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange(Math.min(5, (value || 0) + 1) || 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange(Math.max(1, (value || 1) - 1)); }
    else if (/^[1-5]$/.test(e.key)) { e.preventDefault(); onChange(Number(e.key)); }
  };

  return (
    <div className="ex-rating-input" role="radiogroup" aria-label={label} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          tabIndex={value === n || (value === 0 && n === 1) ? 0 : -1}
          className={"ex-rating-star" + (n <= shown ? " is-on" : "")}
          onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)}
          onClick={() => onChange(n)} onKeyDown={onKey}>
          {n <= shown ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}
