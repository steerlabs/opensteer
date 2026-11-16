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
  },
);
