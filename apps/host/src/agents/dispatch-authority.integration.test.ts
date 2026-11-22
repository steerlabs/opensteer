import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginSnapshot, pluginSnapshotDigest } from "@opensteer/agent-plugins";
import type { AgentGrant, ThreadAccessMode } from "@opensteer/core";
import { AgentConnectionStore, TriggerStore } from "@opensteer/database";
import {
  createStoreFixture,
  describeStore,
  testReadyHarnessCatalog,
} from "@opensteer/database/test-support/store";
import { CommandDispatchError, type RunnerRegistry } from "@opensteer/orchestration";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import type { RunnerCommand } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect } from "vitest";
import {
  packageStillGranted,
  PluginPackageService,
  type PluginPackagesTokenService,
} from "../local-servers/plugin-package-service.js";
import {
  connection,
  commands,
  createTask,
  queuedRun,
  serveMcp,
} from "../mcp/connection-caller.test-support.js";
import { HostCommandDispatcher } from "./dispatcher.js";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;

const pluginA = { pluginId: "plugin_a", name: "a", digest: "a".repeat(64) };
const pluginB = { pluginId: "plugin_b", name: "b", digest: "b".repeat(64) };
const plugin = (pluginId: string) =>
  ({ kind: "plugin", target: { kind: "installed", pluginId }, access: "read-write" }) as const;

/** The real dispatcher, with a Runner that runs the send fence and then takes the command. */
function dispatcher(
  storeFixture: Fixture,
  runnerId: string,
  hooks: {
    readonly planning: () => Promise<void>;
    readonly afterFence?: () => Promise<void>;
    readonly holdAck?: (beforeAck: () => Promise<void>) => void;
  },
  sent: RunnerCommand[],
  issued: (readonly string[])[],
) {
  const { store } = storeFixture;
  const identity = {
    bootId: "fixture-boot",
    capabilities: [
      "native-session-continuation-v1",
      "assignments-v1",
      "thread-state-v1",
      "execution-plane-v2",
      "agent-tools-plan-v1",
    ],
    modules: { agents: { computerTool: 1 } },
    name: "Fixture computer",
    runnerId,
  };
  return new HostCommandDispatcher({
    store,
    triggers: new TriggerStore(store.database),
    executionLeaseMs: 90_000,
    publicUrl: new URL("https://host.test"),
    requestResponseVault: {} as never,
    runToolTokens: { issue: () => "tools" } as never,
    attachmentRunTokens: { issue: () => "attachments" } as never,
    attachments: { listForRun: async () => [] },
    browser: { hasBrowserProfiles: async () => false },
    egress: { issue: () => ({ allowedHosts: [], token: "egress" }) } as never,
    pluginVersions: async () => {
      await hooks.planning();
      return [pluginA, pluginB];
    },
    pluginsTokens: {
      issue: (claims: { readonly pluginDigests: readonly string[] }) => {
        issued.push(claims.pluginDigests);
        return "plugins";
      },
    } as never,
    triggerControlTokens: { issue: () => "control" } as never,
    runners: {
      identityForEnvironment: (environmentId: string) => ({ ...identity, environmentId }),
      canRunHarness: () => true,
      supportsMessageAttachments: () => false,
      connectionGenerationFor: () => 1,
      inspectHarnesses: async (_environment: unknown, harnesses: readonly { id: string }[]) =>
        harnesses.map((harness) => testReadyHarnessCatalog(harness.id as never)),
      // RunnerRegistry's contract: the caller's last check, then the command, nothing between.
      dispatch: async (
        command: RunnerCommand,
        _signal: AbortSignal,
        options?: {
          readonly beforeAck?: () => Promise<void>;
          readonly beforeSend?: () => Promise<void>;
        },
      ) => {
        await options?.beforeSend?.();
        await hooks.afterFence?.();
        sent.push(command);
        if (options?.beforeAck) hooks.holdAck?.(options.beforeAck);
        return { type: "runner.command-accepted" };
      },
    } as unknown as RunnerRegistry,
  });
}

