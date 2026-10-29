import { createDatabase } from "@opensteer/database";
import { AgentControlResponseSchema } from "@opensteer/protocol";
import { connect, createServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MachineAccessPolicy } from "@opensteer/protocol";
import {
  activeSessionId,
  openRealtime,
  machineAccessHistory,
  createMachineAccessDatabase,
  resetMachineAccessDatabase,
  revokeMachine,
  runGrants,
  runShim,
  shellSessionRows,
  startMachineAccessScenario,
  startShim,
  steerRun,
  stopRun,
  stopShellSession,
  updateAccessPolicy,
  waitForCondition,
  waitForValue,
  connectCallerMachine,
  connectTargetMachine,
  dispatchCallerRun,
  enrollmentToken,
  followWorkspace,
  setUpCallerLaunchDirectory,
  startMachineAccessHost,
  type MachineAccessScenario,
} from "./machine-access.test-support.js";
import { createId, type CommandId, type RunId } from "@opensteer/core";
import { sql } from "kysely";
import { testRpcData } from "../server/test-host-api-request.js";

/** Everything that ends a live session, and what the caller and the row say. */
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

integration("Machine access session lifecycle", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  let scenario: MachineAccessScenario | undefined;

  beforeEach(async () => {
    await resetMachineAccessDatabase(databaseUrl);
  });

  afterEach(async () => {
    await scenario?.close();
    scenario = undefined;
  }, 60_000);

  it("fulfills a full access Request only after the Mac reports its grant", async () => {
    const host = await startMachineAccessHost(databaseUrl);
    const closers: (() => Promise<void>)[] = [() => host.close()];
    const db = createDatabase({ connectionString: databaseUrl });
    closers.unshift(() => db.destroy());
    try {
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "fda-caller",
          name: "Caller",
        }),
      });
      closers.unshift(() => caller.close());
      const target = await connectTargetMachine(host, {
        name: "Test Mac",
        fullDiskAccess: false,
        token: await enrollmentToken(host, {
          allowedModules: ["shell"],
          idempotencyKey: "fda-mac",
          name: "Test Mac",
        }),
      });
      closers.unshift(() => target.close());
      await updateAccessPolicy(host, {
        expectedRevision: 1,
        key: "fda-reach",
        policy: openPolicy,
        runnerId: target.runnerId,
      });
      const list = () =>
        testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders });
      expect(
        (await list()).machines.find((machine) => machine.id === target.runnerId)?.fullDiskAccess,
      ).toBe(false);
      const run = await dispatchCallerRun(host, caller, { key: "fda-run", title: "Read Mail" });
      expect(
        run.machineAccess?.machines.find((machine) => machine.runnerId === target.runnerId)
          ?.fullDiskAccess,
      ).toBe(false);
      const response = await fetch(new URL("/internal/v1/agent-control", host.origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${run.agentControlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          type: "machine.full-disk-access.request",
          computer: "test-mac",
          reason: "Read Mail",
        }),
      });
      expect(response.status).toBe(200);
      const result = AgentControlResponseSchema.parse(await response.json());
      if (result.type !== "machine.full-disk-access.request.result")
        throw new Error("Unexpected response");
      const requestId = result.result.requestId;
      expect(await host.store.requests.get(requestId)).toMatchObject({
        kind: "machine.full-disk-access",
        mode: "durable",
        requiredActor: "requester",
        status: "pending",
        payload: {
          kind: "machine.full-disk-access",
          machineId: target.runnerId,
          machineName: "Test Mac",
          reason: "Read Mail",
        },
        presentation: {
          kind: "external",
          subject: { kind: "machine", id: target.runnerId },
          title: "Allow macOS Full Disk Access on Test Mac",
          detail: "Read Mail",
        },
      });
      const feed = await openRealtime(host, host.ownerHeaders);
      closers.unshift(() => feed.close());
      target.reportFullDiskAccess(true);
      await waitForCondition(async () =>
        feed.messages.some((message) => message.type === "host.machines.changed"),
      );
      await waitForCondition(
        async () => (await host.store.requests.get(requestId))?.status === "fulfilled",
      );
      expect(
        (await list()).machines.find((machine) => machine.id === target.runnerId)?.fullDiskAccess,
      ).toBe(true);
      expect(
        await db
          .selectFrom("requestContinuations")
          .select("requestId")
          .where("requestId", "=", requestId)
          .execute(),
      ).toEqual([{ requestId }]);
    } finally {
      for (const close of closers) await close();
    }
  }, 180_000);

  it("fulfills a pending full access Request when the Mac comes back holding the grant", async () => {
    // macOS applies the grant only after the app quits and reopens, so the
    // grant arrives as a fresh registration, not as a change message.
    const host = await startMachineAccessHost(databaseUrl);
    const closers: (() => Promise<void>)[] = [() => host.close()];
    try {
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "fda-relaunch-caller",
          name: "Caller",
        }),
      });
      closers.unshift(() => caller.close());
      const target = await connectTargetMachine(host, {
        name: "Test Mac",
        fullDiskAccess: false,
        token: await enrollmentToken(host, {
          allowedModules: ["shell"],
          idempotencyKey: "fda-relaunch-mac",
          name: "Test Mac",
        }),
      });
      closers.unshift(() => target.close());
      await updateAccessPolicy(host, {
        expectedRevision: 1,
        key: "fda-relaunch-reach",
        policy: openPolicy,
        runnerId: target.runnerId,
      });
      const run = await dispatchCallerRun(host, caller, {
        key: "fda-relaunch-run",
        title: "Read Mail",
      });
      const response = await fetch(new URL("/internal/v1/agent-control", host.origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${run.agentControlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          type: "machine.full-disk-access.request",
          computer: "test-mac",
          reason: "Read Mail",
        }),
      });
      expect(response.status).toBe(200);
      const result = AgentControlResponseSchema.parse(await response.json());
      if (result.type !== "machine.full-disk-access.request.result")
        throw new Error("Unexpected response");
      const requestId = result.result.requestId;
      expect((await host.store.requests.get(requestId))?.status).toBe("pending");

      await target.disconnect();
      // Still pending while the Mac is away: nothing can have changed.
      expect((await host.store.requests.get(requestId))?.status).toBe("pending");
      await target.reconnect({ fullDiskAccess: true });

      await waitForCondition(
        async () => (await host.store.requests.get(requestId))?.status === "fulfilled",
      );
      const list = () =>
        testRpcData(host.origin, "machines.list", {}, { headers: host.ownerHeaders });
      expect(
        (await list()).machines.find((machine) => machine.id === target.runnerId)?.fullDiskAccess,
      ).toBe(true);
    } finally {
      for (const close of closers) await close();
    }
  }, 180_000);

  it("ends every live session on a policy write, and nothing on a stale one", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: openPolicy,
    });
    const { alias, host, launch, target } = scenario;
    const long = startShim(launch, "ssh", [alias, "sleep 60"]);
    const sessionId = await activeSessionId(host, target.runnerId);

    // A stale expected revision is an outcome the editor renders, not an error,
    // and it must not touch a session it did not authorize ending.
    const conflict = await updateAccessPolicy(host, {
      expectedRevision: 1,
      key: "policy-stale",
      policy: { ...openPolicy, shares: [] },
      runnerId: target.runnerId,
    });
    expect(conflict).toEqual({ outcome: "conflict", type: "machine.access.update" });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect((await shellSessionRows(host)).map((row) => [row.id, row.state, row.endReason])).toEqual(
      [[sessionId, "active", null]],
    );

    const written = await updateAccessPolicy(host, {
      expectedRevision: 2,
      key: "policy-write",
      policy: openPolicy,
      runnerId: target.runnerId,
    });
    expect(written).toEqual({ outcome: "updated", revision: 3, type: "machine.access.update" });

    const started = Date.now();
    const exited = await long.exited;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(exited.code).not.toBe(0);
    await waitForCondition(async () =>
      (await shellSessionRows(host)).every((row) => row.state === "ended"),
    );
    expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
      [sessionId, "policy-changed"],
    ]);

    const after = await runShim(launch, "ssh", [alias, "echo after"]);
    expect(after).toMatchObject({ code: 0, stdout: "after\n" });
  }, 180_000);

  it("ends a live session on Stop, and says a second Stop ended nothing", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: openPolicy,
    });
    const { alias, host, launch, target } = scenario;
    const long = startShim(launch, "ssh", [alias, "sleep 60"]);
    const sessionId = await activeSessionId(host, target.runnerId);

    expect(await stopShellSession(host, { key: "stop-1", sessionId })).toEqual({
      ended: true,
      type: "machine.access.session.stop",
    });
    const exited = await long.exited;
    expect(exited.code).not.toBe(0);
    expect((await shellSessionRows(host)).map((row) => [row.id, row.state, row.endReason])).toEqual(
      [[sessionId, "ended", "stopped-by-owner"]],
    );

    expect(await stopShellSession(host, { key: "stop-2", sessionId })).toEqual({
      ended: false,
      type: "machine.access.session.stop",
    });
    expect((await shellSessionRows(host)).map((row) => row.endReason)).toEqual([
      "stopped-by-owner",
    ]);
  }, 180_000);

  it("ends sessions and the target's processes when the machine is revoked", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: openPolicy,
    });
    const { alias, host, launch, target } = scenario;
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-ma-revoke-"));
    try {
      const pidFile = join(scratch, "group.pid");
      const long = startShim(launch, "ssh", [alias, `echo $$ > ${pidFile}; sleep 60; echo late`]);
      const sessionId = await activeSessionId(host, target.runnerId);
      const processGroup = Number.parseInt(
        await waitForValue(async () => {
          const content = await readFile(pidFile, "utf8").catch(() => "");
          return content.trim() === "" ? undefined : content.trim();
        }),
        10,
      );
      expect(processGroup).toBeGreaterThan(0);
      expect(processAlive(processGroup)).toBe(true);

      await revokeMachine(host, { key: "revoke-1", runnerId: target.runnerId });
      const exited = await long.exited;
      expect(exited.stdout).not.toContain("late");
      expect(exited.code).not.toBe(0);

      await waitForCondition(async () =>
        (await shellSessionRows(host)).every((row) => row.endReason === "machine-revoked"),
      );
      expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
        [sessionId, "machine-revoked"],
      ]);
      // The helper terminates the process group it started before it exits, so
      // nothing the command left running survives the revocation.
      await waitForCondition(async () => !processAlive(processGroup), 10_000);
      expect(processAlive(processGroup)).toBe(false);

      // And when it tries to come back on the credential it kept, it is told
      // its identity is gone — apart from every refusal it should retry, so
      // the computer supervising it clears the slot instead of reconnecting.
      const refused = await target.observeRefusal();
      expect(refused.close).toEqual({ code: 4010, reason: "Runner identity was revoked" });
      // Nothing precedes it. A `host.error` frame here is read first and
      // thrown on, so the Runner would never reach the code that tells it to
      // stop — the close frame has to be the whole message.
      expect(refused.frames.map((frame) => frame.type)).toEqual(["host.challenge"]);
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  }, 180_000);

  it("closes the Run's relay and ends its sessions when the Run ends", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: openPolicy,
    });
    const { alias, host, launch, run, target } = scenario;
    const long = startShim(launch, "ssh", [alias, "sleep 60"]);
    const sessionId = await activeSessionId(host, target.runnerId);

    await run.complete();
    const exited = await long.exited;
    expect(exited.code).not.toBe(0);
    await waitForCondition(async () =>
      (await shellSessionRows(host)).every((row) => row.state === "ended"),
    );
    expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
      [sessionId, "run-ended"],
    ]);

    // The Runner owns the relay socket and takes it away with the Run.
    await launch.close();
    await expect(connectToSocket(launch.machineAccessRelaySocket)).rejects.toThrow();
  }, 180_000);

  it("prints the offline sentence, queues nothing, and works again on reconnect", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: openPolicy,
    });
    const { alias, host, launch, target } = scenario;
    expect(await runShim(launch, "ssh", [alias, "echo online"])).toMatchObject({ code: 0 });
    const before = (await shellSessionRows(host)).length;

    await target.disconnect();
    await waitForCondition(async () => {
      const inventory = await testRpcData(
        host.origin,
        "machines.list",
        {},
        { headers: host.ownerHeaders },
      );
      return inventory.machines.some(
        (machine) => machine.id === target.runnerId && machine.status === "offline",
      );
    });

    const offline = await runShim(launch, "ssh", [alias, "true"]);
    expect(offline.code).toBe(255);
    expect(offline.stderr).toContain("Example Mac is offline (last seen ");
    expect(offline.stderr).toContain(").");
    // Nothing is queued: an unreachable machine gets no reservation at all.
    expect((await shellSessionRows(host)).length).toBe(before);

    await target.reconnect();
    await waitForCondition(async () => {
      const inventory = await testRpcData(
        host.origin,
        "machines.list",
        {},
        { headers: host.ownerHeaders },
      );
      return inventory.machines.some(
        (machine) => machine.id === target.runnerId && machine.status === "online",
      );
    });
    expect(await runShim(launch, "ssh", [alias, "echo back"])).toMatchObject({
      code: 0,
      stdout: "back\n",
    });
  }, 180_000);

  it("refuses a caller the machine's reach does not admit", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: openPolicy,
    });
    const { alias, host, launch, target } = scenario;
    expect(await runShim(launch, "ssh", [alias, "true"])).toMatchObject({ code: 0 });

    await updateAccessPolicy(host, {
      expectedRevision: 2,
      key: "reach-nobody",
      policy: { ...openPolicy, reach: "nobody" },
      runnerId: target.runnerId,
    });
    const denied = await runShim(launch, "ssh", [alias, "true"]);
    expect(denied.code).toBe(255);
    expect(denied.stderr).toContain("Example Mac does not allow access from other computers.");
    // A refusal reserves nothing, so no row was ever written for it.
    expect((await shellSessionRows(host)).every((row) => row.endReason !== null)).toBe(true);
  }, 180_000);

  it("refuses `reach: owner` on a machine whose effective owner is not the caller", async () => {
    // A managed computer belongs to this server Deployment rather than to a
    // person, so it has no effective owner and `reach: owner` admits no Run at
    // all — including the administrator's own, who may still manage it.
    const host = await startMachineAccessHost(databaseUrl);
    const closers: (() => Promise<void>)[] = [() => host.close()];
    try {
      const caller = await connectCallerMachine(host, {
        name: "Caller computer",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "caller",
          name: "Caller computer",
        }),
      });
      closers.unshift(() => caller.close());
      const deploymentMachine = await connectTargetMachine(host, {
        name: "Build Box",
        runnerKind: "managed",
        token: await enrollmentToken(host, {
          allowedModules: ["shell"],
          idempotencyKey: "build-box",
          managed: true,
          name: "Build Box",
        }),
      });
      closers.unshift(() => deploymentMachine.close());
      await expect(host.store.effectiveMachineOwner(deploymentMachine.runnerId)).resolves.toEqual({
        effectiveOwner: null,
        ownerKind: "deployment",
      });

      await updateAccessPolicy(host, {
        expectedRevision: 1,
        key: "build-box-deployment",
        policy: { ...openPolicy, reach: "deployment" },
        runnerId: deploymentMachine.runnerId,
      });
      const run = await dispatchCallerRun(host, caller, { key: "run", title: "Reach out" });
      const launch = await setUpCallerLaunchDirectory(host, run);
      closers.unshift(() => launch.close());
      expect(run.machineAccess?.machines.map((machine) => machine.alias)).toEqual(["build-box"]);
      expect(await runShim(launch, "ssh", ["build-box", "true"])).toMatchObject({ code: 0 });

      // A Deployment-owned computer has no effective owner, so "owner" reach
      // would admit nobody: the authoritative write refuses it by name rather
      // than saving a setting that silently locks everyone out.
      await expect(
        updateAccessPolicy(host, {
          expectedRevision: 2,
          key: "build-box-owner",
          policy: openPolicy,
          runnerId: deploymentMachine.runnerId,
        }),
      ).rejects.toThrow("cannot be limited to its owner's agents");
      // Nothing changed, so the Run still reaches the computer and the refused
      // write closed no session.
      expect(await runShim(launch, "ssh", ["build-box", "true"])).toMatchObject({ code: 0 });
      await waitForCondition(async () => {
        const history = await machineAccessHistory(host, deploymentMachine.runnerId);
        return (
          history.sessions.length === 2 &&
          history.sessions.every(
            (session) =>
              session.endReason === "client-closed" || session.endReason === "target-closed",
          )
        );
      });
      const history = await machineAccessHistory(host, deploymentMachine.runnerId);
      expect(history.sessions).toHaveLength(2);
      // A completed SSH process closes both ends of the byte stream. Which
      // close reaches the Host first is scheduling-dependent; either natural
      // close proves the refused policy write did not terminate the session.
      expect(
        history.sessions.every(
          (session) =>
            session.endReason === "client-closed" || session.endReason === "target-closed",
        ),
      ).toBe(true);
    } finally {
      for (const close of closers) await close().catch(() => undefined);
    }
  }, 180_000);

  it("binds one environment and keeps it while a computer flips to reach-only and back", async () => {
    const host = await startMachineAccessHost(databaseUrl);
    const machine = await connectTargetMachine(host, {
      name: "Studio Mac",
      // The grant says what this computer may ever advertise; what it is
      // advertising right now is a separate fact, and it starts reach-only.
      token: await enrollmentToken(host, {
        allowedModules: ["agents", "shell"],
        idempotencyKey: "flippable",
        name: "Studio Mac",
      }),
    });
    try {
      const bound = () =>
        host.store.database
          .selectFrom("executionEnvironments")
          .select("id")
          .where("runnerId", "=", machine.runnerId)
          .execute()
          .then((rows) => rows.map((row) => row.id));
      const row = async () => {
        const inventory = await testRpcData(
          host.origin,
          "machines.list",
          {},
          { headers: host.ownerHeaders },
        );
        const found = inventory.machines.find((entry) => entry.id === machine.runnerId);
        if (!found) throw new Error("The computer is missing from the list.");
        return found;
      };
      const placement = async () => {
        const bootstrap = await testRpcData(
          host.origin,
          "bootstrap.get",
          {},
          { headers: host.ownerHeaders },
        );
        return bootstrap.environments.find((entry) => entry.id === machine.environmentId)?.status;
      };

      // Enrolled reach-only: nothing to bind yet, and nowhere to place work.
      expect(await bound()).toEqual([]);
      expect(await row()).toMatchObject({
        allowedModules: ["agents", "integrations", "messaging", "shell"],
        status: "online",
      });
      expect(Object.keys((await row()).modules)).toEqual(["shell"]);
      expect(await placement()).toBeUndefined();

      // Running agents: the first advertisement is the binding.
      await machine.reconnect({ runsAgents: true });
      await waitForCondition(async () => (await placement()) === "connected");
      expect(await bound()).toEqual([machine.environmentId]);
      expect(Object.keys((await row()).modules).sort()).toEqual(["agents", "shell"]);

      // Reach-only again: the binding survives, and the row stops offering the
      // module, exactly as it reads when a lent machine is stopped.
      await machine.reconnect({ runsAgents: false });
      await waitForCondition(async () => (await placement()) === "disconnected");
      expect(await bound()).toEqual([machine.environmentId]);
      expect(Object.keys((await row()).modules)).toEqual(["shell"]);

      // And back, onto the same environment rather than a second one.
      await machine.reconnect({ runsAgents: true });
      await waitForCondition(async () => (await placement()) === "connected");
      expect(await bound()).toEqual([machine.environmentId]);

      // A different environment is a different computer wearing this one's
      // credential, and the binding never moves.
      await expect(
        machine.reconnect({ environmentId: createId("environment"), runsAgents: true }),
      ).rejects.toThrow();
      expect(await bound()).toEqual([machine.environmentId]);
    } finally {
      await machine.close().catch(() => undefined);
      await host.close();
    }
  }, 180_000);
});

