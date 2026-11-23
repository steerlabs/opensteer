import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginSnapshot, pluginSnapshotDigest } from "@opensteer/agent-plugins";
import { OpensteerError, type AgentGrant, type ThreadAccessMode } from "@opensteer/core";
import {
  AgentConnectionStore,
  ChannelStore,
  OpensteerStore,
  TriggerStore,
  wakeChatQueues,
} from "@opensteer/database";
import {
  createStoreFixture,
  describeStore,
  testMessagingRunnerId,
  testReadyHarnessCatalog,
} from "@opensteer/database/test-support/store";
import {
  CommandDispatchError,
  ExecutionCoordinator,
  type RunnerRegistry,
} from "@opensteer/orchestration";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import type { RunnerCommand } from "@opensteer/protocol";
import { sql } from "kysely";
import { createChannelId, type ChannelConversationId } from "@opensteer/channel-core";
import { expect, vi } from "vitest";
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
import { ChannelService } from "../channels/channel-service.js";
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
    /** Between the Home's preparation and its send fence. */
    readonly beforeFence?: () => Promise<void>;
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
          readonly onNotAdmitted?: () => Promise<void>;
        },
      ) => {
        await hooks.beforeFence?.();
        // As the registry: a fence that refuses means the Runner never had it.
        try {
          await options?.beforeSend?.();
        } catch (error) {
          await options?.onNotAdmitted?.();
          throw error;
        }
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

  it("reads a chat's standing once when its Run is claimed: resumed between two reads, it is never failed", async ({
    storeFixture,
  }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("claim-once");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridgeId })
      .where("id", "=", fixture.thread.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "From the chat" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "claim-once",
    });
    if (!queued.command) throw new Error("Expected a queued Run");
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    // Right after the claim's first read of the chat's standing, the chat is resumed (by its
    // person, on another device). A second read would now see it live, and its "not live, not
    // waiting" would fail the Run; one read answers "waiting" and the Run is held.
    const standingReads = new Set<unknown>();
    let resumed = false;
    const resume = async () => {
      await sql`update channel_accounts set status = 'connected' where id = ${configured.account.id}`.execute(
        database,
      );
      await sql`update integration_connections set status = 'connected' where id = ${configured.connection.id}`.execute(
        database,
      );
    };
    const observed = database.withPlugin({
      transformQuery: (args) => {
        const text = JSON.stringify(args.node);
        if (text.includes('"agent_connections"') && text.includes('"connection_state"'))
          standingReads.add(args.queryId);
        return args.node;
      },
      transformResult: async (args) => {
        if (!resumed && standingReads.has(args.queryId)) {
          resumed = true;
          await resume();
        }
        return args.result;
      },
    });
    const claimed = await new OpensteerStore(observed).claimCommand(
      queued.command.id,
      "claim-once",
    );
    expect(resumed).toBe(true);
    expect(claimed?.terminalFailure ?? null).toBeNull();
  });

  it("holds a chat's queued Run while the chat is paused, and never fails it for that", async ({
    storeFixture,
  }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("dispatch-paused");
    const { database, store } = storeFixture;
    // The fixture's task is the chat's: its next Run works for the bridge.
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridgeId })
      .where("id", "=", fixture.thread.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "From the chat" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "dispatch-paused",
    });
    if (!queued.run || !queued.command) throw new Error("Expected a queued Run");
    const claimed = await store.claimCommand(queued.command.id, "dispatch-paused");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the Run's command");
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    const sent: RunnerCommand[] = [];
    const failure = await dispatcher(
      storeFixture,
      fixture.runnerId,
      { planning: async () => {} },
      sent,
      [],
    )
      .dispatch(claimed.command, new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    // Nothing is sent, and the Run is held for its chat rather than failed or retried on a timer.
    expect(sent).toEqual([]);
    expect(failure).toBeInstanceOf(CommandDispatchError);
    expect((failure as CommandDispatchError).disposition).toBe("held");
  });

  it("holds a chat's Run paused while it is being prepared: no failure, no error, no timer, until the chat is back", async ({
    storeFixture,
  }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("dispatch-planning");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridgeId })
      .where("id", "=", fixture.thread.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "From the chat" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "dispatch-planning",
    });
    if (!queued.run || !queued.command) throw new Error("Expected a queued Run");
    // The person pauses the chat while the Run is being prepared, after the first check.
    let pauseWhilePlanning = true;
    const sent: RunnerCommand[] = [];
    const host = dispatcher(
      storeFixture,
      fixture.runnerId,
      {
        planning: async () => {
          if (!pauseWhilePlanning) return;
          pauseWhilePlanning = false;
          await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
        },
      },
      sent,
      [],
    );
    const errors: unknown[] = [];
    const timers: number[] = [];
    let dispatches = 0;
    let listings = 0;
    const coordinator = new ExecutionCoordinator({
      dispatcher: {
        isAvailable: () => true,
        dispatch: async (command, signal) => {
          dispatches += 1;
          await host.dispatch(command, signal);
        },
      },
      dispatcherId: "dispatch-planning",
      maxConcurrentRuns: 1,
      maxConcurrentTriggerPrograms: 1,
      maxQueuedBytes: 1_000_000,
      maxQueuedCommands: 10,
      store: {
        claimCommand: (...args) => store.claimCommand(...args),
        failCommand: (...args) => store.failCommand(...args),
        markSteerUnknown: (...args) => store.markSteerUnknown(...args),
        retryCommand: (...args) => store.retryCommand(...args),
        listPendingCommands: async (...args) => {
          const listed = await store.listPendingCommands(...args);
          listings += 1;
          return listed;
        },
      },
      onDispatchError: (error) => errors.push(error),
      clock: {
        now: Date.now,
        schedule: (callback, milliseconds) => {
          timers.push(milliseconds);
          const timer = setTimeout(callback, milliseconds);
          return () => clearTimeout(timer);
        },
      },
    });
    const run = () =>
      database
        .selectFrom("runs")
        .innerJoin("commands", "commands.runId", "runs.id")
        .select(["runs.status as run", "commands.status as command"])
        .where("commands.id", "=", queued.command!.id)
        .executeTakeFirstOrThrow();
    coordinator.start();
    try {
      await vi.waitFor(async () => {
        expect(dispatches).toBe(1);
        expect(await run()).toEqual({ run: "queued", command: "pending" });
      }, 20_000);
      // Woken again while the chat waits, it is not taken again: nothing is listed for it.
      expect((await store.listPendingCommands()).map(({ id }) => id)).not.toContain(
        queued.command.id,
      );
      const before = listings;
      coordinator.wake();
      await vi.waitFor(() => expect(listings).toBeGreaterThan(before), 20_000);
      expect(dispatches).toBe(1);
      expect(sent).toEqual([]);
      expect(errors).toEqual([]);
      expect(timers).toEqual([]);
      // No failure, and nothing said in the chat.
      expect(
        await database
          .selectFrom("bridgeDeliveries")
          .select("id")
          .where("bridgeId", "=", bridgeId!)
          .execute(),
      ).toEqual([]);
      // The chat is back: what it held is woken, and the Run is sent.
      await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
      await wakeChatQueues(database, configured.connection.id);
      coordinator.wake();
      await vi.waitFor(() => expect(sent).toHaveLength(1), 20_000);
      expect(errors).toEqual([]);
    } finally {
      await coordinator.stop();
    }
  });

  for (const back of ["resume", "recovery", "check"] as const)
    it(`starts a chat's held Run once the chat is back by ${back === "resume" ? "the person's resume" : back === "recovery" ? "the account reporting healthy" : "a successful check of the account"}, woken by the commit, never polled`, async ({
      storeFixture,
    }) => {
      const { bridgeId, configured, fixture } = await storeFixture.createChannelDeliveryFixture(
        `dispatch-wake-${back}`,
      );
      const { database, store } = storeFixture;
      await database
        .updateTable("threads")
        .set({ originConnectionId: bridgeId })
        .where("id", "=", fixture.thread.id)
        .execute();
      const { externalTenantId: tenant } = await database
        .selectFrom("integrationConnections")
        .select("externalTenantId")
        .where("id", "=", configured.connection.id)
        .executeTakeFirstOrThrow();
      // The service the person and the messaging runtime reach.
      const service = new ChannelService({
        channels: new ChannelStore(database),
        // A check reaches the account through its messaging runtime, which says it is ready.
        credentials: { materializeForChannelRuntime: async () => ({}) } as never,
        relay: {
          connectedRunnerIds: () => [],
          isConnected: () => true,
          request: async (_runnerId: string, operation: string) =>
            operation === "connection.inspect"
              ? {
                  capabilities: [],
                  identity: {
                    accountDisplayName: "Workshop",
                    connectionDisplayName: "Workshop",
                    externalAccountId: tenant,
                    externalIdentityId: null,
                    handle: null,
                    metadata: {},
                  },
                  issues: [],
                  ready: true,
                }
              : {},
        } as never,
        store,
        bridgeTools: () => ({ callTool: async () => ({}) }),
      });
      const health = (status: "connected" | "needs-attention") =>
        service.handleRuntimeRequest(testMessagingRunnerId, {
          operation: "connection.health",
          payload: {
            connectionId: configured.connection.id,
            detail: status === "connected" ? null : "Signed out",
            reason: status === "connected" ? null : "credentials",
            status,
          },
        } as never);
      // Its Run is queued, then the chat is paused before any dispatcher takes it.
      const queued = await store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: fixture.thread.id,
        content: [{ type: "text", text: "From the chat" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: `dispatch-wake-${back}`,
      });
      if (back === "recovery") await health("needs-attention");
      else await service.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
      if (!queued.command) throw new Error("Expected a queued Run");
      const sent: RunnerCommand[] = [];
      const host = dispatcher(
        storeFixture,
        fixture.runnerId,
        { planning: async () => {} },
        sent,
        [],
      );
      let listings = 0;
      const coordinator = new ExecutionCoordinator({
        dispatcher: {
          isAvailable: () => true,
          dispatch: (command, signal) => host.dispatch(command, signal),
        },
        dispatcherId: `dispatch-wake-${back}`,
        maxConcurrentRuns: 1,
        maxConcurrentTriggerPrograms: 1,
        maxQueuedBytes: 1_000_000,
        maxQueuedCommands: 10,
        store: {
          claimCommand: (...args) => store.claimCommand(...args),
          failCommand: (...args) => store.failCommand(...args),
          markSteerUnknown: (...args) => store.markSteerUnknown(...args),
          retryCommand: (...args) => store.retryCommand(...args),
          listPendingCommands: async (...args) => {
            const listed = await store.listPendingCommands(...args);
            listings += 1;
            return listed;
          },
        },
        // No poll: only a wake lists commands again.
        clock: { now: Date.now, schedule: () => () => undefined },
      });
      // The coordinator hears commits as the runtime wires it (runtime.ts, `react`): the Home's
      // mutation hooks hand it each commit's reactions, and an executionCommandsChanged one wakes
      // it. Nothing in this test wakes it otherwise.
      const unhook = storeFixture.observePersonalReactions({
        notice: () => undefined,
        reaction: (reaction) => {
          if (reaction.type === "executionCommandsChanged") coordinator.wake();
        },
      });
      coordinator.start();
      try {
        // While the chat is paused it is listed for nothing, and nothing is sent.
        await vi.waitFor(() => expect(listings).toBeGreaterThan(0), 20_000);
        expect(sent).toEqual([]);
        // Back, through the service's own call: the commit's reaction wakes the coordinator.
        if (back === "resume")
          await service.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
        else if (back === "recovery") await health("connected");
        else await service.checkConnection(configured.connection.id, fixture.userId);
        await vi.waitFor(() => expect(sent).toHaveLength(1), 20_000);
        expect(sent[0]).toMatchObject({ type: "run.execute" });
      } finally {
        await coordinator.stop();
        unhook();
        await service.close();
      }
    });

  it("holds a chat's Run paused between its listing and its claim: no failure, no notice, its message kept", async ({
    storeFixture,
  }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("dispatch-claim-race");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridgeId })
      .where("id", "=", fixture.thread.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "From the chat" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "dispatch-claim-race",
    });
    if (!queued.run || !queued.command) throw new Error("Expected a queued Run");
    // A dispatcher listed it while the chat was live; then the chat is paused; then it claims.
    expect((await store.listPendingCommands()).map(({ id }) => id)).toContain(queued.command.id);
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    const claimed = await store.claimCommand(queued.command.id, "dispatch-claim-race");
    expect(claimed?.terminalFailure).toBeUndefined();
    expect(claimed).toBeNull();
    expect(
      await database
        .selectFrom("runs")
        .innerJoin("commands", "commands.runId", "runs.id")
        .innerJoin("threadInputs", "threadInputs.messageId", "runs.seedInputId")
        .select(["runs.status as run", "commands.status as command", "threadInputs.state as input"])
        .where("commands.id", "=", queued.command.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ run: "queued", command: "pending", input: "pending" });
    expect(
      await database
        .selectFrom("bridgeDeliveries")
        .select("id")
        .where("bridgeId", "=", bridgeId!)
        .execute(),
    ).toEqual([]);
    // Claiming the next command for its computer leaves it out, as the listing does.
    expect(await store.claimNextCommand(fixture.environmentId, "dispatch-claim-race")).toBeNull();
    expect((await store.listPendingCommands()).map(({ id }) => id)).not.toContain(
      queued.command.id,
    );
  });

  /**
   * A chat in #team and a task it started, as the chat. Its automations are made by the chat's
   * own agent (`actorConnectionId`); one that anyone may speak in can have none.
   */
  async function chatWithTask(
    storeFixture: Fixture,
    suffix: string,
    senders: "owner" | "anyone" = "owner",
  ) {
    const f = await storeFixture.createChannelDeliveryFixture(suffix, { bridge: false });
    const { database, store } = storeFixture;
    const chat = await new AgentConnectionStore(database).createBridge({
      userId: f.fixture.userId,
      accountId: f.configured.account.id,
      conversation: { id: `C-${suffix}`, name: "#team" },
      senders,
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const { thread } = await store.createThread({
      authority: {
        kind: "connection",
        connectionId: chat.id,
        userId: f.fixture.userId,
        accessMode: "full-access",
      },
      createdBy: f.fixture.userId,
      environmentId: f.fixture.environmentId,
      harnessInstanceId: f.fixture.harnessInstance.id,
      idempotencyKey: `${suffix}-task`,
      modelSelection: f.fixture.thread.modelSelection,
      title: "From #team",
    });
    // The Runner runs automation programs.
    await database
      .updateTable("runners")
      .set({ capabilities: sql`capabilities || '["trigger-program-v5"]'::jsonb` })
      .where("id", "=", f.fixture.runnerId as never)
      .execute();
    return { ...f, chat, thread };
  }
  const originOf = async (storeFixture: Fixture, triggerId: string) =>
    (
      await storeFixture.database
        .selectFrom("triggers")
        .select("originConnectionId")
        .where("id", "=", triggerId as never)
        .executeTakeFirstOrThrow()
    ).originConnectionId;
  const everyMinute = {
    program: { toolContractVersion: 5, language: "javascript", source: "export default () => {}" },
    source: {
      kind: "schedule",
      schedule: { expression: "* * * * *", kind: "cron", timezone: "UTC" },
    },
  } as const;

  it("refuses an automation in a chat anyone can message: by its agent, by the person on its task, or a new program", async ({
    storeFixture,
  }) => {
    const anyone = await chatWithTask(storeFixture, "auto-anyone", "anyone");
    const triggers = new TriggerStore(storeFixture.database);
    const refusal = {
      code: "forbidden",
      message: "A chat that anyone in the conversation can message can't have an automation.",
    };
    const make = (input: Partial<Parameters<TriggerStore["create"]>[0]>) =>
      triggers.create({
        actorThreadId: null,
        anchorThreadId: anyone.thread.id,
        createdBy: anyone.fixture.userId,
        idempotencyKey: `auto-anyone-${crypto.randomUUID()}`,
        name: "Every minute",
        ...everyMinute,
        ...input,
      });
    // Its program would run as the person, in their Agent home.
    await expect(
      make({ actorConnectionId: anyone.chat.id, actorAccessMode: "full-access" }),
    ).rejects.toMatchObject(refusal);
    await expect(make({})).rejects.toMatchObject(refusal);
    // One of an owner chat whose lineage is then the anyone chat's can't be given a program.
    const owner = await chatWithTask(storeFixture, "auto-owner");
    const { trigger, revision } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: owner.chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: owner.thread.id,
      createdBy: owner.fixture.userId,
      idempotencyKey: "auto-owner",
      name: "Every minute",
      ...everyMinute,
    });
    await storeFixture.database
      .updateTable("triggers")
      .set({ originConnectionId: anyone.chat.id })
      .where("id", "=", trigger.id)
      .execute();
    await expect(
      triggers.update({
        actorThreadId: null,
        ownerId: owner.fixture.userId,
        triggerId: trigger.id,
        expectedRevisionId: revision.id,
        program: everyMinute.program,
      }),
    ).rejects.toMatchObject(refusal);
  });

  it("holds a message steered into a paused chat's Run, and returns it to the task's queue if that Run ended meanwhile", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { channels, configured, fixture, thread } = await chatWithTask(
      storeFixture,
      "steer-held",
    );
    const first = await store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      idempotencyKey: "steer-held-first",
      content: [{ type: "text", text: "Start" }],
      policy: "queue",
      source: { kind: "human" },
    });
    if (!first.run) throw new Error("Expected a queued Run");
    await startPersonalQueuedRunFixture(store, first.run.id);
    const followUp = await store.enqueueThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      idempotencyKey: "steer-held-follow-up",
      content: [{ type: "text", text: "One more thing" }],
      policy: "queue",
      source: { kind: "human" },
    });
    const steer = await store.steerThreadInput({
      threadId: thread.id,
      requestedBy: fixture.userId,
      expectedRunId: first.run.id,
      messageId: followUp.message.id,
      idempotencyKey: "steer-held",
    });
    if (!steer.command) throw new Error("Expected a pending steer command");
    const commandId = steer.command.id;
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    // Paused: held, never failed, its message kept with it.
    expect(await listed(storeFixture, commandId)).toBe(false);
    expect(await store.claimCommand(commandId, "steer-held")).toBeNull();
    const input = () =>
      database
        .selectFrom("threadInputs")
        .select(["state", "policy"])
        .where("messageId", "=", followUp.message.id)
        .executeTakeFirstOrThrow();
    expect((await input()).state).toBe("claimed");
    // Meanwhile the Run it was for ends; the chat comes back.
    await database
      .updateTable("runs")
      .set({ status: "interrupted", completedAt: new Date() })
      .where("id", "=", first.run.id)
      .execute();
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
    const claimed = await store.claimCommand(commandId, "steer-held-2");
    expect(claimed?.terminalFailure).toBeDefined();
    expect(claimed?.terminalFailure).not.toMatch(/access ended/u);
    await store.refuseSteer(commandId, claimed!.terminalFailure!);
    expect(await input()).toEqual({ state: "pending", policy: "queue" });
  });

  it("refuses at once a person's message to a task whose chat has ended, in a chat's words, and holds it while the chat waits", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const send = (thread: string, userId: string, key: string) =>
      store.enqueueThreadInput({
        requestedBy: userId as never,
        threadId: thread as never,
        content: [{ type: "text", text: key }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: key,
      });
    // Paused: the message is the person's, held until the chat is back.
    const paused = await chatWithTask(storeFixture, "person-paused");
    await paused.channels.setConnectionStatus(
      paused.configured.connection.id,
      paused.fixture.userId,
      "paused",
    );
    await expect(
      send(paused.thread.id, paused.fixture.userId, "while-paused"),
    ).resolves.toMatchObject({ disposition: "pending" });
    // Ended: nothing more goes in, and the person reads why.
    const ended = await chatWithTask(storeFixture, "person-ended");
    expect(
      await new AgentConnectionStore(storeFixture.database).revoke(
        ended.fixture.userId,
        ended.chat.id,
      ),
    ).toBe(true);
    await expect(send(ended.thread.id, ended.fixture.userId, "after-end")).rejects.toMatchObject({
      code: "forbidden",
      message:
        "This chat ended, so this task takes no new messages. Start a new task, or add the chat again on Messaging.",
    });
  });

  it("refuses at once a person's message to a task whose connected agent was disconnected, in its words", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const fixture = await storeFixture.createRunFixture("person-agent-ended");
    const connections = new AgentConnectionStore(database);
    const agent = await connections.create({
      userId: fixture.userId,
      label: "Test agent",
      clientName: "Test agent",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await connections.activate(agent.id, "person-agent-ended-hash");
    const { thread } = await store.createThread({
      authority: {
        kind: "connection",
        connectionId: agent.id,
        userId: fixture.userId,
        accessMode: "full-access",
      },
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "person-agent-ended-task",
      modelSelection: fixture.thread.modelSelection,
      title: "The agent's task",
    });
    expect(await connections.revoke(fixture.userId, agent.id)).toBe(true);
    await expect(
      store.enqueueThreadInput({
        requestedBy: fixture.userId,
        threadId: thread.id,
        content: [{ type: "text", text: "Go on" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: "person-agent-ended-send",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "This connected agent's access ended, so this task takes no new messages. Start a new task, or reconnect it from Connected agents.",
    });
  });

  it("refuses at once to resume, reschedule or edit an automation in a chat anyone can message", async ({
    storeFixture,
  }) => {
    const anyone = await chatWithTask(storeFixture, "change-anyone", "anyone");
    const owner = await chatWithTask(storeFixture, "change-owner");
    const triggers = new TriggerStore(storeFixture.database);
    // Made before such a chat could not have one, and paused: an owner chat's, moved over.
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: owner.chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: owner.thread.id,
      createdBy: owner.fixture.userId,
      idempotencyKey: "change-anyone",
      name: "Every minute",
      ...everyMinute,
    });
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: owner.fixture.userId,
      status: "paused",
      triggerId: trigger.id,
    });
    await storeFixture.database
      .updateTable("triggers")
      .set({ originConnectionId: anyone.chat.id })
      .where("id", "=", trigger.id)
      .execute();
    const before = await storeFixture.database
      .selectFrom("triggers")
      .select(["status", "nextFireAt", "name", "currentRevisionId"])
      .where("id", "=", trigger.id)
      .executeTakeFirstOrThrow();
    const refusal = {
      code: "forbidden",
      message: "A chat that anyone in the conversation can message can't have an automation.",
    };
    const base = { actorThreadId: null, ownerId: owner.fixture.userId, triggerId: trigger.id };
    await expect(triggers.setStatus({ ...base, status: "active" })).rejects.toMatchObject(refusal);
    await expect(
      triggers.setNextFire({
        ...base,
        nextFireAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).rejects.toMatchObject(refusal);
    await expect(
      triggers.update({ ...base, expectedRevisionId: before.currentRevisionId!, name: "Renamed" }),
    ).rejects.toMatchObject(refusal);
    // Nothing of it moved; it can still be stopped for good.
    expect(
      await storeFixture.database
        .selectFrom("triggers")
        .select(["status", "nextFireAt", "name", "currentRevisionId"])
        .where("id", "=", trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    await expect(triggers.setStatus({ ...base, status: "archived" })).resolves.toMatchObject({
      status: "archived",
    });
  });

  it("launches no automation that already exists in a chat anyone can message, however it fires", async ({
    storeFixture,
  }) => {
    const anyone = await chatWithTask(storeFixture, "existing-anyone", "anyone");
    const owner = await chatWithTask(storeFixture, "existing-owner");
    const triggers = new TriggerStore(storeFixture.database);
    // Made before such a chat could not have one: an owner chat's, moved to the anyone chat.
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: owner.chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: owner.thread.id,
      createdBy: owner.fixture.userId,
      idempotencyKey: "existing-anyone",
      name: "Every minute",
      ...everyMinute,
    });
    await storeFixture.database
      .updateTable("triggers")
      .set({ originConnectionId: anyone.chat.id, nextFireAt: new Date(Date.now() - 60_000) })
      .where("id", "=", trigger.id)
      .execute();
    const refusal = {
      code: "forbidden",
      message: "A chat that anyone in the conversation can message can't have an automation.",
    };
    // Run now: refused, nothing queued.
    await expect(
      triggers.enqueueManual({
        actorThreadId: null,
        ownerId: owner.fixture.userId,
        triggerId: trigger.id,
      }),
    ).rejects.toMatchObject(refusal);
    // Due: nothing fires, and it is paused saying why.
    const claimed = await triggers.claimDueSchedules(new Date());
    expect(claimed.occurrences).toEqual([]);
    const row = await storeFixture.database
      .selectFrom("triggers")
      .select(["status", "pauseReason"])
      .where("id", "=", trigger.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: "paused",
      pauseReason:
        "Paused because a chat that anyone in the conversation can message can't have an automation.",
    });
    expect(
      await storeFixture.database
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("triggerId", "=", trigger.id)
        .execute(),
    ).toEqual([]);
  });

  for (const who of ["made by the chat's own agent"] as const)
    it(`fires no automation of a paused chat (${who}): no occurrence, no error, still active, and once when it is back`, async ({
      storeFixture,
    }) => {
      const { chat, channels, configured, fixture, thread } = await chatWithTask(
        storeFixture,
        `auto-${who === "made by the chat's own agent" ? "agent" : "person"}`,
      );
      const { database, store } = storeFixture;
      const triggers = new TriggerStore(database);
      const { trigger } = await triggers.create({
        actorThreadId: null,
        ...(who === "made by the chat's own agent"
          ? { actorConnectionId: chat.id, actorAccessMode: "full-access" as const }
          : {}),
        anchorThreadId: thread.id,
        createdBy: fixture.userId,
        idempotencyKey: `auto-${who}`,
        name: "Every minute",
        ...everyMinute,
      });
      expect(await originOf(storeFixture, trigger.id)).toBe(chat.id);
      const due = (at: number) =>
        database
          .updateTable("triggers")
          .set({ nextFireAt: new Date(at) })
          .where("id", "=", trigger.id)
          .execute();
      const service = new ChannelService({
        channels,
        credentials: {} as never,
        relay: { connectedRunnerIds: () => [] } as never,
        store,
        bridgeTools: () => ({ callTool: async () => ({}) }),
      });
      try {
        await service.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
        // Due three times while it waits: nothing is created, nothing fails, nothing moves.
        for (const minutes of [3, 2, 1]) {
          const at = Date.now() - minutes * 60_000;
          await due(at);
          const claimed = await triggers.claimDueSchedules(new Date());
          expect(claimed).toMatchObject({ occurrences: [], failures: [] });
          // The loop does not count it as due, so it neither spins nor backs off.
          expect((await triggers.nextScheduleAt())?.getTime() ?? null).not.toBe(at);
        }
        expect(
          await database
            .selectFrom("triggers")
            .select(["status", "pauseReason"])
            .where("id", "=", trigger.id)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: "active", pauseReason: null });
        expect(
          await database
            .selectFrom("triggerOccurrences")
            .select("id")
            .where("triggerId", "=", trigger.id)
            .execute(),
        ).toEqual([]);
        // Back, through the service: the schedule loop is woken, and the overdue tick fires once.
        const reactions: string[] = [];
        const unhook = storeFixture.observePersonalReactions({
          notice: () => undefined,
          reaction: (reaction) => reactions.push(reaction.type),
        });
        await service.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
        unhook();
        expect(reactions).toContain("triggerSchedulesChanged");
        const back = await triggers.claimDueSchedules(new Date());
        expect(back.failures).toEqual([]);
        expect(back.occurrences).toHaveLength(1);
        expect(await triggers.claimDueSchedules(new Date())).toMatchObject({ occurrences: [] });
        const claimed = await store.claimCommand(back.occurrences[0]!.commandId, "auto");
        if (!claimed || claimed.terminalFailure)
          throw new Error("Expected the automation's command");
        const sent: RunnerCommand[] = [];
        await dispatcher(
          storeFixture,
          fixture.runnerId,
          { planning: async () => {} },
          sent,
          [],
        ).dispatch(claimed.command, new AbortController().signal);
        expect(sent.map(({ type }) => type)).toEqual(["trigger.execute"]);
      } finally {
        await service.close();
      }
    });

  it("skips, never pauses, an automation whose chat started waiting between the due read and its authority", async ({
    storeFixture,
  }) => {
    const { chat, channels, configured, fixture, thread } = await chatWithTask(
      storeFixture,
      "auto-race",
    );
    const { database } = storeFixture;
    const triggers = new TriggerStore(database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "auto-race",
      name: "Every minute",
      ...everyMinute,
    });
    expect(await originOf(storeFixture, trigger.id)).toBe(chat.id);
    const at = new Date(Date.now() - 60_000);
    await database
      .updateTable("triggers")
      .set({ nextFireAt: at })
      .where("id", "=", trigger.id)
      .execute();
    // Due when read; then the account needs attention before its authority is read.
    const claimed = await triggers.claimDueSchedules(new Date(), 64, {
      afterDueRead: async () => {
        await channels.setRuntimeConnectionHealth({
          connectionId: configured.connection.id,
          detail: "Signed out",
          reason: "credentials",
          runnerId: testMessagingRunnerId,
          status: "needs-attention",
        });
      },
    });
    // Held: nothing created, nothing moved, and nothing changed for the list to read again.
    expect(claimed).toEqual({ occurrences: [], failures: [], changed: false });
    expect(
      await database
        .selectFrom("triggers")
        .select(["status", "pauseReason", "nextFireAt"])
        .where("id", "=", trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active", pauseReason: null, nextFireAt: at });
  });

  /** A chat automation due a minute ago, for a claim whose seams the test forces. */
  async function dueChatAutomation(storeFixture: Fixture, suffix: string) {
    const chat = await chatWithTask(storeFixture, suffix);
    const triggers = new TriggerStore(storeFixture.database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: chat.chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: chat.thread.id,
      createdBy: chat.fixture.userId,
      idempotencyKey: suffix,
      name: "Every minute",
      ...everyMinute,
    });
    const at = new Date(Date.now() - 60_000);
    await storeFixture.database
      .updateTable("triggers")
      .set({ nextFireAt: at })
      .where("id", "=", trigger.id)
      .execute();
    const health = async (status: "needs-attention" | "connected") => {
      await chat.channels.setRuntimeConnectionHealth({
        connectionId: chat.configured.connection.id,
        detail: status === "connected" ? null : "Signed out",
        reason: status === "connected" ? null : "credentials",
        runnerId: testMessagingRunnerId,
        status,
      });
    };
    const standing = async () => ({
      trigger: await storeFixture.database
        .selectFrom("triggers")
        .select(["status", "pauseReason", "nextFireAt"])
        .where("id", "=", trigger.id)
        .executeTakeFirstOrThrow(),
      occurrences: (
        await storeFixture.database
          .selectFrom("triggerOccurrences")
          .select("id")
          .where("triggerId", "=", trigger.id)
          .execute()
      ).length,
    });
    return { at, health, standing, triggers };
  }

  it("never pauses a live chat's automation when its account needs attention for a moment mid-claim", async ({
    storeFixture,
  }) => {
    const { at, health, standing, triggers } = await dueChatAutomation(storeFixture, "auto-flap");
    // Waiting when its authority is read, live again by the next read.
    const claimed = await triggers.claimDueSchedules(new Date(), 64, {
      afterDueRead: () => health("needs-attention"),
      afterAuthority: () => health("connected"),
    });
    expect(await standing()).toEqual({
      trigger: { status: "active", pauseReason: null, nextFireAt: at },
      occurrences: 0,
    });
    expect(claimed).toEqual({ occurrences: [], failures: [], changed: false });
  });

  it("holds, never reports a failure, when its chat starts waiting just before the occurrence is recorded", async ({
    storeFixture,
  }) => {
    const { at, health, standing, triggers } = await dueChatAutomation(storeFixture, "auto-late");
    const claimed = await triggers.claimDueSchedules(new Date(), 64, {
      beforeEnqueue: () => health("needs-attention"),
    });
    expect(claimed).toEqual({ occurrences: [], failures: [], changed: false });
    expect(await standing()).toEqual({
      trigger: { status: "active", pauseReason: null, nextFireAt: at },
      occurrences: 0,
    });
  });

  /** An automation of an "anyone" chat with one tick enqueued while the chat was live. */
  async function liveTick(storeFixture: Fixture, suffix: string) {
    const chat = await chatWithTask(storeFixture, suffix);
    const triggers = new TriggerStore(storeFixture.database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: chat.chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: chat.thread.id,
      createdBy: chat.fixture.userId,
      idempotencyKey: suffix,
      name: "Every minute",
      ...everyMinute,
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: chat.fixture.userId,
      triggerId: trigger.id,
    });
    const pause = () =>
      chat.channels.setConnectionStatus(
        chat.configured.connection.id,
        chat.fixture.userId,
        "paused",
      );
    const resume = () =>
      chat.channels.setConnectionStatus(
        chat.configured.connection.id,
        chat.fixture.userId,
        "connected",
      );
    return { ...chat, occurrence, pause, resume };
  }
  const listed = async (storeFixture: Fixture, commandId: string) =>
    (await storeFixture.store.listPendingCommands()).some(({ id }) => id === commandId);

  it("holds a tick enqueued before the pause at its listing, and lists it when the chat is back", async ({
    storeFixture,
  }) => {
    const { occurrence, pause, resume } = await liveTick(storeFixture, "tick-listing");
    expect(await listed(storeFixture, occurrence.commandId)).toBe(true);
    await pause();
    expect(await listed(storeFixture, occurrence.commandId)).toBe(false);
    await resume();
    expect(await listed(storeFixture, occurrence.commandId)).toBe(true);
  });

  it("holds a tick listed before the pause at its claim, and claims it when the chat is back", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const { occurrence, pause, resume } = await liveTick(storeFixture, "tick-claim");
    expect(await listed(storeFixture, occurrence.commandId)).toBe(true);
    await pause();
    expect(await store.claimCommand(occurrence.commandId, "tick-claim")).toBeNull();
    await resume();
    expect(
      (await store.claimCommand(occurrence.commandId, "tick-claim"))?.terminalFailure,
    ).toBeUndefined();
  });

  it("holds a tick paused at its send fence, undoes its running stamp, and sends it once when back", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { fixture, occurrence, pause, resume } = await liveTick(storeFixture, "tick-fence");
    const claimed = await store.claimCommand(occurrence.commandId, "tick-fence");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the automation's command");
    const failure = await dispatcher(
      storeFixture,
      fixture.runnerId,
      { planning: async () => {}, beforeFence: pause },
      [],
      [],
    )
      .dispatch(claimed.command, new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((failure as CommandDispatchError).disposition).toBe("held");
    await store.retryCommand(occurrence.commandId, failure);
    expect(
      await database
        .selectFrom("triggerOccurrences")
        .select("status")
        .where("id", "=", occurrence.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending" });
    await resume();
    const again = await store.claimCommand(occurrence.commandId, "tick-fence-2");
    if (!again || again.terminalFailure) throw new Error("Expected the automation's command again");
    const sent: RunnerCommand[] = [];
    await dispatcher(
      storeFixture,
      fixture.runnerId,
      { planning: async () => {} },
      sent,
      [],
    ).dispatch(again.command, new AbortController().signal);
    expect(sent.map(({ type }) => type)).toEqual(["trigger.execute"]);
  });

  it("fails a tick as itself when something other than a paused chat refuses it, even while paused", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const { fixture, occurrence, pause } = await liveTick(storeFixture, "tick-conflict");
    const claimed = await store.claimCommand(occurrence.commandId, "tick-conflict");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the automation's command");
    await pause();
    const load = vi
      .spyOn(TriggerStore.prototype, "loadDispatchContext")
      .mockRejectedValue(
        new OpensteerError({ code: "conflict", message: "The occurrence changed" }),
      );
    try {
      const failure = await dispatcher(
        storeFixture,
        fixture.runnerId,
        { planning: async () => {} },
        [],
        [],
      )
        .dispatch(claimed.command, new AbortController().signal)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toMatchObject({ message: "The occurrence changed" });
      expect((failure as { disposition?: string }).disposition).not.toBe("held");
    } finally {
      load.mockRestore();
    }
  });

  it("holds a tick its one read found paused, even if the chat is back before anything else is read", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const { fixture, occurrence, pause, resume } = await liveTick(storeFixture, "tick-race");
    const claimed = await store.claimCommand(occurrence.commandId, "tick-race");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the automation's command");
    await pause();
    // The chat is back the moment its standing has been read once.
    const original = TriggerStore.prototype.loadDispatchContext;
    const load = vi
      .spyOn(TriggerStore.prototype, "loadDispatchContext")
      .mockImplementation(async function (this: TriggerStore, ...input) {
        try {
          return await original.apply(this, input);
        } finally {
          await resume();
        }
      });
    try {
      const failure = await dispatcher(
        storeFixture,
        fixture.runnerId,
        { planning: async () => {} },
        [],
        [],
      )
        .dispatch(claimed.command, new AbortController().signal)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect((failure as { disposition?: string }).disposition).toBe("held");
    } finally {
      load.mockRestore();
    }
  });

  it("fails, never holds, an automation of a paused chat anyone in the conversation can message", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { fixture, occurrence } = await liveTick(storeFixture, "tick-anyone");
    const claimed = await store.claimCommand(occurrence.commandId, "tick-anyone");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the automation's command");
    // Made before such a chat could not have one: moved to a chat anyone can message, then paused.
    const anyone = await chatWithTask(storeFixture, "tick-anyone-chat", "anyone");
    await database
      .updateTable("triggers")
      .set({ originConnectionId: anyone.chat.id })
      .where(
        "id",
        "=",
        database
          .selectFrom("triggerOccurrences")
          .select("triggerId")
          .where("id", "=", occurrence.id),
      )
      .execute();
    await anyone.channels.setConnectionStatus(
      anyone.configured.connection.id,
      anyone.fixture.userId,
      "paused",
    );
    const failure = await dispatcher(
      storeFixture,
      fixture.runnerId,
      { planning: async () => {} },
      [],
      [],
    )
      .dispatch(claimed.command, new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({
      message: "A chat that anyone in the conversation can message can't have an automation.",
    });
    expect((failure as { disposition?: string }).disposition).not.toBe("held");
  });

  it("never turns a dispatch that may have reached the Runner into held, even if the chat is paused meanwhile", async ({
    storeFixture,
  }) => {
    const { chat, channels, configured, fixture, thread } = await chatWithTask(
      storeFixture,
      "auto-uncertain",
    );
    const { database, store } = storeFixture;
    const triggers = new TriggerStore(database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      actorConnectionId: chat.id,
      actorAccessMode: "full-access",
      anchorThreadId: thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "auto-uncertain",
      name: "Every minute",
      ...everyMinute,
    });
    expect(await originOf(storeFixture, trigger.id)).toBe(chat.id);
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: trigger.id,
    });
    const claimed = await store.claimCommand(occurrence.commandId, "auto-uncertain");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the automation's command");
    // The send fence passes and the frame leaves; then the chat is paused and the answer is lost.
    const failure = await dispatcher(
      storeFixture,
      fixture.runnerId,
      {
        planning: async () => {},
        afterFence: async () => {
          await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
          throw new CommandDispatchError("Runner command acknowledgement timed out", "uncertain");
        },
      },
      [],
      [],
    )
      .dispatch(claimed.command, new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((failure as CommandDispatchError).disposition).toBe("uncertain");
    // Only "held" goes back to pending; an unknown end stays where it is, and is never run again.
    if ((failure as CommandDispatchError).disposition === "held")
      await store.retryCommand(occurrence.commandId, failure);
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "connected");
    expect((await store.listPendingCommands()).map(({ id }) => id)).not.toContain(
      occurrence.commandId,
    );
  });

  it("holds nothing of the person's own automation on a chat's task, and its Disconnect leaves it alone", async ({
    storeFixture,
  }) => {
    const { bridgeId, channels, configured, fixture } =
      await storeFixture.createChannelDeliveryFixture("auto-own");
    const { database, store } = storeFixture;
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridgeId })
      .where("id", "=", fixture.thread.id)
      .execute();
    const triggers = new TriggerStore(database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "auto-own",
      name: "Mine",
      ...everyMinute,
    });
    // It is the person's: the chat owns nothing of it.
    expect(await originOf(storeFixture, trigger.id)).toBeNull();
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: fixture.userId,
      triggerId: trigger.id,
    });
    await channels.setConnectionStatus(configured.connection.id, fixture.userId, "paused");
    expect((await store.listPendingCommands()).map(({ id }) => id)).toContain(occurrence.commandId);
    // A pre-send refusal fails as itself, never as held (this Runner runs no automation programs).
    const claimed = await store.claimCommand(occurrence.commandId, "auto-own");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the automation's command");
    const failure = await dispatcher(
      storeFixture,
      fixture.runnerId,
      { planning: async () => {} },
      [],
      [],
    )
      .dispatch(claimed.command, new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({
      disposition: "failed",
      message: "Update this computer to run automation programs with tool contract version 5.",
    });
    // Disconnecting the chat changes nothing of it.
    await new AgentConnectionStore(database).revoke(fixture.userId, bridgeId!);
    await store.driveConnectionCleanups({ stopper: { stop: async () => undefined } });
    expect(
      await database
        .selectFrom("triggers")
        .select("status")
        .where("id", "=", trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active" });
  });

  it('sends nothing of a Run whose sender stopped being "me" between its claim and its send, and the chat hears nothing', async ({
    storeFixture,
  }) => {
    const bridge = await storeFixture.createBridgeFixture("dispatch-relink");
    const { database, store } = storeFixture;
    const { fixture } = bridge;
    const conversationId = createChannelId("conversation") as ChannelConversationId;
    await database
      .insertInto("bridgeConversations")
      .values({
        id: conversationId,
        bridgeId: bridge.bridge.id,
        accountId: bridge.configured.account.id,
        externalScopeId: null,
        externalConversationId: "D-dispatch-relink",
        externalThreadId: null,
        conversationType: "dm",
        displayName: null,
        threadId: null,
      })
      .execute();
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", fixture.thread.id)
      .execute();
    const queued = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
      content: [{ type: "text", text: "From the old phone" }],
      source: {
        kind: "connection",
        connectionId: bridge.bridge.id,
        chat: {
          conversationId,
          revision: bridge.bridge.grantRevision!,
          sender: { displayName: "Tim", externalUserId: bridge.owner },
        },
      },
      policy: "queue",
      idempotencyKey: "dispatch-relink",
    });
    if (!queued.command) throw new Error("Expected a queued Run");
    const claimed = await store.claimCommand(queued.command.id, "dispatch-relink");
    if (!claimed || claimed.terminalFailure) throw new Error("Expected the Run's command");
    const sent: RunnerCommand[] = [];
    const failure = await dispatcher(
      storeFixture,
      fixture.runnerId,
      {
        // The person links "me" to their new phone while the Run is being prepared.
        planning: async () => {
          await database
            .updateTable("channelIdentities")
            .set({ status: "unlinked", linkedUserId: null })
            .where("accountId", "=", bridge.configured.account.id)
            .where("externalUserId", "=", bridge.owner)
            .execute();
        },
      },
      sent,
      [],
    )
      .dispatch(claimed.command, new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(sent).toEqual([]);
    expect(failure).toMatchObject({
      disposition: "failed",
      message: "Its message came from an account that is no longer linked as you.",
    });
    await store.failCommand(queued.command.id, (failure as Error).message);
    expect(
      await database
        .selectFrom("bridgeDeliveries")
        .select("id")
        .where("bridgeId", "=", bridge.bridge.id)
        .where("kind", "=", "status")
        .execute(),
    ).toEqual([]);
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

  it("refuses steering, edit lease, and editing waiting inputs on tasks of an ended chat or connected agent", async ({
    storeFixture,
  }) => {
    const chatEnded =
      "This chat ended, so this task takes no new messages. Start a new task, or add the chat again on Messaging.";
    const agentEnded =
      "This connected agent's access ended, so this task takes no new messages. Start a new task, or reconnect it from Connected agents.";
    const { database, store } = storeFixture;
    const runningChat = await storeFixture.startRunFixture("ended-steer-chat");
    const bridge = await storeFixture.createBridgeFixture("ended-steer-bridge");
    await database
      .updateTable("agentConnections")
      .set({ userId: runningChat.userId })
      .where("id", "=", bridge.bridge.id)
      .execute();
    await database
      .updateTable("threads")
      .set({ originConnectionId: bridge.bridge.id })
      .where("id", "=", runningChat.thread.id)
      .execute();
    const chatQueued = await store.enqueueThreadInput({
      requestedBy: runningChat.userId,
      threadId: runningChat.thread.id,
      content: [{ type: "text", text: "Waiting while chat runs" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "ended-steer-chat-q",
    });

    const runningAgent = await storeFixture.startRunFixture("ended-steer-agent");
    const url = await serveMcp(storeFixture);
    const agent = await connection(store, url, {
      userId: runningAgent.userId,
      accessMode: "approval-required",
    });
    await database
      .updateTable("threads")
      .set({ originConnectionId: agent.id })
      .where("id", "=", runningAgent.thread.id)
      .execute();
    const agentQueued = await store.enqueueThreadInput({
      requestedBy: runningAgent.userId,
      threadId: runningAgent.thread.id,
      content: [{ type: "text", text: "Waiting while agent runs" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "ended-steer-agent-q",
    });

    // Disconnect both (without running cleanup yet, so their Runs remain running and inputs waiting).
    const connections = new AgentConnectionStore(database);
    await connections.revoke(runningChat.userId, bridge.bridge.id);
    await connections.revoke(runningAgent.userId, agent.id);

    const sessionId = `aus_${crypto.randomUUID()}` as never;
    for (const entry of [
      {
        label: "chat",
        userId: runningChat.userId,
        threadId: runningChat.thread.id,
        runId: runningChat.run.id,
        messageId: chatQueued.message.id,
        expected: chatEnded,
      },
      {
        label: "agent",
        userId: runningAgent.userId,
        threadId: runningAgent.thread.id,
        runId: runningAgent.run.id,
        messageId: agentQueued.message.id,
        expected: agentEnded,
      },
    ]) {
      await expect(
        store.steerThreadInput({
          expectedRunId: entry.runId,
          idempotencyKey: `ended-steer-${entry.label}`,
          messageId: entry.messageId,
          requestedBy: entry.userId,
          threadId: entry.threadId,
        }),
      ).rejects.toMatchObject({ code: "forbidden", message: entry.expected });
      await expect(
        store.takeThreadInputLease({
          deviceLabel: "Mac",
          leaseId: `lease-${entry.label}`,
          messageId: entry.messageId,
          requestedBy: entry.userId,
          sessionId,
          takeOver: false,
          threadId: entry.threadId,
        }),
      ).rejects.toMatchObject({ code: "forbidden", message: entry.expected });
      await expect(
        store.editThreadInput({
          content: [{ type: "text", text: "Edited after disconnect" }],
          deviceLabel: "Mac",
          expectedRevision: 0,
          idempotencyKey: `ended-edit-${entry.label}`,
          messageId: entry.messageId,
          requestedBy: entry.userId,
          sessionId,
          threadId: entry.threadId,
        }),
      ).rejects.toMatchObject({ code: "forbidden", message: entry.expected });
    }
  });
});
