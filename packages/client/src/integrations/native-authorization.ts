import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import {
  IntegrationAuthorizationAttemptIdSchema,
  type IntegrationAuthorizationStart,
  type IntegrationAuthorizationStatus,
} from "@opensteer/integration-core";
import type { HostApiClient } from "@opensteer/protocol";
import { unwrapRpcResult } from "../host/host-session-client.js";

export const opensteerMobileIntegrationAuthorizationCallback =
  "com.opensteer.mobile:/oauth/integration-callback";

export interface NativeIntegrationAuthorizationCallback {
  readonly attemptId: IntegrationAuthorizationStart["attemptId"];
  readonly deploymentId: DeploymentId;
}

/**
 * Builds the notification-only return from the system browser. The identifiers
 * select authenticated Host state; the URL never carries a provider result,
 * credential, launch ticket, or Host address.
 */
export function buildNativeIntegrationAuthorizationCallback(
  input: NativeIntegrationAuthorizationCallback,
): string {
  const url = new URL(opensteerMobileIntegrationAuthorizationCallback);
  url.searchParams.set("deployment_id", DeploymentIdSchema.parse(input.deploymentId));
  url.searchParams.set(
    "attempt_id",
    IntegrationAuthorizationAttemptIdSchema.parse(input.attemptId),
  );
  return url.toString();
}

/** Accepts exactly this build's integration return shape and nothing else. */
export function parseNativeIntegrationAuthorizationCallback(
  rawUrl: string,
): NativeIntegrationAuthorizationCallback | null {
  if (rawUrl.length > 8_192) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const callback = new URL(opensteerMobileIntegrationAuthorizationCallback);
  if (
    url.protocol !== callback.protocol ||
    url.host !== callback.host ||
    url.pathname !== callback.pathname ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "deployment_id" && key !== "attempt_id") ||
    url.searchParams.getAll("deployment_id").length !== 1 ||
    url.searchParams.getAll("attempt_id").length !== 1
  ) {
    return null;
  }
  const deploymentId = DeploymentIdSchema.safeParse(url.searchParams.get("deployment_id"));
  const attemptId = IntegrationAuthorizationAttemptIdSchema.safeParse(
    url.searchParams.get("attempt_id"),
  );
  return deploymentId.success && attemptId.success
    ? { deploymentId: deploymentId.data, attemptId: attemptId.data }
    : null;
}

const terminalStatuses = new Set<IntegrationAuthorizationStatus["status"]>([
  "completed",
  "denied",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Reads the Host's durable attempt until it reaches a terminal state. A browser
 * return only wakes this loop and is never interpreted as authorization.
 */
export async function waitForIntegrationAuthorization(input: {
  readonly attemptId: IntegrationAuthorizationStart["attemptId"];
  readonly client: { readonly rpc: Pick<HostApiClient, "integration.authorization.get"> };
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly pollIntervalMilliseconds?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<IntegrationAuthorizationStatus> {
  let expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt).getTime();
  if (expiresAt !== null && !Number.isFinite(expiresAt)) {
    throw new Error("Integration authorization expiry is invalid.");
  }
  const now = input.now ?? Date.now;
  const interval = input.pollIntervalMilliseconds ?? 1_000;
  const sleep = input.sleep ?? abortableSleep;
  while (true) {
    if (input.signal?.aborted) throw abortReason(input.signal);
    const status = unwrapRpcResult(
      await input.client.rpc["integration.authorization.get"]({ attemptId: input.attemptId }),
    );
    if (terminalStatuses.has(status.status)) return status;
    expiresAt ??= new Date(status.expiresAt).getTime();
    if (!Number.isFinite(expiresAt))
      throw new Error("Integration authorization expiry is invalid.");
    const remaining = expiresAt - now();
    if (remaining <= 0) {
      return {
        connectionId: null,
        expiresAt: status.expiresAt,
        failureCode: null,
        status: "expired",
      };
    }
    await sleep(Math.min(interval, remaining), input.signal);
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Integration authorization was stopped.");
}