/*
 * A session lives as long as the grant that admitted it, not as long as its
 * Run. The ways that goes wrong, each pinned by a journey below:
 * - Stop revokes the grant, but a command and a `-L` forward keep moving bytes
 *   until the Runner reports `run.interrupted`, or forever if it never does.
 * - The session ends, but for another reason: the caller's ssh giving up
 *   (`client-closed`), the target (`target-closed`), or the Run's later end.
 * - Restart steering leaves the superseded attempt's sessions running.
 * - Ending by Run rather than by grant: the replacement attempt's sessions die
 *   with a duplicate of the steer, a replayed report from the old attempt, or
 *   any other late word about it.
 * - A token refresh, or the first token's expiry, ends a session its grant
 *   still admits; or an expired token still opens one.
 * - The Run's own end no longer ends what its live grant admitted.
 *
 * The artifact records, per journey, each grant and each session: which
 * binding generation opened it, how it ended, and when, relative to the grant's
 * revocation and the Run's terminal event. It never holds a bearer.
 */
interface AuthoritySession {
  readonly endReason: string | null;
  /** Milliseconds from the revocation of the grant that admitted it, when it was revoked. */
  readonly endedAfterRevocationMs: number | null;
  /** Milliseconds before the Run's terminal event was recorded, when it has one. */
  readonly endedBeforeTerminalMs: number | null;
  readonly id: string;
  readonly openedUnderBindingGeneration: number;
  readonly shimExitCode: number | null;
}

