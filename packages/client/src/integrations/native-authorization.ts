import {
  buildIntegrationAuthorizationAppReturn,
  integrationAuthorizationAppReturnBase,
  parseIntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationStart,
  type IntegrationAuthorizationStatus,
} from "@opensteer/integration-core";
export { integrationAuthorizationTerminalStatuses } from "./authorization-outcome.js";
import type { HostApiClient } from "@opensteer/protocol";
import { unwrapRpcResult } from "../host/host-session-client.js";
import {
  authorizationStatusReturned,
  waitForAuthorizationAttempt,
} from "../host/authorization-attempt.js";

export const opensteerMobileIntegrationAuthorizationCallback =
  integrationAuthorizationAppReturnBase("native");

export type NativeIntegrationAuthorizationCallback = IntegrationAuthorizationAppReturn;

/**
 * Uses the shared fixed mobile callback, including an optional app return proof.
 */
export function buildNativeIntegrationAuthorizationCallback(
  input: Omit<NativeIntegrationAuthorizationCallback, "returnProof"> & {
    readonly returnProof?: string | null;
  },
): string {
  return buildIntegrationAuthorizationAppReturn("native", {
    ...input,
    returnProof: input.returnProof ?? null,
  });
}

/** Accepts exactly this build's integration return shape and nothing else. */
export function parseNativeIntegrationAuthorizationCallback(
  rawUrl: string,
): NativeIntegrationAuthorizationCallback | null {
  return parseIntegrationAuthorizationAppReturn("native", rawUrl);
}

/** Wakes existing UI waiters with the Host's committed response, without another polling interval. */
export function integrationAuthorizationStatusReturned(
  client: object,
  attemptId: string,
  status: IntegrationAuthorizationStatus,
): void {
  authorizationStatusReturned(client, attemptId, status);
}

/**
 * Reads the Host's durable attempt until it reaches a terminal state. A browser
 * return only wakes this loop and is never interpreted as authorization.
 */
export function waitForIntegrationAuthorization(input: {
  readonly attemptId: IntegrationAuthorizationStart["attemptId"];
  readonly client: { readonly rpc: Pick<HostApiClient, "integration.authorization.get"> };
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly pollIntervalMilliseconds?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<IntegrationAuthorizationStatus> {
  return waitForAuthorizationAttempt<IntegrationAuthorizationStatus>({
    ...input,
    read: async () =>
      unwrapRpcResult(
        await input.client.rpc["integration.authorization.get"]({ attemptId: input.attemptId }),
      ),
    expired: (status) => ({
      connectionId: null,
      expiresAt: status.expiresAt,
      failureCode: null,
      status: "expired",
    }),
  });
}

export { IntegrationAuthorizationAttempts } from "./authorization-attempts.js";

export class IntegrationAuthorizationCancelledError extends Error {
  constructor() {
    super("Integration authorization was cancelled.");
  }
}

/**
 * A Cancel the Host has not answered. No proof leaves this device any more, but
 * one already sent may have finished the attempt, so nothing can be said yet.
 * `reconciled` settles with the Host's durable status, or with null once that can
 * no longer be read.
 */
export class IntegrationAuthorizationCancelUnconfirmedError extends Error {
  readonly attemptId: string;
  readonly reconciled: Promise<IntegrationAuthorizationStatus | null>;

  constructor(attemptId: string, reconciled: Promise<IntegrationAuthorizationStatus | null>) {
    super("This sign-in's Cancel is not confirmed yet.");
    this.attemptId = attemptId;
    this.reconciled = reconciled;
  }
}

export const integrationAuthorizationCancelUnconfirmedDetail =
  "Checking whether this was cancelled…";
export const integrationAuthorizationCancelUnknownDetail =
  "Opensteer could not confirm the Cancel. Check your connected accounts to see whether it finished.";

/** A sign-in's outcome, waiting for the Host when a Cancel could not be confirmed. */
export async function integrationAuthorizationSettled(
  signIn: Promise<IntegrationAuthorizationStatus>,
  onUnconfirmed: () => void,
): Promise<IntegrationAuthorizationStatus> {
  try {
    return await signIn;
  } catch (error) {
    if (!(error instanceof IntegrationAuthorizationCancelUnconfirmedError)) throw error;
    onUnconfirmed();
    const status = await error.reconciled;
    if (status === null) throw new Error(integrationAuthorizationCancelUnknownDetail);
    return status;
  }
}