describeStore("a connected agent's authority at the send", (it) => {
  const steerCases = [
    { boundary: "claim", change: "revoked" },
    { boundary: "send", change: "revoked" },
    { boundary: "claim", change: "narrowed" },
    { boundary: "send", change: "narrowed" },
  ] as const;
  for (const { boundary, change } of steerCases) {
    it(`refuses a queued steer at ${boundary} after the connection is ${change}`, async ({
      storeFixture,
    }) => {
      const f = await storeFixture.startRunFixture(`steer-after-${change}-${boundary}`);
      const { database, store } = storeFixture;
      const url = await serveMcp(storeFixture);
      const agent = await connection(store, url, { userId: f.userId, accessMode: "full-access" });
      const task = await createTask(agent, f, "steer-after-revoke");
      const run = await queuedRun(storeFixture, task);
      await startPersonalQueuedRunFixture(store, run.id);
      const followUp = await store.enqueueThreadInput({
        threadId: task,
        requestedBy: f.userId,
        idempotencyKey: "follow-up-after-revoke",
        content: [{ type: "text", text: "follow up" }],
        policy: "queue",
        source: { kind: "human" },
      });
      const steer = await store.steerThreadInput({
        threadId: task,
        requestedBy: f.userId,
        expectedRunId: run.id,
        messageId: followUp.message.id,
        idempotencyKey: "steer-after-revoke",
      });
      if (!steer.command) throw new Error("Expected a pending steer command");
      const connections = new AgentConnectionStore(database);
      const changeAuthority = async () => {
        if (change === "revoked") {
          await connections.revoke(f.userId, agent.id);
          return;
        }
        expect(
          await connections.update(f.userId, {
            connectionId: agent.id,
            expectedRevision: 1,
            grant: { scope: "selected", tasks: true, resources: [] },
          }),
        ).toMatchObject({
          narrowed: true,
          connection: { accessMode: "full-access", grantRevision: 2 },
        });
        expect(
          await database
            .selectFrom("threads")
            .select("originConnectionId")
            .where("id", "=", task)
            .executeTakeFirstOrThrow(),
        ).toEqual({ originConnectionId: agent.id });
        expect(
          await database
            .selectFrom("runs")
            .select(["status", "admittedGrantRevision"])
            .where("id", "=", run.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: "running", admittedGrantRevision: 1 });
      };
      if (boundary === "send") {
        const claimed = await store.claimCommand(steer.command.id, "steer-before-change");
        if (!claimed || claimed.terminalFailure)
          throw new Error("Expected the steer to be claimed");
        await changeAuthority();
        const sent: RunnerCommand[] = [];
        await dispatcher(storeFixture, f.runnerId, { planning: async () => {} }, sent, []).dispatch(
          claimed.command,
          new AbortController().signal,
        );
        expect(sent).toEqual([]);
        return;
      }
      await changeAuthority();
      await expect(
        store.claimCommand(steer.command.id, "steer-after-change"),
      ).resolves.toMatchObject({
        terminalFailure: "The connected agent's access ended before this work could be delivered.",
      });
    });
  }

  it("uses a distinct Trigger wire command per generation and only accepts the current ACK", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const f = await storeFixture.startRunFixture("trigger-retry-ack");
    await database
      .updateTable("runners")
      .set({ capabilities: sql`'["trigger-program-v5"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
    });
    const task = await createTask(agent, f, "trigger-retry-ack");
    const triggers = new TriggerStore(database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: agent.id,
      anchorThreadId: task,
      createdBy: f.userId,
      idempotencyKey: "trigger-retry-ack",
      name: "Retry ACK",
      program: {
        language: "javascript",
        source: "export default async () => null",
        toolContractVersion: 5,
      },
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: trigger.id,
    });
    const sent: RunnerCommand[] = [];
    const acks: (() => Promise<void>)[] = [];
    const queue = dispatcher(
      storeFixture,
      f.runnerId,
      {
        planning: async () => {},
        holdAck: (ack) => acks.push(ack),
      },
      sent,
      [],
    );
    const dispatch = async () => {
      const claimed = await store.claimCommand(occurrence.commandId, "trigger-retry-ack");
      if (!claimed) throw new Error("Expected the Trigger command");
      await queue.dispatch(claimed.command, new AbortController().signal);
    };
    await dispatch();
    await store.retryCommand(occurrence.commandId, new Error("Retried before ACK"));
    await dispatch();
    const [first, current] = sent;
    if (first?.type !== "trigger.execute" || current?.type !== "trigger.execute")
      throw new Error("Expected both Trigger generations on the wire");
    expect(current.context.executionGeneration).toBe(first.context.executionGeneration + 1);
    expect(current.commandId).not.toBe(first.commandId);
    const status = async () =>
      (
        await database
          .selectFrom("commands")
          .select("status")
          .where("id", "=", occurrence.commandId)
          .executeTakeFirstOrThrow()
      ).status;
    expect(acks).toHaveLength(2);
    await acks[0]!();
    expect(await status()).toBe("dispatched");
    await acks[1]!();
    expect(await status()).toBe("succeeded");
    expect(
      await database
        .selectFrom("triggerOccurrences")
        .select("status")
        .where("id", "=", occurrence.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "running" });
  });

  it("ends a connected Run locally when revoke wins before its handoff stamp", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("revoke-before-handoff");
    const { database, store } = storeFixture;
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, { userId: f.userId, accessMode: "full-access" });
    const task = await createTask(agent, f, "revoke-before-handoff");
    const run = await queuedRun(storeFixture, task);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const claimed = await store.claimCommand(command.id, "revoke-before-handoff");
    if (!claimed) throw new Error("Expected the Run's command");

    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const sent: RunnerCommand[] = [];
    const dispatch = dispatcher(
      storeFixture,
      f.runnerId,
      {
        planning: async () => {
          entered.resolve();
          await resume.promise;
        },
      },
      sent,
      [],
    ).dispatch(claimed.command, new AbortController().signal);
    const result = dispatch.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        entered.promise,
        result.then(() => {
          throw new Error("Run did not reach planning");
        }),
      ]);
      expect(
        await database
          .selectFrom("runs")
          .select("bindingGeneration")
          .where("id", "=", run.id)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ bindingGeneration: expect.any(Number) });
      const home = commands(storeFixture, f.userId);
      await home.revoke(agent.id);
      expect(home.failures).toEqual([]);
      expect((await home.list()).find(({ id }) => id === agent.id)?.state).toBe("stopped");
      expect(
        await database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", run.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: "interrupted" });
    } finally {
      resume.resolve();
      await result;
    }
    expect(sent).toEqual([]);
  });

  it("keeps the exact Run in Stopping when its handoff wins before revoke", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("handoff-before-revoke");
    const { database, store } = storeFixture;
    const agent = await connection(store, await serveMcp(storeFixture), {
      userId: f.userId,
      accessMode: "full-access",
    });
    const task = await createTask(agent, f, "handoff-before-revoke");
    const run = await queuedRun(storeFixture, task);
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    const claimed = await store.claimCommand(command.id, "handoff-before-revoke");
    if (!claimed) throw new Error("Expected the Run's command");
    const stamped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sent: RunnerCommand[] = [];
    const dispatch = dispatcher(
      storeFixture,
      f.runnerId,
      {
        planning: async () => {},
        afterFence: async () => {
          stamped.resolve();
          await release.promise;
        },
      },
      sent,
      [],
    ).dispatch(claimed.command, new AbortController().signal);
    const stopped: unknown[] = [];
    const home = commands(storeFixture, f.userId, {
      stopper: {
        async stop(attempt) {
          stopped.push(attempt);
        },
      },
    });
    try {
      await Promise.race([
        stamped.promise,
        dispatch.then(() => {
          throw new Error("Run did not reach handoff");
        }),
      ]);
      expect(sent).toEqual([]);
      await home.revoke(agent.id);
      expect(home.failures).toEqual([]);
      expect(stopped).toEqual([
        expect.objectContaining({
          kind: "run-attempt",
          runId: run.id,
          generation: expect.any(Number),
        }),
      ]);
      expect((await home.list()).find(({ id }) => id === agent.id)?.state).toBe("stopping");
      await expect(home.remove(agent.id)).rejects.toMatchObject({ reason: "cleanup-outstanding" });
    } finally {
      release.resolve();
      await dispatch;
    }
    expect(sent).toEqual([
      expect.objectContaining({
        type: "run.execute",
        context: expect.objectContaining({ runId: run.id }),
      }),
    ]);
  });

  const cases: readonly {
    readonly name: string;
    readonly accessMode: ThreadAccessMode;
    readonly grant: AgentGrant;
    readonly change: { readonly accessMode?: ThreadAccessMode; readonly grant?: AgentGrant };
    readonly expected: { readonly accessMode: ThreadAccessMode; readonly digests: string[] };
  }[] = [
    {
      name: "a lowered mode",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [plugin(pluginA.pluginId)] },
      change: { accessMode: "auto" },
      expected: { accessMode: "auto", digests: [pluginA.digest] },
    },
    {
      name: "a new grant revision in the same mode",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [plugin(pluginA.pluginId)] },
      change: {
        grant: {
          scope: "selected",
          tasks: true,
          resources: [plugin(pluginA.pluginId), plugin(pluginB.pluginId)],
        },
      },
      expected: { accessMode: "full-access", digests: [pluginA.digest, pluginB.digest] },
    },
  ];
  it("refuses a Run planned under authority that changed before the send, then sends under the new one", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("dispatch-fence");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    for (const [index, item] of cases.entries()) {
      const agent = await connection(store, url, {
        userId: f.userId,
        accessMode: item.accessMode,
        grant: item.grant,
      });
      const task = await createTask(agent, f, `dispatch-fence-${index}`);
      const run = await queuedRun(storeFixture, task);
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", run.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      const sent: RunnerCommand[] = [];
      const issued: (readonly string[])[] = [];
      let changeOnce = true;
      const planning = async () => {
        if (!changeOnce) return;
        changeOnce = false;
        // Committed while the dispatcher plans; its effects (a narrowing's Stop) have not run.
        await new AgentConnectionStore(database).update(f.userId, {
          connectionId: agent.id,
          expectedRevision: 1,
          ...item.change,
        });
      };
      const { runnerId } = await database
        .selectFrom("executionEnvironments")
        .select("runnerId")
        .where("id", "=", f.environmentId)
        .executeTakeFirstOrThrow();
      const dispatch = dispatcher(storeFixture, runnerId!, { planning }, sent, issued);
      const first = await store.claimCommand(command.id, "fence-test");
      if (!first) throw new Error("Expected the Run's command");
      const refused = await dispatch.dispatch(first.command, new AbortController().signal).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused, item.name).toBeInstanceOf(CommandDispatchError);
      expect(refused, item.name).toMatchObject({
        disposition: "retry",
        message: "This connected agent's access changed while the Run was being prepared.",
      });
      expect(sent, `${item.name}: the Runner received nothing`).toEqual([]);
      await store.retryCommand(command.id, refused);
      const second = await store.claimCommand(command.id, "fence-test");
      if (!second) throw new Error("Expected the retried command");
      await dispatch.dispatch(second.command, new AbortController().signal);
      const [received] = sent;
      if (received?.type !== "run.execute") throw new Error(`${item.name}: nothing was sent`);
      expect(
        {
          accessMode: received.context.accessMode,
          plugins: received.context.plugins?.versions.map(({ digest }) => digest),
          token: issued.at(-1),
        },
        item.name,
      ).toEqual({
        accessMode: item.expected.accessMode,
        plugins: item.expected.digests,
        token: item.expected.digests,
      });
    }
  });

  it("refuses a pinned package once the grant no longer reaches its plugin, before the Run stops", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("package-withdrawn");
    const url = await serveMcp(storeFixture);
    const { database, store } = storeFixture;
    const root = await mkdtemp(join(tmpdir(), "package-withdrawn-"));
    try {
      const digests: string[] = [];
      for (const name of ["a", "b"]) {
        const source = join(root, `source-${name}`);
        await mkdir(source);
        await writeFile(join(source, "tool.sh"), `echo ${name}`);
        const digest = pluginSnapshotDigest(await readPluginSnapshot(source));
        await (await import("node:fs/promises")).rename(source, join(root, digest));
        digests.push(digest);
      }
      const [digestA, digestB] = digests as [string, string];
      const installed = [
        { id: pluginA.pluginId, digest: digestA },
        { id: pluginB.pluginId, digest: digestB },
      ];
      const agent = await connection(store, url, {
        userId: f.userId,
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: true,
          resources: [plugin(pluginA.pluginId), plugin(pluginB.pluginId)],
        },
      });
      const run = await queuedRun(storeFixture, await createTask(agent, f, "package-withdrawn"));
      const service = new PluginPackageService({
        snapshotDirectory: root,
        tokens: {
          authenticate: async () => ({
            pluginDigests: digests,
            requestedBy: f.userId,
            runId: run.id,
          }),
        } as unknown as PluginPackagesTokenService,
        stillGranted: packageStillGranted({ store, installed: async () => installed }),
      });
      for (const digest of digests) expect(await service.snapshot("run", digest)).toHaveLength(1);
      await new AgentConnectionStore(database).update(f.userId, {
        connectionId: agent.id,
        expectedRevision: 1,
        grant: { scope: "selected", tasks: true, resources: [plugin(pluginA.pluginId)] },
      });
      expect(await service.snapshot("run", digestA)).toHaveLength(1);
      await expect(service.snapshot("run", digestB)).rejects.toMatchObject({
        code: "forbidden",
        message: "Package is not pinned to this Run",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
