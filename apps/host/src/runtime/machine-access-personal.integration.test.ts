import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RunnerBootIdSchema,
  RunnerDescriptorSchema,
  type MachineAccessPolicy,
} from "@opensteer/protocol";
import { RunnerRegistry, type RunnerIdentity } from "@opensteer/orchestration";
import { authorizeRunnerRegistration, confirmRunnerRegistration } from "./runtime.js";
import {
  activeSessionId,
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  enrollmentToken,
  resetMachineAccessDatabase,
  runShim,
  shellSessionRows,
  startMachineAccessScenario,
  startPersonalMachineAccessScenario,
  startShim,
  waitForCondition,
  type MachineAccessScenario,
  type PersonalMachineAccessScenario,
} from "./machine-access.test-support.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";

/**
 * What a Personal Deployment does with a computer that is not the one it runs
 * on: it admits only reachable ones, only while there is a route for them to
 * arrive on, and it takes their connections away the moment that route changes.
 */
const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";
process.env.SHELL = "/bin/sh";

const openPolicy: MachineAccessPolicy = {
  commands: true,
  forwarding: false,
  reach: "owner",
  shares: [],
};

integration("Personal computer membership", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  let scenario: PersonalMachineAccessScenario | undefined;
  let serverScenario: MachineAccessScenario | undefined;

  beforeEach(async () => {
    await resetMachineAccessDatabase(databaseUrl);
  });

  afterEach(async () => {
    await scenario?.close();
    scenario = undefined;
    await serverScenario?.close();
    serverScenario = undefined;
  }, 60_000);

  it("ends the reachable computer's sessions and drops it when remote access changes", async () => {
    scenario = await startPersonalMachineAccessScenario(databaseUrl, { policy: openPolicy });
    const { alias, caller, host, launch, target } = scenario;
    const long = startShim(launch, "ssh", [alias, "sleep 60"]);
    const sessionId = await activeSessionId(host, target.runnerId);

    const configured = await configurePersonalRemoteAccess(host, {
      mode: "off",
      routeOrigin: null,
    });
    expect(configured).toMatchObject({ mode: "off" });

    const started = Date.now();
    const exited = await long.exited;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(exited.code).not.toBe(0);
    // The route those bytes travelled is gone, so the session ended as the
    // disconnection it is — not as a revocation and not as a policy change.
    await waitForCondition(async () =>
      (await shellSessionRows(host)).every((row) => row.state === "ended"),
    );
    expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
      [sessionId, "machine-disconnected"],
    ]);

    const machines = await waitForMachines(host, (rows) =>
      rows.some((machine) => machine.id === target.runnerId && machine.status === "offline"),
    );
    // Nothing was revoked: the computer is still a member, merely offline. The
    // computer the Deployment runs on never travelled that route and stays.
    expect(machines.find((machine) => machine.id === target.runnerId)).toMatchObject({
      allowedModules: ["integrations", "messaging", "shell"],
      status: "offline",
    });
    expect(machines.find((machine) => machine.id === caller.runnerId)).toMatchObject({
      status: "online",
    });
    expect(
      await host.store.database
        .selectFrom("runners")
        .select(["revokedAt"])
        .where("id", "=", target.runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revokedAt: null });

    // It is refused while the route is off, on the credential it kept: sent
    // away with the same "going away" code the sweep used, and told what to do
    // about it rather than that it did something wrong.
    await expect(target.reconnect()).rejects.toThrow(
      "socket closed with 1001: Turn on remote access on this computer to connect other computers.",
    );

    // And it comes back by itself once there is a route again.
    await configurePersonalRemoteAccess(host, {
      mode: "private",
      routeOrigin: "https://personal.machine-access.test",
    });
    await target.reconnect();
    await waitForMachines(host, (rows) =>
      rows.some((machine) => machine.id === target.runnerId && machine.status === "online"),
    );
    expect(await runShim(launch, "ssh", [alias, "echo back"])).toMatchObject({
      code: 0,
      stdout: "back\n",
    });
  }, 240_000);

  it("refuses a computer admitted an instant before remote access changed", async () => {
    scenario = await startPersonalMachineAccessScenario(databaseUrl, { policy: openPolicy });
    const { host, target } = scenario;
    // Out of the way, so the admission below is the only thing holding this
    // computer's connection fence.
    await target.disconnect();
    await waitForMachines(host, (rows) =>
      rows.some((machine) => machine.id === target.runnerId && machine.status === "offline"),
    );
    const sessionsBefore = (await shellSessionRows(host)).length;

    // The step the Host takes between an identity proof and registration. It
    // commits against the route that exists right now, which is the whole
    // reason it has to say which route that was.
    const admitted = await host.store.authenticateRunnerConnection(
      RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: { shell: { hostPublicKey: target.hostPublicKey, platform: "darwin" } },
        name: target.name,
        runnerId: target.runnerId,
        runnerKind: "local",
        runtimeVersion: "integration",
      }),
    );
    const identity = {
      allowedModules: admitted.allowedModules,
      connectionGeneration: admitted.connectionGeneration,
      environmentIds: admitted.environmentIds,
      personalRemoteAccessGeneration: admitted.personalRemoteAccessGeneration,
      runnerId: admitted.runnerId,
      runnerKind: admitted.runnerKind,
    };
    expect(admitted.personalRemoteAccessGeneration).toEqual(expect.any(Number));
    // Nothing has moved yet, so this connection would become a computer.
    await expect(authorizeRunnerRegistration(host.store, identity)).resolves.toBeUndefined();

    // Remote access changes. Its sweep runs against the registry and finds
    // nothing to drop, because this connection is not registered yet — that is
    // exactly the window.
    const reconfigured = await configurePersonalRemoteAccess(host, {
      mode: "off",
      routeOrigin: null,
    });
    expect(reconfigured.generation).not.toBe(admitted.personalRemoteAccessGeneration);

    await expect(authorizeRunnerRegistration(host.store, identity)).rejects.toMatchObject({
      code: "forbidden",
      message: "Turn on remote access on this computer to connect other computers.",
      reason: "personal-remote-access-off",
    });
    // It never became a computer, so there is nothing to open a session on and
    // the identity is untouched.
    expect(await shellSessionRows(host)).toHaveLength(sessionsBefore);
    expect(
      await host.store.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", target.runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revokedAt: null });
  }, 180_000);

  it("refuses a computer whose route changed while it was being registered", async () => {
    scenario = await startPersonalMachineAccessScenario(databaseUrl, { policy: openPolicy });
    const { host, target } = scenario;
    await target.disconnect();
    await waitForMachines(host, (rows) =>
      rows.some((machine) => machine.id === target.runnerId && machine.status === "offline"),
    );
    const sessionsBefore = (await shellSessionRows(host)).length;

    const admitted = await host.store.authenticateRunnerConnection(
      RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: { shell: { hostPublicKey: target.hostPublicKey, platform: "darwin" } },
        name: target.name,
        runnerId: target.runnerId,
        runnerKind: "local",
        runtimeVersion: "integration",
      }),
    );
    const identity = {
      ...RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: { shell: { hostPublicKey: target.hostPublicKey, platform: "darwin" } },
        name: target.name,
        runnerId: target.runnerId,
        runnerKind: "local",
        runtimeVersion: "integration",
      }),
      allowedModules: admitted.allowedModules,
      connectionGeneration: admitted.connectionGeneration,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      environmentIds: admitted.environmentIds,
      personalRemoteAccessGeneration: admitted.personalRemoteAccessGeneration,
    } as never as RunnerIdentity;
    const fenced: RunnerIdentity = { ...identity, fence: { ...identity } };

    // The interleaving the post-insert read exists for, forced through the one
    // seam that sits between the two: `authorize` has passed, and the settings
    // change lands before the registry holds this connection — so its sweep,
    // which runs against the Host's own registry, finds nothing to sweep.
    let bumped = false;
    let survived: boolean | undefined;
    const registry: RunnerRegistry = new RunnerRegistry({
      hooks: {
        authorize: async (candidate) => {
          await authorizeRunnerRegistration(host.store, candidate);
          if (bumped) return;
          bumped = true;
          await configurePersonalRemoteAccess(host, { mode: "off", routeOrigin: null });
        },
        onEvent: async () => undefined,
        onRegistered: async (candidate) => {
          survived = await confirmRunnerRegistration(host.store, registry, candidate);
        },
      },
    });
    const peer = {
      id: "refused-peer",
      close: (code: number, reason: string) => {
        closed = { code, reason };
      },
      send: async () => undefined,
    };
    let closed: { code: number; reason: string } | undefined;

    // The first half of the fence still passes: at that moment nothing had moved.
    await registry.register(fenced, peer);
    await waitForCondition(async () => survived !== undefined);

    expect(survived).toBe(false);
    expect(closed).toEqual({
      code: 1001,
      reason: "Turn on remote access on this computer to connect other computers.",
    });
    expect(registry.isRunnerConnected(target.runnerId)).toBe(false);
    // It never became a computer, so there is nothing to open a session on.
    expect(await shellSessionRows(host)).toHaveLength(sessionsBefore);
    await registry.close();
  }, 180_000);

  it("issues a Personal enrollment only for a computer that is reachable and nothing else", async () => {
    scenario = await startPersonalMachineAccessScenario(databaseUrl, { policy: openPolicy });
    const { host } = scenario;

    const refused = await testRpcRequest(
      host.origin,
      "commands.dispatch",
      {
        allowedModules: ["agents"],
        idempotencyKey: "personal-agents",
        name: "Another Mac",
        type: "runner.enrollment.createLocal",
      },
      { headers: host.ownerHeaders },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "forbidden",
        message: "Only reachable computers can join a Personal Deployment.",
      },
    });

    // The same person, the same route, asking for reach: honoured.
    await expect(
      enrollmentToken(host, {
        allowedModules: ["shell"],
        idempotencyKey: "personal-shell",
        name: "Another Mac",
      }),
    ).resolves.toEqual(expect.any(String));
  }, 180_000);

  it("leaves a server Deployment free to admit a computer that runs agents", async () => {
    // The rule is about Personal Deployments, not about grants: the same
    // command on a server Deployment mints the same agents computer as always.
    serverScenario = await startMachineAccessScenario(databaseUrl, { policy: openPolicy });
    await expect(
      enrollmentToken(serverScenario.host, {
        allowedModules: ["agents", "browser"],
        idempotencyKey: "server-agents",
        name: "Build box",
      }),
    ).resolves.toEqual(expect.any(String));
  }, 180_000);
});

type MachineRows = Awaited<ReturnType<typeof machineRows>>;

function machineRows(host: MachineAccessScenario["host"]) {
  return testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders }).then(
    (inventory) => inventory.machines,
  );
}

async function waitForMachines(
  host: MachineAccessScenario["host"],
  ready: (machines: MachineRows) => boolean,
): Promise<MachineRows> {
  let latest = await machineRows(host);
  await waitForCondition(async () => {
    latest = await machineRows(host);
    return ready(latest);
  });
  return latest;
}
