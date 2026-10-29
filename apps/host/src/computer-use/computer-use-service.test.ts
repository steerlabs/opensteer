import {
  createId,
  OpensteerError,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { computerAppIdentityKey, type ComputerAppIdentity } from "@opensteer/integration-core";
import {
  computerUseMaxTimeoutMs,
  mintComputerUseSessionId,
  type AndroidPhoneObservation,
  type ComputerUseObservation,
  type MachineAppStatus,
} from "@opensteer/protocol";
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import { DisplayStreamHub } from "./display-stream-hub.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerAppPlatform } from "@opensteer/integration-core";
import type {
  ComputerAppMachine,
  ComputerUseOutcome,
  ComputerUseSendInput,
} from "../computer-apps/computer-app-hub.js";
import {
  ComputerUseError,
  ComputerUseService,
  computerUseBusyNextStep,
  computerUseDeadlineMs,
  type ComputerUseCallable,
  type ComputerUseContext,
  type ComputerUseMachine,
  type ComputerUseTarget,
  type ComputerUseDispatch,
  type ComputerUseLease,
  type ComputerUseStopLedger,
  type ComputerUseServiceOptions,
} from "./computer-use-service.js";

/** A ledger whose first `failures` writes fail, as a database that is briefly down does. */
function flakyStops(failures: number) {
  const stops = durableStops();
  let left = failures;
  const ledger = stops.ledger();
  return {
    rows: stops.rows,
    ledger: (): ComputerUseStopLedger => ({
      ...ledger,
      record: async (runId, runnerId) => {
        if (left > 0) {
          left -= 1;
          throw new Error("connection terminated unexpectedly");
        }
        await ledger.record(runId, runnerId);
      },
    }),
  };
}

/** Stands in for the Stops table: what one Host records, the next one starts from. */
function durableStops() {
  const rows = new Map<string, { readonly runId: RunId; readonly runnerId: RunnerId }>();
  return {
    rows,
    ledger: (): ComputerUseStopLedger => ({
      clear: async (runId) => {
        for (const [key, row] of rows) if (row.runId === runId) rows.delete(key);
      },
      initial: [...rows.values()],
      record: async (runId, runnerId) => {
        rows.set(`${runId}|${runnerId}`, { runId, runnerId });
      },
    }),
  };
}

const notes: ComputerAppIdentity = {
  bundleId: "com.apple.Notes",
  displayName: "Notes",
  teamId: null,
};
const calendar: ComputerAppIdentity = {
  bundleId: "com.apple.iCal",
  displayName: "Calendar",
  teamId: null,
};

function observation(overrides: Partial<ComputerUseObservation> = {}): ComputerUseObservation {
  return {
    app: notes,
    capturedAt: "2026-09-21T10:00:00.000Z",
    elementCount: 2,
    focusChanged: false,
    geometry: { width: 800, height: 600 },
    snapshot: "obs-1",
    screenshot: null,
    tree: '[0] window "Notes" (0,0 800×600)',
    truncated: false,
    windows: [],
    blockedBy: [],
    alone: false,
    window: {
      ref: "window-1",
      id: 7,
      frame: { x: 0, y: 0, width: 800, height: 600 },
      scale: 1,
      title: "Notes",
    },
    ...overrides,
  };
}

/** A computer as the hub lists it, with the platform the Runner registry records for it. */
type ListedMachine = ComputerAppMachine & { readonly platform: ComputerAppPlatform };

/** What the Agent Phone app answers an observe with, screen on and nothing in the way. */
function phoneObservation(
  overrides: Partial<AndroidPhoneObservation> = {},
): AndroidPhoneObservation {
  return {
    capturedAt: "2026-10-11T10:00:00.000Z",
    elementCount: 2,
    foreground: { label: "Messages", packageName: "com.google.android.apps.messaging" },
    geometry: { height: 2400, width: 1080 },
    locked: false,
    observationId: "phone-obs-1",
    rotation: 0,
    screen: "on",
    screenshot: null,
    screenshotUnavailable: "not-requested",
    secureLock: false,
    tree: '[0] window "Messages" (0,0 1080×2400)\n  [1] button "Send" (900,2200 120×80)',
    truncated: false,
    ...overrides,
  };
}

interface Harness {
  /** Every "Stop recorded" the Host told a computer, in order. */
  readonly acknowledged: {
    readonly runnerId: RunnerId;
    readonly runId: RunId;
    readonly sessionId: string;
  }[];
  readonly machines: ListedMachine[];
  readonly outcomes: ComputerUseOutcome[];
  /** Gates one answer each, so a call can be held in flight deliberately. */
  readonly pending: Promise<void>[];
  readonly sent: ComputerUseSendInput[];
  readonly onSessionsChanged: ReturnType<typeof vi.fn>;
  readonly onSessionEnded: ReturnType<typeof vi.fn>;
  readonly service: ComputerUseService;
  now: number;
}

function macosApp(): MachineAppStatus {
  return {
    definitionId: "macos-app",
    operations: [
      { detail: null, operation: "observe", remedy: null, state: "ready" },
      { detail: null, operation: "act", remedy: null, state: "ready" },
    ],
  };
}

function harness(
  options: {
    readonly passwords?: ComputerUseServiceOptions["passwords"];
    readonly loginReceiver?: ComputerUseServiceOptions["loginReceiver"];
    readonly expireSetupRequests?: () => Promise<void>;
    readonly onError?: (error: unknown) => void;
    readonly owner?: UserId;
    readonly runIsActive?: (runId: RunId) => Promise<boolean>;
    /** Runs before each grant check; a throw is the store failing to answer. */
    readonly grantCheck?: () => Promise<void>;
    readonly stops?: ComputerUseStopLedger;
    readonly threadTitle?: (threadId: ThreadId, ownerUserId: UserId) => Promise<string | null>;
  } = {},
): Harness {
  const outcomes: ComputerUseOutcome[] = [];
  const pending: Promise<void>[] = [];
  const sent: ComputerUseSendInput[] = [];
  const acknowledged: Harness["acknowledged"][number][] = [];
  const machines: ListedMachine[] = [];
  const onSessionsChanged = vi.fn();
  const onSessionEnded = vi.fn();
  const state: { now: number } = { now: 1_000_000 };
  const service = new ComputerUseService({
    ...(options.passwords ? { passwords: options.passwords } : {}),
    ...(options.loginReceiver ? { loginReceiver: options.loginReceiver } : {}),
    ...(options.expireSetupRequests ? { expireSetupRequests: options.expireSetupRequests } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    listMachines: async () =>
      machines.map(({ name, platform, runnerId }) => ({ name, platform, runnerId })),
    hub: {
      acknowledgeComputerUseStop: async (stoppedOn, stop) => {
        acknowledged.push({ runnerId: stoppedOn, ...stop });
        return true;
      },
      attached: () => true,
      machinesFor: () => machines,
      sendComputerUse: async (input) => {
        sent.push(input);
        const gate = pending.shift();
        // A phone answers in a phone's shapes, exactly as its app does.
        const observed = input.definitionId === undefined ? observation() : phoneObservation();
        const next =
          outcomes.shift() ??
          (input.operation === "act"
            ? {
                kind: "ok" as const,
                value: {
                  error: null,
                  ...(input.definitionId === undefined ? {} : { observation: observed }),
                  performed:
                    "actions" in input.params && Array.isArray(input.params.actions)
                      ? input.params.actions.map(() => "Waited 10 ms")
                      : [],
                },
              }
            : { kind: "ok" as const, value: { observation: observed } });
        return { outcome: gate ? gate.then(() => next) : Promise.resolve(next) };
      },
      withRunnerAdmission: async (_runnerId, task) => task(),
    },
    machineOwners: async (runnerIds) =>
      new Map(
        runnerIds.map((runnerId) => [
          runnerId,
          { effectiveOwner: options.owner ?? (callable.ownerUserId as UserId) },
        ]),
      ),
    now: () => state.now,
    onSessionsChanged,
    onSessionEnded,
    authorizer: {
      // The store refuses an ended grant as `forbidden`, as `assertActiveGrant` does.
      assertActiveGrant: async (claims) => {
        await options.grantCheck?.();
        if (!(await (options.runIsActive ?? (async () => true))(claims.runId)))
          throw new OpensteerError({ code: "forbidden", message: "Run tool authority has ended" });
      },
    },
    stops: options.stops ?? durableStops().ledger(),
    threadTitle: options.threadTitle ?? (async () => "Tidy the notes"),
  });
  return {
    acknowledged,
    machines,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    onSessionsChanged,
    onSessionEnded,
    outcomes,
    pending,
    sent,
    service,
  };
}

const runnerId = createId("runner");
const ownerUserId = createId("user");
/** One app on one Mac, the target every test here that is not about a phone operates. */
type AppCallable = ComputerUseMachine & Extract<ComputerUseTarget, { readonly kind: "app" }>;
const callable: AppCallable = {
  access: "read-write",
  app: notes,
  kind: "app",
  ownerUserId,
  runnerId,
  runnerName: "Alex's Mac",
};
const context: ComputerUseContext = {
  aud: "opensteer-integration-tools",
  bindingGeneration: 1,
  capabilityProfileId: "main",
  environmentId: createId("environment"),
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  iss: "opensteer-host",
  jti: "test",
  membershipGeneration: 1,
  requestedBy: ownerUserId,
  runnerBootId: "boot",
  runnerId: createId("runner"),
  runId: createId("run"),
  threadId: createId("thread"),
  workspaceId: createId("workspace"),
};

function otherRun(): ComputerUseContext {
  return { ...context, runId: createId("run") };
}

/** One whole call, the way the gateway makes it: ready, send, then wait. */
async function dispatch(
  service: ComputerUseService,
  target: ComputerUseCallable,
  context: ComputerUseContext,
  send: (lease: ComputerUseLease) => Promise<ComputerUseDispatch>,
): Promise<ComputerUseObservation> {
  const lease = await service.prepare(target, context);
  let sent;
  try {
    sent = await send(lease);
  } finally {
    service.release(lease);
  }
  const result = await sent.settle();
  if (!result.observation) throw result.error ?? new Error("No observation came back.");
  if (result.error) throw result.error;
  if (result.kind !== "app") throw new Error("A Mac's call came back as a phone's.");
  return result.observation;
}

/** Sends one batch and returns before its answer, as the gateway's turn does. */
async function sendAct(
  service: ComputerUseService,
  target: ComputerUseCallable,
  params: unknown,
  context: ComputerUseContext,
): Promise<ComputerUseDispatch> {
  const lease = await service.prepare(target, context);
  try {
    return await service.sendAct(
      lease,
      target,
      { window: "window-1", ...(params as Record<string, unknown>) },
      false,
    );
  } finally {
    service.release(lease);
  }
}

function observe(
  service: ComputerUseService,
  target: ComputerUseCallable,
  context: ComputerUseContext,
  signal?: AbortSignal,
): Promise<ComputerUseObservation> {
  return dispatch(service, target, context, (lease) =>
    service.sendWindowOperation(
      lease,
      target,
      "observe",
      { window: "window-1", includeScreenshot: true },
      signal,
    ),
  );
}

async function act(
  service: ComputerUseService,
  target: ComputerUseCallable,
  params: unknown,
  context: ComputerUseContext,
  signal?: AbortSignal,
) {
  const lease = await service.prepare(target, context);
  try {
    const dispatched = await service.sendAct(
      lease,
      target,
      { window: "window-1", ...(params as Record<string, unknown>) },
      false,
      signal,
    );
    const result = await dispatched.settle();
    if (result.error) throw result.error;
    return result;
  } finally {
    service.release(lease);
  }
}

describe("ComputerUseService", () => {
  let test: Harness;

  beforeEach(() => {
    test = harness();
  });

  it("adds an app the session has not held and counts the actions an act performs", async () => {
    await observe(test.service, callable, context);
    await act(
      test.service,
      { ...callable, app: calendar },
      {
        actions: [
          { type: "click", target: { index: 3 } },
          { keys: "Escape", type: "key" as const },
        ],
        snapshot: "obs-1",
      },
      context,
    );

    const sentAct = test.sent.at(-1);
    expect(sentAct?.operation).toBe("act");
    expect(sentAct?.app).toEqual(calendar);
    expect(sentAct?.timeoutMs).toBe(60_000);
    expect(sentAct?.params).toMatchObject({ snapshot: "obs-1" });
    const session = test.service.sessionsForRunner(runnerId)[0];
    expect(session?.apps).toEqual([notes, calendar]);
    expect(session?.actionCount).toBe(2);
    expect(test.service.sessionsForRunner(runnerId)).toHaveLength(1);
  });

  it("returns the Mac's own sentence when the session belongs to another Host", async () => {
    test.outcomes.push({
      code: "busy",
      kind: "error",
      message: "This Mac is already in use by an agent.",
      retryable: true,
    });

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "busy",
      message: `This Mac is already in use by an agent. ${computerUseBusyNextStep}`,
    });
    // Nothing opened, so nothing is shown as running on that Mac.
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
  });

  it("reports a lost act as outcome-unknown and keeps the session", async () => {
    await observe(test.service, callable, context);
    test.outcomes.push({
      code: "outcome-unknown",
      kind: "error",
      message: "That computer did not answer in time.",
      retryable: false,
    });

    await expect(
      act(
        test.service,
        callable,
        { actions: [{ text: "hello", type: "type" }], snapshot: "obs-1" },
        context,
      ),
    ).rejects.toMatchObject({ code: "outcome-unknown", retryable: false });
    expect(test.service.sessionsForRunner(runnerId)[0]).not.toBeUndefined();
  });

  it("closes the session when its Run ends", async () => {
    await observe(test.service, callable, context);
    const opened = test.sent[0]?.sessionId;

    test.service.closeForRun(context.runId);
    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));

    expect(test.sent.at(-1)?.sessionId).toBe(opened);
    expect(test.sent.at(-1)?.app).toBeNull();
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
  });

  it("closes a session that has been idle for ten minutes", async () => {
    await observe(test.service, callable, context);
    test.now += 9 * 60 * 1_000;
    test.service.sweepIdle();
    expect(test.service.sessionsForRunner(runnerId)[0]).not.toBeUndefined();

    test.now += 2 * 60 * 1_000;
    test.service.sweepIdle();
    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
  });

  it("closes a session when the connection holding one of its apps is removed", async () => {
    await observe(test.service, callable, context);
    const firstSessionId = test.service.sessionsForRunner(runnerId)[0]?.sessionId;

    test.service.closeForConnection(runnerId, { appKey: "com.other.app", kind: "app" });
    expect(test.service.sessionsForRunner(runnerId)[0]).not.toBeUndefined();

    test.service.closeForConnection(runnerId, { appKey: "com.apple.notes", kind: "app" });
    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();

    await observe(test.service, callable, context);
    expect(test.service.sessionsForRunner(runnerId)[0]?.sessionId).not.toBe(firstSessionId);
  });

  it("forgets a Mac's sessions without a close frame when its stream drops", async () => {
    await observe(test.service, callable, context);
    const before = test.sent.length;

    test.service.forgetRunner(runnerId);

    // The desktop closes the helper session bound to that bridge connection,
    // so there is nobody left to send a close to.
    expect(test.sent).toHaveLength(before);
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
  });

  it("lets the Mac's owner stop a session and nobody else", async () => {
    await observe(test.service, callable, context);
    const sessionId = test.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!sessionId) throw new Error("The session was not opened.");

    await expect(test.service.stop(sessionId, createId("user"))).rejects.toBeInstanceOf(
      ComputerUseError,
    );
    expect(test.service.sessionsForRunner(runnerId)[0]).not.toBeUndefined();

    await test.service.stop(sessionId, ownerUserId);
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    await expect(observe(test.service, callable, otherRun())).resolves.toMatchObject({
      snapshot: "obs-1",
    });
  });

  it("applies a native Stop immediately and keeps it across a stream reconnect", async () => {
    await observe(test.service, callable, context);
    const sessionId = test.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!sessionId) throw new Error("The session was not opened.");

    test.service.handleHelperEvent(runnerId, {
      event: "session.stopped",
      params: { reason: "user", sessionId },
    });
    test.service.forgetRunner(runnerId);

    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    // A Mac's Stop names no Run, and its Runner could not parse an acknowledgement.
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.acknowledged).toEqual([]);
  });

  /*
   * A Run now outlives a Host restart, so a person's Stop has to as well:
   * - a Stop held only in memory is gone when the Host restarts, and the
   *   resumed Run opens the Mac again;
   * - a Stop pressed on the Mac itself arrives as a helper event and must be
   *   recorded the same way;
   * - a Stop that could not be recorded must still hold in this Host, and a
   *   client's Stop must say it did not stick;
   * - a Stop outlasting its Run would bind nothing, but must not linger.
   */
  it("keeps a person's Stop through a Host restart until the Run ends", async () => {
    const stops = durableStops();
    const before = harness({ stops: stops.ledger() });
    await observe(before.service, callable, context);
    const sessionId = before.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!sessionId) throw new Error("The session was not opened.");
    await before.service.stop(sessionId, ownerUserId);

    const after = harness({ stops: stops.ledger() });
    await expect(observe(after.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    await expect(observe(after.service, callable, otherRun())).resolves.toMatchObject({
      snapshot: "obs-1",
    });

    after.service.closeForRun(context.runId);
    await vi.waitFor(() => expect(stops.rows.size).toBe(0));
  });

  it("records a Stop pressed on the Mac itself for the next Host", async () => {
    const stops = durableStops();
    const before = harness({ stops: stops.ledger() });
    await observe(before.service, callable, context);
    const sessionId = before.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!sessionId) throw new Error("The session was not opened.");
    before.service.handleHelperEvent(runnerId, {
      event: "session.stopped",
      params: { reason: "user", sessionId },
    });
    await vi.waitFor(() => expect(stops.rows.size).toBe(1));

    const after = harness({ stops: stops.ledger() });
    await expect(observe(after.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
  });

  it("holds a Stop it could not record, tells the client so, and records it later", async () => {
    const onError = vi.fn();
    const stops = durableStops();
    let unavailable = true;
    const unrecordable: ComputerUseStopLedger = {
      ...stops.ledger(),
      record: async (runId, runnerId) => {
        if (unavailable) throw new Error("The database is unavailable");
        await stops.ledger().record(runId, runnerId);
      },
    };
    const test = harness({ onError, stops: unrecordable });
    await observe(test.service, callable, context);
    const sessionId = test.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!sessionId) throw new Error("The session was not opened.");

    await expect(test.service.stop(sessionId, ownerUserId)).rejects.toThrow(
      "The database is unavailable",
    );
    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });

    const other = otherRun();
    await observe(test.service, callable, other);
    const native = test.service
      .sessionsForRunner(runnerId)
      .find((session) => session.runId === other.runId)?.sessionId;
    if (!native) throw new Error("The second session was not opened.");
    test.service.handleHelperEvent(runnerId, {
      event: "session.stopped",
      params: { reason: "user", sessionId: native },
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await expect(observe(test.service, callable, other)).rejects.toMatchObject({
      code: "stopped-by-user",
    });

    // Pressing Stop again records the first; the sweep records the one pressed
    // on the Mac, which nobody can press again.
    unavailable = false;
    await test.service.stop(sessionId, ownerUserId);
    expect([...stops.rows.values()]).toEqual([{ runId: context.runId, runnerId }]);
    test.service.sweep();
    await vi.waitFor(() => expect(stops.rows.size).toBe(2));
  });

  it("makes a second Stop wait for the first one's record", async () => {
    let finish!: (failure?: Error) => void;
    const written = new Promise<void>((resolve, reject) => {
      finish = (failure) => (failure ? reject(failure) : resolve());
    });
    const pending: ComputerUseStopLedger = {
      clear: async () => undefined,
      initial: [],
      record: () => written,
    };
    const test = harness({ stops: pending });
    await observe(test.service, callable, context);
    const sessionId = test.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!sessionId) throw new Error("The session was not opened.");

    const first = test.service.stop(sessionId, ownerUserId);
    let secondSettled = false;
    const second = test.service.stop(sessionId, ownerUserId).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondSettled).toBe(false);

    finish(new Error("The database is unavailable"));
    await expect(first).rejects.toThrow("The database is unavailable");
    await expect(second).rejects.toThrow("The database is unavailable");
  });

  it("publishes a change when a session opens and throttles action counts", async () => {
    await observe(test.service, callable, context);
    expect(test.onSessionsChanged).toHaveBeenCalledTimes(1);

    const batch = { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" };
    await act(test.service, callable, batch, context);
    await act(test.service, callable, batch, context);
    // Two batches inside the same two seconds are one change a person sees.
    expect(test.onSessionsChanged).toHaveBeenCalledTimes(2);

    test.now += 3_000;
    await act(test.service, callable, batch, context);
    expect(test.onSessionsChanged).toHaveBeenCalledTimes(3);
  });

  it("lists only the Macs this person owns that report computer use ready", async () => {
    const other = createId("runner");
    test.machines.push(
      { name: "Alex's Mac", platform: "darwin", runnerId, status: macosApp() },
      { name: "Studio Mac", platform: "darwin", runnerId: other, status: null },
    );

    await expect(test.service.eligibleMachines(ownerUserId, "macos-app")).resolves.toEqual([
      { name: "Alex's Mac", ready: true, state: "ready", runnerId },
      { name: "Studio Mac", ready: false, state: "unavailable", runnerId: other },
    ]);
  });
});

