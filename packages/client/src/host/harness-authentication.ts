import type { HarnessSetupMethod, HostApiClient, HostApiCommandInput } from "@opensteer/protocol";
import { observedAccountConnection } from "./connection-usage.js";
import type { HarnessAuthenticationEnvelope, HostClient } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";

const harnessAuthenticationPollIntervalMs = 1_500;

export const harnessAuthenticationEnsureIntervalMs = 5_000;

const harnessAuthenticationCancelWaitMs = 5_000;
const harnessAuthenticationLifetimeMs = 15 * 60_000;

export type HarnessAuthenticationView =
  | { readonly kind: "starting" }
  | {
      readonly kind: "pending";
      readonly codeReplaced: boolean;
      readonly inputKind?: "code" | "secret";
      readonly inputPrompt?: string;
      readonly userCode: string;
      readonly verificationUrl?: string;
    }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "disconnected" };

export interface HarnessAuthenticationSession {
  readonly userCode: string | null;
  readonly view: HarnessAuthenticationView;
}

export function nextHarnessAuthenticationSession(
  previous: HarnessAuthenticationSession | null,
  envelope: HarnessAuthenticationEnvelope,
): HarnessAuthenticationSession {
  const view = resolveView(previous, envelope);
  return {
    userCode:
      view.kind === "pending"
        ? view.userCode || (previous?.userCode ?? "")
        : (previous?.userCode ?? null),
    view,
  };
}

export function harnessAuthenticationSettled(view: HarnessAuthenticationView): boolean {
  return view.kind === "ready" || view.kind === "failed";
}

export function harnessAuthenticationEnsureDue(
  view: HarnessAuthenticationView,
  lastEnsureAt: number,
  now: number,
): boolean {
  return view.kind === "starting" && now - lastEnsureAt >= harnessAuthenticationEnsureIntervalMs;
}

function resolveView(
  previous: HarnessAuthenticationSession | null,
  envelope: HarnessAuthenticationEnvelope,
): HarnessAuthenticationView {
  const { authentication, environmentStatus } = envelope;
  if (authentication.status === "ready") return { kind: "ready" };
  if (authentication.status === "failed") {
    return { detail: authentication.detail, kind: "failed" };
  }
  if (authentication.status === "pending") {
    if (authentication.challenge.kind === "device-code") {
      return {
        codeReplaced: codeWasReplaced(previous, authentication.challenge.userCode),
        inputKind: "code",
        kind: "pending",
        userCode: authentication.challenge.userCode,
        verificationUrl: authentication.challenge.verificationUrl,
      };
    }
    if (authentication.challenge.kind === "browser-code")
      return {
        codeReplaced: false,
        inputKind: "code",
        inputPrompt: authentication.challenge.inputPrompt,
        kind: "pending",
        userCode: "",
        verificationUrl: authentication.challenge.authorizationUrl,
      };
    return {
      codeReplaced: false,
      inputKind: "secret",
      inputPrompt: authentication.challenge.inputLabel,
      kind: "pending",
      userCode: "",
    };
  }
  switch (environmentStatus) {
    case "connected":
      return { kind: "starting" };
    case "disconnected":
      return { kind: "disconnected" };
  }
}

function codeWasReplaced(previous: HarnessAuthenticationSession | null, userCode: string): boolean {
  if (previous === null || previous.userCode === null) return false;
  if (previous.userCode !== userCode) return true;
  return previous.view.kind === "pending" && previous.view.codeReplaced;
}

export type HarnessAuthenticationClient = Pick<HostClient, "dispatch" | "refresh"> & {
  readonly rpc: Pick<HostApiClient, "harness.authentication.get">;
};

export interface HarnessAuthenticationRun {
  stop: () => void;
  whenEnsureSettled: (waitForLate?: boolean) => Promise<void>;
  submit: (value: string) => Promise<void>;
}

