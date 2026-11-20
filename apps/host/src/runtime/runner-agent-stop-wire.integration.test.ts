import { parseRunnerConfig } from "@opensteer/config";
import { createId, type RunnerId } from "@opensteer/core";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import {
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  runnerAgentStopCapability,
  type RunnerOperationalMessage,
} from "@opensteer/protocol";
import { RunnerRegistry } from "@opensteer/orchestration";
import {
  FileRunnerIdentityStore,
  ReconnectingHostConnection,
} from "@opensteer/runner";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  closed,
  connectPrimary,
  startPrivateMachineHost,
  waitForMessage,
  type PrimaryConnection,
} from "./private-machine-host.test-support.js";

const shell = {
  fullDiskAccess: false,
  hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
  platform: "darwin" as const,
};
const device = { app: "opensteer", form: "laptop", platform: "macos" } as const;

it("says a Device is stopped while its person has agents stopped, through a reconnect, until they resume", async () => {
  const database = await cloneTestDatabase("host");
  const clock = new ManualClock();
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>> | undefined;
  let stop: AbortController | undefined;
  let running: Promise<void> | undefined;
  const peers: PrimaryConnection[] = [];
  const disconnect = RunnerRegistry.prototype.disconnect;
  const drops = new Map<RunnerId, () => void>();
  const observedDrops = vi
    .spyOn(RunnerRegistry.prototype, "disconnect")
    .mockImplementation(function (this: RunnerRegistry, peer) {
      disconnect.call(this, peer);
      for (const [runnerId, resolve] of drops) {
        if (this.isRunnerConnected(runnerId)) continue;
        drops.delete(runnerId);
        resolve();
      }
    });
  const waitForDrop = (runnerId: RunnerId) =>
    new Promise<void>((resolve) => drops.set(runnerId, resolve));
  // The Home has taken a notice once its own handling of that frame returns.
  const handle = RunnerRegistry.prototype.handle;
  const notices = new Map<string, () => void>();
  const observedNotices = vi
    .spyOn(RunnerRegistry.prototype, "handle")
    .mockImplementation(async function (this: RunnerRegistry, peer, message) {
      await handle.call(this, peer, message);
      const type = (message as { type?: string }).type ?? "";
      notices.get(type)?.();
      notices.delete(type);
    });
  const told = (type: "runner.agents.stopped" | "runner.agents.resumed") =>
    new Promise<void>((resolve) => notices.set(type, resolve));

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
    const dataDirectory = join(home.config.dataDirectory, "stop-runner");
    const identityStore = new FileRunnerIdentityStore({ dataDirectory, environmentless: true });
    const identity = await identityStore.loadOrCreate();
    const startRunner = async (token?: string, agentsStoppedSince: string | null = null) => {
      const connected = Promise.withResolvers<void>();
      const connection = new ReconnectingHostConnection({
        agentsStoppedSince,
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

    await startRunner(await enrollment());
    expect((await readMac(identity.runnerId)).agentsStoppedSince).toBeUndefined();

    const stoppedAt = new Date(clock.now() - 60_000);
    const normalDrop = waitForDrop(identity.runnerId);
    stop!.abort();
    await running;
    await normalDrop;
    await startRunner(undefined, stoppedAt.toISOString());
    expect(await readMac(identity.runnerId)).toMatchObject({
      status: "online",
      agentsStoppedSince: stoppedAt.toISOString(),
      capabilities: { files: { reason: { kind: "driver-stopped" } } },
    });

    // A Device Runner told the Home before it was stopped: offline, and still stopped.
    const dropped = waitForDrop(identity.runnerId);
    stop!.abort();
    await running;
    await dropped;
    expect(await readMac(identity.runnerId)).toMatchObject({
      status: "offline",
      agentsStoppedSince: stoppedAt.toISOString(),
      capabilities: { files: { reason: { kind: "driver-stopped" } } },
    });

    // It reconnects still stopped and says so again on the new connection.
    const again = told("runner.agents.stopped");
    await startRunner(undefined, stoppedAt.toISOString());
    await again;
    expect(await readMac(identity.runnerId)).toMatchObject({
      status: "online",
      agentsStoppedSince: stoppedAt.toISOString(),
    });

    // The person resumes: plain online.
    const stoppedDrop = waitForDrop(identity.runnerId);
    stop!.abort();
    await running;
    await stoppedDrop;
    await startRunner();
    const live = await readMac(identity.runnerId);
    expect(live.status).toBe("online");
    expect(live.agentsStoppedSince).toBeUndefined();
    expect(live.capabilities?.files.reason).not.toEqual({ kind: "driver-stopped" });
    const lastDrop = waitForDrop(identity.runnerId);
    stop!.abort();
    await running;
    await lastDrop;

    const connect = async (capable: boolean, previous?: PrimaryConnection) => {
      const primary = await connectPrimary(
        home.hostPort,
        RunnerDescriptorSchema.parse({
          bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
          capabilities: capable ? [runnerAgentStopCapability] : [],
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
    const heartbeat = (primary: PrimaryConnection) => {
      const renewed = waitForMessage(
        primary.socket,
        (message) => message.type === "host.connection.lease-renewed",
      );
      send(primary, {
        ...primary.fence,
        activeRunIds: [],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        sentAt: new Date(clock.now()).toISOString(),
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

    // A Runner that never advertised the capability is not believed.
    const legacy = await connect(false);
    send(legacy, {
      ...legacy.fence,
      stoppedAt: new Date(clock.now()).toISOString(),
      type: "runner.agents.stopped",
    });
    await heartbeat(legacy);
    expect((await readMac(legacy.fence.runnerId)).agentsStoppedSince).toBeUndefined();
    await drop(legacy);

    // A notice on a superseded connection's fence is refused, and sets nothing.
    let prior = await connect(true);
    await drop(prior);
    for (const field of ["connectionGeneration", "connectionLeaseId", "runnerId"] as const) {
      const current = await connect(true, prior);
      const rejected = once(current.socket, "close");
      const dropped = waitForDrop(current.fence.runnerId);
      send(current, {
        ...current.fence,
        [field]: field === "runnerId" ? identity.runnerId : prior.fence[field],
        stoppedAt: new Date(clock.now()).toISOString(),
        type: "runner.agents.stopped",
      });
      const [code] = await rejected;
      expect(code).not.toBe(1000);
      await dropped;
      expect((await readMac(current.fence.runnerId)).agentsStoppedSince).toBeUndefined();
      expect((await readMac(identity.runnerId)).agentsStoppedSince).toBeUndefined();
      prior = current;
    }
  } finally {
    observedDrops.mockRestore();
    observedNotices.mockRestore();
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
