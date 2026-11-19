import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { RunnerAuxiliaryFrameFence, DeviceScreenDriverAssignment } from "@opensteer/protocol";
import {
  IphoneScreenObservationResultSchema,
  IphoneScreenActResultSchema,
  ComputerUseSessionIdSchema,
  RunnerAuxiliaryRequestIdSchema,
} from "@opensteer/protocol";
import {
  iphoneRunnerResults,
  type IphoneRunnerEvent,
  type IphoneRunnerMethod,
  type IphoneRunnerParams,
  type IphoneRunnerResult,
  type IphoneNativeObservation,
} from "@opensteer/protocol/iphone-bridge";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import {
  IphoneScreenDriver,
  iphoneCapabilityReason,
  type IphoneScreenBridge,
} from "./iphone-screen-driver.js";
import { phoneTree } from "./phone-tree.js";
import type { PhoneScreenContext, PhoneScreenDriverEvent } from "./phone-screen-driver.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function startedWithin(promise: Promise<void>) {
  return withTimeout(promise, 1000, {
    timeoutError: () => new Error("The fake native operation never started"),
  });
}

function native(overrides: Partial<IphoneNativeObservation> = {}): IphoneNativeObservation {
  return {
    observationToken: "native-observation",
    nativeEpoch: 1,
    geometryRevision: 1,
    geometry: {
      width: 100,
      height: 200,
      captureWidth: 300,
      captureHeight: 600,
      rotation: 0,
      displayId: 0,
    },
    state: { lock: "unlocked", display: "on", rotation: 0, displayId: 0 },
    foreground: { appId: "example.app", label: "Example" },
    buttons: ["home", "lock"],
    nodes: [
      {
        nodeId: "node",
        parent: null,
        depth: 0,
        role: "button",
        label: 'Send\n"now"',
        frame: { x: 2, y: 3, width: 10, height: 20 },
        enabled: true,
        focused: null,
        selected: null,
        editable: "unknown",
        secure: "unknown",
      },
    ],
    coverage: {
      coordinateSpace: "unqualified",
      status: "partial",
      reason: "quiet-window",
      received: 2,
      returned: 1,
      missingFrames: 0,
      missingChildren: 1,
      unreturned: 1,
      cycles: 0,
      truncated: false,
    },
    textReason: "unsupported-text",
    clearReason: "unsupported-clear",
    screenshot: { mimeType: "image/jpeg", base64: "test", width: 100, height: 200 },
    ...overrides,
  };
}

