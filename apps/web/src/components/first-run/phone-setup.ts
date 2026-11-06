import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthSessionSummary } from "@opensteer/core";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import type {
  DeploymentAccessSnapshot,
  DesktopPersonalAccountLinkStatus,
} from "@opensteer/protocol/desktop";
import {
  requestPersonalRemoteAccess,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import type { usePersonalRemoteAccess } from "@opensteer/client/react";
import type { PersonalAccountLinkController } from "../../account/use-personal-account-link.js";
import { actionErrorMessage } from "../../ui-utils.js";

/**
 * Reaching this computer from a phone, in the order it has to be true: the
 * computer is linked to the person's Opensteer Account, remote access is on
 * through Opensteer Connect, and Connect has published a route. The phone then
 * signs in to the same Account and opens this computer from its list.
 *
 * `phoneReach` is the whole decision, read from live state every time, so a
 * step finished in Settings, on another device, or before a restart is simply
 * skipped. The hook below only runs the one step it names next.
 */
export type PhoneReach =
  /** Not offered here: no Account, no Connect, or no address for the link. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "checking" }
  | { readonly kind: "needs-link" }
  | { readonly kind: "needs-connect" }
  /** Connect is on; its route is still being published. */
  | { readonly kind: "publishing" }
  /** Remote access runs over a private network, which this flow leaves alone. */
  | { readonly kind: "private-network" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "reachable"; readonly url: string };

export interface PhoneReachFacts {
  readonly accountAvailable: boolean;
  readonly deploymentId: string | null;
  readonly link: DesktopPersonalAccountLinkStatus["status"] | null;
  readonly portalOrigin: string | null;
  readonly remote: PersonalRemoteAdministrationStatus | null;
  /** The status read failed: not this person's to administer, or the Host is away. */
  readonly remoteUnreadable: boolean;
}

export function phoneReach(facts: PhoneReachFacts): PhoneReach {
  if (!facts.accountAvailable || !facts.portalOrigin || !facts.deploymentId) {
    return { kind: "unavailable" };
  }
  if (facts.remoteUnreadable) return { kind: "unavailable" };
  if (!facts.remote || facts.link === null) return { kind: "checking" };
  if (facts.remote.accountIssuer === null || facts.link === "unavailable") {
    return { kind: "unavailable" };
  }
  if (facts.link === "linked-elsewhere") {
    return {
      kind: "blocked",
      message: "This computer is in a different Opensteer account.",
    };
  }
  if (facts.link === "needs-repair") {
    return {
      kind: "blocked",
      message: "This computer’s account link needs repair in Settings.",
    };
  }
  if (facts.link === "unlinking") return { kind: "checking" };
  const { access } = facts.remote;
  if (facts.link !== "linked" || access.accountLink?.state !== "active") {
    return { kind: "needs-link" };
  }
  if (access.mode === "private") return { kind: "private-network" };
  if (access.mode !== "connect") return { kind: "needs-connect" };
  if (access.route === null) return { kind: "publishing" };
  return { kind: "reachable", url: phoneOpenUrl(facts.portalOrigin, facts.deploymentId) };
}

/**
 * The address the code carries: only this computer's id, in the fragment, so
 * it never reaches a server log. The phone still signs in to the Account to
 * get in; the id only says which computer to open.
 */
export function phoneOpenUrl(portalOrigin: string, deploymentId: string): string {
  return `${new URL(portalOrigin).origin}/open#d=${encodeURIComponent(deploymentId)}`;
}

/** How long a Connect request may take before the row stops waiting on it. */
const connectSettleMilliseconds = 2 * 60_000;

export type PhoneSetupPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "linking" }
  /** The link answered; waiting for the state this hook reads to say so too. */
  | { readonly kind: "linked" }
  | { readonly kind: "connecting"; readonly operationId: string | null }
  | { readonly kind: "failed"; readonly message: string };

export interface PhoneSetup {
  readonly cancel: () => void;
  readonly phase: PhoneSetupPhase;
  readonly reach: PhoneReach;
  readonly start: () => void;
  /** Whether the person asked to add a phone in this visit. */
  readonly started: boolean;
}

/**
 * Runs the next missing step while the person has asked for a phone, and only
 * then. Cancelling stops the steps that have not started; it does not undo
 * one that already finished, because a link or a Connect route is a real
 * setting the person can see and change in Settings.
 */
