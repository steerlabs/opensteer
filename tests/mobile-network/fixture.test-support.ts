import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  startPrivateMachineHost,
} from "../../apps/host/src/integrations/personal-machine.test-support.js";
import { HarnessInstanceIdSchema } from "../../packages/core/src/index.js";
import { createBrowserSessionId } from "../../packages/protocol/src/index.js";

import type { MachineAccessHost } from "../../apps/host/src/runtime/machine-access.test-support.js";
import type { createDatabase } from "../../packages/database/src/connection.js";
import type { PendingAgentEvent } from "../../packages/protocol/src/index.js";
import type {
  EnvironmentId,
  HarnessInstanceId,
  RunnerId,
  RunId,
} from "../../packages/core/src/index.js";

export interface BenchmarkRun {
  readonly runId: RunId;
  readonly attempt: { readonly nextOrdinal: number; readonly bindingGeneration: number };
  complete(): Promise<void>;
  openLiveRequest(): Promise<void>;
}
export interface BenchmarkCaller {
  readonly runnerId: RunnerId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  startRun(input: {
    readonly key: string;
    readonly title: string;
    readonly threadId: ThreadId;
  }): Promise<BenchmarkRun>;
  commitEvent(event: PendingAgentEvent): Promise<void>;
  close(): Promise<void>;
}
export interface MobileNetworkHost extends MachineAccessHost {
  readonly database: ReturnType<typeof createDatabase>;
  readonly ownerHeaders: Readonly<Record<string, string>>;
  connectHostingCaller(): Promise<BenchmarkCaller>;
  seedSuspendedTabs(caller: BenchmarkCaller, count: number): Promise<void>;
}
export type MobileNetworkHostFactory = (databaseUrl: string) => Promise<MobileNetworkHost>;

import {
  AgentEventSchema,
  createId,
  MessageSchema,
  ModelSelectionSchema,
  type AgentEvent,
  type ThreadId,
  nodeDetailEventNodeId,
} from "../../packages/core/src/index.js";
import { PendingAgentEventSchema } from "../../packages/protocol/src/index.js";
import { eventFromRow, jsonValue } from "../../packages/database/src/store-primitives.js";

export async function startMobileNetworkHost(databaseUrl: string): Promise<MobileNetworkHost> {
  const clone = await createMachineAccessDatabase(databaseUrl);
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>> | undefined;
  try {
    host = await startPrivateMachineHost(clone.url, { remoteAccess: true });
    const active = host;
    return {
      ...active,
      database: active.store.database,
      connectHostingCaller: async () => {
        const caller = await connectCallerMachine(active, {
          name: "Benchmark computer",
          maxConcurrentRuns: 8,
          token: active.hostingRunnerEnrollmentToken,
        });
        return {
          runnerId: caller.runnerId,
          environmentId: caller.environmentId,
          harnessInstanceId: HarnessInstanceIdSchema.parse(caller.harnessInstanceId),
          startRun: async (input) => {
            const run = await dispatchCallerRun(active, caller, input);
            return {
              ...run,
              openLiveRequest: async () => {
                await run.openLiveRequest();
              },
            };
          },
          commitEvent: async (event) => {
            await active.store.commitRunnerEvent({
              environmentId: caller.environmentId,
              event,
              runnerId: caller.runnerId,
              runnerBootId: caller.primary.bootId,
            });
          },
          close: () => caller.close(),
        };
      },
      seedSuspendedTabs: async (caller, count) => {
        const createdAt = new Date();
        for (let index = 0; index < count; index++) {
          const id = createBrowserSessionId();
          await active.store.database.transaction().execute(async (transaction) => {
            await transaction
              .insertInto("browserSessions")
              .values({
                id,
                tabGroupId: id,
                tabRevision: 1,
                origin: "person",
                opener: null,
                placementKey: `runner:${caller.runnerId}:browser`,
                profileId: null,
                runnerId: caller.runnerId,
                runtimeId: "benchmark-browser",
                state: "closed",
                createdAt,
                updatedAt: createdAt,
                closedAt: null,
              })
              .execute();
            await transaction
              .insertInto("personalTabs")
              .values({
                id: `benchmark-${index}`,
                groupId: id,
                sessionId: id,
                title: `Saved tab ${index}`,
                url: `https://example.test/${index}`,
                order: 0,
                openerId: null,
                state: "suspended",
                createdAt,
                closedAt: null,
              })
              .execute();
          });
        }
      },
      close: async () => {
        try {
          await active.close();
        } finally {
          await clone.drop();
        }
      },
    };
  } catch (error) {
    try {
      await host?.close();
    } finally {
      await clone.drop();
    }
    throw error;
  }
}

