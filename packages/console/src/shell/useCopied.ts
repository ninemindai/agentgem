import { useState } from "react";

/** One-shot "Copied ✓" feedback for copy-to-clipboard buttons: `copy(text)` writes to
 *  the clipboard and flips `copied` true for `ms` (default 1.6s), then back to false. */
export function useCopied(ms = 1600) {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), ms);
  };
  return { copied, copy };
}
