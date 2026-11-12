import { useCallback, useEffect, useRef, useState } from "react";
import { buildMobilePairingDeepLink } from "@opensteer/core";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import type { DesktopTailscaleShareResult } from "@opensteer/protocol/desktop";
import { requestPersonalRemoteAccess, type HostClient } from "@opensteer/client/host";
import type { usePersonalRemoteAccess } from "@opensteer/client/react";
import { actionErrorMessage } from "../../ui-utils.js";

/** How a phone reaches this computer, as the person chooses it. */
export type PhoneConnectionMode = "address" | "connect" | "tailscale";

/** The private address remote access answers on now, or null. */
export function privateRouteOrigin(
  status: PersonalRemoteAdministrationStatus | null,
): string | null {
  const access = status?.access;
  if (access?.mode !== "private" || !access.route) return null;
  return sameOrigin(access.route.document.route.origin);
}

export function sameOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The choice setup opens on: whatever is on now, recognising the tailnet
 * address Opensteer itself shared; otherwise Connect when this build has it,
 * because it needs nothing else.
 */
export function initialPhoneMode(input: {
  readonly connectAvailable: boolean;
  readonly status: PersonalRemoteAdministrationStatus | null;
  readonly tailscaleOrigin: string | null;
}): PhoneConnectionMode {
  const mode = input.status?.access.mode;
  if (mode === "connect" && input.connectAvailable) return "connect";
  if (mode === "private") {
    const origin = privateRouteOrigin(input.status);
    return origin !== null && origin === sameOrigin(input.tailscaleOrigin ?? "")
      ? "tailscale"
      : "address";
  }
  return input.connectAvailable ? "connect" : "tailscale";
}

export type PrivatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "sharing" }
  | { readonly kind: "turning-on"; readonly operationId: string | null; readonly origin: string }
  | { readonly kind: "failed"; readonly message: string };

/** How long turning a private address on may take before the panel stops waiting. */
const settleMilliseconds = 2 * 60_000;

/**
 * Turns on remote access at a private HTTPS address — the tailnet name
 * Opensteer shares, or one the person runs — and then offers a one-time code
 * for the phone. Each press is one attempt; a newer press, or a route that
 * changed elsewhere, leaves an older attempt's late answers with nothing to do.
 */