describe("ComputerUseService helper wire fixtures", () => {
  // The Runner forwards the helper's answer untouched, so the exact bytes the
  // Swift side is tested against are the bytes this side has to read.
  const wire = JSON.parse(
    readFileSync(
      new URL(
        "../../../desktop/native/computer-use/Tests/Fixtures/helper-wire.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { readonly results: Record<string, unknown> };

  it("reads session.observe as the helper's result envelope", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: wire.results["session.observe"] as never });

    const observed = await observe(test.service, callable, context);

    expect(observed.snapshot).toBe("9f2c41ab7e0d5638");
    expect(observed.app.bundleId).toBe("com.apple.Notes");
    expect(observed.elementCount).toBe(5);
  });

  it("reads session.act as the same envelope", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: wire.results["session.act"] as never });

    const observed = await act(
      test.service,
      callable,
      { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
      context,
    );

    expect(observed.observation).toBeNull();
    expect(observed.performed).toEqual(expect.any(Array));
  });

  it("reads app.resolve as its result envelope", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: wire.results["app.resolve"] as never });

    await expect(test.service.resolveApp({ app: "Chrome", runnerId })).resolves.toMatchObject({
      allowed: true,
      identity: { bundleId: "com.google.Chrome" },
      risk: "elevated",
    });
  });

  it("reads apps.installed as its result envelope", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: wire.results["apps.installed"] as never });

    const apps = await test.service.installedApps(runnerId, ownerUserId, {
      query: "",
      limit: 50,
      offset: 0,
      icons: false,
    });

    expect(apps.apps.map(({ identity }) => identity.bundleId)).toEqual([
      "com.apple.Notes",
      "com.google.Chrome",
    ]);
  });

  it("refuses a bare observation, which is not what the Runner sends", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: observation() as never });

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "failed",
    });
  });
});

