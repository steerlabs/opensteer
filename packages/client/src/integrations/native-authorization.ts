import {
  buildIntegrationAuthorizationAppReturn,
  integrationAuthorizationAppReturnBase,
  parseIntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationStart,
  type IntegrationAuthorizationStatus,
} from "@opensteer/integration-core";
import { integrationAuthorizationTerminalStatuses } from "./authorization-outcome.js";
export { integrationAuthorizationTerminalStatuses } from "./authorization-outcome.js";
import type { HostApiClient } from "@opensteer/protocol";
import { unwrapRpcResult } from "../host/host-session-client.js";

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

const returnedStatuses = new WeakMap<object, Map<string, IntegrationAuthorizationStatus>>();
const returnListeners = new WeakMap<object, Map<string, Set<() => void>>>();

/** Wakes existing UI waiters with the Host's committed response, without another polling interval. */
export function integrationAuthorizationStatusReturned(
  client: object,
  attemptId: string,
  status: IntegrationAuthorizationStatus,
): void {
  let statuses = returnedStatuses.get(client);
  if (!statuses) returnedStatuses.set(client, (statuses = new Map()));
  for (const [id, value] of statuses)
    if (Date.parse(value.expiresAt) <= Date.now()) statuses.delete(id);
  if (statuses.size >= 32) statuses.delete(statuses.keys().next().value!);
  statuses.set(attemptId, status);
  for (const wake of returnListeners.get(client)?.get(attemptId) ?? []) wake();
}

function returnedStatus(
  client: object,
  attemptId: string,
): IntegrationAuthorizationStatus | undefined {
  const status = returnedStatuses.get(client)?.get(attemptId);
  return status && integrationAuthorizationTerminalStatuses.has(status.status) ? status : undefined;
}

function waitForReturnOrInterval(
  client: object,
  attemptId: string,
  milliseconds: number,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (returnedStatus(client, attemptId)) return Promise.resolve();
  let attempts = returnListeners.get(client);
  if (!attempts) returnListeners.set(client, (attempts = new Map()));
  let listeners = attempts.get(attemptId);
  if (!listeners) attempts.set(attemptId, (listeners = new Set()));
  const waiting = listeners;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let wake!: () => void;
  return new Promise<void>((resolve, reject) => {
    wake = resolve;
    waiting.add(wake);
    void sleep(milliseconds, controller.signal).then(resolve, reject);
  }).finally(() => {
    waiting.delete(wake);
    if (waiting.size === 0) attempts.delete(attemptId);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  });
}

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
    const returned = returnedStatus(input.client, input.attemptId);
    if (returned) return returned;
    const status = unwrapRpcResult(
      await input.client.rpc["integration.authorization.get"]({ attemptId: input.attemptId }),
    );
    if (integrationAuthorizationTerminalStatuses.has(status.status)) return status;
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
    await waitForReturnOrInterval(
      input.client,
      input.attemptId,
      Math.min(interval, remaining),
      sleep,
      input.signal,
    );
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

export { IntegrationAuthorizationAttempts } from "./authorization-attempts.js";

export class IntegrationAuthorizationCancelledError extends Error {
  constructor() {
    super("Integration authorization was cancelled.");
  }
}