interface AuthorityJourney {
  readonly grants: readonly {
    readonly bindingGeneration: number;
    readonly id: string;
    readonly revokedReason: string | null;
    readonly status: string;
  }[];
  readonly name: string;
  readonly runId: string;
  /** The Run as it stood when the revoked grant's sessions were all seen ended. */
  readonly runWhenRevokedSessionsEnded: {
    readonly status: string;
    readonly terminalEvents: readonly string[];
  } | null;
  readonly sessions: readonly AuthoritySession[];
  readonly terminalEvent: string | null;
}

integration("Machine access across a Run's authority", () => {
  let authorityDatabase: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
  let authorityDatabaseUrl = "postgres://unconfigured";
  let scenario: MachineAccessScenario | undefined;
  const journeys: AuthorityJourney[] = [];

  beforeAll(async () => {
    authorityDatabase = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    authorityDatabaseUrl = authorityDatabase.url;
  }, 120_000);

  afterAll(async () => {
    await authorityDatabase?.drop();
    authorityDatabase = undefined;
    const directory = await mkdtemp(join(tmpdir(), "opensteer-machine-access-authority-"));
    const artifact = join(directory, "sessions-by-grant.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Machine access sessions by grant: ${artifact}`);
  }, 120_000);

  beforeEach(async () => {
    await resetMachineAccessDatabase(authorityDatabaseUrl);
  });

  afterEach(async () => {
    await scenario?.close();
    scenario = undefined;
  }, 60_000);

  /** What the database says happened to one Run's grants and sessions, for the artifact. */
  async function record(
    name: string,
    host: MachineAccessScenario["host"],
    runId: RunId,
    sessions: readonly {
      readonly id: string;
      readonly openedUnderBindingGeneration: number;
      readonly shimExitCode: number | null;
    }[],
    runWhenRevokedSessionsEnded: AuthorityJourney["runWhenRevokedSessionsEnded"],
  ): Promise<AuthorityJourney> {
    const grants = await runGrants(host, runId);
    const rows = await shellSessionRows(host);
    const terminal = await host.store.database
      .selectFrom("workspaceEvents")
      .select(["createdAt", "type"])
      .where("runId", "=", runId)
      .where("type", "in", ["run.completed", "run.failed", "run.interrupted"])
      .executeTakeFirst();
    const journey: AuthorityJourney = {
      grants: grants.map((grant) => ({
        bindingGeneration: grant.bindingGeneration,
        id: grant.id,
        revokedReason: grant.revokedReason,
        status: grant.status,
      })),
      name,
      runId,
      runWhenRevokedSessionsEnded,
      sessions: sessions.map((session) => {
        const row = rows.find((candidate) => candidate.id === session.id);
        const grant = grants.find(
          (candidate) => candidate.bindingGeneration === session.openedUnderBindingGeneration,
        );
        const endedAt = row?.endedAt?.getTime() ?? null;
        const revokedAt = grant?.revokedAt?.getTime() ?? null;
        return {
          endReason: row?.endReason ?? null,
          endedAfterRevocationMs:
            endedAt !== null && revokedAt !== null ? endedAt - revokedAt : null,
          endedBeforeTerminalMs:
            endedAt !== null && terminal ? terminal.createdAt.getTime() - endedAt : null,
          id: session.id,
          openedUnderBindingGeneration: session.openedUnderBindingGeneration,
          shimExitCode: session.shimExitCode,
        };
      }),
      terminalEvent: terminal?.type ?? null,
    };
    journeys.push(journey);
    return journey;
  }

  async function runState(host: MachineAccessScenario["host"], runId: RunId) {
    const run = await host.store.database
      .selectFrom("runs")
      .select(["bindingGeneration", "status"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    const terminal = await host.store.database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("runId", "=", runId)
      .where("type", "in", ["run.completed", "run.failed", "run.interrupted"])
      .execute();
    return { ...run, terminalEvents: terminal.map((event) => event.type) };
  }

  it("ends a stopped Run's command and forward at the revocation, before the Run reports its end", async () => {
    scenario = await startMachineAccessScenario(authorityDatabaseUrl, {
      policy: { ...openPolicy, forwarding: true },
    });
    const { alias, host, launch, run, target } = scenario;
    const echo = await startEchoServer();
    try {
      const generation = run.attempt.bindingGeneration;
      const command = startShim(launch, "ssh", [alias, "sleep 60; echo late"]);
      const commandSession = await activeSessionId(host, target.runnerId);
      const forwardPort = await freeLocalPort();
      const forward = startShim(launch, "ssh", [
        "-N",
        "-L",
        `${forwardPort}:127.0.0.1:${echo.port}`,
        alias,
      ]);
      const forwardSession = await activeSessionId(host, target.runnerId, [commandSession]);
      await waitForCondition(async () => (await pingThrough(forwardPort)) === "ping-pong");
      // A connection through the forward, held open across the Stop.
      const tunnel = await holdTunnel(forwardPort);

      await stopRun(host, run, "stop-the-run");

      // The grant is revoked when Stop commits; the Runner has not answered
      // the interrupt, so the Run is still running and has recorded no end.
      await waitForCondition(async () =>
        (await shellSessionRows(host)).every((row) => row.state === "ended"),
      );
      const atEnding = await runState(host, run.runId);
      expect(atEnding).toMatchObject({ status: "running", terminalEvents: [] });
      expect(
        (await runGrants(host, run.runId)).map((grant) => [grant.status, grant.revokedReason]),
      ).toEqual([["revoked", "stopped"]]);
      expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
        [commandSession, "run-ended"],
        [forwardSession, "run-ended"],
      ]);
      const [grant] = await runGrants(host, run.runId);
      for (const row of await shellSessionRows(host)) {
        expect(row.endedAt!.getTime()).toBeGreaterThanOrEqual(grant!.revokedAt!.getTime());
        expect(row.endedAt!.getTime() - grant!.revokedAt!.getTime()).toBeLessThan(5_000);
      }
      const commandExit = await command.exited;
      expect(commandExit.code).not.toBe(0);
      expect(commandExit.stdout).not.toContain("late");
      const forwardExit = await forward.exited;
      expect(forwardExit.code).not.toBe(0);
      await tunnel.closed;
      expect(await pingThrough(forwardPort)).toBe("unreachable");

      // Only now does the caller's Runner say the Run ended; the sessions keep
      // the ending they already had.
      await run.reportInterrupted();
      await waitForCondition(
        async () => (await runState(host, run.runId)).status === "interrupted",
      );
      expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
        [commandSession, "run-ended"],
        [forwardSession, "run-ended"],
      ]);
      const journey = await record(
        "stop",
        host,
        run.runId,
        [
          {
            id: commandSession,
            openedUnderBindingGeneration: generation,
            shimExitCode: commandExit.code,
          },
          {
            id: forwardSession,
            openedUnderBindingGeneration: generation,
            shimExitCode: forwardExit.code,
          },
        ],
        atEnding,
      );
      expect(journey.terminalEvent).toBe("run.interrupted");
      for (const session of journey.sessions) {
        expect(session.endedBeforeTerminalMs).toBeGreaterThan(0);
      }
    } finally {
      await echo.close();
    }
  }, 180_000);

  it("ends a restarted attempt's sessions at the restart, and never its replacement's", async () => {
    scenario = await startMachineAccessScenario(authorityDatabaseUrl, {
      policy: openPolicy,
      restartsRuns: true,
    });
    const { alias, host, launch, run, target } = scenario;
    const first = run.attempt;
    const superseded = startShim(launch, "ssh", [alias, "sleep 60; echo late"]);
    const supersededSession = await activeSessionId(host, target.runnerId);

    expect(await steerRun(host, run, { key: "steer-blue", text: "Use the blue palette" })).toEqual({
      wasDuplicate: false,
    });
    await waitForCondition(async () =>
      (await shellSessionRows(host)).every((row) => row.state === "ended"),
    );
    // The Run lives on: only the attempt the steer interrupts lost its grant.
    const atEnding = await runState(host, run.runId);
    expect(atEnding).toMatchObject({
      bindingGeneration: first.bindingGeneration,
      status: "running",
      terminalEvents: [],
    });
    expect(
      (await runGrants(host, run.runId)).map((grant) => [grant.status, grant.revokedReason]),
    ).toEqual([["revoked", "superseded"]]);
    expect((await shellSessionRows(host)).map((row) => [row.id, row.endReason])).toEqual([
      [supersededSession, "run-ended"],
    ]);
    const supersededExit = await superseded.exited;
    expect(supersededExit.code).not.toBe(0);
    expect(supersededExit.stdout).not.toContain("late");

    // The interrupted attempt reports its end, and the Host starts the next.
    await run.reportInterrupted();
    const second = await run.startNextAttempt();
    expect(second.bindingGeneration).toBeGreaterThan(first.bindingGeneration);
    const replacement = startShim(launch, "ssh", [alias, "sleep 60; echo replaced"]);
    const replacementSession = await activeSessionId(host, target.runnerId, [supersededSession]);

    // Late word about the first attempt: the steer that revoked its grant,
    // sent again, and the first attempt's own end, reported again.
    expect(await steerRun(host, run, { key: "steer-blue", text: "Use the blue palette" })).toEqual({
      wasDuplicate: true,
    });
    await run.reportInterrupted(first);
    expect(await runShim(launch, "ssh", [alias, "echo second"])).toMatchObject({
      code: 0,
      stdout: "second\n",
    });
    expect(
      (await shellSessionRows(host)).find((row) => row.id === replacementSession),
    ).toMatchObject({ endReason: null, state: "active" });
    expect(
      (await runGrants(host, run.runId)).map((grant) => [
        grant.bindingGeneration,
        grant.status,
        grant.revokedReason,
      ]),
    ).toEqual([
      [first.bindingGeneration, "revoked", "superseded"],
      [second.bindingGeneration, "active", null],
    ]);

    // The replacement's sessions end with its own authority: here, the Run's end.
    await run.complete();
    const replacementExit = await replacement.exited;
    expect(replacementExit.code).not.toBe(0);
    expect(replacementExit.stdout).not.toContain("replaced");
    await waitForCondition(async () =>
      (await shellSessionRows(host)).every((row) => row.state === "ended"),
    );
    expect(
      (await shellSessionRows(host)).find((row) => row.id === replacementSession)?.endReason,
    ).toBe("run-ended");
    await record(
      "restart",
      host,
      run.runId,
      [
        {
          id: supersededSession,
          openedUnderBindingGeneration: first.bindingGeneration,
          shimExitCode: supersededExit.code,
        },
        {
          id: replacementSession,
          openedUnderBindingGeneration: second.bindingGeneration,
          shimExitCode: replacementExit.code,
        },
      ],
      atEnding,
    );
  }, 180_000);

  it("keeps a session through a token refresh and past its first token's expiry", async () => {
    const lifetimeSeconds = 4;
    scenario = await startMachineAccessScenario(authorityDatabaseUrl, {
      policy: openPolicy,
      runCapabilityLifetimeSeconds: lifetimeSeconds,
    });
    const { alias, host, launch, run, target } = scenario;
    const issuedAt = Date.now();
    const issued = run.agentControlToken;
    const generation = run.attempt.bindingGeneration;
    // Writes a line a second for longer than the first token lives.
    const ticks = lifetimeSeconds * 2 + 2;
    const ticking = startShim(launch, "ssh", [
      alias,
      `i=0; while [ $i -lt ${ticks} ]; do i=$((i+1)); echo tick $i; sleep 1; done; echo done`,
    ]);
    const tickingSession = await activeSessionId(host, target.runnerId);

    expect(await run.refreshCredentials()).toBe("issued");
    expect(run.agentControlToken).not.toBe(issued);
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, issuedAt + (lifetimeSeconds + 1) * 1_000 - Date.now())),
    );
    expect((await shellSessionRows(host)).find((row) => row.id === tickingSession)).toMatchObject({
      endReason: null,
      state: "active",
    });
    // The Runner keeps refreshing at half the lifetime; the grant still stands.
    expect(await run.refreshCredentials()).toBe("issued");

    // The first token opens nothing now; the refreshed one does.
    const expiredLaunch = await setUpCallerLaunchDirectory(host, run, () => issued);
    try {
      const refused = await runShim(expiredLaunch, "ssh", [alias, "true"]);
      expect(refused.code).toBe(255);
      expect(refused.stderr).toContain("This Run has ended.");
    } finally {
      await expiredLaunch.close();
    }
    expect(await runShim(launch, "ssh", [alias, "echo refreshed"])).toMatchObject({
      code: 0,
      stdout: "refreshed\n",
    });

    const tickingExit = await ticking.exited;
    expect(tickingExit.code).toBe(0);
    expect(tickingExit.stdout.trim().split("\n")).toEqual([
      ...Array.from({ length: ticks }, (_, index) => `tick ${index + 1}`),
      "done",
    ]);
    await waitForCondition(async () =>
      (await shellSessionRows(host)).every((row) => row.state === "ended"),
    );
    expect(
      ["client-closed", "target-closed"].includes(
        (await shellSessionRows(host)).find((row) => row.id === tickingSession)?.endReason ?? "",
      ),
    ).toBe(true);
    expect(
      (await runGrants(host, run.runId)).map((grant) => [grant.status, grant.revokedReason]),
    ).toEqual([["active", null]]);
    await run.complete();
    await record(
      "refresh",
      host,
      run.runId,
      [
        {
          id: tickingSession,
          openedUnderBindingGeneration: generation,
          shimExitCode: tickingExit.code,
        },
      ],
      null,
    );
  }, 180_000);

  it("ends an overdue background Run's sessions and tells its clients when its stop commits, though a later Run's stop fails", async () => {
    scenario = await startMachineAccessScenario(authorityDatabaseUrl, { policy: openPolicy });
    const { alias, caller, host, launch, run, target } = scenario;
    const other = await dispatchCallerRun(host, caller, {
      key: "second-run",
      title: "Reach out again",
    });
    const otherLaunch = await setUpCallerLaunchDirectory(host, other);
    const closers: (() => Promise<void>)[] = [() => otherLaunch.close()];
    try {
      // The sweep stops overdue Runs in id order, each in a transaction of its own.
      const [first, second] = run.runId < other.runId ? [run, other] : [other, run];
      const launchFor = (candidate: typeof run) => (candidate === run ? launch : otherLaunch);
      const firstShim = startShim(launchFor(first), "ssh", [alias, "sleep 60; echo late"]);
      const firstSession = await activeSessionId(host, target.runnerId);
      const secondShim = startShim(launchFor(second), "ssh", [alias, "sleep 60; echo late"]);
      const secondSession = await activeSessionId(host, target.runnerId, [firstSession]);
      const grantStates = async (candidate: typeof run) =>
        (await runGrants(host, candidate.runId)).map((grant) => [
          grant.status,
          grant.revokedReason,
        ]);
      const sessionRow = async (sessionId: string) =>
        (await shellSessionRows(host)).find((row) => row.id === sessionId);

      // Both turns answered while their work runs on. Their deadline is four
      // hours out, so the clock is moved by moving the deadline.
      await first.reportPhase("background");
      await second.reportPhase("background");
      // The first Run's engine is also waiting on its requester, so its stop
      // has something to tell the clients following its Workspace.
      const request = await first.openLiveRequest();
      const feed = await followWorkspace(host, first.workspaceId);
      closers.push(() => feed.close());
      await host.store.database
        .updateTable("runs")
        .set({ backgroundDeadlineAt: new Date(Date.now() - 1_000) })
        .where("id", "in", [first.runId, second.runId])
        .execute();
      // The second Run's stop cannot commit while its command's key is taken,
      // so the sweep fails after the first Run's stop has committed.
      const occupied = await occupyBackgroundDeadlineKey(host, second.runId);

      await waitForCondition(
        async () => (await sessionRow(firstSession))?.state === "ended",
        30_000,
      );
      const firstAtEnding = await runState(host, first.runId);
      expect(firstAtEnding).toMatchObject({ status: "running", terminalEvents: [] });
      expect(await grantStates(first)).toEqual([["revoked", "stopped"]]);
      expect((await sessionRow(firstSession))?.endReason).toBe("run-ended");
      expect(await grantStates(second)).toEqual([["active", null]]);
      expect(await sessionRow(secondSession)).toMatchObject({ endReason: null, state: "active" });
      const firstExit = await firstShim.exited;
      expect(firstExit.code).not.toBe(0);
      expect(firstExit.stdout).not.toContain("late");
      // Its clients heard the stop live, though the sweep failed after it.
      await waitForCondition(async () =>
        feed.live.some(
          (event) =>
            event.type === "request.cancelled" &&
            event.runId === first.runId &&
            (event.data as { readonly requestId?: unknown }).requestId === request,
        ),
      );
      expect(await grantStates(second)).toEqual([["active", null]]);

      // Once the second Run's stop can commit, the next sweep ends its sessions.
      await host.store.database.deleteFrom("commands").where("id", "=", occupied).execute();
      await waitForCondition(
        async () => (await sessionRow(secondSession))?.state === "ended",
        30_000,
      );
      const secondAtEnding = await runState(host, second.runId);
      expect(secondAtEnding).toMatchObject({ status: "running", terminalEvents: [] });
      expect(await grantStates(second)).toEqual([["revoked", "stopped"]]);
      expect((await sessionRow(secondSession))?.endReason).toBe("run-ended");
      const secondExit = await secondShim.exited;
      expect(secondExit.code).not.toBe(0);

      // Only now do the Runners report the interrupts the sweep sent.
      await first.reportInterrupted();
      await second.reportInterrupted();
      await waitForCondition(async () =>
        (await Promise.all([runState(host, first.runId), runState(host, second.runId)])).every(
          (state) => state.status === "interrupted",
        ),
      );
      for (const [name, candidate, sessionId, exit, atEnding] of [
        ["background deadline, committed first", first, firstSession, firstExit, firstAtEnding],
        [
          "background deadline, after a failed sweep",
          second,
          secondSession,
          secondExit,
          secondAtEnding,
        ],
      ] as const) {
        const journey = await record(
          name,
          host,
          candidate.runId,
          [
            {
              id: sessionId,
              openedUnderBindingGeneration: candidate.attempt.bindingGeneration,
              shimExitCode: exit.code,
            },
          ],
          atEnding,
        );
        expect(journey.terminalEvent).toBe("run.interrupted");
        expect(journey.sessions[0]?.endedBeforeTerminalMs).toBeGreaterThan(0);
      }
    } finally {
      for (const close of closers) await close();
    }
  }, 180_000);
});