describe("ComputerUseService session lifetime", () => {
  it("opens one session for two concurrent first calls on one Mac", async () => {
    const test = harness();

    await Promise.all([
      observe(test.service, callable, context),
      observe(test.service, callable, context),
    ]);

    expect(test.sent).toHaveLength(2);
    expect(new Set(test.sent.map(({ sessionId }) => sessionId)).size).toBe(1);
    expect(test.service.sessionsForRunner(runnerId)).toHaveLength(1);
  });

  it("closes a session the Mac may already hold when the first call fails", async () => {
    const test = harness();
    test.outcomes.push({
      code: "unsupported",
      kind: "error",
      message: "The Mac is locked; ask the person to unlock it.",
      retryable: false,
    });

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "unsupported",
    });

    // The Runner opens the session before the observe it was asked for, so the
    // Mac can be holding one this side has already given up on.
    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));
    expect(test.sent.at(-1)?.sessionId).toBe(test.sent[0]?.sessionId);
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
  });

  it("closes an unused session after its first app is busy", async () => {
    const test = harness();
    test.outcomes.push({
      code: "busy",
      kind: "error",
      message: "This Mac is already in use by an agent.",
      retryable: true,
    });

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({ code: "busy" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.sent.map(({ operation }) => operation)).toEqual(["observe", "close"]);
  });

  it("closes a session whose Run ended while its first call was in flight", async () => {
    const test = harness();
    // The first observe never answers, so the record is unconfirmed the whole
    // time the Run is ending — which is exactly when the Mac may hold it.
    let release!: () => void;
    test.pending.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const call = observe(test.service, callable, context).catch(() => undefined);
    await vi.waitFor(() => expect(test.sent).toHaveLength(1));

    test.service.closeForRun(context.runId);

    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));
    expect(test.sent.at(-1)?.sessionId).toBe(test.sent[0]?.sessionId);
    release();
    await call;
  });

  it("does not dispatch after the Run ends while the first call reads its title", async () => {
    let resolveTitle!: (title: string | null) => void;
    let active = true;
    const test = harness({
      runIsActive: async () => active,
      threadTitle: () =>
        new Promise((resolve) => {
          resolveTitle = resolve;
        }),
    });

    const call = observe(test.service, callable, context);
    await vi.waitFor(() => expect(resolveTitle).toBeTypeOf("function"));
    active = false;
    test.service.closeForRun(context.runId);
    resolveTitle("Tidy the notes");

    await expect(call).rejects.toMatchObject({
      code: "failed",
      message: "This task's computer-use authority has ended.",
    });
    expect(test.sent).toHaveLength(0);
  });

  it("closes an existing helper session when the authoritative Run check turns terminal", async () => {
    let active = true;
    const test = harness({ runIsActive: async () => active });
    await observe(test.service, callable, context);
    active = false;

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "failed",
      message: "This task's computer-use authority has ended.",
    });

    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));
    expect(test.service.sessionsForRunner(runnerId)[0]).toBeUndefined();
  });

  it("keeps the session when its authority cannot be checked for a moment", async () => {
    let storeAnswers = true;
    const test = harness({
      grantCheck: async () => {
        if (!storeAnswers) throw new Error("connection terminated unexpectedly");
      },
    });
    await observe(test.service, callable, context);
    const before = test.sent.length;
    storeAnswers = false;

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "failed",
      retryable: true,
    });
    expect(test.sent.slice(before).map(({ operation }) => operation)).toEqual([]);
    expect(test.service.sessionsForRunner(runnerId)).toHaveLength(1);

    storeAnswers = true;
    await observe(test.service, callable, context);
    expect(test.sent.slice(before).map(({ operation }) => operation)).toEqual(["observe"]);
  });

  it("counts only completed actions and keeps Mac acts observation-free", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    test.outcomes.push({
      kind: "ok",
      value: {
        error: { code: "failed", message: "The second action failed." },
        performed: ["Waited 10 ms"],
      },
    });

    const dispatched = await sendAct(
      test.service,
      callable,
      {
        actions: [
          { keys: "Escape", type: "key" as const },
          { keys: "Escape", type: "key" as const },
        ],
        snapshot: "obs-1",
      },
      context,
    );
    const result = await dispatched.settle();

    expect(result).toMatchObject({
      error: { code: "failed" },
      observation: null,
      performed: ["Waited 10 ms"],
    });
    expect(test.service.sessionsForRunner(runnerId)[0]?.actionCount).toBe(1);
  });

  it("does not apply a late action result to the replacement session", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    let release!: () => void;
    test.pending.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    test.outcomes.push({
      kind: "ok",
      value: { error: null, performed: ["Waited 10 ms"] },
    });
    const old = await sendAct(
      test.service,
      callable,
      { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
      context,
    );
    test.service.closeForConnection(runnerId, { appKey: "com.apple.notes", kind: "app" });
    await observe(test.service, callable, context);

    release();
    // The batch may have run before the session ended here, so nobody may
    // assume it did not.
    await expect(old.settle()).rejects.toMatchObject({
      code: "outcome-unknown",
      message: "Computer use for this task on Alex's Mac ended before this answer arrived.",
    });
    expect(test.service.sessionsForRunner(runnerId)[0]?.actionCount).toBe(0);
  });

  it("makes an embedded stopped result sticky for the Run and Mac", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    test.outcomes.push({
      kind: "ok",
      value: {
        error: { code: "stopped-by-user", message: "Stopped from the Mac." },
        performed: [],
      },
    });

    const dispatched = await sendAct(
      test.service,
      callable,
      { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
      context,
    );
    await expect(dispatched.settle()).resolves.toMatchObject({
      error: { code: "stopped-by-user" },
    });
    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
  });

  it("treats an unreadable act result as outcome unknown", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: { observation: observation() } });

    await expect(
      act(
        test.service,
        callable,
        { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
        context,
      ),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
  });

  it("cannot read an act result that counts actions instead of describing them", async () => {
    const test = harness();
    test.outcomes.push({
      kind: "ok",
      value: { completedActions: 1, error: null, observation: observation() },
    });

    await expect(
      act(
        test.service,
        callable,
        { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
        context,
      ),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
  });

  it("reports a failing expiry sweep rather than losing it", async () => {
    const onError = vi.fn();
    const test = harness({
      expireSetupRequests: async () => {
        throw new Error("the database is away");
      },
      onError,
    });

    test.service.sweep();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });
});

