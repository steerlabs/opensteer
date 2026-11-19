import { createId, type ThreadId } from "@opensteer/core";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { createPersonalRunFixturePort } from "@opensteer/database/test-support/personal-run";
import { apiVersionHeaders, hostApiVersion } from "@opensteer/deployment-authority";
import { ScopedHostMessageSchema, type ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import WebSocket from "ws";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";

function deadline<T>(work: Promise<T>, purpose: string) {
  return withTimeout(work, 10_000, { timeoutError: () => new Error(purpose) });
}

/** A second device: it acknowledges what it applies, like the client does. */
async function watch(host: PrivateMachineHost, threadId: ThreadId) {
  const url = new URL("/v1/realtime", host.origin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: {
      ...apiVersionHeaders("personal"),
      cookie: host.ownerHeaders.cookie!,
      origin: host.origin.origin,
    },
  });
  const frames: ScopedHostMessage[] = [];
  const closes: { code: number; reason: string }[] = [];
  let changed = Promise.withResolvers<void>();
  socket.on("close", (code, reason) => {
    closes.push({ code, reason: reason.toString() });
    changed.resolve();
  });
  socket.on("message", (raw) => {
    const frame = ScopedHostMessageSchema.parse(JSON.parse(raw.toString()));
    frames.push(frame);
    if (
      frame.type === "host.snapshot" ||
      frame.type === "host.changes" ||
      frame.type === "host.live"
    )
      socket.send(
        JSON.stringify({
          type: "client.ack",
          subscriptionId: frame.subscriptionId,
          generation: frame.generation,
          throughSequence:
            frame.type === "host.live"
              ? [...frames]
                  .reverse()
                  .find(
                    (seen): seen is Extract<ScopedHostMessage, { throughSequence: string }> =>
                      "throughSequence" in seen && seen.subscriptionId === frame.subscriptionId,
                  )!.throughSequence
              : frame.throughSequence,
        }),
      );
    changed.resolve();
  });
  await deadline(
    new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    "The watching socket did not open",
  );
  const until = (predicate: () => boolean, purpose: string) =>
    deadline(
      (async () => {
        for (;;) {
          if (predicate()) return;
          if (closes.length) throw new Error(`Socket closed: ${JSON.stringify(closes)}`);
          await changed.promise;
          changed = Promise.withResolvers<void>();
        }
      })(),
      purpose,
    );
  socket.send(
    JSON.stringify({
      type: "client.attach",
      apiVersion: hostApiVersion,
      generation: 1,
      interests: [],
      installed: {},
      selected: { subscriptionId: "detail:0", generation: 1, scope: { kind: "thread", threadId } },
    }),
  );
  await until(
    () =>
      frames.some((frame) => frame.type === "host.synchronized" && frame.scope.kind === "shell") &&
      frames.some((frame) => frame.type === "host.synchronized" && frame.scope.kind === "thread"),
    "The watching socket did not synchronize",
  );
  return { socket, frames, closes, until };
}