/**
 * Takes the idempotency key the background-deadline stop writes its interrupt
 * under, so that Run's stop fails on a unique key until the row is removed.
 */
async function occupyBackgroundDeadlineKey(
  host: MachineAccessScenario["host"],
  runId: RunId,
): Promise<CommandId> {
  const id = createId("command");
  await sql`
    insert into commands
      (id, environment_id, requested_by, actor_principal_id, authority_source,
       idempotency_key, type, payload, status)
    select ${id}, environment_id, requested_by, actor_principal_id, authority_source,
      ${`background-deadline:${runId}`}, 'assignment.cancel', '{}'::jsonb, 'succeeded'
    from commands
    where run_id = ${runId} and type = 'run.execute'
    limit 1
  `.execute(host.store.database);
  return id;
}

async function startEchoServer(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("echo server has no port");
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      }),
    port: address.port,
  };
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no free port");
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function pingThrough(port: number): Promise<"unreachable" | "ping-pong"> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (value: "unreachable" | "ping-pong") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("error", () => settle("unreachable"));
    socket.once("connect", () => socket.write("ping"));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString("utf8") === "ping") settle("ping-pong");
    });
    socket.once("close", () => settle("unreachable"));
    setTimeout(() => settle("unreachable"), 3_000).unref();
  });
}

/** A connection through a forwarded port that answered once and is then held open. */
async function holdTunnel(port: number): Promise<{ readonly closed: Promise<void> }> {
  const socket = connect({ host: "127.0.0.1", port });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => reject(new Error("the tunnel never answered")), 5_000);
    socket.once("connect", () => socket.write("held"));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString("utf8") === "held") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { closed };
}

function processAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function connectToSocket(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}
