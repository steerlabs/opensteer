import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeploymentAccessSnapshot,
  DesktopPersonalAccountLinkStatus,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";

type PersonalAccountBridge = Pick<
  OpensteerDesktopBridge,
  | "getDeploymentAccessSnapshot"
  | "linkPersonal"
  | "onDeploymentAccessSnapshotChanged"
  | "unlinkPersonal"
>;

/** Which Account-link mutation the Desktop was asked to run. */
export type PersonalAccountLinkOperation = "link" | "repair" | "unlink";

/**
 * What actually happened, once the Desktop's operation slot emptied.
 *
 * `activation-pending` is the state that used to be reported as success: the
 * Host has committed the link and the Account directory has not activated it
 * yet. It is neither a failure nor a finished link, and the only honest thing
 * to say is that finishing it is still available.
 */
export type PersonalAccountLinkOutcomeKind =
  | "activation-pending"
  | "linked"
  | "linked-elsewhere"
  | "needs-repair"
  | "repaired"
  | "unavailable"
  | "unlinked";

export interface PersonalAccountLinkOutcome {
  readonly kind: PersonalAccountLinkOutcomeKind;
  /** What to tell the person. Never claims more than `kind` supports. */
  readonly message: string;
  readonly status: DesktopPersonalAccountLinkStatus;
  readonly succeeded: boolean;
}

export interface PersonalAccountLinkController {
  readonly canLink: boolean;
  readonly canRepair: boolean;
  readonly canUnlink: boolean;
  readonly error: unknown;
  readonly link: () => Promise<PersonalAccountLinkOutcome>;
  readonly pending: PersonalAccountLinkOperation | null;
  readonly repair: () => Promise<PersonalAccountLinkOutcome>;
  readonly status: DesktopPersonalAccountLinkStatus | null;
  readonly unlink: () => Promise<PersonalAccountLinkOutcome>;
}

/** Linking can hand off to a browser sign-in, so settlement is generous. */
const personalAccountLinkTimeoutMilliseconds = 5 * 60_000;

interface SettleAccountLinkInput {
  readonly bridge: Pick<
    PersonalAccountBridge,
    "getDeploymentAccessSnapshot" | "onDeploymentAccessSnapshotChanged"
  >;
  readonly operation: PersonalAccountLinkOperation;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMilliseconds?: number | undefined;
}

/**
 * Reads a settled link status as the outcome of the mutation that was asked
 * for. Pure, so every wording the UI can produce is visible in one table and
 * testable without a bridge.
 */
function personalAccountLinkOutcome(
  operation: PersonalAccountLinkOperation,
  status: DesktopPersonalAccountLinkStatus,
): PersonalAccountLinkOutcome {
  const settled = (
    kind: PersonalAccountLinkOutcomeKind,
    succeeded: boolean,
    message: string,
  ): PersonalAccountLinkOutcome => ({ kind, message, status, succeeded });

  if (status.status === "needs-repair") {
    return settled(
      "needs-repair",
      false,
      "This computer’s records and your account’s records disagree. Repair the account link before changing it.",
    );
  }
  if (status.status === "linked-elsewhere") {
    return settled(
      "linked-elsewhere",
      false,
      "This computer is in a different Opensteer account. Remove it there before adding it here.",
    );
  }
  if (operation === "unlink") {
    return status.status === "unlinked" || status.status === "unavailable"
      ? settled("unlinked", true, "This computer is no longer in your account.")
      : settled(
          "activation-pending",
          false,
          "This computer is still in your account. Try removing it again.",
        );
  }
  if (operation === "repair") {
    return status.status === "unlinked" || status.status === "linked"
      ? settled("repaired", true, "The Account link records agree again.")
      : settled(
          "needs-repair",
          false,
          "The Account link still needs repair. Try again, or reopen Opensteer.",
        );
  }
  if (status.status === "linked") {
    return settled("linked", true, "This computer is in your account.");
  }
  if (status.status === "activating") {
    // The Host committed the link; the Account has not activated it yet. This
    // is exactly the case a success toast used to swallow.
    return settled(
      "activation-pending",
      false,
      "This computer is saved but not added yet. Choose Finish adding to complete it, or Cancel to undo it.",
    );
  }
  if (status.status === "unavailable") {
    return settled("unavailable", false, "Adding this computer to an account isn’t available.");
  }
  return settled(
    "activation-pending",
    false,
    "This computer wasn’t added to your account. Try again.",
  );
}

