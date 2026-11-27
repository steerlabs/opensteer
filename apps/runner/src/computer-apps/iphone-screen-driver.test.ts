import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { RunnerTransportPolicy } from "@opensteer/runner-client";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerViewIdSchema, createId } from "@opensteer/core";
import type { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { RunnerAuxiliaryFrameFence, DeviceScreenDriverAssignment } from "@opensteer/protocol";
import {
  displayFirstFrameTimeoutMs,
  DisplayStreamIdSchema,
  encodeDisplayMediaFrame,
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
  type iphoneNativeCapabilitiesSchema,
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

const fullCapabilities = {
  observe: null,
  act: null,
  launch: null,
  installedApps: null,
  text: null,
  clear: null,
  indexedTargets: null,
  liveVideo: null,
  wake: null,
} satisfies z.infer<typeof iphoneNativeCapabilitiesSchema>;

class Bridge implements IphoneScreenBridge {
  capabilities?: z.infer<typeof iphoneNativeCapabilitiesSchema>;
  openVideoAttachment = vi.fn<IphoneScreenBridge["openVideoAttachment"]>();
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
              capabilities: this.capabilities,
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
function fixture(transport?: RunnerTransportPolicy) {
  const bridge = new Bridge();
  if (transport) bridge.capabilities = fullCapabilities;
  let now = 1_800_000_000_000;
  const driver = new IphoneScreenDriver({ bridge, now: () => now });
  drivers.push(driver);
  const events: PhoneScreenDriverEvent[] = [];
  const connection = driver.connect({
    fence: { runnerId: createId("runner") } as RunnerAuxiliaryFrameFence,
    ...(transport ? { transport } : {}),
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
    async observe(...args: Parameters<typeof connection.observe>) {
      const result = await connection.observe(...args);
      if (!result.observation) throw new Error("Expected a captured observation.");
      return { observation: result.observation };
    },
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
      const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const first = await f.observe(a, observeParams);
    const second = await f.observe(b, observeParams);
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
      const { observation } = await f.observe(context, observeParams);
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
      const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const fresh = await f.observe(context, observeParams);
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
      const capture = f.observe(context, observeParams);
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
      const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
    await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [{ type: "launch", appId: "unlisted.app" }],
      includeScreenshot: false,
    });
    expect(f.bridge.effects[0]?.actions).toEqual([{ kind: "launch", appId: "unlisted.app" }]);
    f.bridge.replies.set("iphone.perform", async () => ({
      error: { code: "app-not-launchable", effect: "not-started", completedSteps: 0 },
    }));
    const next = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    expect((await f.observe(context, observeParams)).observation.screenshotUnavailable).toBe(
      "opensteer-app",
    );
    expect(f.events.at(-1)).toMatchObject({ actions: ["navigate", "launch", "wait"] });
    f.bridge.observation = native({ foreground: null });
    expect((await f.observe(context, observeParams)).observation).toMatchObject({
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
    const { observation } = await f.observe(context, observeParams);
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

  it("reports fresh state without issuing input authority, and recovers on the same session", async () => {
    const f = fixture();
    const context = f.context();
    const { observation } = await f.observe(context, observeParams);
    f.bridge.target(context.deviceId, 1, "phone-locked");
    f.bridge.replies.set("iphone.observe", async () => ({
      nativeEpoch: 1,
      state: { lock: "unlocked", display: "unknown", rotation: null, displayId: 0 },
      reason: "screen-state-unknown",
    }));
    expect(await f.connection.observe(context, observeParams)).toEqual({
      observation: null,
      status: { locked: false, screen: "unknown", reason: "screen-state-unknown" },
    });
    expect(f.events.at(-1)).toMatchObject({
      availability: { state: "unavailable", reason: { kind: "protected" } },
      actions: [],
    });
    const refused = await f.connection.act(context, {
      observationId: observation.observationId,
      actions: [tap],
      includeScreenshot: false,
    });
    expect(refused.error?.code).toBe("stale-observation");
    expect(f.bridge.effects).toHaveLength(0);
    f.bridge.replies.delete("iphone.observe");
    const fresh = await f.observe(context, observeParams);
    expect(
      await f.connection.act(context, {
        observationId: fresh.observation.observationId,
        actions: [tap],
        includeScreenshot: false,
      }),
    ).toMatchObject({ error: null });
    expect(f.bridge.sessions.has(context.sessionId)).toBe(true);
    expect(f.bridge.cancelled).not.toContain(context.sessionId);
  });

  it("does not promote successful observation into qualified native input", async () => {
    const f = fixture();
    const context = f.context();
    await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const { observation } = await f.observe(context, observeParams);
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
    const capture = f.observe(context, observeParams);
    const refused = expect(capture).rejects.toMatchObject({ code: "stopped-by-user" });
    await startedWithin(started.promise);
    f.connection.cancel({ ...context, type: "host.integrations.cancel" });
    const other = await f.observe(f.context(f.b), observeParams);
    expect(other.observation.observationId).toBeTruthy();
    opened.resolve({});
    await refused;
    await f.connection.close(context, {});
    expect(f.bridge.sessions.has(context.sessionId)).toBe(false);
  });

  it.each(["failed", "outcome-unknown", "no-session"] as const)(
    "reports an iPhone close that returned %s",
    async (code) => {
      const f = fixture();
      const context = f.context();
      await f.observe(context, observeParams);
      const reply = vi.fn(async () => {
        throw new ComputerUseBridgeError(code, "Native close did not answer successfully");
      });
      f.bridge.replies.set("iphone.session.close", reply);
      const close = () => f.connection.close(context, {});
      if (code === "no-session") await expect(close()).resolves.toEqual({});
      else await expect(close()).rejects.toMatchObject({ code });
      expect(reply).toHaveBeenCalledOnce();
      if (code === "failed") {
        f.bridge.replies.delete("iphone.session.close");
        await expect(close()).resolves.toEqual({});
      } else if (code === "outcome-unknown") {
        await expect(close()).rejects.toMatchObject({ code });
        expect(reply).toHaveBeenCalledOnce();
        const reopen = vi.fn(async () => ({ nativeEpoch: 1 }));
        f.bridge.replies.set("iphone.session.open", reopen);
        await expect(f.observe(context, observeParams)).rejects.toMatchObject({
          code: "no-session",
        });
        expect(reopen).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["failed", "outcome-unknown"] as const)(
    "preserves %s from the iPhone cancellation that started closing a session",
    async (code) => {
      const f = fixture();
      const context = f.context();
      await f.observe(context, observeParams);
      f.bridge.replies.set("iphone.cancel", async () => {
        throw new ComputerUseBridgeError(code, "Native close did not answer successfully");
      });
      const followUp = vi.fn(async () => ({}));
      f.bridge.replies.set("iphone.session.close", followUp);
      await expect(f.connection.close(context, {})).rejects.toMatchObject({ code });
      expect(followUp).not.toHaveBeenCalled();
      if (code === "outcome-unknown") {
        await expect(f.connection.close(context, {})).rejects.toMatchObject({ code });
        expect(followUp).not.toHaveBeenCalled();
      }
    },
  );

  it("orders replacement assignments and withdraws them on detach", async () => {
    const f = fixture();
    const context = f.context();
    await f.observe(context, observeParams);
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

it("uses only advertised typing, clearing, wake, double tap and qualified element targets", async () => {
  const f = fixture();
  f.bridge.capabilities = fullCapabilities;
  const sample = native();
  f.bridge.observation = native({
    ...sample,
    textReason: null,
    clearReason: null,
    coverage: { ...sample.coverage, coordinateSpace: "qualified" },
    buttons: [
      "home",
      "recents",
      "notifications",
      "quickSettings",
      "lock",
      "volumeUp",
      "volumeDown",
      "action",
      "siri",
    ],
    nodes: [
      {
        ...sample.nodes[0]!,
        nodeId: "field",
        role: "textField",
        source: "ax",
        editable: "yes",
        secure: "no",
      },
      { ...sample.nodes[0]!, nodeId: "ocr-1", source: "ocr", role: "text", depth: 1 },
      { ...sample.nodes[0]!, nodeId: "out-of-bounds", frame: { x: 99, y: 2, width: 3, height: 3 } },
    ],
  });
  const context = f.context();
  const { observation } = await f.observe(context, observeParams);
  expect(observation.tree).toContain('[0] textField "Send \\"now\\"" (2,3 10×20) editable');
  expect(observation.tree).toContain('[1] text "Send \\"now\\"" (2,3 10×20) ocr');
  expect(observation.tree).not.toContain("[2]");
  expect(f.events.at(-1)).toMatchObject({
    actions: expect.arrayContaining(["type", "clear", "wake"]),
    displayVersion: 1,
    ownerViewVersion: 1,
    inputVersion: 1,
    powerVersion: 1,
    navigationButtons: expect.arrayContaining([{ id: "quickSettings", label: "Control Center" }]),
  });
  const input = {
    observationId: observation.observationId,
    includeScreenshot: false,
    actions: [
      { type: "wake" as const },
      { type: "tap" as const, count: 2 as const, target: { index: 1 } },
      { type: "type" as const, target: { index: 0 }, text: "synthetic", submit: true },
      { type: "clear" as const, target: { index: 0 } },
      { type: "navigate" as const, to: "quickSettings" },
    ],
  };
  expect((await f.connection.act(context, input)).error).toBeNull();
  expect(f.bridge.effects.at(-1)?.actions).toEqual([
    { kind: "wake" },
    { kind: "tap", count: 2, target: { nodeId: "ocr-1" } },
    { kind: "type", target: { nodeId: "field" }, text: "synthetic", submit: true },
    { kind: "clear", target: { nodeId: "field" } },
    { kind: "navigate", button: "quickSettings" },
  ]);
});

async function listenForDisplay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a bound loopback port.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

it("relays binary frames and ACKs, forwards owner input and power, and closes both sockets", async () => {
  const host = await listenForDisplay();
  const desktop = await listenForDisplay();
  const f = fixture({ hostOrigin: new URL(host.origin), mode: "development" });
  try {
    const ref = {
      deviceId: f.a.deviceId,
      driverGeneration: 1,
      streamId: DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`),
    };
    const viewId = ComputerViewIdSchema.parse(`cvw_${randomUUID()}`);
    const source = { kind: "owner-view" as const, viewId, generation: 1 };
    const view = {
      ...ref,
      viewId,
      generation: 1,
      operation: "open" as const,
      version: 1 as const,
      target: { kind: "phone" as const, display: "main" },
      type: "host.integrations.computer-view" as const,
      leaseDurationMs: 10000,
      timeoutMs: 5000,
      requestId: RunnerAuxiliaryRequestIdSchema.parse("view-request"),
    };
    await expect(
      f.connection.ownerView(view, new AbortController().signal, Date.now()),
    ).resolves.toEqual({ viewId, generation: 1, state: "ready", captureTargetId: null });
    const methods: [IphoneRunnerMethod, unknown][] = [];
    for (const method of [
      "iphone.display.start",
      "iphone.display.demand",
      "iphone.display.refresh",
      "iphone.display.input",
      "iphone.display.inputReset",
      "iphone.display.power",
      "iphone.display.stop",
    ] as const) {
      f.bridge.replies.set(method, async (params) => {
        methods.push([method, params]);
        if (method === "iphone.display.start")
          return { attachmentToken: "synthetic-token", demandActive: true };
        if (method === "iphone.display.input" || method === "iphone.display.power")
          return { outcome: "dispatched" };
        return {};
      });
    }
    f.bridge.openVideoAttachment.mockImplementation(() => new WebSocket(desktop.origin));
    const hostConnected = once(host.server, "connection");
    const desktopConnected = once(desktop.server, "connection");
    const dataTicket = "synthetic.data.ticket";
    f.connection.display({
      ...ref,
      type: "host.integrations.display.start",
      display: "main",
      revision: 1,
      sources: [source],
      inputSources: [source],
      phoneOwnerControl: 1,
      dataTicket,
      maxFps: 30,
      maxLongSide: 1280,
    });
    const [data, request] = await hostConnected;
    const [media] = await desktopConnected;
    expect(request.url).toBe("/internal/v1/computer-use/display");
    expect(request.headers.authorization).toBe(`Bearer ${dataTicket}`);
    expect(f.bridge.openVideoAttachment).toHaveBeenCalledExactlyOnceWith("synthetic-token");
    const live = {
      ...ref,
      state: "live" as const,
      width: 100,
      height: 200,
      rotation: 0 as const,
      generation: 2,
    };
    for (const listener of f.bridge.events)
      listener({ kind: "event", event: "iphone.displayState", params: live });
    expect(f.events).toContainEqual({
      ...live,
      display: "main",
      type: "runner.integrations.display.state",
    });
    const bytes = encodeDisplayMediaFrame(
      {
        streamId: ref.streamId,
        generation: 2,
        sequence: 0,
        ptsUs: 0,
        key: true,
        codec: "avc1.64002a",
        width: 100,
        height: 200,
      },
      Uint8Array.from([0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65]),
    );
    const frame = once(data, "message");
    media.send(bytes, { binary: true });
    await expect(frame).resolves.toEqual([Buffer.from(bytes), true]);
    const credit = once(media, "message");
    const ack = JSON.stringify({ type: "display.ack", sequence: 0 });
    data.send(ack);
    await expect(credit).resolves.toEqual([Buffer.from(ack), false]);

    f.connection.display({
      ...ref,
      display: "main",
      type: "host.integrations.display.demand",
      revision: 2,
      sources: [source],
      inputSources: [source],
      maxLongSide: 960,
    });
    f.connection.display({ ...ref, display: "main", type: "host.integrations.display.refresh" });
    const events = [{ kind: "pointer" as const, phase: "down" as const, x: 0.5, y: 0.5, t: 1 }];
    f.connection.display({
      ...ref,
      source,
      type: "host.integrations.display.input",
      geometry: 2,
      sequence: 0,
      events,
    });
    await vi.waitFor(() =>
      expect(f.events.at(-1)).toMatchObject({
        type: "runner.integrations.display.input-result",
        geometry: 2,
        sequence: 0,
        outcome: "dispatched",
      }),
    );
    f.connection.display({ ...ref, source, type: "host.integrations.display.input-reset" });
    f.connection.display({
      ...ref,
      source,
      type: "host.integrations.display.power",
      sequence: 1,
      action: "wake",
    });
    f.connection.display({
      ...ref,
      source,
      type: "host.integrations.display.power",
      sequence: 2,
      action: "lock",
    });
    await vi.waitFor(() =>
      expect(f.events.slice(-3)).toMatchObject([
        {
          type: "runner.integrations.display.input-result",
          geometry: 2,
          sequence: 0,
          outcome: "dispatched",
        },
        { type: "runner.integrations.display.power-result", sequence: 1, outcome: "dispatched" },
        { type: "runner.integrations.display.power-result", sequence: 2, outcome: "dispatched" },
      ]),
    );
    await vi.waitFor(() =>
      expect(methods).toEqual([
        ["iphone.display.start", { ...ref, maxFps: 30, maxLongSide: 1280 }],
        ["iphone.display.demand", { ...ref, maxLongSide: 960, active: true }],
        ["iphone.display.refresh", ref],
        ["iphone.display.input", { ...ref, geometry: 2, sequence: 0, events }],
        ["iphone.display.inputReset", ref],
        ["iphone.display.power", { ...ref, action: "wake" }],
        ["iphone.display.power", { ...ref, action: "lock" }],
      ]),
    );
    const closed = Promise.all([once(data, "close"), once(media, "close")]);
    f.connection.display({ ...ref, display: "main", type: "host.integrations.display.stop" });
    await closed;
    expect(methods.at(-1)).toEqual(["iphone.display.stop", ref]);
  } finally {
    await f.driver.shutdown();
    await Promise.all(
      [host.server, desktop.server].map((server) => {
        for (const client of server.clients) client.terminate();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
});

it("allows only wake on a hidden screen observation and leaves passcode entry to the person", async () => {
  const f = fixture();
  f.bridge.capabilities = fullCapabilities;
  f.bridge.observation = native({
    state: { lock: "locked", display: "off", rotation: 0, displayId: 0 },
    textReason: null,
    clearReason: null,
  });
  const context = f.context();
  const { observation } = await f.observe(context, observeParams);
  expect(observation).toMatchObject({
    tree: "",
    screenshot: null,
    screenshotUnavailable: "screen-off",
  });
  expect(f.events.at(-1)).toMatchObject({ wake: true, actions: ["wake"] });
  const act = (actions: Parameters<typeof f.connection.act>[1]["actions"]) =>
    f.connection.act(context, {
      observationId: observation.observationId,
      includeScreenshot: false,
      actions,
    });
  expect((await act([{ type: "type", text: "synthetic", submit: false }])).error?.code).toBe(
    "permission-required",
  );
  expect((await act([{ type: "wake" }])).error).toBeNull();
  expect(f.bridge.effects.map(({ actions }) => actions)).toEqual([[{ kind: "wake" }]]);
});

it("wakes a screen-off iPhone from a native screen status with a wakeToken and refuses non-wake input", async () => {
  const f = fixture();
  f.bridge.capabilities = fullCapabilities;
  f.bridge.observation = native({ geometryRevision: 7, textReason: null, clearReason: null });
  let wakes = 0;
  f.bridge.replies.set("iphone.observe", async () => {
    if (wakes === 0) {
      return {
        nativeEpoch: 1,
        state: { lock: "unlocked", display: "off", rotation: 0, displayId: 0 },
        reason: "wake-on-phone-required",
        wakeToken: "wake-tok-1",
        geometryRevision: 7,
      };
    }
    return f.bridge.observation;
  });
  const context = f.context();
  const { observation } = await f.observe(context, observeParams);
  expect(observation).toMatchObject({
    screen: "off",
    locked: false,
    screenshot: null,
    screenshotUnavailable: "screen-off",
    tree: "",
  });
  expect(f.events.at(-1)).toMatchObject({
    availability: { state: "ready", reason: null },
    wake: true,
    lock: true,
    powerVersion: 1,
    inputVersion: 1,
    actions: ["wake"],
  });
  expect(
    (
      await f.connection.act(context, {
        observationId: observation.observationId,
        includeScreenshot: false,
        actions: [{ type: "tap", count: 1, target: { x: 1, y: 1 } }],
      })
    ).error?.code,
  ).toBe("permission-required");
  expect(f.bridge.effects).toHaveLength(0);
  wakes = 1;
  const woke = await f.connection.act(context, {
    observationId: observation.observationId,
    includeScreenshot: false,
    actions: [{ type: "wake" }],
  });
  expect(woke.error).toBeNull();
  expect(woke.observation?.screen).toBe("on");
  expect(f.bridge.effects).toEqual([
    expect.objectContaining({
      observationToken: "wake-tok-1",
      geometryRevision: 7,
      actions: [{ kind: "wake" }],
    }),
  ]);
});

it("stops a late display start before opening either media socket", async () => {
  const f = fixture({ hostOrigin: new URL("http://127.0.0.1:1"), mode: "development" });
  const ref = {
    deviceId: f.a.deviceId,
    driverGeneration: 1,
    streamId: DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`),
  };
  const entered = deferred<void>();
  const start = deferred<{ attachmentToken: string }>();
  const stop = vi.fn(async () => ({}));
  f.bridge.replies.set("iphone.display.start", async () => {
    entered.resolve();
    return start.promise;
  });
  f.bridge.replies.set("iphone.display.stop", stop);
  f.connection.display({
    ...ref,
    type: "host.integrations.display.start",
    display: "main",
    revision: 1,
    sources: [],
    dataTicket: "synthetic.data.ticket",
    maxFps: 30,
    maxLongSide: 1280,
  });
  await startedWithin(entered.promise);
  f.connection.display({ ...ref, display: "main", type: "host.integrations.display.stop" });
  expect(stop).not.toHaveBeenCalled();
  start.resolve({ attachmentToken: "late-token" });
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(f.bridge.openVideoAttachment).not.toHaveBeenCalled();
});

it("advertises live navigation and lock/wake controls before any agent observation", async () => {
  const f = fixture();
  f.bridge.capabilities = fullCapabilities;
  for (const listener of f.bridge.events)
    listener({
      kind: "event",
      event: "iphone.targetsChanged",
      params: {
        deviceId: f.a.deviceId,
        driverGeneration: 1,
        nativeEpoch: 2,
        ready: true,
        reason: null,
        capabilities: fullCapabilities,
      },
    });
  expect(f.events.at(-1)).toMatchObject({
    availability: { state: "ready", reason: null },
    displayVersion: 1,
    ownerViewVersion: 1,
    inputVersion: 1,
    powerVersion: 1,
    wake: true,
    lock: true,
    actions: expect.arrayContaining(["navigate", "tap", "type", "clear", "wake"]),
    navigationButtons: expect.arrayContaining([
      { id: "home", label: "Home" },
      { id: "recents", label: "App Switcher" },
      { id: "notifications", label: "Notification Center" },
    ]),
  });
});

it("does not fail a live display stream when a best-effort display.refresh request rejects", async () => {
  const host = await listenForDisplay();
  const desktop = await listenForDisplay();
  const f = fixture({ hostOrigin: new URL(host.origin), mode: "development" });
  try {
    const ref = {
      deviceId: f.a.deviceId,
      driverGeneration: 1,
      streamId: DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`),
    };
    const source = {
      kind: "owner-view" as const,
      viewId: ComputerViewIdSchema.parse(`cvw_${randomUUID()}`),
      generation: 1,
    };
    let refreshCalls = 0;
    let demandCalls = 0;
    f.bridge.replies.set("iphone.display.start", async () => ({
      attachmentToken: "synthetic-token",
      demandActive: true,
    }));
    f.bridge.replies.set("iphone.display.refresh", async () => {
      refreshCalls++;
      throw new Error("transient refresh error");
    });
    f.bridge.replies.set("iphone.display.demand", async () => {
      demandCalls++;
      return {};
    });
    f.bridge.replies.set("iphone.display.stop", async () => ({}));
    f.bridge.openVideoAttachment.mockImplementation(() => new WebSocket(desktop.origin));
    const hostConnected = once(host.server, "connection");
    const desktopConnected = once(desktop.server, "connection");
    f.connection.display({
      ...ref,
      type: "host.integrations.display.start",
      display: "main",
      revision: 1,
      sources: [source],
      inputSources: [source],
      phoneOwnerControl: 1,
      dataTicket: "synthetic.data.ticket",
      maxFps: 30,
      maxLongSide: 1280,
    });
    await Promise.all([hostConnected, desktopConnected]);
    f.connection.display({ ...ref, display: "main", type: "host.integrations.display.refresh" });
    f.connection.display({
      ...ref,
      display: "main",
      type: "host.integrations.display.demand",
      revision: 2,
      sources: [source],
      inputSources: [source],
      maxLongSide: 960,
    });
    await vi.waitFor(() => {
      expect(refreshCalls).toBe(1);
      expect(demandCalls).toBe(1);
    });
    expect(
      f.events.filter(
        (event) =>
          event.type === "runner.integrations.display.state" &&
          event.state === "failed" &&
          event.reason === "capture-failed",
      ),
    ).toEqual([]);
  } finally {
    await f.driver.shutdown();
    await Promise.all(
      [host.server, desktop.server].map((server) => {
        for (const client of server.clients) client.terminate();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
});

it("forwards active viewer demand and preserves agent observations across demand pause/resume", async () => {
  const host = await listenForDisplay();
  const desktop = await listenForDisplay();
  const f = fixture({ hostOrigin: new URL(host.origin), mode: "development" });
  f.bridge.capabilities = fullCapabilities;
  try {
    const ref = {
      deviceId: f.a.deviceId,
      driverGeneration: 1,
      streamId: DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`),
    };
    const source = {
      kind: "owner-view" as const,
      viewId: ComputerViewIdSchema.parse(`cvw_${randomUUID()}`),
      generation: 1,
    };
    const demands: unknown[] = [];
    f.bridge.replies.set("iphone.display.start", async () => ({
      attachmentToken: "synthetic-token",
      demandActive: true,
    }));
    f.bridge.replies.set("iphone.display.demand", async (params) => {
      demands.push(params);
      return {};
    });
    f.bridge.replies.set("iphone.display.stop", async () => ({}));
    f.bridge.openVideoAttachment.mockImplementation(() => new WebSocket(desktop.origin));
    const hostConnected = once(host.server, "connection");
    const desktopConnected = once(desktop.server, "connection");
    f.connection.display({
      ...ref,
      type: "host.integrations.display.start",
      display: "main",
      revision: 1,
      sources: [source],
      inputSources: [source],
      phoneOwnerControl: 1,
      dataTicket: "synthetic.data.ticket",
      maxFps: 30,
      maxLongSide: 1280,
    });
    await Promise.all([hostConnected, desktopConnected]);

    // Agent holds a valid observation on the phone while the stream is live at 200x400 rot 0.
    const emitDisplayState = (
      params: Extract<
        Parameters<typeof f.bridge.events extends Set<infer L> ? L : never>[0],
        { event: "iphone.displayState" }
      >["params"],
    ) => {
      for (const listener of f.bridge.events)
        listener({ kind: "event", event: "iphone.displayState", params });
    };
    emitDisplayState({
      ...ref,
      state: "live",
      generation: 1,
      width: 200,
      height: 400,
      rotation: 0,
    });
    const context = f.context();
    const { observation } = await f.observe(context, observeParams);

    // Zero viewers pauses demand (active: false); paused/resume with identical geometry keeps agent observation valid.
    f.connection.display({
      ...ref,
      display: "main",
      type: "host.integrations.display.demand",
      revision: 2,
      sources: [],
      inputSources: [],
    });
    emitDisplayState({
      ...ref,
      state: "protected",
      reason: "paused",
      generation: 2,
      width: 0,
      height: 0,
      rotation: 0,
    });
    f.connection.display({
      ...ref,
      display: "main",
      type: "host.integrations.display.demand",
      revision: 3,
      sources: [source],
      inputSources: [source],
    });
    emitDisplayState({
      ...ref,
      state: "starting",
      generation: 3,
      width: 0,
      height: 0,
      rotation: 0,
    });
    emitDisplayState({
      ...ref,
      state: "live",
      generation: 3,
      width: 200,
      height: 400,
      rotation: 0,
    });
    await vi.waitFor(() => expect(demands).toHaveLength(2));
    expect(demands).toEqual([
      { ...ref, active: false },
      { ...ref, active: true },
    ]);

    // Agent can still act on its prior observation after viewer demand pause/resume with unchanged geometry.
    const acted = await f.connection.act(context, {
      observationId: observation.observationId,
      includeScreenshot: false,
      actions: [{ type: "tap", count: 1, target: { x: 10, y: 10 } }],
    });
    expect(acted.error).toBeNull();

    // A same-rotation dimension resize during pause MUST invalidate the cached observation on live.
    emitDisplayState({
      ...ref,
      state: "protected",
      reason: "paused",
      generation: 4,
      width: 0,
      height: 0,
      rotation: 0,
    });
    emitDisplayState({
      ...ref,
      state: "starting",
      generation: 5,
      width: 0,
      height: 0,
      rotation: 0,
    });
    emitDisplayState({
      ...ref,
      state: "live",
      generation: 5,
      width: 300,
      height: 600,
      rotation: 0,
    });
    const resizedStale = await f.connection.act(context, {
      observationId: acted.observation!.observationId,
      includeScreenshot: false,
      actions: [{ type: "tap", count: 1, target: { x: 10, y: 10 } }],
    });
    expect(resizedStale.error?.code).toBe("stale-observation");

    // Re-observe, then verify a real privacy lock MUST still invalidate the agent's cached observation.
    const { observation: obs2 } = await f.observe(context, observeParams);
    emitDisplayState({
      ...ref,
      state: "protected",
      reason: "locked-screen",
      generation: 6,
      width: 0,
      height: 0,
      rotation: 0,
    });
    const stale = await f.connection.act(context, {
      observationId: obs2.observationId,
      includeScreenshot: false,
      actions: [{ type: "tap", count: 1, target: { x: 10, y: 10 } }],
    });
    expect(stale.error?.code).toBe("stale-observation");
  } finally {
    await f.driver.shutdown();
    await Promise.all(
      [host.server, desktop.server].map((server) => {
        for (const client of server.clients) client.terminate();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
});

it("omits active demand for legacy Desktop and rearms first-frame timeout after pause before first frame", async () => {
  vi.useFakeTimers();
  const host = await listenForDisplay();
  const desktop = await listenForDisplay();
  const f = fixture({ hostOrigin: new URL(host.origin), mode: "development" });
  try {
    const ref = {
      deviceId: f.a.deviceId,
      driverGeneration: 1,
      streamId: DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`),
    };
    const source = {
      kind: "owner-view" as const,
      viewId: ComputerViewIdSchema.parse(`cvw_${randomUUID()}`),
      generation: 1,
    };
    const demands: unknown[] = [];
    // Legacy Desktop reply: omits demandActive.
    f.bridge.replies.set("iphone.display.start", async () => ({
      attachmentToken: "synthetic-token",
    }));
    f.bridge.replies.set("iphone.display.demand", async (params) => {
      demands.push(params);
      return {};
    });
    f.bridge.replies.set("iphone.display.stop", async () => ({}));
    f.bridge.openVideoAttachment.mockImplementation(() => new WebSocket(desktop.origin));
    const hostConnected = once(host.server, "connection");
    const desktopConnected = once(desktop.server, "connection");
    f.connection.display({
      ...ref,
      type: "host.integrations.display.start",
      display: "main",
      revision: 1,
      sources: [source],
      inputSources: [source],
      phoneOwnerControl: 1,
      dataTicket: "synthetic.data.ticket",
      maxFps: 30,
      maxLongSide: 1280,
    });
    await Promise.all([hostConnected, desktopConnected]);

    // Pause before any media frame arrives: no active field sent to legacy Desktop, timer suspended.
    f.connection.display({
      ...ref,
      display: "main",
      type: "host.integrations.display.demand",
      revision: 2,
      sources: [],
      inputSources: [],
    });
    for (const listener of f.bridge.events)
      listener({
        kind: "event",
        event: "iphone.displayState",
        params: {
          ...ref,
          state: "protected",
          reason: "paused",
          generation: 2,
          width: 0,
          height: 0,
          rotation: 0,
        },
      });
    await vi.advanceTimersByTimeAsync(displayFirstFrameTimeoutMs + 100);
    expect(
      f.events.some(
        (event) => event.type === "runner.integrations.display.state" && event.state === "failed",
      ),
    ).toBe(false);

    // Resume demand with maxLongSide: legacy Desktop receives maxLongSide WITHOUT active, and timer rearms.
    f.connection.display({
      ...ref,
      display: "main",
      type: "host.integrations.display.demand",
      revision: 3,
      sources: [source],
      inputSources: [source],
      maxLongSide: 960,
    });
    for (const listener of f.bridge.events)
      listener({
        kind: "event",
        event: "iphone.displayState",
        params: {
          ...ref,
          state: "starting",
          generation: 3,
          width: 0,
          height: 0,
          rotation: 0,
        },
      });
    await vi.waitFor(() => expect(demands).toHaveLength(1));
    expect(demands).toEqual([{ ...ref, maxLongSide: 960 }]);

    // If no frame arrives after resuming into starting, capture-timeout fires.
    await vi.advanceTimersByTimeAsync(displayFirstFrameTimeoutMs + 100);
    expect(
      f.events.some(
        (event) =>
          event.type === "runner.integrations.display.state" &&
          event.state === "failed" &&
          event.reason === "capture-timeout",
      ),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
    await f.driver.shutdown();
    await Promise.all(
      [host.server, desktop.server].map((server) => {
        for (const client of server.clients) client.terminate();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
});