export function usePrivatePhoneSetup(input: {
  readonly hostClient: HostClient;
  readonly remote: ReturnType<typeof usePersonalRemoteAccess>;
  readonly share: () => Promise<DesktopTailscaleShareResult>;
  /** Whether a private choice is on screen; a code is issued only then. */
  readonly showing: boolean;
}) {
  const { hostClient, remote, share, showing } = input;
  const [phase, setPhase] = useState<PrivatePhase>({ kind: "idle" });
  // The tailnet address this visit shared, known before Tailscale's own
  // status is read again, so the code shows the moment the Host answers there.
  const [sharedOrigin, setSharedOrigin] = useState<string | null>(null);
  const attempt = useRef(0);
  const activeOrigin = privateRouteOrigin(remote.status);
  const generation = remote.status?.access.generation ?? null;
  // Closing setup, or reaching a different Host, ends any attempt in flight.
  useEffect(() => {
    setPhase({ kind: "idle" });
    return () => {
      attempt.current += 1;
    };
  }, [hostClient]);
  // Access as this page last saw it. A share that finishes after access
  // changed elsewhere is not applied. A request that was sent is followed
  // through its own steps instead, such as Connect turning off before the new
  // address turns on.
  const access = `${remote.status?.access.mode ?? ""} ${generation ?? ""} ${activeOrigin ?? ""}`;
  const latestAccess = useRef(access);
  useEffect(() => {
    latestAccess.current = access;
  }, [access]);

  const turnOn = useCallback(
    async (origin: string) => {
      const current = attempt.current;
      const wanted = sameOrigin(origin);
      if (!wanted) {
        setPhase({ kind: "failed", message: "Enter an address that starts with https://" });
        return;
      }
      setPhase({ kind: "turning-on", operationId: null, origin: wanted });
      try {
        const operation = await requestPersonalRemoteAccess(hostClient, {
          action: "configure",
          mode: "private",
          privateOrigin: wanted,
        });
        if (attempt.current !== current) return;
        setPhase({ kind: "turning-on", operationId: operation.id, origin: wanted });
      } catch (reason) {
        if (attempt.current !== current) return;
        setPhase({ kind: "failed", message: actionErrorMessage(reason) });
      }
    },
    [hostClient],
  );

  const turnOnAddress = useCallback(
    (origin: string) => {
      attempt.current += 1;
      void turnOn(origin);
    },
    [turnOn],
  );

  const turnOnTailscale = useCallback(() => {
    attempt.current += 1;
    const current = attempt.current;
    const accessBefore = latestAccess.current;
    const superseded = () => {
      if (latestAccess.current === accessBefore) return false;
      setPhase({ kind: "idle" });
      return true;
    };
    setPhase({ kind: "sharing" });
    void share().then(
      (result) => {
        if (attempt.current !== current || superseded()) return;
        if (!result.ok) {
          setPhase({ kind: "failed", message: result.message });
          return;
        }
        setSharedOrigin(sameOrigin(result.origin));
        void turnOn(result.origin);
      },
      (reason: unknown) => {
        if (attempt.current !== current || superseded()) return;
        setPhase({ kind: "failed", message: actionErrorMessage(reason) });
      },
    );
  }, [share, turnOn]);

  const reset = useCallback(() => {
    attempt.current += 1;
    setPhase({ kind: "idle" });
  }, []);

  // Turning on settles when the Host answers at the address asked for, or
  // when the operation that was asked for says it failed.
  const operation = remote.status?.operation ?? null;
  useEffect(() => {
    if (phase.kind !== "turning-on") return;
    if (activeOrigin === phase.origin) {
      setPhase({ kind: "idle" });
      return;
    }
    if (
      phase.operationId !== null &&
      operation?.id === phase.operationId &&
      operation.state === "failed"
    ) {
      setPhase({
        kind: "failed",
        message: operation.detail ?? "Couldn’t turn on. Try again.",
      });
    }
  }, [activeOrigin, operation, phase]);
  useEffect(() => {
    if (phase.kind !== "turning-on" && phase.kind !== "sharing") return;
    const current = attempt.current;
    const timer = setTimeout(() => {
      if (attempt.current !== current) return;
      attempt.current += 1;
      setPhase({ kind: "failed", message: "This is taking longer than expected. Try again." });
    }, settleMilliseconds);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  // One code per visit to an active address: issued when the code is first
  // needed, and again only when the person asks after it ran out. Issuing a
  // code deletes the previous one, so it is never replaced behind a phone
  // that may be scanning it.
  const pairing = remote.pairing;
  const [askedGeneration, setAskedGeneration] = useState<number | null>(null);
  useEffect(() => {
    if (!showing || activeOrigin === null || generation === null || pairing !== null) return;
    if (askedGeneration === generation || remote.working) return;
    setAskedGeneration(generation);
    void remote.pair?.();
  }, [activeOrigin, askedGeneration, generation, pairing, remote, showing]);
  const renew = useCallback(() => void remote.pair?.(), [remote]);
  // A code that could not be issued says so and offers to try again, rather
  // than leaving the panel waiting on a code that is not coming.
  const pairingFailed =
    activeOrigin !== null &&
    pairing === null &&
    askedGeneration === generation &&
    !remote.working &&
    remote.error !== null;

  const link =
    activeOrigin !== null && pairing !== null
      ? buildMobilePairingDeepLink({ code: pairing.code, origin: activeOrigin })
      : null;

  return {
    activeOrigin,
    code: activeOrigin !== null ? (pairing?.code ?? null) : null,
    expiresAt: pairing?.expiresAt ?? null,
    link,
    pairingError: pairingFailed ? remote.error : null,
    phase,
    renew,
    reset,
    sharedOrigin,
    turnOnAddress,
    turnOnTailscale,
  };
}

/** Whether an issued code has run out, checked against the clock once a second. */
export function useExpired(expiresAt: string | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const end = Date.parse(expiresAt);
    if (Date.now() >= end) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, end - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== null && now >= Date.parse(expiresAt);
}
