import { parseRunnerConfig } from "@opensteer/config";
import { createId, type RunnerId } from "@opensteer/core";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import {
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  runnerPowerStateCapability,
  type RunnerOperationalMessage,
} from "@opensteer/protocol";
import { RunnerRegistry } from "@opensteer/orchestration";
import { FileRunnerIdentityStore, ReconnectingHostConnection } from "@opensteer/runner";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  closed,
  connectPrimary,
  startPrivateMachineHost,
  revokeMachine,
  waitForMessage,
  type PrimaryConnection,
} from "./private-machine-host.test-support.js";

const shell = {
  fullDiskAccess: false,
  hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
  platform: "darwin" as const,
};
const device = { app: "opensteer", form: "laptop", platform: "macos" } as const;

it("reports sleep only from a current capable Runner until it wakes", async () => {
  const database = await cloneTestDatabase("host");
  const clock = new ManualClock();
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>> | undefined;
  let stop: AbortController | undefined;
  let running: Promise<void> | undefined;
  const peers: PrimaryConnection[] = [];
  const disconnect = RunnerRegistry.prototype.disconnect;
  const drops = new Map<RunnerId, () => void>();
  const observed = vi.spyOn(RunnerRegistry.prototype, "disconnect").mockImplementation(function (
    this: RunnerRegistry,
    peer,
  ) {
    disconnect.call(this, peer);
    for (const [runnerId, resolve] of drops) {
      if (this.isRunnerConnected(runnerId)) continue;
      drops.delete(runnerId);
      resolve();
    }
  });
  const waitForDrop = (runnerId: RunnerId) =>
    new Promise<void>((resolve) => drops.set(runnerId, resolve));

  try {
    const home = await startPrivateMachineHost(database.url, {
      executionClock: clock,
      remoteAccess: true,
    });
    host = home;
    const enrollment = async () => {
      const response = await home.api["commands.dispatch"]({
        allowedModules: ["shell"],
        access: { apps: false, browser: false, files: true },
        idempotencyKey: randomUUID(),
        name: "Studio MacBook",
        type: "runner.enrollment.createLocal",
      });
      if (!response.ok) throw new Error(response.error.message);
      if (response.data.type !== "runner.enrollment.createLocal")
        throw new Error("Missing enrollment");
      return response.data.token;
    };
    const readMac = async (runnerId: RunnerId) => {
      const response = await home.api["machines.list"]({});
      if (!response.ok) throw new Error(response.error.message);
      const mac = response.data.machines.find((machine) => machine.selfRunnerId === runnerId);
      if (!mac) throw new Error("Runner's Device is missing");
      return mac;
    };
    const assertOffline = async (runnerId: RunnerId) => {
      const mac = await readMac(runnerId);
      expect(mac.status).toBe("offline");
      expect(mac.asleepSince).toBeUndefined();
      expect(mac.capabilities?.files.reason).toEqual({ kind: "driver-offline" });
    };
    const dataDirectory = join(home.config.dataDirectory, "power-runner");
    const identityStore = new FileRunnerIdentityStore({ dataDirectory, environmentless: true });
    const identity = await identityStore.loadOrCreate();
    const startRunner = async (token?: string) => {
      const connected = Promise.withResolvers<void>();
      const connection = new ReconnectingHostConnection({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        config: parseRunnerConfig({
          OPENSTEER_DEPLOYMENT_KIND: "personal",
          OPENSTEER_HOST_URL: home.origin.origin,
          OPENSTEER_MODE: "development",
          OPENSTEER_RUNNER_DATA_DIR: dataDirectory,
          OPENSTEER_RUNNER_ENROLLMENT_TOKEN: token,
          OPENSTEER_RUNNER_ID: identity.runnerId,
          OPENSTEER_RUNNER_KIND: "local",
          OPENSTEER_RUNNER_MODULES: "shell",
          OPENSTEER_RUNNER_NAME: "Studio MacBook",
        }),
        device,
        fullDiskAccessProbe: { probe: async () => false },
        identity: await identityStore.loadOrCreate(),
        identityStore,
        logger: {
          info: console.info,
          error: (message, details) => connected.reject(new Error(message, { cause: details })),
        },
        onConnected: () => connected.resolve(),
        runtimeVersion: "integration",
        shellModule: {
          descriptor: shell,
          helperBinary: process.execPath,
          hostKeyPath: join(dataDirectory, "unused-shell-key"),
        },
      });
      stop = new AbortController();
      running = connection.run(stop.signal);
      void running.catch(connected.reject);
      await connected.promise;
      return connection;
    };

    const mac = await startRunner(await enrollment());
    expect(await readMac(identity.runnerId)).toMatchObject({ status: "online" });
    expect((await readMac(identity.runnerId)).asleepSince).toBeUndefined();
    const firstDrop = waitForDrop(identity.runnerId);
    await mac.notifySleeping();
    stop!.abort();
    await running;
    await firstDrop;
    expect(await readMac(identity.runnerId)).toMatchObject({
      status: "offline",
      asleepSince: new Date(clock.now()).toISOString(),
      capabilities: { files: { reason: { kind: "driver-asleep" } } },
    });

    await startRunner();
    const awake = await readMac(identity.runnerId);
    expect(awake.status).toBe("online");
    expect(awake.asleepSince).toBeUndefined();
    const secondDrop = waitForDrop(identity.runnerId);
    stop!.abort();
    await running;
    await secondDrop;
    await assertOffline(identity.runnerId);

    const connect = async (power: boolean, previous?: PrimaryConnection) => {
      const primary = await connectPrimary(
        home.hostPort,
        RunnerDescriptorSchema.parse({
          bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
          capabilities: power ? [runnerPowerStateCapability] : [],
          device,
          modules: { shell },
          name: "Studio MacBook",
          runnerId: previous?.fence.runnerId ?? createId("runner"),
          runnerKind: "local",
          runtimeVersion: "integration",
        }),
        previous ? { privateKey: previous.privateKey } : { token: await enrollment() },
      );
      peers.push(primary);
      return primary;
    };
    const heartbeat = (primary: PrimaryConnection, sentAt = clock.now()) => {
      const renewed = waitForMessage(
        primary.socket,
        (message) => message.type === "host.connection.lease-renewed",
      );
      send(primary, {
        ...primary.fence,
        activeRunIds: [],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        sentAt: new Date(sentAt).toISOString(),
        type: "runner.heartbeat",
      });
      return renewed;
    };
    const drop = async (primary: PrimaryConnection) => {
      const dropped = waitForDrop(primary.fence.runnerId);
      primary.socket.close();
      await closed(primary.socket);
      await dropped;
    };

    const legacy = await connect(false);
    send(legacy, { ...legacy.fence, type: "runner.power.sleeping" });
    await heartbeat(legacy);
    await drop(legacy);
    await assertOffline(legacy.fence.runnerId);

    let prior = await connect(true);
    await drop(prior);
    for (const field of ["connectionGeneration", "connectionLeaseId", "runnerId"] as const) {
      const current = await connect(true, prior);
      const rejected = once(current.socket, "close");
      const dropped = waitForDrop(current.fence.runnerId);
      send(current, {
        ...current.fence,
        [field]: field === "runnerId" ? identity.runnerId : prior.fence[field],
        type: "runner.power.sleeping",
      });
      const [code] = await rejected;
      expect(code).not.toBe(1000);
      await dropped;
      await assertOffline(current.fence.runnerId);
      await assertOffline(identity.runnerId);
      prior = current;
    }

    const continuing = await connect(true, prior);
    send(continuing, { ...continuing.fence, type: "runner.power.sleeping" });
    await heartbeat(continuing);
    clock.advanceBy(5_001);
    await heartbeat(continuing);
    await drop(continuing);
    await assertOffline(continuing.fence.runnerId);

    const removed = await connect(true, continuing);
    send(removed, { ...removed.fence, type: "runner.power.sleeping" });
    await heartbeat(removed);
    await drop(removed);
    expect((await readMac(removed.fence.runnerId)).asleepSince).toBeDefined();
    await revokeMachine(home, { key: randomUUID(), runnerId: removed.fence.runnerId });
    const remaining = await home.api["machines.list"]({});
    if (!remaining.ok) throw new Error(remaining.error.message);
    expect(
      remaining.data.machines.some((machine) => machine.selfRunnerId === removed.fence.runnerId),
    ).toBe(false);
  } finally {
    observed.mockRestore();
    stop?.abort();
    await running;
    for (const peer of peers) peer.socket.terminate();
    await host?.close();
    await database.drop();
  }
});

function send(primary: PrimaryConnection, message: RunnerOperationalMessage): void {
  primary.socket.send(JSON.stringify(message));
}