class Bridge implements IphoneScreenBridge {
  readonly events = new Set<(event: IphoneRunnerEvent) => void>();
  readonly connections = new Set<(state: "connected" | "lost") => void>();
  readonly effects: IphoneRunnerParams<"iphone.perform">[] = [];
  readonly assignments: IphoneRunnerParams<"iphone.targets">[] = [];
  readonly sessions = new Set<string>();
  readonly cancelled: string[] = [];
  observation = native();
  readonly replies = new Map<
    IphoneRunnerMethod,
    (params: unknown, options: { deadline: number; signal?: AbortSignal }) => Promise<unknown>
  >();
  async iphoneRequest<M extends IphoneRunnerMethod>(
    method: M,
    params: IphoneRunnerParams<M>,
    options: { deadline: number; signal?: AbortSignal },
  ): Promise<IphoneRunnerResult<M>> {
    if (method === "iphone.perform") {
      const perform = params as IphoneRunnerParams<"iphone.perform">;
      if (
        perform.geometryRevision !== this.observation.geometryRevision ||
        perform.nativeEpoch !== this.observation.nativeEpoch
      )
        return iphoneRunnerResults[method].parse({
          error: { code: "stale-observation", effect: "not-started", completedSteps: 0 },
        }) as IphoneRunnerResult<M>;
      this.effects.push(perform);
    }
    if (method === "iphone.targets")
      this.assignments.push(params as IphoneRunnerParams<"iphone.targets">);
    if (method === "iphone.cancel" || method === "iphone.session.close") {
      const session = params as IphoneRunnerParams<"iphone.cancel">;
      this.cancelled.push(session.sessionId);
      this.sessions.delete(session.sessionId);
    }
    const custom = this.replies.get(method);
    let result: unknown;
    if (custom) result = await custom(params, options);
    else
      switch (method) {
        case "iphone.targets":
          result = {
            targets: (params as IphoneRunnerParams<"iphone.targets">).assignments.map((a) => ({
              deviceId: a.deviceId,
              driverGeneration: a.generation,
              nativeEpoch: 1,
              ready: true,
              reason: null,
            })),
          };
          break;
        case "iphone.session.open":
          this.sessions.add((params as IphoneRunnerParams<"iphone.session.open">).sessionId);
          result = { nativeEpoch: 1 };
          break;
        case "iphone.observe":
          result = this.observation;
          break;
        case "iphone.perform":
          result = {
            effect: "submitted",
            completedSteps: this.effects.at(-1)!.actions.length,
            observationRequired: true,
          };
          break;
        case "iphone.installedApps":
          result = { apps: [{ appId: "example.app", label: "Example" }], total: 1, offset: 0 };
          break;
        case "iphone.media":
          result = { available: false, reason: "unsupported" };
          break;
        default:
          result = {};
      }
    return iphoneRunnerResults[method].parse(result) as IphoneRunnerResult<M>;
  }
  onIphoneEvent(listener: (event: IphoneRunnerEvent) => void) {
    this.events.add(listener);
    return () => {
      this.events.delete(listener);
    };
  }
  onIphoneConnection(listener: (state: "connected" | "lost") => void) {
    this.connections.add(listener);
    return () => {
      this.connections.delete(listener);
    };
  }
  target(deviceId: string, nativeEpoch = 1, reason: "phone-locked" | null = null) {
    for (const listener of this.events)
      listener({
        kind: "event",
        event: "iphone.targetsChanged",
        params: { deviceId, driverGeneration: 1, nativeEpoch, ready: reason === null, reason },
      });
  }
}