describe("ComputerUseService thread and run scoping", () => {
  it("stops only the selected task on the selected Mac from another client", async () => {
    const test = harness();
    const otherMac = { ...callable, runnerId: createId("runner"), runnerName: "Office Mac" };
    const otherTask = otherRun();
    try {
      await observe(test.service, callable, context);
      await observe(test.service, otherMac, context);
      await observe(test.service, { ...callable, app: calendar }, otherTask);
      const target = test.service
        .sessionsForRunner(runnerId)
        .find((session) => session.runId === context.runId);
      if (!target) throw new Error("The target session was not opened.");
      const remote = test.service.sessionsForRunner(otherMac.runnerId)[0];
      const before = test.sent.length;

      await test.service.stop(target.sessionId, ownerUserId);

      expect(test.sent.slice(before)).toEqual([
        expect.objectContaining({
          operation: "close",
          runnerId,
          runId: context.runId,
          sessionId: target.sessionId,
        }),
      ]);
      expect(test.service.sessionsForRunner(runnerId).map((session) => session.runId)).toEqual([
        otherTask.runId,
      ]);
      expect(test.service.sessionsForRunner(otherMac.runnerId)).toEqual([remote]);
      await expect(observe(test.service, callable, context)).rejects.toMatchObject({
        code: "stopped-by-user",
      });
      await expect(observe(test.service, otherMac, context)).resolves.toMatchObject({
        snapshot: "obs-1",
      });
      await expect(
        observe(test.service, { ...callable, app: calendar }, otherTask),
      ).resolves.toMatchObject({ snapshot: "obs-1" });
    } finally {
      await test.service.shutdown();
    }
  });

  it("keys sessions by (runId, runnerId)", async () => {
    const test = harness();
    const second = otherRun();
    test.outcomes.push({
      kind: "ok",
      value: { observation: observation() },
    });
    await observe(test.service, callable, context);
    const otherRunner = createId("runner") as RunnerId;
    await observe(test.service, { ...callable, runnerId: otherRunner }, second);

    expect(test.service.sessionsForRunner(runnerId)[0]?.runId).toBe(context.runId);
    expect(test.service.sessionsForRunner(otherRunner)[0]?.runId).toBe(second.runId);
    expect(test.sent.map(({ sessionId }) => sessionId)).toHaveLength(2);
    expect(new Set(test.sent.map(({ sessionId }) => sessionId)).size).toBe(2);
    expect(test.sent[0]?.runId).toBe(context.runId as RunId);
  });
});

