import { useEffect, useState } from "react";
import type { AuthSessionSummary } from "@opensteer/core";
import { unwrapRpcResult, type HostClient, type RemoteAccessView } from "@opensteer/client/host";

/**
 * The code a phone scans once Connect is on: only on the person's Account
 * portal, for this computer. Null until then.
 */
export function phoneConnectUrl(
  view: Pick<RemoteAccessView, "state">,
  portalOrigin: string | null,
  deploymentId: string | null,
): string | null {
  if (view.state !== "on-connect" || !portalOrigin || !deploymentId) return null;
  return phoneOpenUrl(portalOrigin, deploymentId);
}

/**
 * The address the code carries: only this computer's id, in the fragment, so
 * it never reaches a server log. The phone still signs in to the Account to
 * get in; the id only says which computer to open.
 */
export function phoneOpenUrl(portalOrigin: string, deploymentId: string): string {
  return `${new URL(portalOrigin).origin}/open#d=${encodeURIComponent(deploymentId)}`;
}

/** How often a visible code checks whether a phone has signed in. */
const phoneSignInCheckMilliseconds = 4_000;

/**
 * The phone that signed in while a code was on screen. Signed-in devices are
 * only a list of logins, not a live connection, so this says what is true —
 * a phone signed in — and only for a login that was not there when the code
 * appeared. It reads only while the code is visible and the window is in
 * front, one read at a time.
 */
export function useNewPhoneSignIn(
  hostClient: HostClient,
  watching: boolean,
): AuthSessionSummary | null {
  const [found, setFound] = useState<AuthSessionSummary | null>(null);
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let baseline: ReadonlySet<string> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        try {
          const { sessions } = unwrapRpcResult(await hostClient.rpc["sessions.list"]({}));
          if (cancelled) return;
          if (baseline === null) {
            baseline = new Set(sessions.map(({ id }) => id));
          } else {
            const fresh = newestNewPhoneSession(sessions, baseline);
            if (fresh) {
              setFound(fresh);
              return;
            }
          }
        } catch {
          // A missed read is retried on the next tick; the code stays usable.
        }
      }
      if (!cancelled) timer = setTimeout(() => void read(), phoneSignInCheckMilliseconds);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hostClient, watching]);
  return found;
}

export function newestNewPhoneSession(
  sessions: readonly AuthSessionSummary[],
  baseline: ReadonlySet<string>,
): AuthSessionSummary | null {
  return (
    sessions
      .filter(
        (session) => !session.current && session.form === "mobile" && !baseline.has(session.id),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
  );
}