export function startHarnessAuthentication({
  client,
  connectionSlot,
  environmentId,
  harnessInstanceId,
  methodId,
  now = Date.now,
  onError,
  onReady,
  onSession,
  sleep = defaultSleep,
}: {
  readonly client: HarnessAuthenticationClient;
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly methodId: string;
  readonly connectionSlot?: string;
  readonly now?: () => number;
  readonly onError: (message: string) => void;
  readonly onReady: () => void;
  readonly onSession: (session: HarnessAuthenticationSession) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}): HarnessAuthenticationRun {
  let stopped = false;
  let current: HarnessAuthenticationSession | null = null;
  let lastEnsureAt = 0;
  let inFlightEnsure: Promise<unknown> | null = null;
  let wake: (() => void) | null = null;
  const startedAt = now();
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    wake?.();
  };
  const expire = () => {
    if (stopped) return;
    stop();
    onError("Sign-in timed out. Try again.");
  };
  if (sleep === defaultSleep) lifetimeTimer = setTimeout(expire, harnessAuthenticationLifetimeMs);

  const apply = (envelope: HarnessAuthenticationEnvelope) => {
    current = nextHarnessAuthenticationSession(current, envelope);
    if (!stopped) onSession(current);
    return current;
  };
  const ensure = async () => {
    lastEnsureAt = now();
    const request = client.dispatch({
      ...(connectionSlot ? { connectionSlot } : {}),
      environmentId,
      harnessInstanceId,
      idempotencyKey: mutationIdempotencyKey(`harness-auth:${harnessInstanceId}`),
      methodId,
      type: "harness.authentication.begin",
    });
    inFlightEnsure = request;
    try {
      const result = await request;
      if (result.type !== "harness.authentication.begin") {
        throw new Error("Harness authentication command mismatch.");
      }
      return apply(result);
    } finally {
      if (inFlightEnsure === request) inFlightEnsure = null;
    }
  };

  const run = async () => {
    try {
      let session = await ensure();
      while (!stopped) {
        if (now() - startedAt >= harnessAuthenticationLifetimeMs) {
          expire();
          return;
        }
        if (session.view.kind === "ready") {
          await client.refresh();
          if (!stopped) onReady();
          return;
        }
        if (harnessAuthenticationSettled(session.view)) return;
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          if (sleep === defaultSleep) {
            const timer = setTimeout(resolve, harnessAuthenticationPollIntervalMs);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          } else {
            void sleep(harnessAuthenticationPollIntervalMs).then(resolve, reject);
          }
        });
        wake = null;
        if (stopped) return;
        const result = await client.rpc["harness.authentication.get"]({
          environmentId,
          harnessInstanceId,
        });
        if (stopped) return;
        session = apply(unwrapRpcResult(result));
        if (harnessAuthenticationEnsureDue(session.view, lastEnsureAt, now())) {
          session = await ensure();
        }
      }
    } catch (cause) {
      if (!stopped)
        onError(
          cause instanceof Error ? cause.message : "Opensteer couldn’t complete that action.",
        );
    } finally {
      if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    }
  };

  void run();
  return {
    stop,
    whenEnsureSettled: async (waitForLate = false) => {
      const request = inFlightEnsure;
      if (request === null) return;
      const settled = request.then(
        () => undefined,
        () => undefined,
      );
      if (waitForLate) return settled;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          settled,
          sleep === defaultSleep
            ? new Promise<void>((resolve) => {
                timer = setTimeout(resolve, harnessAuthenticationCancelWaitMs);
              })
            : sleep(harnessAuthenticationCancelWaitMs),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    submit: async (value: string) => {
      if (stopped) return;
      const result = await client.dispatch({
        environmentId,
        harnessInstanceId,
        idempotencyKey: mutationIdempotencyKey(`harness-auth:${harnessInstanceId}`),
        type: "harness.authentication.submit",
        value,
      });
      if (result.type !== "harness.authentication.submit") {
        throw new Error("Harness authentication command mismatch.");
      }
      apply(result);
    },
  };
}