it("keeps a watching device on one stream of values through a busy Run, an oversized commit and a revocation", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const { store } = host;
    const tasks = createPersonalRunFixturePort(store);
    const runs: ({ threadId: ThreadId } & Awaited<ReturnType<typeof tasks.startTask>>)[] = [];
    const first = await tasks.createTask({ ownerId: host.ownerId, suffix: "gate" });
    const threadIds = [first.threadId];
    for (let index = 1; index < 12; index++) {
      const { thread } = await store.createThread({
        createdBy: first.thread.createdBy,
        environmentId: first.thread.environmentId,
        harnessInstanceId: first.harnessInstance.id,
        modelSelection: first.thread.modelSelection,
        idempotencyKey: `gate-task-${index}`,
        title: `Task ${index}`,
      });
      threadIds.push(thread.id);
    }
    runs.push(
      ...(await Promise.all(
        threadIds.map(async (threadId, index) => ({
          threadId,
          ...(await tasks.startTask(threadId, `Work ${index}`)),
        })),
      )),
    );
    const [focus] = runs;
    const environment = await store.database
      .selectFrom("threads")
      .select("environmentId")
      .where("id", "=", focus!.threadId)
      .executeTakeFirstOrThrow();
    const runner = await store.database
      .selectFrom("executionEnvironments")
      .select("runnerId")
      .where("id", "=", environment.environmentId)
      .executeTakeFirstOrThrow();
    const ordinals = new Map(runs.map(({ runId }) => [runId, 1]));
    const emit = (run: (typeof runs)[number], type: string, data: Record<string, unknown>) => {
      const ordinal = ordinals.get(run.runId)!;
      ordinals.set(run.runId, ordinal + 1);
      return store.commitRunnerEvent({
        environmentId: environment.environmentId,
        runnerId: runner.runnerId!,
        runnerBootId: run.runnerBootId,
        event: {
          type,
          data,
          ordinal,
          runId: run.runId,
          threadId: run.threadId,
          environmentId: environment.environmentId,
          bindingGeneration: run.bindingGeneration,
          emittedAt: new Date().toISOString(),
        } as Parameters<typeof store.commitRunnerEvent>[0]["event"],
      });
    };

    watcher = await watch(host, focus!.threadId);
    const shell = watcher.frames.find(
      (frame) => frame.type === "host.snapshot" && frame.scope.kind === "shell",
    );
    if (shell?.type !== "host.snapshot" || !("tasks" in shell.snapshot))
      throw new Error("The shell snapshot was missing");
    expect(new Set(shell.snapshot.activeTaskIds)).toEqual(
      new Set(runs.map(({ threadId }) => threadId)),
    );
    expect(shell.snapshot).toMatchObject({ activeNextBefore: null, taskCounts: { active: 12 } });
    const attachedAt = watcher.frames.length;
    const headBefore = BigInt(
      (
        await store.database
          .selectFrom("clientSyncState")
          .select("sequence")
          .executeTakeFirstOrThrow()
      ).sequence,
    );

    const tool = { namespace: "claude", name: "Bash" };
    await emit(focus!, "tool.started", {
      callId: "gate-tool",
      tool,
      arguments: { command: "pwd" },
    });
    await emit(focus!, "tool.completed", {
      callId: "gate-tool",
      isError: false,
      output: { text: "/work" },
    });
    const nodeId = createId("executionNode");
    await emit(focus!, "node.started", {
      nodeId,
      kind: "subagent",
      effort: "high",
      model: "research-model",
      phaseIndex: 0,
      nativeRef: nodeId,
      sessionRef: null,
      originCallId: null,
      parentNodeId: null,
      prompt: "Research",
      title: "Research",
    });
    await emit(focus!, "node.updated", { nodeId, title: "Research the queue" });
    const queued = await Promise.all(
      ["First follow-up", "Second follow-up"].map((text, index) =>
        store.enqueueThreadInput({
          requestedBy: host!.ownerId,
          threadId: focus!.threadId,
          content: [{ type: "text", text }],
          source: { kind: "human" },
          policy: "queue",
          idempotencyKey: `gate-queue-${index}`,
        }),
      ),
    );
    await store.cancelThreadInput({
      idempotencyKey: "gate-queue-cancel",
      messageId: queued[0]!.message.id,
      requestedBy: host.ownerId,
      threadId: focus!.threadId,
    });
    for (const run of runs) await emit(run, "run.completed", { status: "completed" });
    const headAfter = BigInt(
      (
        await store.database
          .selectFrom("clientSyncState")
          .select("sequence")
          .executeTakeFirstOrThrow()
      ).sequence,
    );
    await watcher.until(
      () =>
        watcher!.frames.some(
          (frame) =>
            frame.type === "host.changes" &&
            frame.scope.kind === "shell" &&
            BigInt(frame.throughSequence) >= headAfter,
        ) &&
        watcher!.frames.some(
          (frame) =>
            frame.type === "host.changes" &&
            frame.scope.kind === "thread" &&
            frame.changes.some(
              (change) =>
                change.entityKind === "run-queue" &&
                change.operation === "upsert" &&
                change.value.runs.length === 1 &&
                change.value.inputs.length === 1,
            ),
        ),
      "The watching device did not see the Run finish and the queue settle",
    );
    const during = watcher.frames.slice(attachedAt);
    const detailRows = during.flatMap((frame) =>
      frame.type === "host.changes" && frame.scope.kind === "thread" ? frame.changes : [],
    );
    expect(during.filter((frame) => frame.type === "host.snapshot")).toEqual([]);
    expect(watcher.closes).toEqual([]);
    expect(new Set(detailRows.map((row) => row.entityKind))).toEqual(
      new Set(["thread", "run-queue", "queue-entry", "item"]),
    );
    expect(detailRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "item",
          operation: "upsert",
          value: expect.objectContaining({ kind: "node", executionNodeId: nodeId }),
        }),
        expect.objectContaining({
          entityKind: "queue-entry",
          operation: "remove",
          entityId: queued[0]!.message.id,
        }),
        expect.objectContaining({
          entityKind: "thread",
          operation: "upsert",
          value: expect.objectContaining({
            thread: expect.objectContaining({ id: focus!.threadId }),
          }),
        }),
      ]),
    );
    const durable = during.filter((frame) => frame.type === "host.changes");
    const commits = Number(headAfter - headBefore);
    expect(durable.length).toBeLessThanOrEqual(2 * commits);
    const shellTasks = durable.flatMap((frame) =>
      frame.type === "host.changes" && frame.scope.kind === "shell"
        ? frame.changes.filter((change) => change.entityKind === "task")
        : [],
    );
    expect(new Set(shellTasks.map((change) => change.entityId))).toEqual(
      new Set(runs.map(({ threadId }) => threadId)),
    );

    // More rows than one commit may carry reset the scope: the device gets a snapshot inline.
    const repairedAt = watcher.frames.length;
    await commitPersonalMutation(store.database, async (_tx, mutation) => {
      for (let index = 0; index < 130; index++)
        mutation.change({
          scopeKey: `thread:${focus!.threadId}`,
          entityKind: "item",
          entityId: `gate-missing-${index}`,
          operation: "remove",
        });
    });
    await watcher.until(
      () =>
        watcher!.frames
          .slice(repairedAt)
          .some(
            (frame) =>
              frame.type === "host.snapshot" &&
              frame.scope.kind === "thread" &&
              frame.generation === 1,
          ),
      "The oversized commit was not repaired by an inline snapshot",
    );
    expect(watcher.closes).toEqual([]);
    expect(
      watcher.frames
        .slice(repairedAt)
        .filter((frame) => frame.type === "host.snapshot" && frame.subscriptionId === "shell"),
    ).toEqual([]);

    // A revocation still closes the viewer and purges the feed it could replay.
    await commitPersonalMutation(store.database, async (_tx, mutation) => {
      mutation.purge(`thread:${focus!.threadId}`);
    });
    await watcher.until(
      () => watcher!.closes.length > 0,
      "The revocation did not close the viewer",
    );
    expect(watcher.closes).toEqual([
      { code: 4003, reason: expect.stringContaining("Personal authority changed") },
    ]);
    expect(
      await store.database
        .selectFrom("clientChanges")
        .select("sequence")
        .where("scopeKey", "=", `thread:${focus!.threadId}`)
        .execute(),
    ).toEqual([]);
  } finally {
    watcher?.socket.terminate();
    await host?.close();
    await database.drop();
  }
}, 120_000);

