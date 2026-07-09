// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The GitHub device-flow, once. Flow state is per-consumer (a Studio banner and a
// Settings row must not share a spinner), so this is a hook — not context. Status
// lives in IdentityProvider; on success we refresh it so every consumer converges.
import { useCallback, useState } from "react";
import { bindStartRoute, bindCompleteRoute, makeClient } from "../api/routes.js";
import { useIdentity } from "./IdentityProvider.js";

// The aggregator returns machine-readable rejection slugs; turn them into guidance.
// `unknown-producer` is the common one on a fresh key — the bind requires you to
// have produced (shared/published) at least once before an identity can be linked.
export function rejectionMessage(slug: string): string {
  switch (slug) {
    case "unknown-producer":
      return "Publish or share a Gem first — verification links your GitHub to an identity that has already produced something.";
    case "bad-signature":
      return "Verification failed a signature check. Please try Connect again.";
    case "stale":
      return "The verification request expired. Please try Connect again.";
    case "provider-error":
      return "Couldn't reach GitHub just now. Please try again in a moment.";
    case "not-configured":
      return "Identity verification isn't configured on this server.";
    default:
      return `Verification failed: ${slug}`;
  }
}

export type BindFlow = { userCode: string; openUrl: string; deviceCode: string; interval?: number };

export type GitHubBind = {
  flow: BindFlow | null;
  unconfigured: boolean;
  connectBusy: boolean;
  polling: boolean;
  codeCopied: boolean;
  error: string | null;
  connect: () => Promise<void>;
  copyOpenAndWait: () => Promise<void>;
  reset: () => void;
};

export function useGitHubBind(apiBase: string, opts: { onBound?: (login: string) => void } = {}): GitHubBind {
  const { refresh } = useIdentity();
  const [flow, setFlow] = useState<BindFlow | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => { setFlow(null); setError(null); setUnconfigured(false); }, []);

  // Step 1: mint the device code and show it. Deliberately does NOT poll and does NOT
  // open a browser yet — both happen in copyOpenAndWait, so the code being polled and
  // the code the user authorizes are always the same, and the ~5-min poll window
  // aligns with the moment they actually go to authorize.
  const connect = useCallback(async () => {
    setError(null); setUnconfigured(false); setFlow(null); setConnectBusy(true);
    try {
      const r = await bindStartRoute.call(makeClient(apiBase), { body: {} });
      if (!r.configured) { setUnconfigured(true); return; }
      setFlow({
        userCode: r.userCode!,
        openUrl: r.verificationUriComplete ?? r.verificationUri!,
        deviceCode: r.deviceCode!,
        interval: r.interval,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub — try again.");
    } finally {
      setConnectBusy(false);
    }
  }, [apiBase]);

  // Step 2: copy the code, open GitHub in the system browser, then poll. The long-poll
  // resolves once the user authorizes there.
  const copyOpenAndWait = useCallback(async () => {
    if (!flow || polling) return;
    void navigator.clipboard?.writeText(flow.userCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 1500);
    window.open(flow.openUrl, "_blank", "noopener"); // desktop: main.ts routes to the system browser
    setError(null);
    setPolling(true);
    try {
      const res = await bindCompleteRoute.call(makeClient(apiBase), { body: { deviceCode: flow.deviceCode, interval: flow.interval } });
      if (res.bound) {
        setFlow(null);
        await refresh();
        // Pass login straight through: reading it back off the refreshed context would
        // race the render that applies it, so a resuming caller could see a stale null.
        opts.onBound?.(res.login!);
      } else {
        // Leave the flow up: a rejection is retryable with the same code.
        setError(rejectionMessage(res.rejected!));
      }
    } catch (e) {
      // Any thrown error (network, expired/denied device code) must surface, not vanish.
      setError(e instanceof Error ? e.message : "Couldn't reach GitHub — try again.");
    } finally {
      setPolling(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, flow, polling, refresh]);

  return { flow, unconfigured, connectBusy, polling, codeCopied, error, connect, copyOpenAndWait, reset };
}