/**
 * The Desktop's link/unlink/repair intents only *start* a long-running
 * operation — the machine may first open an Account sign-in in the system
 * browser. Observe the access snapshot stream until the operation slot empties
 * and report the terminal link status, instead of trusting the snapshot taken
 * right after dispatch.
 *
 * This snapshot stream is the one settlement mechanism in the renderer: there
 * is no polling path beside it, and no caller infers completion from the IPC
 * promise resolving.
 */
export function settleAccountLinkOperation(
  input: SettleAccountLinkInput,
): Promise<PersonalAccountLinkOutcome> {
  const { bridge, operation, signal } = input;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The Account link change was interrupted. Try again."));
      return;
    }
    let settled = false;
    let unsubscribe = () => {};
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      settle();
    };
    const onAbort = () =>
      finish(() => reject(new Error("The Account link change was interrupted. Try again.")));
    const timer = setTimeout(
      () => finish(() => reject(new Error("The Account link change timed out. Try again."))),
      input.timeoutMilliseconds ?? personalAccountLinkTimeoutMilliseconds,
    );
    const evaluate = (snapshot: DeploymentAccessSnapshot) => {
      const link = snapshot.personalAccountLink;
      const terminal =
        operation === "link"
          ? link.status === "activating" ||
            link.status === "linked" ||
            link.status === "linked-elsewhere" ||
            link.status === "needs-repair"
          : operation === "repair"
            ? link.status !== "needs-repair"
            : link.status === "unlinked" || link.status === "unavailable";
      if (terminal) finish(() => resolve(personalAccountLinkOutcome(operation, link)));
    };
    signal?.addEventListener("abort", onAbort);
    unsubscribe = bridge.onDeploymentAccessSnapshotChanged(evaluate);
    void bridge
      .getDeploymentAccessSnapshot()
      .then(evaluate)
      .catch((reason: unknown) => {
        finish(() => reject(reason instanceof Error ? reason : new Error(String(reason))));
      });
  });
}

/**
 * The Desktop owns the one deployment-level Account-link operation. Settings,
 * integrations, and Thread requests all observe and invoke that same state
 * machine through this controller.
 *
 * The snapshot is supplied by the caller — the app root already holds the one
 * revision-guarded subscription — so this hook never opens a second one and no
 * two surfaces can describe different revisions of the same link.
 */
export function usePersonalAccountLink(
  bridge: PersonalAccountBridge | null,
  snapshot: DeploymentAccessSnapshot | null,
): PersonalAccountLinkController {
  const [pending, setPending] = useState<PersonalAccountLinkOperation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pendingRef = useRef<PersonalAccountLinkOperation | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A settlement outlives the click but not the surface that asked for it:
  // unmounting drops the snapshot subscription instead of holding one open
  // until the five-minute timeout.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (operation: PersonalAccountLinkOperation) => {
      if (!bridge) throw new Error("Account listing is available in the Opensteer app.");
      if (pendingRef.current) throw new Error("An Account link change is already in progress.");
      setError(null);
      pendingRef.current = operation;
      setPending(operation);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await bridge.getDeploymentAccessSnapshot();
        if (operation === "link") await bridge.linkPersonal();
        else if (operation === "unlink") await bridge.unlinkPersonal();
        else await bridge.linkPersonal();
        return await settleAccountLinkOperation({
          bridge,
          operation,
          signal: controller.signal,
        });
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason);
        throw reason;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        pendingRef.current = null;
        setPending(null);
      }
    },
    [bridge],
  );

  const status = snapshot?.personalAccountLink.status ?? "unavailable";
  return {
    // An `activating` link is saved on the Host and not yet live in the
    // Account: linking again is the "Finish listing" the outcome copy names.
    canLink: status === "unlinked" || status === "activating",
    canRepair: status === "needs-repair",
    canUnlink: ["activating", "linked", "linked-elsewhere", "unlinking"].includes(status),
    error,
    link: () => run("link"),
    pending,
    repair: () => run("repair"),
    status: snapshot?.personalAccountLink ?? null,
    unlink: () => run("unlink"),
  };
}

export function supportsPersonalAccountLink(
  bridge: OpensteerDesktopBridge | null,
): bridge is OpensteerDesktopBridge {
  return Boolean(
    bridge &&
    typeof bridge.getDeploymentAccessSnapshot === "function" &&
    typeof bridge.linkPersonal === "function" &&
    typeof bridge.onDeploymentAccessSnapshotChanged === "function" &&
    typeof bridge.unlinkPersonal === "function",
  );
}