it("republishes the thread a device views when a return-hint input changes, and only that thread", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  let watcher: Awaited<ReturnType<typeof watch>> | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const { store } = host;
    const tasks = createPersonalRunFixturePort(store);
    const viewed = await tasks.createTask({ ownerId: host.ownerId, suffix: "hint-viewed" });
    const other = await tasks.createTask({ ownerId: host.ownerId, suffix: "hint-other" });
    watcher = await watch(host, viewed.threadId);
    const from = watcher.frames.length;
    const head = async () =>
      (
        await store.database
          .selectFrom("clientSyncState")
          .select("sequence")
          .executeTakeFirstOrThrow()
      ).sequence;
    const before = await head();
    await store.notificationState.setIdleCompactionPolicy({
      policy: { mode: "off" },
      userId: host.ownerId,
    });
    await watcher.until(
      () =>
        watcher!.frames
          .slice(from)
          .some(
            (frame) =>
              frame.type === "host.changes" &&
              frame.scope.kind === "thread" &&
              frame.changes.some(
                (change) => change.entityKind === "thread" && change.entityId === viewed.threadId,
              ),
          ),
      "The viewed task's thread value was not republished",
    );
    const republished = await store.database
      .selectFrom("clientChanges")
      .select("scopeKey")
      .where("entityKind", "=", "thread")
      .where("sequence", ">", before)
      .execute();
    // One durable change republishes once; runtime-only bumps write nothing.
    expect(republished).toEqual([{ scopeKey: `thread:${viewed.threadId}` }]);
    expect(other.threadId).not.toBe(viewed.threadId);
    expect(watcher.closes).toEqual([]);
  } finally {
    watcher?.socket.terminate();
    await host?.close();
    await database.drop();
  }
});
