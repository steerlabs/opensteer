import { OpensteerError } from "@opensteer/core";
import { HostTransportError } from "../connections/host-transport-error.js";
import { ClientOperationError } from "../connections/operation-error.js";
import { HostClientRequestError } from "./client.js";
import type { ClientNetworkState } from "./lifecycle.js";

/**
 * What one failed Host operation means for the person. It is never "offline":
 * only the device's network state says that, and one failed request is not
 * evidence of it.
 */
export type OperationFailure = "gone" | "unavailable" | "signed-out" | "failed";

/**
 * Reads the failure's own classification. Only a typed failure to reach is
 * "unavailable": a Host that answered, even with "try again", was reached, and
 * an unclassified throw is a failure, not a lost connection.
 */
export function operationFailure(error: unknown): OperationFailure {
  if (error instanceof HostClientRequestError || error instanceof OpensteerError) {
    if (error.code === "unauthorized") return "signed-out";
    if (
      (error.code === "forbidden" || error.code === "not_found") &&
      error.reason !== "unknown-method"
    )
      return "gone";
    return hostUnanswered(error) || error.code === "runner_offline" || error.code === "timeout"
      ? "unavailable"
      : "failed";
  }
  // The boundary that observed it already said whether it may pass (a transport error is one).
  if (error instanceof ClientOperationError)
    return error.classification === "transient" ? "unavailable" : "failed";
  return "failed";
}

/** Whether the request never got the Host's answer, as opposed to the Host answering no. */
export function hostUnanswered(error: unknown): boolean {
  if (error instanceof HostTransportError)
    return error.code === "unreachable" || error.code === "timed-out";
  return (
    (error instanceof HostClientRequestError || error instanceof OpensteerError) &&
    (error.reason === "transport-unreachable" || error.reason === "transport-timed-out")
  );
}

export interface FailureNotice {
  readonly tone: "offline" | "unreachable" | "gone" | "signed-out" | "failed";
  readonly title: string;
  readonly body: string;
  readonly retry: boolean;
}

/** The words every surface shows for a failed open, so web, desktop and mobile can't drift. */
export function failureNotice(
  failure: OperationFailure,
  network: ClientNetworkState,
): FailureNotice {
  switch (failure) {
    case "gone":
      return {
        tone: "gone",
        title: "This isn't available",
        body: "It may have been deleted, or you don't have access.",
        retry: false,
      };
    case "signed-out":
      return {
        tone: "signed-out",
        title: "You're signed out",
        body: "Sign in again to see this.",
        retry: false,
      };
    case "unavailable":
      return network === "offline"
        ? {
            tone: "offline",
            title: "You're offline",
            body: "Reconnect, then try again.",
            retry: true,
          }
        : {
            tone: "unreachable",
            title: "Can't reach Opensteer right now",
            body: "Try again in a moment.",
            retry: true,
          };
    case "failed":
      return {
        tone: "failed",
        title: "Couldn't open this",
        body: "Try again in a moment.",
        retry: true,
      };
  }
}
