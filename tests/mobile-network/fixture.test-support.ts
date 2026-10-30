import {
  createId,
  AgentEventSchema,
  MessageSchema,
  ModelSelectionSchema,
  HarnessInstanceIdSchema,
  type AgentEvent,
  type ThreadId,
} from "../../packages/core/src/index.js";
import {
  BrowserSurfaceIdSchema,
  createBrowserSessionId,
} from "../../packages/protocol/src/index.js";
import { WorkspaceTabStore } from "../../packages/database/src/workspace-tab-store.js";
import { jsonValue } from "../../packages/database/src/store-primitives.js";
import {
  connectCallerMachine,
  dispatchCallerRun,
  enrollmentToken,
  type MachineAccessHost,
} from "../../apps/host/src/runtime/machine-access.test-support.js";

export type SeedName = "light" | "heavy";

/** Real store commands establish authority; bulk history uses the integration fixtures' DB path. */
export async function seedWorkspace(
  host: MachineAccessHost,
  seed: SeedName,
  cleanup: (() => Promise<unknown>)[],
) {
  const caller = await connectCallerMachine(host, {
    name: "Benchmark computer",
    token: await enrollmentToken(host, {
      allowedModules: ["agents"],
      idempotencyKey: "bench-runner",
      name: "Benchmark computer",
    }),
  });
  cleanup.push(() => caller.close());
  const main = await host.store.findMainWorkspaceForOwner(host.ownerId);
  if (!main) throw new Error("Owner bootstrap did not create Main");
  const workspace = main;
  const createThread = async (key: string, home = false) =>
    (
      await host.store.createThread({
        createdBy: host.ownerId,
        environmentId: caller.environmentId,
        harnessInstanceId: HarnessInstanceIdSchema.parse(caller.harnessInstanceId),
        home,
        idempotencyKey: key,
        modelSelection: ModelSelectionSchema.parse({
          modelId: "gpt-5.6-sol",
          providerId: "openai",
          options: { effort: "low" },
        }),
        title: home ? "Chat" : `Benchmark task ${key}`,
        workspaceId: workspace.id,
      })
    ).thread.id;
  const homeThreadId = workspace.homeThreadId ?? (await createThread("home", true));
  const historyRun = await dispatchCallerRun(host, caller, {
    key: "history",
    title: "Chat",
    workspaceId: workspace.id,
    threadId: homeThreadId,
  });
  await historyRun.complete();
  const database = host.store.database;
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
      const thread = await transaction
        .selectFrom("threads")
        .select("nextMessageSequence")
        .where("id", "=", threadId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const head = await transaction
        .updateTable("workspaces")
        .set({ updatedAt: new Date() })
        .where("id", "=", workspace.id)
        .returning("eventSequence")
        .executeTakeFirstOrThrow();
      let sequence = BigInt(head.eventSequence);
      const events: (Omit<AgentEvent, "createdAt" | "data"> & {
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
                workspaceId: workspace.id,
                workspaceName: workspace.name,
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
            workspaceId: workspace.id,
            type,
            data,
          });
          events.push({
            ...event,
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
          .insertInto("workspaceEvents")
          .values(events.slice(start, start + 100))
          .execute();
      await transaction
        .updateTable("threads")
        .set({ nextMessageSequence: String(BigInt(thread.nextMessageSequence) + BigInt(count)) })
        .where("id", "=", threadId)
        .execute();
      await transaction
        .updateTable("workspaces")
        .set({ eventSequence: String(sequence) })
        .where("id", "=", workspace.id)
        .execute();
    });
  }
  const existing = await database
    .selectFrom("messages")
    .select("id")
    .where("threadId", "=", homeThreadId)
    .execute();
  await history(homeThreadId, messageCount - existing.length, seed === "heavy", historyRun.runId);
  // Real admission creates each Run's seed input, ProviderSession and execution binding.
  for (const [index, id] of taskIds.slice(-5).entries()) {
    const run = await dispatchCallerRun(host, caller, {
      key: `task-history-${index}`,
      title: "Task history",
      workspaceId: workspace.id,
      threadId: id,
    });
    await run.complete();
    await history(id, seed === "heavy" ? 12 : 4, seed === "heavy", run.runId);
  }
  const pendingRequests = seed === "heavy" ? 3 : 1;
  for (let index = 0; index < pendingRequests; index++) {
    const run = await dispatchCallerRun(host, caller, {
      key: `pending-${index}`,
      title: "Needs approval",
      workspaceId: workspace.id,
      threadId: taskIds[index]!,
    });
    await run.openLiveRequest();
  }
  // The same cheap projection setup used by home-viewer-sync.integration.test.ts.
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
  const sessionId = createBrowserSessionId();
  await host.store.createBrowserSession({
    id: sessionId,
    runnerId: caller.runnerId,
    leaseGeneration: 1,
    leaseTokenHash: null,
    origin: "workspace",
    placementKey: "benchmark",
    profileId: null,
    runtimeId: "benchmark",
    workspaceId: workspace.id,
  });
  await new WorkspaceTabStore(database).record(
    sessionId,
    Array.from({ length: tabCount }, (_, index) => ({
      id: BrowserSurfaceIdSchema.parse(`surface_bench-${index}`),
      title: `Reference ${index}`,
      url: `https://example.test/reference/${index}`,
      order: index,
      openerId: null,
    })),
    [],
  );
  // Persisted places are intentionally suspended: no browser process is needed to measure their catalog.
  await host.store.transitionBrowserSession({ sessionId, state: "closed" });
  return {
    homeThreadId,
    taskIds,
    workspaceId: workspace.id,
    manifest: {
      seed,
      tasks: taskCount,
      homeMessages: messageCount,
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