describe("per-app sessions", () => {
  it("allows two Runs on different apps and names only the holder of the busy app", async () => {
    const test = harness({
      threadTitle: async (id) => (id === context.threadId ? "Tidy the notes" : "Plan the week"),
    });
    const second = { ...context, runId: createId("run"), threadId: createId("thread") };
    const third = { ...context, runId: createId("run"), threadId: createId("thread") };
    await observe(test.service, { ...callable, app: calendar }, second);
    await observe(test.service, callable, context);
    expect(test.service.sessionsForRunner(runnerId)).toHaveLength(2);
    expect(test.sent[1]?.threadTitle).toBe("Tidy the notes");
    expect(test.service.holders(runnerId)).toEqual(
      new Map([
        [computerAppIdentityKey(calendar), { runId: second.runId, threadTitle: "Plan the week" }],
        [
          computerAppIdentityKey(callable.app),
          { runId: context.runId, threadTitle: "Tidy the notes" },
        ],
      ]),
    );
    test.outcomes.push({
      kind: "error",
      code: "busy",
      message: "This app is already being used by another task.",
      retryable: false,
    });
    await expect(observe(test.service, callable, third)).rejects.toThrow(
      "This app is already being used by another task. (Thread: Tidy the notes)",
    );
    expect(test.service.sessionsForRunner(runnerId)).toHaveLength(2);
    // Busy on a new app leaves the existing Calendar session alive.
    test.outcomes.push({
      kind: "error",
      code: "busy",
      message: "This app is already being used by another task.",
      retryable: false,
    });
    await expect(observe(test.service, callable, second)).rejects.toMatchObject({ code: "busy" });
    expect(
      test.service.sessionsForRunner(runnerId).find(({ runId }) => runId === second.runId)?.apps,
    ).toEqual([calendar]);
    await test.service.shutdown();
  });

  it("handles every stopped event from one pill Stop and fences all affected Runs", async () => {
    const test = harness();
    const second = { ...context, runId: createId("run"), threadId: createId("thread") };
    await observe(test.service, callable, context);
    await observe(test.service, { ...callable, app: calendar }, second);
    for (const { sessionId } of test.service.sessionsForRunner(runnerId)) {
      test.service.handleHelperEvent(runnerId, {
        event: "session.stopped",
        params: { sessionId, reason: "user" },
      });
    }
    expect(test.service.sessionsForRunner(runnerId)).toEqual([]);
    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    await expect(
      observe(test.service, { ...callable, app: calendar }, second),
    ).rejects.toMatchObject({ code: "stopped-by-user" });
    await test.service.shutdown();
  });
});

describe("act observation binding", () => {
  it.each([undefined, null, ""])("refuses snapshot %s before sending", async (snapshot) => {
    const test = harness();
    await expect(
      act(
        test.service,
        callable,
        {
          actions: [{ type: "wait", ms: 1 }],
          ...(snapshot === undefined ? {} : { snapshot }),
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "failed" });
    expect(test.sent).toEqual([]);
    await test.service.shutdown();
  });
});

describe("ComputerUseService call lifecycle", () => {
  it("reads the title while readying a call and reasserts authority immediately before dispatch", async () => {
    const runIsActive = vi.fn(async () => true);
    const threadTitle = vi.fn(async () => "Tidy the notes");
    const test = harness({ runIsActive, threadTitle });

    const lease = await test.service.prepare(callable, context);
    expect(runIsActive).toHaveBeenCalledOnce();
    expect(threadTitle).toHaveBeenCalledOnce();

    const sent = await test.service.sendWindowOperation(lease, callable, "observe", {
      window: "window-1",
      includeScreenshot: true,
    });
    expect(runIsActive).toHaveBeenCalledTimes(2);
    expect(threadTitle).toHaveBeenCalledOnce();
    await sent.settle();
    await test.service.shutdown();
  });

  it("sends each call's one deadline on the frame", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    await act(
      test.service,
      callable,
      { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
      context,
    );

    expect(test.sent.map(({ timeoutMs }) => timeoutMs)).toEqual([
      computerUseDeadlineMs.observe,
      computerUseDeadlineMs.act,
    ]);
    expect(Math.max(computerUseDeadlineMs.observe, computerUseDeadlineMs.act)).toBeLessThanOrEqual(
      computerUseMaxTimeoutMs,
    );
    await test.service.shutdown();
  });

  it("hands the caller's cancellation to the frame and ends only that session when it fires", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    const controller = new AbortController();
    test.outcomes.push({
      abandoned: "cancelled",
      code: "outcome-unknown",
      kind: "error",
      message: "The request was cancelled.",
      retryable: false,
    });

    let answer!: () => void;
    test.pending.push(
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    const pending = act(
      test.service,
      callable,
      { actions: [{ text: "milk", type: "type" }], snapshot: "obs-1" },
      context,
      controller.signal,
    );
    await vi.waitFor(() => expect(test.sent.some((frame) => frame.operation === "act")).toBe(true));
    const forwarded = test.sent.find((frame) => frame.operation === "act")?.signal;
    expect(forwarded?.aborted).toBe(false);
    controller.abort();
    expect(forwarded?.aborted).toBe(true);
    answer();
    await expect(pending).rejects.toMatchObject({ code: "outcome-unknown", retryable: false });
    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("close"));
    expect(test.service.sessionsForRunner(runnerId)).toEqual([]);
    // Unlike Stop, the Run may use the Mac again: the next call opens anew.
    await expect(observe(test.service, callable, context)).resolves.toMatchObject({
      snapshot: "obs-1",
    });
    await test.service.shutdown();
  });

  it("asks for a fresh observation when a read is given up on", async () => {
    const test = harness();
    test.outcomes.push({
      abandoned: "deadline",
      code: "failed",
      kind: "error",
      message: "That computer did not answer in time.",
      retryable: true,
    });

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "failed",
      message:
        "That computer did not answer in time. Observe the app again before deciding what to do next.",
    });
    await test.service.shutdown();
  });

  it("leaves a session with a call in flight to the idle sweep's next pass", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    let answer!: () => void;
    test.pending.push(
      new Promise<void>((resolve) => {
        answer = resolve;
      }),
    );
    const inFlight = act(
      test.service,
      callable,
      { actions: [{ keys: "Escape", type: "key" as const }], snapshot: "obs-1" },
      context,
    );
    await vi.waitFor(() => expect(test.sent.at(-1)?.operation).toBe("act"));

    test.now += 11 * 60 * 1_000;
    test.service.sweepIdle();
    expect(test.service.sessionsForRunner(runnerId)).toHaveLength(1);

    answer();
    await expect(inFlight).resolves.toMatchObject({
      observation: null,
      performed: ["Waited 10 ms"],
    });
    expect(test.sent.some(({ operation }) => operation === "close")).toBe(false);
    await test.service.shutdown();
  });

  it("tells the model to observe again when the Mac no longer holds the session", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    test.outcomes.push({
      code: "no-session",
      kind: "error",
      message: "No such session.",
      retryable: false,
    });

    await expect(observe(test.service, callable, context)).rejects.toMatchObject({
      code: "no-session",
      message:
        "Computer use for this task on Alex's Mac ended before this call ran. Observe the app again to continue.",
    });
    await test.service.shutdown();
  });

  it("opens a fresh session after the Mac ends one on its own, without calling it a Stop", async () => {
    const test = harness();
    await observe(test.service, callable, context);
    const ended = test.service.sessionsForRunner(runnerId)[0]?.sessionId;
    if (!ended) throw new Error("The session was not opened.");

    // A hop whose wait ran out closes that one session and says so this way.
    test.service.handleHelperEvent(runnerId, {
      event: "session.stopped",
      params: { reason: "app-quit", sessionId: ended },
    });

    expect(test.service.sessionsForRunner(runnerId)).toEqual([]);
    await expect(observe(test.service, callable, context)).resolves.toMatchObject({
      snapshot: "obs-1",
    });
    expect(test.sent.at(-1)?.sessionId).not.toBe(ended);
    await test.service.shutdown();
  });

  it("forgets a readied session whose call never sent", async () => {
    const test = harness();

    const lease = await test.service.prepare(callable, context);
    test.service.release(lease);
    const next = await test.service.prepare(callable, context);

    expect(next.sessionId).not.toBe(lease.sessionId);
    test.service.release(next);
    expect(test.sent).toEqual([]);
    await test.service.shutdown();
  });

  it("names each refused field and says how to fix the batch", async () => {
    const test = harness();

    await expect(
      act(
        test.service,
        callable,
        {
          actions: [
            { keys: "Escape", type: "key" as const },
            { button: "left", count: 1, type: "click" },
          ],
          snapshot: "obs-1",
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "failed",
      message: expect.stringMatching(
        /^Those actions are not usable — actions\[1\]\.[a-z]+: .+\. Correct those fields as the computer tool describes, observe this window again, and act on its snapshot\.$/u,
      ),
    });
    expect(test.sent).toEqual([]);
    await test.service.shutdown();
  });
});