export async function releaseHarnessAuthentication({
  client,
  environmentId,
  harnessInstanceId,
  run,
}: {
  readonly client: Pick<HostClient, "dispatch">;
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly run: HarnessAuthenticationRun | null;
}): Promise<void> {
  if (run !== null) {
    run.stop();
    await run.whenEnsureSettled();
  }
  await client.dispatch({
    environmentId,
    harnessInstanceId,
    idempotencyKey: mutationIdempotencyKey(`harness-auth:${harnessInstanceId}`),
    type: "harness.authentication.cancel",
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AccountSignInTarget =
  | {
      readonly kind: "create";
      readonly request: Extract<HostApiCommandInput, { type: "harness.create" }>;
    }
  | {
      readonly kind: "existing";
      readonly environmentId: string;
      readonly harnessInstanceId: string;
    };

export type AccountSignInState =
  | { readonly kind: "preparing" }
  | {
      readonly kind: "signing-in";
      readonly harnessInstanceId: string;
      readonly methods: readonly HarnessSetupMethod[];
      readonly methodId: string;
      readonly session: HarnessAuthenticationSession | null;
      readonly error: string | null;
    }
  | { readonly kind: "finishing"; readonly harnessInstanceId: string }
  | {
      readonly kind: "duplicate";
      readonly harnessInstanceId: string;
      readonly accountLabel: string;
    }
  | {
      readonly kind: "done";
      readonly harnessInstanceId: string;
      readonly accountLabel: string | null;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

export interface AccountSignInFlow {
  getState(): AccountSignInState;
  subscribe(listener: () => void): () => void;
  chooseMethod(methodId: string): void;
  submit(value: string): Promise<void>;
  retry(): void;
  keepDuplicate(): void;
  removeDuplicate(): Promise<void>;
  cancel(): Promise<void>;
}

export function startAccountSignIn({
  client,
  target,
  errorMessage,
  selectMethod,
  now = Date.now,
  sleep,
}: {
  readonly client: Pick<HostClient, "dispatch" | "getSnapshot" | "refresh" | "subscribe"> & {
    readonly rpc: Pick<HostApiClient, "harness.authentication.get">;
  };
  readonly target: AccountSignInTarget;
  readonly errorMessage: (cause: unknown) => string;
  /** The way in to start with. Answering nothing means this account offers none the caller can use. */
  readonly selectMethod?: (methods: readonly HarnessSetupMethod[]) => string | undefined;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): AccountSignInFlow {
  let state: AccountSignInState = { kind: "preparing" };
  const listeners = new Set<() => void>();
  const environmentId =
    target.kind === "create" ? target.request.environmentId : target.environmentId;
  if (typeof environmentId !== "string") throw new Error("The account needs a work location.");
  let harnessInstanceId = target.kind === "existing" ? target.harnessInstanceId : null;
  let run: HarnessAuthenticationRun | null = null;
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let cancelling = false;
  let cancelPromise: Promise<void> | null = null;
  let switchPromise: Promise<void> = Promise.resolve();
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let finishGeneration = 0;
  let finishingCatalog: object | undefined;

  const stopWatching = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (finishTimer !== null) clearTimeout(finishTimer);
    finishTimer = null;
    finishGeneration += 1;
    run?.stop();
  };
  const publish = (next: AccountSignInState) => {
    if (state.kind === "cancelled") return;
    state = next;
    if (["done", "duplicate", "failed", "cancelled"].includes(next.kind)) stopWatching();
    for (const listener of listeners) listener();
  };
  const fail = (cause: unknown) => publish({ kind: "failed", message: errorMessage(cause) });
  const catalog = () =>
    client
      .getSnapshot()
      .environments.find((item) => item.id === environmentId)
      ?.harnessCatalogs.find((item) => item.harnessInstanceId === harnessInstanceId);
  const complete = (accountLabel: string | null) => {
    if (cancelling || state.kind !== "finishing" || harnessInstanceId === null) return;
    const snapshot = client.getSnapshot();
    const harness = snapshot.harnesses.find((item) => item.id === harnessInstanceId);
    const environment = snapshot.environments.find((item) => item.id === environmentId);
    const duplicate =
      target.kind === "create" &&
      accountLabel?.includes("@") &&
      harness &&
      snapshot.harnesses.some(
        (other) =>
          other.id !== harnessInstanceId &&
          other.enabled &&
          other.environmentId === environmentId &&
          other.driverKind === harness.driverKind &&
          observedAccountConnection(
            environment?.harnessCatalogs.find((item) => item.harnessInstanceId === other.id)
              ?.connections ?? [],
          )?.accountLabel === accountLabel,
      );
    publish(
      duplicate && accountLabel !== null
        ? { kind: "duplicate", harnessInstanceId, accountLabel }
        : { kind: "done", harnessInstanceId, accountLabel },
    );
  };
  const finish = () => {
    if (cancelling || state.kind === "finishing" || harnessInstanceId === null) return;
    run?.stop();
    generation += 1;
    finishingCatalog = catalog();
    const token = ++finishGeneration;
    publish({ kind: "finishing", harnessInstanceId });
    if (cancelling || token !== finishGeneration) return;
    const expired = () => {
      if (token === finishGeneration) complete(null);
    };
    if (sleep)
      void sleep(15_000).then(expired, (cause: unknown) => {
        if (token === finishGeneration && !cancelling) fail(cause);
      });
    else finishTimer = setTimeout(expired, 15_000);
    void client.refresh().then(
      () => {
        if (token !== finishGeneration || cancelling) return;
        const fresh = catalog();
        if (fresh?.status === "ready")
          complete(observedAccountConnection(fresh.connections)?.accountLabel ?? null);
      },
      () => undefined,
    );
  };
  const release = async (attempt: HarnessAuthenticationRun | null) => {
    if (harnessInstanceId === null || attempt === null) return;
    attempt.stop();
    let settled = false;
    const drained = attempt.whenEnsureSettled(true).then(() => {
      settled = true;
    });
    await attempt.whenEnsureSettled();
    const needsFinalCancel = !settled;
    let failure: unknown;
    try {
      await releaseHarnessAuthentication({
        client,
        environmentId,
        harnessInstanceId,
        run: null,
      });
    } catch (cause) {
      failure = cause;
    }
    if (needsFinalCancel) {
      await drained;
      await releaseHarnessAuthentication({ client, environmentId, harnessInstanceId, run: null });
    }
    if (failure !== undefined) throw failure;
  };
  const begin = (methods: readonly HarnessSetupMethod[], methodId: string) => {
    const method = methods.find((item) => item.methodId === methodId);
    if (!method || harnessInstanceId === null || cancelling) return;
    const token = ++generation;
    publish({
      kind: "signing-in",
      harnessInstanceId,
      methods,
      methodId,
      session: null,
      error: null,
    });
    if (cancelling || token !== generation) return;
    run = startHarnessAuthentication({
      client,
      environmentId,
      harnessInstanceId,
      methodId,
      ...(method.connectionSlot ? { connectionSlot: method.connectionSlot } : {}),
      now,
      ...(sleep ? { sleep } : {}),
      onError: (message) => {
        if (!cancelling && token === generation && state.kind === "signing-in")
          publish({ ...state, error: message });
      },
      onReady: () => {
        if (!cancelling && token === generation) finish();
      },
      onSession: (session) => {
        if (cancelling || token !== generation || state.kind !== "signing-in") return;
        publish({
          ...state,
          session,
          error: session.view.kind === "failed" ? session.view.detail : null,
        });
        if (session.view.kind === "ready") finish();
      },
    });
  };
  const inspect = () => {
    if (cancelling) return;
    const current = catalog();
    if (state.kind === "finishing") {
      if (current !== finishingCatalog && current?.status === "ready")
        complete(observedAccountConnection(current.connections)?.accountLabel ?? null);
      return;
    }
    if (
      state.kind !== "preparing" ||
      harnessInstanceId === null ||
      !current ||
      current.status === "preparing"
    )
      return;
    const environment = client.getSnapshot().environments.find((item) => item.id === environmentId);
    if (current.status !== "ready" && current.status !== "authentication-required") {
      fail(new Error(current.detail));
    } else if (
      target.kind === "create" &&
      current.status === "ready" &&
      current.setupMethods.length === 0
    ) {
      finish();
    } else if (!environment?.harnessAuthenticationAllowed || current.setupMethods.length === 0) {
      fail(new Error(current.detail ?? "This account does not offer sign-in on this computer."));
    } else {
      const methodId = selectMethod
        ? selectMethod(current.setupMethods)
        : (current.setupMethods.find((item) => item.kind === "local-import") ??
            current.setupMethods[0]!).methodId;
      if (methodId === undefined) {
        fail(new Error(current.detail ?? "This account does not offer that sign-in here."));
      } else {
        begin(current.setupMethods, methodId);
      }
    }
  };
  const prepare = async () => {
    if (target.kind === "create" && harnessInstanceId === null) {
      const result = await client.dispatch(target.request);
      if (result.type !== "harness.create") throw new Error("AI engine create command mismatch.");
      harnessInstanceId = result.harness.id;
    }
    if (cancelling) return;
    unsubscribe = client.subscribe(inspect);
    inspect();
    if (state.kind === "preparing") {
      void client.refresh().then(inspect, (cause: unknown) => {
        if (!cancelling && state.kind === "preparing") fail(cause);
      });
    }
  };
  let preparation = prepare().catch((cause: unknown) => {
    if (!cancelling) fail(cause);
  });
  const chooseMethod = (methodId: string) => {
    if (
      cancelling ||
      state.kind !== "signing-in" ||
      !state.methods.some((item) => item.methodId === methodId)
    )
      return;
    const methods = state.methods;
    const attempt = run;
    run = null;
    attempt?.stop();
    const token = ++generation;
    switchPromise = switchPromise
      .then(async () => {
        await release(attempt);
        if (!cancelling && token === generation) begin(methods, methodId);
      })
      .catch((cause: unknown) => {
        if (!cancelling) fail(cause);
        else throw cause;
      });
  };
  const cancel = () => {
    if (cancelPromise) return cancelPromise;
    if (state.kind === "done" || state.kind === "cancelled") return Promise.resolve();
    // The sign-in already succeeded: closing stops the wait for its details, not the account.
    if (state.kind === "finishing") {
      publish({ kind: "done", harnessInstanceId: state.harnessInstanceId, accountLabel: null });
      return Promise.resolve();
    }
    cancelling = true;
    generation += 1;
    stopWatching();
    cancelPromise = (async () => {
      let failure: unknown;
      try {
        await preparation;
        await switchPromise;
      } catch (cause) {
        failure = cause;
      }
      try {
        await release(run);
      } catch (cause) {
        failure = cause;
      }
      if (target.kind === "create" && harnessInstanceId !== null) {
        try {
          await client.dispatch({
            type: "harness.delete",
            environmentId,
            harnessInstanceId,
            idempotencyKey: mutationIdempotencyKey(`harness-delete:${harnessInstanceId}`),
          });
        } catch (cause) {
          failure = cause;
        }
      }
      if (failure !== undefined) fail(failure);
      else publish({ kind: "cancelled" });
    })();
    return cancelPromise;
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    chooseMethod,
    submit: async (value) => {
      if (cancelling || state.kind !== "signing-in") return;
      const token = generation;
      try {
        await run?.submit(value);
      } catch (cause) {
        if (!cancelling && token === generation && state.kind === "signing-in")
          publish({ ...state, error: errorMessage(cause) });
      }
    },
    retry: () => {
      if (cancelling) return;
      if (state.kind === "signing-in") chooseMethod(state.methodId);
      else if (state.kind === "failed") {
        publish({ kind: "preparing" });
        preparation = prepare().catch((cause: unknown) => {
          if (!cancelling) fail(cause);
        });
      }
    },
    keepDuplicate: () => {
      if (!cancelling && state.kind === "duplicate") publish({ ...state, kind: "done" });
    },
    removeDuplicate: async () => {
      if (state.kind === "duplicate") await cancel();
    },
    cancel,
  };
}
