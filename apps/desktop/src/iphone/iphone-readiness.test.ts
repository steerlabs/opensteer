import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  ComputerUseSessionIdSchema,
  RunnerAuxiliaryRequestIdSchema,
  type RunnerAuxiliaryFrameFence,
} from "@opensteer/protocol";
import type { IphoneRunnerEvent } from "@opensteer/protocol/iphone-bridge";
import { IphoneScreenDriver } from "../../../runner/src/computer-apps/iphone-screen-driver.js";
import type {
  PhoneScreenContext,
  PhoneScreenDriverEvent,
} from "../../../runner/src/computer-apps/phone-screen-driver.js";
import { fixture, ownerA } from "./test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it.each(["read", "read-write"] as const)(
  "becomes ready through the service and driver after a first %s observation",
  async (access) => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    f.native.probeReady = false;
    f.native.foreground = { appId: "example.app", label: "Example" };
    await f.bind();
    const listeners = new Set<(event: IphoneRunnerEvent) => void>();
    const transport = f.service.forSlot(ownerA).connect((event) => {
      for (const listener of listeners) listener(event);
    });
    const driver = new IphoneScreenDriver({
      bridge: {
        iphoneRequest: (method, params, options) => transport.request(method, params, options),
        onIphoneEvent: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onIphoneConnection: () => () => undefined,
      },
    });
    cleanups.unshift(async () => {
      await driver.shutdown();
      transport.close();
    });
    const events: PhoneScreenDriverEvent[] = [];
    const connection = driver.connect({
      fence: { runnerId: ownerA.runnerId } as RunnerAuxiliaryFrameFence,
      emit: async (event) => {
        events.push(event);
      },
    });
    connection.replaceAssignments([
      { deviceId: f.deviceId, generation: 1, role: "screen", definitionId: "iphone-screen" },
    ]);
    await vi.waitFor(
      () => expect(f.native.calls.some(({ method }) => method === "binding.probe")).toBe(true),
      { timeout: 1000 },
    );
    expect((await f.service.targets(ownerA.deploymentId))[0]).toMatchObject({
      ready: false,
      reason: "not-initialized",
    });
    const context: PhoneScreenContext = {
      deviceId: f.deviceId,
      driverGeneration: 1,
      sessionId: ComputerUseSessionIdSchema.parse(`cus_${crypto.randomUUID()}`),
      runId: createId("run"),
      requestId: RunnerAuxiliaryRequestIdSchema.parse("readiness"),
      access,
      threadTitle: null,
      deadline: Date.now() + 10000,
      signal: new AbortController().signal,
    };
    const { observation } = await connection.observe(context, { includeScreenshot: true });
    if (!observation) throw new Error("Expected a captured observation.");
    expect(observation.screenshot).not.toBeNull();
    expect((await f.service.targets(ownerA.deploymentId))[0]).toMatchObject({
      ready: true,
      reason: null,
    });
    const status = events
      .filter((event) => event.type === "runner.integrations.device-status")
      .at(-1)!;
    expect(status.availability).toEqual({ state: "ready", reason: null });
    expect(status.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "observe", state: "ready" }),
        expect.objectContaining({ operation: "installed_apps", state: "ready" }),
        expect.objectContaining({
          operation: "act",
          state: access === "read-write" ? "ready" : "unavailable",
        }),
      ]),
    );
    expect(status.actions).not.toContain("type");
    expect(status.actions).not.toContain("clear");
    expect(status.displayVersion).toBeNull();
    if (access === "read-write") {
      const result = await connection.act(context, {
        observationId: observation.observationId,
        includeScreenshot: true,
        actions: [{ type: "tap", target: { x: 10, y: 20 }, count: 1 }],
      });
      expect(result.error).toBeNull();
      expect(f.native.calls.filter(({ method }) => method === "phone.perform")).toHaveLength(1);
    } else expect(status.navigationButtons).toEqual([]);

    const ready = f.native.ready.bind(f.native);
    let physicallyLocked = true;
    vi.spyOn(f.native, "ready").mockImplementation((control) => {
      if (!physicallyLocked) return ready(control);
      f.native.roster = {
        revision: f.native.roster.revision + 1,
        candidates: f.native.roster.candidates.map((candidate) => ({
          ...candidate,
          reason: "phone-locked",
          capabilities: {
            ...candidate.capabilities!,
            observe: "phone-locked",
            act: "phone-locked",
            launch: "phone-locked",
          },
        })),
      };
      f.native.publish();
    });
    const epoch = f.native.epoch;
    f.native.ready(false);
    await vi.waitFor(
      () =>
        expect(
          events.filter((event) => event.type === "runner.integrations.device-status").at(-1)
            ?.availability.reason?.kind,
        ).toBe("locked"),
      { timeout: 1000 },
    );
    expect((await f.service.targets(ownerA.deploymentId))[0]?.ready).toBe(false);
    physicallyLocked = false;
    const refreshed = await connection.observe(context, { includeScreenshot: true });
    expect(refreshed.observation?.screenshot).toBeTruthy();
    expect(f.native.epoch).toBe(epoch);
    const recovered = events
      .filter((event) => event.type === "runner.integrations.device-status")
      .at(-1)!;
    expect(recovered.availability).toEqual({ state: "ready", reason: null });
    expect(recovered.operations).toContainEqual(
      expect.objectContaining({
        operation: "act",
        state: access === "read-write" ? "ready" : "unavailable",
      }),
    );
  },
);
