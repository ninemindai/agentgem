import { useState } from "react";

// The mint state machine shared by every "create a hosted share" button
// (Mine's certificate, QuickShareButton's gem): a busy spinner, a ~3s
// "waking the server" cold-start hint for the hosted backend, and error
// capture. `run` wraps the async mint and returns its result, or undefined
// if it threw (the message is surfaced via `err`).
export function useShareMint() {
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async <T>(mint: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setErr(null); setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), 3000);
    try {
      return await mint();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create a share link — try again.");
      return undefined;
    } finally {
      clearTimeout(slowTimer); setBusy(false); setSlow(false);
    }
  };

  return { busy, slow, err, run };
}