const drivers: IphoneScreenDriver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.shutdown();
  vi.useRealTimers();
});
function fixture() {
  const bridge = new Bridge();
  let now = 1_800_000_000_000;
  const driver = new IphoneScreenDriver({ bridge, now: () => now });
  drivers.push(driver);
  const events: PhoneScreenDriverEvent[] = [];
  const connection = driver.connect({
    fence: { runnerId: createId("runner") } as RunnerAuxiliaryFrameFence,
    emit: async (event) => {
      events.push(event);
    },
  });
  const a: DeviceScreenDriverAssignment = {
    deviceId: createId("device"),
    generation: 1,
    role: "screen",
    definitionId: "iphone-screen",
  };
  const b = { ...a, deviceId: createId("device") };
  connection.replaceAssignments([a, b]);
  const context = (assignment = a): PhoneScreenContext => ({
    deviceId: assignment.deviceId,
    driverGeneration: assignment.generation,
    sessionId: ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`),
    runId: createId("run"),
    requestId: RunnerAuxiliaryRequestIdSchema.parse("request"),
    access: "read-write",
    threadTitle: null,
    deadline: now + 30000,
    signal: new AbortController().signal,
  });
  return {
    bridge,
    connection,
    driver,
    events,
    a,
    b,
    context,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const observeParams = { includeScreenshot: true };
const tap = { type: "tap" as const, count: 1 as const, target: { x: 20, y: 30 } };

describe("iPhone screen driver", () => {
  it.each(["up", "down", "left", "right"] as const)(
    "scrolls toward %s with bounded interior swipes in delivered geometry",
    async (direction) => {
      const f = fixture();
      const context = f.context();
      const { observation } = await f.connection.observe(context, observeParams);
      const result = await f.connection.act(context, {
        observationId: observation.observationId,
        actions: [{ type: "scroll", target: { x: 1, y: 198 }, direction, amount: 3 }],
        includeScreenshot: false,
      });
      expect(result.error).toBeNull();
      expect(result.performed).toEqual(["Sent 3 scroll steps."]);
      const expected = {
        down: [
          { x: 25, y: 150 },
          { x: 25, y: 50 },
        ],
        up: [
          { x: 25, y: 50 },
          { x: 25, y: 150 },
        ],
        right: [
          { x: 75, y: 150 },
          { x: 25, y: 150 },
        ],
        left: [
          { x: 25, y: 150 },
          { x: 75, y: 150 },
        ],
      }[direction];
      expect(f.bridge.effects[0]?.actions).toEqual(
        Array.from({ length: 3 }, () => ({
          kind: "swipe",
          target: { point: expected[0] },
          to: expected[1],
          durationMs: 350,
        })),
      );
      expect(f.events.at(-1)).toMatchObject({
        actions: ["tap", "longPress", "swipe", "drag", "scroll", "navigate", "launch", "wait"],
        wake: false,
        displayVersion: null,
        inputVersion: null,
      });
    },
  );

  it("maps partial native scroll receipts back to phone actions and never replays them", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    f.bridge.replies.set("iphone.perform", async () => ({
      error: { code: "cancelled", effect: "unknown", completedSteps: 3 },
    }));
    const input = {
      observationId: observation.observationId,
      actions: [
        tap,
        {
          type: "scroll" as const,
          target: { x: 20, y: 30 },
          direction: "down" as const,
          amount: 4,
        },
        tap,
      ],
      includeScreenshot: false,
    };
    const result = await f.connection.act(context, input);
    expect(result.performed).toEqual(["Sent tap input.", "Sent 2 of 4 scroll steps."]);
    expect(result.error?.code).toBe("outcome-unknown");
    expect((await f.connection.act(context, input)).error?.code).toBe("stale-observation");
    expect(f.bridge.effects).toHaveLength(1);
  });

  it("rejects scroll expansion beyond the native batch bound before any effect", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    const scroll = {
      type: "scroll" as const,
      target: { x: 20, y: 30 },
      direction: "down" as const,
      amount: 20,
    };
    const result = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap, scroll, scroll],
      includeScreenshot: false,
    });
    expect(result.error?.code).toBe("unsupported");
    expect(f.bridge.effects).toHaveLength(0);
  });
  it("isolates phones, sessions and consumed observations", async () => {
    const f = fixture();
    const a = f.context();
    const b = f.context(f.b);
    const first = await f.connection.observe(a, observeParams);
    const second = await f.connection.observe(b, observeParams);
    expect(IphoneScreenObservationResultSchema.safeParse(first).success).toBe(true);
    expect(first.observation.observationId).not.toBe(second.observation.observationId);
    const wrong = await f.connection.act(b, {
      observationId: first.observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(wrong.error?.code).toBe("stale-observation");
    expect(f.bridge.effects).toHaveLength(0);
    const result = await f.connection.act(a, {
      observationId: first.observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(IphoneScreenActResultSchema.safeParse(result).success).toBe(true);
    expect(result.performed).toHaveLength(1);
    expect(f.bridge.effects[0]?.deviceId).toBe(f.a.deviceId);
    expect(
      (
        await f.connection.act(a, {
          observationId: first.observation.observationId,
          actions: [tap],
          includeScreenshot: false,
        })
      ).error?.code,
    ).toBe("stale-observation");
    expect(f.bridge.effects).toHaveLength(1);
  });

  it.each(["generation", "epoch", "connection", "session"])(
    "invalidates old observations on %s change",
    async (change) => {
      const f = fixture();
      const context = f.context();
      const { observation } = await f.connection.observe(context, observeParams);
      if (change === "generation")
        f.connection.replaceAssignments([{ ...f.a, generation: 2 }, f.b]);
      if (change === "epoch") f.bridge.target(f.a.deviceId, 2);
      if (change === "connection") {
        for (const listener of f.bridge.connections) listener("lost");
        for (const listener of f.bridge.connections) listener("connected");
      }
      const result = await f.connection.act(change === "session" ? f.context() : context, {
        observationId: observation.observationId,
        actions: [tap],
        includeScreenshot: false,
      });
      expect(result.error).not.toBeNull();
      expect(f.bridge.effects).toHaveLength(0);
    },
  );

  it.each([0, 90, 180, 270] as const)(
    "preserves exact delivered pixel geometry at rotation %s for native normalization",
    async (rotation) => {
      const f = fixture();
      const context = f.context();
      const width = rotation % 180 === 0 ? 100 : 200,
        height = rotation % 180 === 0 ? 200 : 100;
      f.bridge.observation = native({
        geometry: {
          width,
          height,
          captureWidth: width * 3,
          captureHeight: height * 3,
          rotation,
          displayId: 0,
        },
        state: { lock: "unlocked", display: "on", rotation, displayId: 0 },
        screenshot: { mimeType: "image/jpeg", base64: "test", width, height },
      });
      const { observation } = await f.connection.observe(context, observeParams);
      expect(observation.geometry).toEqual({ width, height });
      await f.connection.act(context, {
        observationId: observation.observationId,
        includeScreenshot: false,
        actions: [{ ...tap, target: { x: width - 1, y: height - 1 } }],
      });
      expect(f.bridge.effects[0]?.actions).toEqual([
        { kind: "tap", target: { point: { x: width - 1, y: height - 1 } } },
      ]);
    },
  );

  it("keeps incomplete unqualified AX descriptive, escaped and without indices or fabricated frames", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    expect(observation.tree).toContain('button "Send \\"now\\""');
    expect(observation.tree).toContain("partial");
    expect(observation.tree).toContain("coordinates");
    expect(observation.tree).not.toMatch(/\[\d+\]|\(2,3/);
    expect(
      (
        await f.connection.act(context, {
          observationId: observation.observationId,
          actions: [{ ...tap, target: { index: 0 } }],
          includeScreenshot: false,
        })
      ).error?.code,
    ).toBe("unsupported");
    expect(f.bridge.effects).toHaveLength(0);
  });

  it.each([
    { type: "type", text: "synthetic secret", submit: false },
    { type: "clear", target: { x: 1, y: 2 } },
    { type: "navigate", to: "back" },
    { ...tap, target: { x: 100, y: 20 } },
  ])("preflights the whole batch before effects: $type", async (action) => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    const result = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap, action] as Parameters<typeof f.connection.act>[1]["actions"],
      includeScreenshot: false,
    });
    expect(result.error).not.toBeNull();
    expect(result.performed).toEqual([]);
    expect(f.bridge.effects).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("synthetic secret");
  });

  it("keeps unknown outcomes and the known prefix, never repeats a lost perform", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    f.bridge.replies.set("iphone.perform", async () => {
      throw new ComputerUseBridgeError("outcome-unknown", "lost");
    });
    const result = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(result.error?.code).toBe("outcome-unknown");
    await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    for (const listener of f.bridge.connections) listener("connected");
    expect(f.bridge.effects).toHaveLength(1);
    const fresh = await f.connection.observe(context, observeParams);
    f.bridge.replies.set("iphone.perform", async () => ({
      error: { code: "outcome-unknown", effect: "unknown", completedSteps: 1 },
    }));
    const partial = await f.connection.act(context, {
      observationId: fresh.observation.observationId,
      actions: [tap, tap],
      includeScreenshot: false,
    });
    expect(partial.error?.code).toBe("outcome-unknown");
    expect(partial.performed).toHaveLength(1);
  });

  it.each(["cancel", "revoke", "stop"])(
    "prevents capture publication on %s, even when the reply arrives later",
    async (interruption) => {
      const f = fixture();
      const context = f.context();
      const held = deferred<unknown>();
      const started = deferred<void>();
      f.bridge.replies.set("iphone.observe", async () => {
        started.resolve();
        return held.promise;
      });
      const capture = f.connection.observe(context, observeParams);
      const rejected = expect(capture).rejects.toBeInstanceOf(ComputerUseBridgeError);
      await startedWithin(started.promise);
      if (interruption === "cancel")
        f.connection.cancel({ ...context, type: "host.integrations.cancel" });
      if (interruption === "revoke") f.connection.replaceAssignments([f.b]);
      if (interruption === "stop")
        for (const listener of f.bridge.events)
          listener({
            kind: "event",
            event: "iphone.sessionEnded",
            params: {
              deviceId: context.deviceId,
              driverGeneration: 1,
              sessionId: context.sessionId,
              runId: context.runId,
              nativeEpoch: 1,
              reason: "cancelled",
            },
          });
      if (interruption === "revoke") f.connection.replaceAssignments([f.a, f.b]);
      else f.bridge.target(f.a.deviceId);
      held.resolve(native());
      await rejected;
      expect(f.bridge.cancelled).toContain(context.sessionId);
    },
  );

  it.each(["cancel", "revoke", "stop"])(
    "%s cuts off a gesture but retains its queue until native settlement",
    async (interruption) => {
      const f = fixture();
      const context = f.context();
      const { observation } = await f.connection.observe(context, observeParams);
      const held = deferred<unknown>();
      const started = deferred<void>();
      f.bridge.replies.set("iphone.perform", async () => {
        started.resolve();
        return held.promise;
      });
      const act = f.connection.act(context, {
        observationId: observation.observationId,
        actions: [tap],
        includeScreenshot: false,
      });
      await startedWithin(started.promise);
      if (interruption === "cancel")
        f.connection.cancel({ ...context, type: "host.integrations.cancel" });
      if (interruption === "revoke") f.connection.replaceAssignments([f.b]);
      if (interruption === "stop")
        for (const listener of f.bridge.events)
          listener({
            kind: "event",
            event: "iphone.sessionEnded",
            params: {
              deviceId: context.deviceId,
              driverGeneration: 1,
              sessionId: context.sessionId,
              runId: context.runId,
              nativeEpoch: 1,
              reason: "cancelled",
            },
          });
      expect(f.bridge.cancelled).toContain(context.sessionId);
      let settled = false;
      void act.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      held.resolve({ error: { code: "cancelled", effect: "unknown", completedSteps: 0 } });
      expect((await act).error?.code).toBe("outcome-unknown");
    },
  );

  it("pages app inventory without a screen session and leaves launchability to the phone", async () => {
    const f = fixture();
    const context = f.context();
    const page = await f.connection.installedApps(context, { query: "", limit: 1, offset: 0 });
    expect(page).toEqual({ apps: [{ appId: "example.app", label: "Example" }], total: 1 });
    expect(f.bridge.sessions.size).toBe(0);
    const { observation } = await f.connection.observe(context, observeParams);
    await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [{ type: "launch", appId: "unlisted.app" }],
      includeScreenshot: false,
    });
    expect(f.bridge.effects[0]?.actions).toEqual([{ kind: "launch", appId: "unlisted.app" }]);
    f.bridge.replies.set("iphone.perform", async () => ({
      error: { code: "app-not-launchable", effect: "not-started", completedSteps: 0 },
    }));
    const next = await f.connection.observe(context, observeParams);
    const refused = await f.connection.act(context, {
      observationId: next.observation.observationId,
      actions: [{ type: "launch", appId: "missing.app" }],
      includeScreenshot: false,
    });
    expect(refused.error?.code).toBe("app-not-found");
    expect(refused.performed).toEqual([]);
  });

  it("hides unknown lock state and self-app content but not an unknown front app, and maps native readiness reasons", async () => {
    const f = fixture();
    const context = f.context();
    f.bridge.observation = native({
      state: { lock: "unknown", display: "on", rotation: 0, displayId: 0 },
    });
    const { observation } = await f.connection.observe(context, observeParams);
    expect(observation).toMatchObject({
      locked: null,
      secureLock: null,
      tree: "",
      screenshot: null,
      screenshotUnavailable: "protected",
    });
    f.bridge.observation = native({
      foreground: { appId: "com.opensteer.opensteer", label: "Opensteer" },
    });
    expect(
      (await f.connection.observe(context, observeParams)).observation.screenshotUnavailable,
    ).toBe("opensteer-app");
    expect(f.events.at(-1)).toMatchObject({ actions: ["navigate", "launch", "wait"] });
    f.bridge.observation = native({ foreground: null });
    expect((await f.connection.observe(context, observeParams)).observation).toMatchObject({
      foreground: null,
      screenshot: { mime: "image/jpeg" },
      screenshotUnavailable: null,
    });
    f.bridge.target(f.a.deviceId, 1, "phone-locked");
    expect(f.events.at(-1)).toMatchObject({
      type: "runner.integrations.device-status",
      availability: { state: "unavailable", reason: { kind: "locked" } },
      operations: expect.arrayContaining([
        { operation: "installed_apps", state: "ready", detail: null, remedy: null },
      ]),
    });
  });

  it("refuses a changed native geometry revision without input", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    f.bridge.observation = native({ geometryRevision: 2 });
    const result = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(result.error?.code).toBe("stale-observation");
    expect(result.performed).toEqual([]);
    expect(f.bridge.effects).toHaveLength(0);
  });

  it("does not promote successful observation into qualified native input", async () => {
    const f = fixture();
    const context = f.context();
    await f.connection.observe(context, observeParams);
    for (const listener of f.bridge.events)
      listener({
        kind: "event",
        event: "iphone.targetsChanged",
        params: {
          deviceId: context.deviceId,
          driverGeneration: 1,
          nativeEpoch: 1,
          ready: false,
          reason: "qualification-required",
        },
      });
    const { observation } = await f.connection.observe(context, observeParams);
    expect(f.events.at(-1)).toMatchObject({
      availability: { state: "unavailable", reason: { kind: "unsupported" } },
      actions: [],
    });
    const result = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(result.error?.code).toBe("unsupported");
    expect(f.bridge.effects).toHaveLength(0);
  });

  it("withdraws observations omitted by the desktop target snapshot", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    const before = f.events.length;
    f.bridge.replies.set("iphone.targets", async () => ({ targets: [] }));
    f.connection.replaceAssignments([f.a, f.b]);
    await vi.waitFor(
      () =>
        expect(f.events.slice(before)).toContainEqual(
          expect.objectContaining({
            deviceId: f.a.deviceId,
            availability: { state: "unavailable", reason: { kind: "not-connected" } },
          }),
        ),
      { timeout: 1000 },
    );
    expect(
      (
        await f.connection.act(context, {
          observationId: observation.observationId,
          actions: [tap],
          includeScreenshot: false,
        })
      ).error?.code,
    ).toBe("stale-observation");
    expect(f.bridge.effects).toHaveLength(0);
  });

  it("checks the original deadline and read-only authority before input", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.connection.observe(context, observeParams);
    const readonly = await f.connection.act(
      { ...context, access: "read" },
      { observationId: observation.observationId, actions: [tap], includeScreenshot: false },
    );
    expect(readonly.error?.code).toBe("permission-required");
    f.advance(30001);
    const expired = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(expired.error?.code).toBe("failed");
    expect(f.bridge.effects).toHaveLength(0);
  });

  it("closes a cancelled opening after its late reply and keeps other phones independent", async () => {
    const f = fixture();
    const context = f.context();
    const opened = deferred<unknown>();
    const started = deferred<void>();
    f.bridge.replies.set("iphone.session.open", async (params) => {
      const p = params as IphoneRunnerParams<"iphone.session.open">;
      if (p.deviceId !== context.deviceId) return { nativeEpoch: 1 };
      started.resolve();
      await opened.promise;
      f.bridge.sessions.add(p.sessionId);
      return { nativeEpoch: 1 };
    });
    const capture = f.connection.observe(context, observeParams);
    const refused = expect(capture).rejects.toMatchObject({ code: "stopped-by-user" });
    await startedWithin(started.promise);
    f.connection.cancel({ ...context, type: "host.integrations.cancel" });
    const other = await f.connection.observe(f.context(f.b), observeParams);
    expect(other.observation.observationId).toBeTruthy();
    opened.resolve({});
    await refused;
    await f.connection.close(context, {});
    expect(f.bridge.sessions.has(context.sessionId)).toBe(false);
  });

  it("orders replacement assignments and withdraws them on detach", async () => {
    const f = fixture();
    const context = f.context();
    await f.connection.observe(context, observeParams);
    f.connection.replaceAssignments([{ ...f.a, generation: 2 }]);
    await f.connection.installedApps(
      { ...context, driverGeneration: 2 },
      { query: "", limit: 1, offset: 0 },
    );
    expect(f.bridge.assignments.at(-1)).toEqual({ assignments: [{ ...f.a, generation: 2 }] });
    for (const listener of f.bridge.connections) listener("connected");
    await f.connection.installedApps(
      { ...context, driverGeneration: 2 },
      { query: "", limit: 1, offset: 0 },
    );
    expect(f.bridge.assignments.at(-1)?.assignments).toEqual([{ ...f.a, generation: 2 }]);
    f.connection.detach();
    await f.driver.shutdown();
    expect(f.bridge.assignments.at(-1)).toEqual({ assignments: [] });
  });

  it("preserves filtered page order and totals without acquiring control", async () => {
    const f = fixture();
    const context = f.context();
    const pages = new Map([
      [0, { apps: [{ appId: "opaque.a", label: "Alpha" }], total: 2, offset: 0 }],
      [1, { apps: [{ appId: "opaque.b", label: "Beta" }], total: 2, offset: 1 }],
    ]);
    f.bridge.replies.set("iphone.installedApps", async (params) => {
      const p = params as IphoneRunnerParams<"iphone.installedApps">;
      expect(p.filter).toBe("a");
      expect(p.limit).toBe(1);
      return pages.get(p.offset);
    });
    const first = await f.connection.installedApps(context, { query: "a", limit: 1, offset: 0 });
    const second = await f.connection.installedApps(context, { query: "a", limit: 1, offset: 1 });
    expect([...first.apps, ...second.apps].map((a) => a.appId)).toEqual(["opaque.a", "opaque.b"]);
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(f.bridge.sessions.size).toBe(0);
  });

  it("bounds tree output in UTF-8 and distinguishes size truncation from partial AX", () => {
    const observation = native();
    observation.nodes = Array.from({ length: 1500 }, (_, index) => ({
      ...observation.nodes[0]!,
      nodeId: `node-${index}`,
      label: "한".repeat(400),
    }));
    const result = phoneTree(observation);
    expect(Buffer.byteLength(result.tree)).toBeLessThanOrEqual(32000);
    expect(result.truncated).toBe(true);
    expect(result.elementCount).toBeLessThan(1500);
    expect(result.tree).toContain("Tree size limit");
    expect(result.tree).toContain("Accessibility partial");
    expect(result.tree).not.toContain("�");
    expect(iphoneCapabilityReason("future-native-reason")).toEqual({ kind: "runtime-failed" });
  });
});