export type SeedName = "light" | "heavy" | "busy-subagents";

/** Real store commands establish authority; bulk history uses the integration fixtures' DB path. */
export async function seedPersonal(
  host: MobileNetworkHost,
  seed: SeedName,
  cleanup: (() => Promise<unknown>)[],
) {
  const caller = await host.connectHostingCaller();
  cleanup.push(() => caller.close());
  const boot = await host.api["bootstrap.get"]({});
  if (!boot.ok) throw new Error(boot.error.message);
  const deploymentId = boot.data.deploymentId;
  const createThread = async (key: string) => {
    const result = await host.api["commands.dispatch"]({
      type: "thread.create",
      environmentId: caller.environmentId,
      harnessInstanceId: caller.harnessInstanceId,
      folder: host.agentHome,
      idempotencyKey: `benchmark:${key}`,
      title: `Benchmark task ${key}`,
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        providerId: "openai",
        options: { effort: "low" },
      }),
    });
    if (!result.ok) throw new Error(result.error.message);
    if (result.data.type !== "thread.create")
      throw new Error("Benchmark task creation result mismatch.");
    return result.data.thread.id;
  };
  const historyThreadId = await createThread("history");
  const historyRun = await caller.startRun({
    key: "history",
    title: "Task history",
    threadId: historyThreadId,
  });
  await historyRun.complete();
  const database = host.database;
  const template = await database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", historyRun.runId)
    .executeTakeFirstOrThrow();
  const taskCount = seed === "heavy" ? 300 : 5;
  const taskIds: ThreadId[] = [];
  for (let index = 0; index < taskCount; index++) taskIds.push(await createThread(String(index)));
  const messageCount = seed === "heavy" ? 2000 : 20;
  async function history(
    threadId: ThreadId,
    count: number,
    tools: boolean,
    runId: typeof historyRun.runId,
  ) {
    await database.transaction().execute(async (transaction) => {
      const head = await transaction
        .selectFrom("deploymentEventState")
        .select("sequence")
        .where("deploymentId", "=", deploymentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const thread = await transaction
        .selectFrom("threads")
        .select("nextMessageSequence")
        .where("id", "=", threadId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      let sequence = BigInt(head.sequence);
      const events: (Omit<AgentEvent, "createdAt" | "data"> & {
        deploymentId: typeof deploymentId;
        nodeDetailId: ReturnType<typeof nodeDetailEventNodeId>;
        createdAt: Date;
        data: ReturnType<typeof jsonValue>;
        runnerId: null;
        runnerOrdinal: null;
        runnerBootId: null;
        runnerBindingGeneration: null;
      })[] = [];
      const messages = [];
      for (let index = 0; index < count; index++) {
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
        const id = createId("message");
        const assistant = index % 2 === 1;
        const message = MessageSchema.parse({
          id,
          threadId,
          runId: assistant ? runId : null,
          sequence: String(BigInt(thread.nextMessageSequence) + BigInt(index)),
          createdAt: createdAt.toISOString(),
          kind: assistant ? "assistant" : "input",
          author: assistant
            ? {
                kind: "agent",
                displayName: "Assistant",
                runId: runId,
                threadId,
              }
            : {
                kind: "human",
                displayName: "Benchmark owner",
                principalId: template.actorPrincipalId,
                userId: host.ownerId,
              },
          content: [
            {
              type: "text",
              text: `Message ${index}: ${"Review the deployment logs and explain the next step. ".repeat(assistant ? 12 : 2)}`,
            },
          ],
        });
        messages.push({
          id,
          threadId,
          runId: message.runId,
          sequence: message.sequence,
          kind: message.kind,
          author: jsonValue(message.author),
          actorPrincipalId: template.actorPrincipalId,
          content: jsonValue(message.content),
          createdAt,
        });
        const add = (type: string, data: unknown) => {
          const event = AgentEventSchema.parse({
            createdAt: createdAt.toISOString(),
            eventId: createId("event"),
            environmentId: caller.environmentId,
            runId: runId,
            sequence: String(++sequence),
            threadId,
            type,
            data,
          });
          events.push({
            ...event,
            deploymentId,
            nodeDetailId: nodeDetailEventNodeId(event),
            createdAt,
            data: jsonValue(event.data),
            runnerId: null,
            runnerOrdinal: null,
            runnerBootId: null,
            runnerBindingGeneration: null,
          });
        };
        add("message.created", { message, input: null });
        if (tools && index % 10 === 5) {
          const callId = `logs-${index}`;
          add("tool.started", {
            callId,
            arguments: { command: "tail deployment.log" },
            tool: { name: "shell", namespace: "functions" },
          });
          add("tool.completed", {
            callId,
            isError: false,
            output: {
              text: "Build log: checked workspace and synchronized dependency.\n".repeat(440),
            },
          });
        }
      }
      for (let start = 0; start < messages.length; start += 100)
        await transaction
          .insertInto("messages")
          .values(messages.slice(start, start + 100))
          .execute();
      for (let start = 0; start < events.length; start += 100)
        await transaction
          .insertInto("deploymentEvents")
          .values(events.slice(start, start + 100))
          .execute();
      await transaction
        .updateTable("threads")
        .set({ nextMessageSequence: String(BigInt(thread.nextMessageSequence) + BigInt(count)) })
        .where("id", "=", threadId)
        .execute();
      await transaction
        .updateTable("deploymentEventState")
        .set({ sequence: String(sequence) })
        .where("deploymentId", "=", deploymentId)
        .execute();
    });
  }
  const existing = await database
    .selectFrom("messages")
    .select("id")
    .where("threadId", "=", historyThreadId)
    .execute();
  await history(
    historyThreadId,
    messageCount - existing.length,
    seed === "heavy",
    historyRun.runId,
  );
  // Real admission creates each Run's seed input, ProviderSession and execution binding.
  for (const [index, id] of taskIds.slice(-5).entries()) {
    const run = await caller.startRun({
      key: `task-history-${index}`,
      title: "Task history",
      threadId: id,
    });
    await run.complete();
    await history(id, seed === "heavy" ? 12 : 4, seed === "heavy", run.runId);
  }
  let busySubagents: {
    threadId: ThreadId;
    nodeIds: string[];
    toolCalls: number[];
    detailEvents: number;
    detailBytes: number;
  } | null = null;
  if (seed === "busy-subagents") {
    const threadId = await createThread("busy-subagents");
    const run = await caller.startRun({
      key: "busy-subagents",
      title: "Investigate with three subagents",
      threadId,
    });
    let ordinal = run.attempt.nextOrdinal;
    const emit = async (type: string, data: unknown) => {
      await caller.commitEvent(
        PendingAgentEventSchema.parse({
          type,
          data,
          ordinal: ordinal++,
          bindingGeneration: run.attempt.bindingGeneration,
          emittedAt: new Date().toISOString(),
          environmentId: caller.environmentId,
          runId: run.runId,
          threadId,
        }),
      );
    };
    const reply = (text: string) =>
      emit("assistant.message", {
        messageId: createId("message"),
        content: [{ type: "text", text }],
      });
    await reply("I will split the investigation between three subagents.");
    const nodeIds = Array.from({ length: 3 }, () => createId("executionNode"));
    const toolCalls = [174, 173, 173];
    for (const [index, nodeId] of nodeIds.entries()) {
      await emit("node.started", {
        nodeId,
        kind: "subagent",
        title: `Investigate component ${index + 1}`,
        model: "gpt-5.6-sol",
        effort: "low",
        nativeRef: `bench-${index}`,
        originCallId: null,
        parentNodeId: null,
        sessionRef: null,
        prompt: `Inspect component ${index + 1} and report findings.`,
      });
      for (let call = 0; call < toolCalls[index]!; call++) {
        if (call % 60 === 0) {
          await emit("node.message", {
            nodeId,
            text: `Inspecting component ${index + 1}, batch ${call / 60 + 1}.`,
          });
          await emit("reasoning.completed", {
            nodeId,
            blockId: `reason-${index}-${call}`,
            text: "Compare the implementation with the failing execution trace.",
          });
        }
        const callId = `child-${index}-${call}`;
        await emit("tool.started", {
          nodeId,
          callId,
          tool: { namespace: "functions", name: "shell" },
          arguments: { command: `inspect component-${index} file-${call}` },
        });
        await emit("tool.completed", {
          nodeId,
          callId,
          isError: false,
          output: {
            text: Array.from(
              { length: 64 },
              (_, line) =>
                `component-${index}/file-${call}:${line}: inspected dependency and verified execution trace.\n`,
            ).join(""),
          },
        });
      }
      const result = `Component ${index + 1}: investigation complete; verified ${toolCalls[index]} source locations.`;
      await emit("node.message", { nodeId, text: result });
      await emit("node.completed", { nodeId, result, status: "completed", usage: null });
    }
    for (let call = 0; call < 4; call++) {
      const callId = `parent-${call}`;
      await emit("tool.started", {
        callId,
        tool: { namespace: "functions", name: "shell" },
        arguments: { command: "review findings" },
      });
      await emit("tool.completed", {
        callId,
        isError: false,
        output: { text: "Findings verified against the parent investigation." },
      });
    }
    await reply("All three investigations finished. The findings agree and the checks passed.");
    await emit("run.completed", { status: "completed" });
    const rows = await database
      .selectFrom("deploymentEvents")
      .selectAll()
      .where("threadId", "=", threadId)
      .execute();
    const detail = rows.map(eventFromRow).filter((event) => nodeDetailEventNodeId(event));
    busySubagents = {
      threadId,
      nodeIds,
      toolCalls,
      detailEvents: detail.length,
      detailBytes: detail.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
        0,
      ),
    };
  }
  const pendingRequests = seed === "heavy" ? 3 : 1;
  for (let index = 0; index < pendingRequests; index++) {
    const run = await caller.startRun({
      key: `pending-${index}`,
      title: "Needs approval",
      threadId: taskIds[index]!,
    });
    await run.openLiveRequest();
  }

  for (let index = pendingRequests; index < taskIds.length; index++) {
    await database
      .updateTable("threads")
      .set({
        status: index % 3 === 0 ? "running" : "idle",
        doneAt: index % 3 === 2 ? new Date("2026-01-01T00:00:00Z") : null,
      })
      .where("id", "=", taskIds[index]!)
      .execute();
  }
  const tabCount = seed === "heavy" ? 20 : 2;
  await host.seedSuspendedTabs(caller, tabCount);
  return {
    historyThreadId,
    busySubagents,
    taskIds,
    manifest: {
      seed,
      busySubagents,
      tasks: taskCount + 1 + (busySubagents ? 1 : 0),
      historyMessages: messageCount,
      historyTasks: Math.min(5, taskCount),
      addedMessagesPerHistoryTask: seed === "heavy" ? 12 : 4,
      pendingRequests,
      tabs: tabCount,
      tabsState: "suspended",
      toolOutputBytes: Buffer.byteLength(
        "Build log: checked workspace and synchronized dependency.\n".repeat(440),
      ),
    },
  };
}