export function usePhoneSetup(input: {
  readonly deploymentAccess: DeploymentAccessSnapshot | null;
  readonly deploymentId: string | null;
  readonly hostClient: HostClient;
  readonly link: PersonalAccountLinkController;
  readonly portalOrigin: string | null;
  /** The caller's own observation, so one screen reads remote access once. */
  readonly remote: ReturnType<typeof usePersonalRemoteAccess>;
}): PhoneSetup {
  const { deploymentAccess, deploymentId, hostClient, link, portalOrigin, remote } = input;
  const reach = useMemo(
    () =>
      phoneReach({
        accountAvailable: deploymentAccess?.account.available ?? false,
        deploymentId,
        link: link.status?.status ?? null,
        portalOrigin,
        remote: remote.status,
        remoteUnreadable: remote.status === null && remote.error !== null,
      }),
    [
      deploymentAccess?.account.available,
      deploymentId,
      link.status?.status,
      portalOrigin,
      remote.error,
      remote.status,
    ],
  );
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<PhoneSetupPhase>({ kind: "idle" });
  // Each start is one attempt; a cancel or a newer start leaves an older
  // attempt's late answers with nothing to change.
  const attempt = useRef(0);

  const start = useCallback(() => {
    attempt.current += 1;
    setStarted(true);
    setPhase({ kind: "idle" });
  }, []);
  const cancel = useCallback(() => {
    attempt.current += 1;
    setStarted(false);
    setPhase({ kind: "idle" });
  }, []);

  // Run the one step the live state asks for next.
  useEffect(() => {
    if (!started || phase.kind !== "idle") return;
    const current = attempt.current;
    if (reach.kind === "needs-link") {
      if (!link.canLink) return;
      setPhase({ kind: "linking" });
      void link.link().then(
        (outcome) => {
          if (attempt.current !== current) return;
          // The link's own answer can arrive before the snapshot this hook
          // reads catches up; linking again then would open a second sign-in.
          setPhase(
            outcome.succeeded ? { kind: "linked" } : { kind: "failed", message: outcome.message },
          );
        },
        (reason: unknown) => {
          if (attempt.current !== current) return;
          setPhase({ kind: "failed", message: actionErrorMessage(reason) });
        },
      );
      return;
    }
    // A private network in use is replaced only because the person chose
    // Connect and confirmed it; starting is that choice.
    if (reach.kind === "needs-connect" || reach.kind === "private-network") {
      setPhase({ kind: "connecting", operationId: null });
      void requestPersonalRemoteAccess(hostClient, {
        action: "configure",
        mode: "connect",
        privateOrigin: null,
      }).then(
        (operation) => {
          if (attempt.current !== current) return;
          setPhase({ kind: "connecting", operationId: operation.id });
        },
        (reason: unknown) => {
          if (attempt.current !== current) return;
          setPhase({ kind: "failed", message: actionErrorMessage(reason) });
        },
      );
    }
  }, [hostClient, link, phase.kind, reach.kind, started]);

  // A Connect request settles when the Host reports its operation finished
  // and the route it publishes is in place.
  const operationId = phase.kind === "connecting" ? phase.operationId : null;
  const operation = remote.status?.operation ?? null;
  useEffect(() => {
    if (phase.kind === "linked" && reach.kind !== "needs-link") setPhase({ kind: "idle" });
  }, [phase.kind, reach.kind]);
  useEffect(() => {
    if (phase.kind !== "connecting") return;
    if (reach.kind === "reachable") {
      setPhase({ kind: "idle" });
      return;
    }
    if (operationId !== null && operation?.id === operationId && operation.state === "failed") {
      setPhase({
        kind: "failed",
        message: operation.detail ?? "Remote access couldn’t be turned on. Try again.",
      });
    }
  }, [operation, operationId, phase.kind, reach.kind]);
  useEffect(() => {
    if (phase.kind !== "connecting" && phase.kind !== "linked") return;
    const current = attempt.current;
    const timer = setTimeout(() => {
      if (attempt.current !== current) return;
      setPhase({
        kind: "failed",
        message: "Remote access is taking longer than expected. Try again.",
      });
    }, connectSettleMilliseconds);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  return { cancel, phase, reach, start, started };
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

/** What the Connect panel is doing, while it is doing it. */
export function phoneStepDetail(
  phone: Pick<PhoneSetup, "phase" | "reach">,
  account: string | null,
): string {
  if (
    phone.phase.kind === "linking" ||
    phone.phase.kind === "linked" ||
    phone.reach.kind === "needs-link"
  ) {
    return account === "authorizing"
      ? "Finish signing in in your browser"
      : "Adding this computer to your account…";
  }
  if (
    phone.phase.kind === "connecting" ||
    phone.reach.kind === "needs-connect" ||
    phone.reach.kind === "publishing"
  ) {
    return "Turning on Opensteer Connect…";
  }
  return "Checking…";
}