/*
 * A phone is held whole by one Run, and this Host decides that before a
 * frame leaves. What goes wrong otherwise:
 * - a second Run's frame reaches a busy phone, which can only say "busy"
 *   without naming whose task holds it;
 * - two Runs both find the phone free when their calls interleave;
 * - a first frame that never reached the phone, or that it refused, keeps
 *   the phone reserved for a session that does not exist, until the idle sweep;
 * - a forgotten hold blocks every other task for a Mac's ten minutes;
 * - releasing frees nothing, or fails a task that held nothing;
 * - taking the phone's access back leaves its session running, or ends
 *   another Workspace's;
 * - a Mac's actions, or an unbounded batch, reach the phone; a Mac-shaped
 *   answer is read as a phone's;
 * - a frame to a phone names an app or omits its definition, or a frame to a
 *   Mac gains a definition it never had;
 * - watching the phone renews the hold.
 */
describe("display sessions on an Android phone", () => {
  const phoneId = createId("runner");
  type DisplayCallable = ComputerUseMachine &
    Extract<ComputerUseTarget, { readonly kind: "display" }>;
  const phone: DisplayCallable = {
    access: "read-write",
    definitionId: "android-phone",
    kind: "display",
    ownerUserId,
    runnerId: phoneId,
    runnerName: "Pixel 8",
  };

  async function observePhone(
    service: ComputerUseService,
    on: ComputerUseContext,
  ): Promise<AndroidPhoneObservation> {
    const lease = await service.prepare(phone, on);
    let sent;
    try {
      sent = await service.sendObserve(lease, phone, true);
    } finally {
      service.release(lease);
    }
    const result = await sent.settle();
    if (result.error) throw result.error;
    if (result.kind !== "display" || !result.observation) throw new Error("Expected a phone.");
    return result.observation;
  }

  async function actOnPhone(service: ComputerUseService, params: unknown, on = context) {
    const lease = await service.prepare(phone, on);
    try {
      return await service.sendAct(lease, phone, params, true);
    } finally {
      service.release(lease);
    }
  }

  function titled() {
    return harness({
      threadTitle: async (id) => (id === context.threadId ? "Reply to the driver" : "Order lunch"),
    });
  }

  it("lets the phone go when the first Run's frame never reached it", async () => {
    const test = titled();
    test.outcomes.push({
      code: "offline",
      kind: "error",
      message: "That computer is offline.",
      retryable: true,
    });
    await expect(observePhone(test.service, context)).rejects.toMatchObject({ code: "offline" });

    const second = { ...context, runId: createId("run"), threadId: createId("thread") };
    await expect(observePhone(test.service, second)).resolves.toMatchObject({
      observationId: "phone-obs-1",
    });
    // Nothing reached the phone the first time, so there was nothing to close.
    expect(test.sent.map(({ operation }) => operation)).toEqual(["observe", "observe"]);
    await test.service.shutdown();
  });

  it("lets the phone go, and closes what the phone may hold, when the phone refuses the first frame", async () => {
    const test = titled();
    test.outcomes.push({
      code: "permission-required",
      kind: "error",
      message: "The Opensteer accessibility service is off.",
      retryable: false,
    });
    await expect(observePhone(test.service, context)).rejects.toMatchObject({
      code: "permission-required",
    });
    await vi.waitFor(() =>
      expect(test.sent.map(({ operation }) => operation)).toEqual(["observe", "close"]),
    );
    expect(test.sent[1]).toMatchObject({ app: null, definitionId: "android-phone" });

    const second = { ...context, runId: createId("run"), threadId: createId("thread") };
    await expect(observePhone(test.service, second)).resolves.toMatchObject({
      observationId: "phone-obs-1",
    });
    await test.service.shutdown();
  });

  /**
   * The phone can receive another old-session observe before its unsolicited
   * Stop reaches the Host. Forgetting the record alone strands that reopened
   * hold; the matching Close must be admitted before the next Run observes.
   */
  it("acknowledges a phone's local Stop with a matching Close before the next holder", async () => {
    const test = titled();
    await observePhone(test.service, context);
    const [held] = test.service.sessionsForRunner(phoneId);
    if (!held) throw new Error("The phone session was not opened.");
    test.service.handleHelperEvent(phoneId, {
      event: "session.stopped",
      params: { reason: "user", sessionId: held.sessionId },
    });
    expect(test.service.sessionsForRunner(phoneId)).toEqual([]);
    await expect(observePhone(test.service, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    const next = otherRun();
    await observePhone(test.service, next);
    expect(test.sent.map(({ operation, runId }) => [operation, runId])).toEqual([
      ["observe", context.runId],
      ["close", context.runId],
      ["observe", next.runId],
    ]);
    expect(test.sent[1]).toMatchObject({
      app: null,
      definitionId: "android-phone",
      sessionId: held.sessionId,
    });
    // A repeated old Stop has no authority over the next holder.
    test.service.handleHelperEvent(phoneId, {
      event: "session.stopped",
      params: { reason: "user", sessionId: held.sessionId },
    });
    expect(test.service.sessionsForRunner(phoneId).map(({ runId }) => runId)).toEqual([next.runId]);
    expect(test.sent).toHaveLength(3);
    await test.service.shutdown();
  });

  /**
   * The phone's stream can drop before its owner's Stop is reported, and the
   * Host forgets every session of a computer whose stream is gone. The phone
   * names the Run in the Stop it sends again on its next stream, so the Stop
   * still holds for that Run here, durably, and for nobody else.
   */
  it("holds a phone owner's Stop that arrives after the Host forgot its session", async () => {
    const stops = durableStops();
    const test = harness({ stops: stops.ledger() });
    await observePhone(test.service, context);
    const [held] = test.service.sessionsForRunner(phoneId);
    if (!held) throw new Error("The phone session was not opened.");
    test.service.forgetRunner(phoneId);

    test.service.handleHelperEvent(phoneId, {
      event: "session.stopped",
      params: { reason: "user", runId: context.runId, sessionId: held.sessionId },
    });

    await vi.waitFor(() =>
      expect([...stops.rows.values()]).toEqual([{ runId: context.runId, runnerId: phoneId }]),
    );
    await expect(observePhone(test.service, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    await observePhone(test.service, otherRun());
    await test.service.shutdown();
  });

  it.each(["run", "runner"] as const)(
    "keeps colliding session IDs separate when the %s differs, including failed-write retries",
    async (difference) => {
      const stops = durableStops();
      const ledger = stops.ledger();
      const firstWrite = Promise.withResolvers<void>();
      const secondWrite = Promise.withResolvers<void>();
      const onError = vi.fn();
      const record = vi
        .fn(ledger.record)
        .mockImplementationOnce(async (runId, runnerId) => {
          await firstWrite.promise;
          await ledger.record(runId, runnerId);
        })
        .mockImplementationOnce(async (runId, runnerId) => {
          await secondWrite.promise;
          await ledger.record(runId, runnerId);
        });
      const test = harness({ onError, stops: { ...ledger, record } });
      const sessionId = mintComputerUseSessionId();
      const first = { runId: context.runId, runnerId: phoneId, sessionId };
      const second = {
        runId: difference === "run" ? createId("run") : context.runId,
        runnerId: difference === "runner" ? createId("runner") : phoneId,
        sessionId,
      };
      const report = (stop: typeof first) =>
        test.service.handleHelperEvent(stop.runnerId, {
          event: "session.stopped",
          params: { reason: "user", runId: stop.runId, sessionId: stop.sessionId },
        });

      report(first);
      report(second);
      report(first);
      expect(record).toHaveBeenCalledTimes(2);
      expect(test.acknowledged).toEqual([]);

      firstWrite.resolve();
      await vi.waitFor(() => expect(test.acknowledged).toEqual([first]));
      expect([...stops.rows.values()]).toEqual([{ runId: first.runId, runnerId: first.runnerId }]);
      secondWrite.reject(new Error("Temporary second Stop-ledger outage"));
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());
      expect(test.acknowledged).toEqual([first]);

      test.service.sweep();
      await vi.waitFor(() => expect(test.acknowledged).toEqual([first, second]));
      expect(record).toHaveBeenCalledTimes(3);
      expect([...stops.rows.values()]).toEqual([
        { runId: first.runId, runnerId: first.runnerId },
        { runId: second.runId, runnerId: second.runnerId },
      ]);
      await test.service.shutdown();
    },
  );

  it("retries a forgotten phone Stop the ledger could not record, and only then acknowledges it", async () => {
    const stops = flakyStops(1);
    const test = harness({ onError: () => undefined, stops: stops.ledger() });
    await observePhone(test.service, context);
    const [held] = test.service.sessionsForRunner(phoneId);
    if (!held) throw new Error("The phone session was not opened.");
    test.service.forgetRunner(phoneId);

    test.service.handleHelperEvent(phoneId, {
      event: "session.stopped",
      params: { reason: "user", runId: context.runId, sessionId: held.sessionId },
    });
    await vi.waitFor(() => expect(stops.rows.size).toBe(0));
    expect(test.acknowledged).toEqual([]);
    // Held here already: the Run may not use the phone meanwhile.
    await expect(observePhone(test.service, context)).rejects.toMatchObject({
      code: "stopped-by-user",
    });

    test.service.sweep();
    await vi.waitFor(() =>
      expect(test.acknowledged).toEqual([
        { runId: context.runId, runnerId: phoneId, sessionId: held.sessionId },
      ]),
    );
    expect([...stops.rows.values()]).toEqual([{ runId: context.runId, runnerId: phoneId }]);
    await test.service.shutdown();
  });

  it("acknowledges a phone's Stop for a session it still holds once recorded, and again when re-sent", async () => {
    const stops = durableStops();
    const test = harness({ stops: stops.ledger() });
    await observePhone(test.service, context);
    const [held] = test.service.sessionsForRunner(phoneId);
    if (!held) throw new Error("The phone session was not opened.");
    const stopped = {
      event: "session.stopped",
      params: { reason: "user", runId: context.runId, sessionId: held.sessionId },
    } as const;

    test.service.handleHelperEvent(phoneId, stopped);
    await vi.waitFor(() => expect(test.acknowledged).toHaveLength(1));
    expect([...stops.rows.values()]).toEqual([{ runId: context.runId, runnerId: phoneId }]);

    // The acknowledgement was lost with its stream; the phone reports the Stop again.
    test.service.handleHelperEvent(phoneId, stopped);
    await vi.waitFor(() => expect(test.acknowledged).toHaveLength(2));
    expect(test.acknowledged[1]).toEqual({
      runId: context.runId,
      runnerId: phoneId,
      sessionId: held.sessionId,
    });
    await test.service.shutdown();
  });

  it("holds nothing for a forgotten phone session that ended on its own", async () => {
    const stops = durableStops();
    const test = harness({ stops: stops.ledger() });
    await observePhone(test.service, context);
    const [held] = test.service.sessionsForRunner(phoneId);
    if (!held) throw new Error("The phone session was not opened.");
    test.service.forgetRunner(phoneId);

    test.service.handleHelperEvent(phoneId, {
      event: "session.stopped",
      params: { reason: "app-quit", runId: context.runId, sessionId: held.sessionId },
    });

    await observePhone(test.service, context);
    expect(stops.rows.size).toBe(0);
    await test.service.shutdown();
  });

  it("ends a phone session when its access is taken back, in that Workspace only", async () => {
    const test = harness();
    await observePhone(test.service, context);

    test.service.closeForConnection(phoneId, { appKey: "com.apple.notes", kind: "app" });
    test.service.closeForConnection(
      phoneId,
      { definitionId: "android-phone", kind: "display" },
      createId("workspace"),
    );
    expect(test.service.sessionsForRunner(phoneId)).toHaveLength(1);

    test.service.closeForConnection(
      phoneId,
      { definitionId: "android-phone", kind: "display" },
      context.workspaceId,
    );
    expect(test.service.sessionsForRunner(phoneId)).toEqual([]);
    await vi.waitFor(() => expect(test.sent.at(-1)).toMatchObject({ operation: "close" }));
    await test.service.shutdown();
  });

  it("judges a phone's batch by the phone's actions and counts what it performed", async () => {
    const test = harness();
    await observePhone(test.service, context);

    await expect(
      actOnPhone(test.service, {
        actions: [{ target: { index: 1 }, type: "click" }],
        observationId: "phone-obs-1",
      }),
    ).rejects.toMatchObject({
      code: "failed",
      message: expect.stringContaining("observe the phone again, and act on its observationId"),
    });
    await expect(
      actOnPhone(test.service, {
        actions: Array.from({ length: 9 }, () => ({ ms: 5_000, type: "wait" })),
        observationId: "phone-obs-1",
      }),
    ).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("40000 ms") });
    expect(test.sent.map(({ operation }) => operation)).toEqual(["observe"]);

    const sent = await actOnPhone(test.service, {
      actions: [{ type: "wake" }, { target: { index: 1 }, type: "tap" }],
      observationId: "phone-obs-1",
    });
    await expect(sent.settle()).resolves.toMatchObject({
      error: null,
      kind: "display",
      performed: ["Waited 10 ms", "Waited 10 ms"],
    });
    expect(test.sent.at(-1)).toMatchObject({
      app: null,
      definitionId: "android-phone",
      operation: "act",
      params: {
        actions: [{ type: "wake" }, { count: 1, target: { index: 1 }, type: "tap" }],
        includeScreenshot: true,
        observationId: "phone-obs-1",
      },
    });
    expect(test.service.sessionsForRunner(phoneId)).toEqual([
      expect.objectContaining({ actionCount: 2, apps: [], display: true, runId: context.runId }),
    ]);
    await test.service.shutdown();
  });

  it("refuses a Mac-shaped answer from a phone rather than reading it as one", async () => {
    const test = harness();
    test.outcomes.push({ kind: "ok", value: { observation: observation() } });

    await expect(observePhone(test.service, context)).rejects.toMatchObject({
      code: "failed",
      message:
        "That phone answered with an observation this Host cannot read. Update the Opensteer Agent Phone app there.",
    });
    await test.service.shutdown();
  });

  it.each(["idle", "runner", "shutdown"] as const)(
    "ends display demand once on %s teardown",
    async (cause) => {
      const test = harness();
      await observePhone(test.service, context);
      const session = test.service.sessionsForRunner(phoneId)[0]!;
      if (cause === "idle") {
        test.now += 181_000;
        test.service.sweepIdle();
      }
      if (cause === "runner") test.service.forgetRunner(phoneId);
      await test.service.shutdown();
      expect(test.onSessionEnded).toHaveBeenCalledExactlyOnceWith(session.sessionId);
    },
  );
  // Display failures: wrong session/effective owner; passive renewal; input DB reads;
  // renewal after a session ended; revocation not detected by periodic admission.
  it("refuses display admission after effective ownership changes", async () => {
    const test = harness({ owner: createId("user") });
    await observePhone(test.service, context);
    const session = test.service.sessionsForRunner(phoneId)[0]!;
    await expect(
      test.service.authorizeDisplay(session.sessionId, ownerUserId),
    ).rejects.toMatchObject({
      constructor: ComputerUseError,
      code: "unsupported",
      message: "Only this computer's owner can do that.",
    });
    await test.service.shutdown();
  });
  it.each(["session", "machine"] as const)(
    "refuses a viewer through the real service's %s owner gate",
    async (gate) => {
      const stranger = createId("user");
      const test = harness(gate === "machine" ? { owner: stranger } : {});
      await observePhone(test.service, context);
      const session = test.service.sessionsForRunner(phoneId)[0]!;
      const displayStream = vi.fn(() => null);
      const hub = new DisplayStreamHub({
        computerUse: test.service,
        computerViews: {
          authorizeDisplay: async () => {
            throw new Error("No owner lease");
          },
          isDisplayLive: () => false,
          endDisplaySource: () => undefined,
        },
        computerApps: {
          resolveDisplay: vi.fn(),
          displayStream,
          sendDisplay: vi.fn(async () => false),
        },
        authenticator: { issueDisplayDataTicket: vi.fn(), verifyDisplayDataTicket: vi.fn() },
      });
      try {
        await expect(
          hub.attachViewer(
            { kind: "task-session", sessionId: session.sessionId },
            gate === "session" ? stranger : ownerUserId,
            {} as WebSocket,
          ),
        ).rejects.toMatchObject({
          constructor: ComputerUseError,
          code: "unsupported",
          message: "Only this computer's owner can do that.",
          retryable: false,
        });
        expect(displayStream).not.toHaveBeenCalled();
      } finally {
        hub.close();
        await test.service.shutdown();
      }
    },
  );
  it("authorizes display ownership and live grants without renewing passive demand", async () => {
    let active = true;
    const test = harness({ runIsActive: async () => active });
    await observePhone(test.service, context);
    const session = test.service.sessionsForRunner(phoneId)[0]!;
    await expect(
      test.service.authorizeDisplay(session.sessionId, createId("user")),
    ).rejects.toMatchObject({
      constructor: ComputerUseError,
      code: "unsupported",
      message: "Only this computer's owner can do that.",
    });
    test.now += 120_000;
    await expect(test.service.authorizeDisplay(session.sessionId, ownerUserId)).resolves.toBe(
      phoneId,
    );
    test.now += 61_000;
    test.service.sweepIdle();
    expect(test.service.isDisplaySessionLive(session.sessionId, phoneId)).toBe(false);
    await observePhone(test.service, context);
    const next = test.service.sessionsForRunner(phoneId)[0]!;
    test.now += 120_000;
    expect(test.service.noteOwnerActivity(next.sessionId)).toBeUndefined();
    test.now += 61_000;
    test.service.sweepIdle();
    expect(test.service.isDisplaySessionLive(next.sessionId, phoneId)).toBe(true);
    active = false;
    await expect(test.service.authorizeDisplay(next.sessionId, ownerUserId)).rejects.toMatchObject({
      constructor: ComputerUseError,
      code: "failed",
      message: "This task's computer-use authority has ended.",
    });
    expect(() => test.service.noteOwnerActivity(next.sessionId)).toThrow(
      "That phone session has ended.",
    );
    expect(test.service.isDisplaySessionLive(next.sessionId, phoneId)).toBe(false);
    await test.service.shutdown();
  });

  it("renews owner input synchronously without consulting the grant store", async () => {
    const grant = vi.fn(async () => true);
    const test = harness({ runIsActive: grant });
    await observePhone(test.service, context);
    const session = test.service.sessionsForRunner(phoneId)[0]!;
    grant.mockClear();
    test.now += 120_000;
    expect(test.service.noteOwnerActivity(session.sessionId)).toBeUndefined();
    expect(grant).not.toHaveBeenCalled();
    test.now += 61_000;
    test.service.sweepIdle();
    expect(test.service.isDisplaySessionLive(session.sessionId, phoneId)).toBe(true);
    test.service.forgetRunner(phoneId);
    expect(() => test.service.noteOwnerActivity(session.sessionId)).toThrow(
      "That phone session has ended.",
    );
    await test.service.shutdown();
  });

  it("lists phones for the phone definition and Macs for the Mac's", async () => {
    const test = harness();
    test.machines.push(
      { name: "Alex's Mac", platform: "darwin", runnerId, status: macosApp() },
      {
        name: "Pixel 8",
        platform: "android",
        runnerId: phoneId,
        status: {
          definitionId: "android-phone",
          operations: [
            {
              detail: "Paused on the phone",
              operation: "observe",
              remedy: null,
              state: "unavailable",
            },
          ],
        },
      },
    );

    await expect(test.service.eligibleMachines(ownerUserId, "android-phone")).resolves.toEqual([
      { name: "Pixel 8", ready: false, runnerId: phoneId, state: "unavailable" },
    ]);
    await expect(test.service.eligibleMachines(ownerUserId, "macos-app")).resolves.toEqual([
      { name: "Alex's Mac", ready: true, runnerId, state: "ready" },
    ]);
  });
});

// No batch may leave the Host until every saved field is sealed and all live fences still hold.
describe("saved login batch admission", () => {
  const receiver = {
    version: 1 as const,
    connectionId: "receiver-1",
    connectionGeneration: 1,
    publicKey: "B" + "A".repeat(86),
  };
  const loginRef = "lgn_" + "1".repeat(32);
  const savedActions = [
    { type: "type", text: { loginRef, field: "username" } },
    { type: "type", text: { loginRef, field: "password" } },
  ];
  function authority() {
    return {
      validateLease: vi.fn(() => true),
      seal: vi.fn<NonNullable<ComputerUseServiceOptions["passwords"]>["seal"]>(async (input) => ({
        type: "login.seal.result",
        status: "sealed",
        envelope: {
          binding: input.binding,
          senderPublicKey: receiver.publicKey,
          salt: "A".repeat(43),
          nonce: "A".repeat(16),
          ciphertext: "",
          tag: "A".repeat(22),
        },
      })),
    };
  }
  for (const kind of ["app", "display"] as const) {
    const firstAction =
      kind === "app"
        ? { type: "click", target: { index: 0 }, button: "left", count: 1 }
        : { type: "tap", target: { index: 0 }, count: 1 };
    const actions = [firstAction, ...savedActions];
    const batch =
      kind === "app"
        ? { window: "window-1", snapshot: "obs-1", actions }
        : { observationId: "obs-1", actions };
    const target: ComputerUseTarget =
      kind === "app"
        ? callable
        : { kind: "display", access: "read-write", definitionId: "android-phone" };
    it(`${kind}: refuses old hops before an early visible action`, async () => {
      const passwords = authority();
      const h = harness({ passwords });
      try {
        const lease = await h.service.prepare(callable, context);
        await expect(h.service.sendAct(lease, target, batch, false)).rejects.toMatchObject({
          code: "unsupported",
          message: expect.stringMatching(/update/i),
        });
        expect(h.sent).toEqual([]);
        expect(passwords.seal).not.toHaveBeenCalled();
      } finally {
        await h.service.shutdown();
      }
    });
    it(`${kind}: sends ciphertext with reserved act identity only after all fields seal`, async () => {
      const passwords = authority();
      const h = harness({ passwords, loginReceiver: () => receiver });
      try {
        const lease = await h.service.prepare(callable, context);
        const sent = await h.service.sendAct(lease, target, batch, false);
        const result = await sent.settle();
        expect(result.performed).toEqual([
          "Waited 10 ms",
          "Typed saved username",
          "Typed saved password",
        ]);
        expect(passwords.seal).toHaveBeenCalledTimes(2);
        const frame = h.sent[0]!;
        expect(frame.params.loginContext).toEqual({ runId: context.runId, actId: frame.requestId });
        expect(frame.params.actions).toEqual([
          actions[0],
          expect.objectContaining({ text: { sealed: expect.any(Object) } }),
          expect.objectContaining({ text: { sealed: expect.any(Object) } }),
        ]);
        expect(JSON.stringify(frame)).not.toContain(loginRef);
        expect(passwords.seal.mock.calls[0]?.[0]).toMatchObject({
          workspaceId: context.workspaceId,
          binding: {
            runId: context.runId,
            sessionId: lease.sessionId,
            actId: frame.requestId,
            actionIndex: 1,
            field: "username",
          },
        });
      } finally {
        await h.service.shutdown();
      }
    });
    for (const failure of [
      "lease",
      "second-seal",
      "receiver-replaced",
      "run-ended",
      "lease-revoked",
      "aborted",
      "expired",
    ] as const) {
      it(`${kind}: ${failure} performs no actions`, async () => {
        const passwords = authority();
        let key = receiver;
        let active = true;
        const abort = new AbortController();
        const h = harness({ passwords, loginReceiver: () => key, runIsActive: async () => active });
        if (failure === "lease") passwords.validateLease.mockReturnValue(false);
        const seal = passwords.seal.getMockImplementation()!;
        passwords.seal.mockImplementation(async (input) => {
          if (failure === "second-seal" && input.binding.field === "password")
            return { type: "login.seal.result", status: "denied" };
          const result = await seal(input);
          if (failure === "receiver-replaced") key = { ...receiver, connectionGeneration: 2 };
          if (failure === "run-ended") active = false;
          if (failure === "lease-revoked") passwords.validateLease.mockReturnValue(false);
          if (failure === "aborted") abort.abort();
          if (failure === "expired") h.now += 60_000;
          return result;
        });
        try {
          const lease = await h.service.prepare(callable, context);
          await expect(
            h.service.sendAct(lease, target, batch, false, abort.signal),
          ).rejects.toBeInstanceOf(ComputerUseError);
          expect(h.sent.filter((frame) => frame.operation === "act")).toEqual([]);
        } finally {
          await h.service.shutdown();
        }
      });
    }
  }
});
