/**
 * Waiting on one browser authorization attempt the Host owns. A browser or app
 * return only wakes the wait; the Host's durable status is the only outcome.
 */
export const authorizationTerminalStatuses: ReadonlySet<string> = new Set([
  "completed",
  "denied",
  "failed",
  "cancelled",
  "expired",
]);

interface AttemptStatus {
  readonly status: string;
  readonly expiresAt: string;
}

const returnedStatuses = new WeakMap<object, Map<string, AttemptStatus>>();
const returnListeners = new WeakMap<object, Map<string, Set<() => void>>>();

/** Wakes waiters on this client with the Host's committed answer to a return. */
export function authorizationStatusReturned(
  client: object,
  attemptId: string,
  status: AttemptStatus,
): void {
  let statuses = returnedStatuses.get(client);
  if (!statuses) returnedStatuses.set(client, (statuses = new Map()));
  for (const [id, value] of statuses)
    if (Date.parse(value.expiresAt) <= Date.now()) statuses.delete(id);
  if (statuses.size >= 32) statuses.delete(statuses.keys().next().value!);
  statuses.set(attemptId, status);
  for (const wake of returnListeners.get(client)?.get(attemptId) ?? []) wake();
}

function returnedStatus<S extends AttemptStatus>(client: object, attemptId: string): S | undefined {
  const status = returnedStatuses.get(client)?.get(attemptId);
  return status && authorizationTerminalStatuses.has(status.status) ? (status as S) : undefined;
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
 * Reads the Host's attempt until it reaches a terminal state or its expiry,
 * waking early when a return on this client already settled it.
 */
export async function waitForAuthorizationAttempt<S extends AttemptStatus>(input: {
  readonly attemptId: string;
  /** The client returns are reported on; also the key that scopes them. */
  readonly client: object;
  readonly read: () => Promise<S>;
  /** The status to report once the attempt's time is up without an answer. */
  readonly expired: (last: S) => S;
  readonly expiresAt?: string;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly pollIntervalMilliseconds?: number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): Promise<S> {
  let expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt).getTime();
  if (expiresAt !== null && !Number.isFinite(expiresAt))
    throw new Error("Authorization expiry is invalid.");
  const now = input.now ?? Date.now;
  const interval = input.pollIntervalMilliseconds ?? 1_000;
  const sleep = input.sleep ?? abortableSleep;
  while (true) {
    if (input.signal?.aborted) throw abortReason(input.signal);
    const returned = returnedStatus<S>(input.client, input.attemptId);
    if (returned) return returned;
    const status = await input.read();
    if (authorizationTerminalStatuses.has(status.status)) return status;
    expiresAt ??= new Date(status.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) throw new Error("Authorization expiry is invalid.");
    const remaining = expiresAt - now();
    if (remaining <= 0) return input.expired(status);
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
  return signal.reason instanceof Error ? signal.reason : new Error("Authorization was stopped.");
}

/** Where a started attempt opens, on the origin this app reaches its Host at. */
export function authorizationLaunchUrl(
  origin: string,
  started: { readonly attemptId: string; readonly launchTicket: string },
): string {
  const target = new URL(
    `/v1/integration-authorizations/${encodeURIComponent(started.attemptId)}/launch`,
    origin,
  );
  target.searchParams.set("ticket", started.launchTicket);
  return target.toString();
}
