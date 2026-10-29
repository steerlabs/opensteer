import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HarnessIdSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  AgentEventSchema,
  createId,
  type AssignmentId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { NotificationStore } from "@opensteer/database";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  type HarnessInspectionContext,
  type HarnessInspectionResult,
} from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { CommandService, KeyedAdmissionQueue } from "@opensteer/orchestration";
import { PendingAgentEventSchema, type RunnerDescriptor } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testRpcRequest } from "../server/test-host-api-request.js";
import {
  AgentControlService,
  type AgentControlRunScope,
  type AgentControlTokenService,
} from "./agent-control-service.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

class SmallWindowCodexHarnessDriver extends CodexHarnessDriver {
  override async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    const result = await super.inspect(context);
    return result.status === "ready"
      ? {
          ...result,
          models: result.models.map((model) => ({
            ...model,
            contextWindow: 4_096,
            maxOutputTokens: 512,
          })),
        }
      : result;
  }
}

function fakeCodexRegistry(
  capturePath: string,
  scenario = "vertical",
  smallWindow = false,
): HarnessRegistry {
  const registry = new HarnessRegistry();
  registry.registerDriver(
    new (smallWindow ? SmallWindowCodexHarnessDriver : CodexHarnessDriver)({
      launch: {
        arguments: [
          fakeCodexAppServer,
          `--scenario=${scenario}`,
          `--capture=${capturePath}`,
          "--unique-threads",
        ],
        executable: process.execPath,
      },
    }),
  );
  return registry;
}

integration("durable Thread changes native continuation", () => {
  let stack: VerticalStack | undefined;
  let captureRoot: string | undefined;

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    if (captureRoot) await rm(captureRoot, { force: true, recursive: true });
    captureRoot = undefined;
  }, 60_000);

  it("pins each Run to one selected session through A → B → A without changing the Thread", async () => {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-home-capture-"));
    const capturePath = join(captureRoot, "codex.jsonl");
    stack = await startVerticalStack({
      additionalHarnessInstances: [
        { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
      ],
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(capturePath),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
    const secondAccountId = stack.additionalHarnessInstanceIds[0];
    if (!secondAccountId) throw new Error("The second account did not connect");
    const workspaceId = stack.mainWorkspaceId;
    const threadId = await stack.createThread({
      home: true,
      idempotencyKey: "home-ensure-first",
      modelSelection,
      title: "Chat",
      workspaceId,
    });
    expect(
      await stack.createThread({
        home: true,
        idempotencyKey: "home-ensure-second",
        modelSelection,
        title: "Another Home attempt",
        workspaceId,
      }),
    ).toBe(threadId);
    expect((await stack.host.store.workspaceSnapshot(workspaceId)).workspace.homeThreadId).toBe(
      threadId,
    );

    const first = await stack.sendMessage({
      text: "Keep this conversation open across a route change.",
      threadId,
      workspaceId,
    });
    expect(first.assistantText).toBe("Completed by Codex.");
    const initial = await selectedSession();
    expect(initial.harnessInstanceId).toBe(stack.harnessInstanceId);
    expect(initial.providerSessionReference).toEqual(expect.any(String));

    await stack.updateThreadExecution(threadId, modelSelection, {
      expectedProviderSessionId: initial.id,
      harnessInstanceId: secondAccountId,
      idempotencyKey: "home-switch-to-second-account",
    });
    const second = await selectedSession();
    expect(second.id).not.toBe(initial.id);
    expect(second.harnessInstanceId).toBe(secondAccountId);
    expect(second.providerSessionReference).toBeNull();
    expect(second.runnerId).toBeNull();
    expect(second.leaseTokenHash).toBeNull();
    expect(second.leaseExpiresAt).toBeNull();
    expect(await allSessions()).toHaveLength(2);

    const firstRun = await stack.host.store.database
      .selectFrom("runs")
      .select("nextRunnerOrdinal")
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    if (!initial.runnerId || !initial.runnerBootId)
      throw new Error("First Run lost its binding evidence");
    const staleMessageId = createId("message");
    const staleEvent = PendingAgentEventSchema.parse({
      bindingGeneration: initial.bindingGeneration,
      data: {
        content: [{ text: "Late old-account output", type: "text" }],
        messageId: staleMessageId,
      },
      emittedAt: new Date().toISOString(),
      environmentId: stack.environmentId,
      ordinal: firstRun.nextRunnerOrdinal,
      runId: first.runId,
      threadId,
      type: "assistant.message",
      workspaceId,
    });
    let lateEventOutcome: "duplicate" | "rejected";
    try {
      const result = await stack.host.store.commitRunnerEvent({
        environmentId: stack.environmentId,
        event: staleEvent,
        runnerBootId: initial.runnerBootId,
        runnerId: initial.runnerId,
      });
      expect(result.wasDuplicate).toBe(true);
      lateEventOutcome = "duplicate";
    } catch (error) {
      expect(error).toMatchObject({ code: "conflict" });
      lateEventOutcome = "rejected";
    }
    expect((await selectedSession()).id).toBe(second.id);
    expect((await selectedSession()).providerSessionReference).toBeNull();
    expect(
      await stack.host.store.database
        .selectFrom("messages")
        .select("id")
        .where("id", "=", staleMessageId)
        .execute(),
    ).toHaveLength(0);

    await stack.updateThreadExecution(threadId, modelSelection, {
      expectedProviderSessionId: initial.id,
      harnessInstanceId: secondAccountId,
      idempotencyKey: "home-switch-to-second-account",
    });
    expect(await allSessions()).toHaveLength(2);

    const secondTurn = await stack.sendMessage({
      text: "Continue in this same visible conversation.",
      threadId,
      workspaceId,
    });
    expect(secondTurn.assistantText).toBe("Completed by Codex.");
    expect((await selectedSession()).id).toBe(second.id);
    const continuedSecondTurn = await stack.sendMessage({
      text: "Use this account's exact native continuation.",
      threadId,
      workspaceId,
    });
    expect(continuedSecondTurn.assistantText).toBe("Completed by Codex.");

    await stack.updateThreadExecution(threadId, modelSelection, {
      expectedProviderSessionId: second.id,
      harnessInstanceId: stack.harnessInstanceId,
    });
    const third = await selectedSession();
    expect(third.id).not.toBe(initial.id);
    expect(third.id).not.toBe(second.id);
    expect(third.harnessInstanceId).toBe(stack.harnessInstanceId);
    expect(third.providerSessionReference).toBeNull();
    const thirdTurn = await stack.sendMessage({
      text: "Continue after changing back.",
      threadId,
      workspaceId,
    });
    expect(thirdTurn.assistantText).toBe("Completed by Codex.");
    expect((await selectedSession()).providerSessionReference).not.toBe(
      initial.providerSessionReference,
    );

    const runs = await stack.host.store.database
      .selectFrom("runs")
      .select(["id", "threadId", "providerSessionId", "harnessInstanceId", "status", "runOrdinal"])
      .where("threadId", "=", threadId)
      .orderBy("runOrdinal", "asc")
      .execute();
    expect(runs.map((run) => run.id)).toEqual([
      first.runId,
      secondTurn.runId,
      continuedSecondTurn.runId,
      thirdTurn.runId,
    ]);
    expect(runs.map((run) => run.providerSessionId)).toEqual([
      initial.id,
      second.id,
      second.id,
      third.id,
    ]);
    expect(runs.map((run) => run.harnessInstanceId)).toEqual([
      stack.harnessInstanceId,
      secondAccountId,
      secondAccountId,
      stack.harnessInstanceId,
    ]);
    expect(runs.every((run) => run.threadId === threadId && run.status === "completed")).toBe(true);
    expect(
      (await allSessions()).filter((session) => session.active).map((session) => session.id),
    ).toEqual([third.id]);
    const transcript = await stack.host.store.workspaceSnapshot(workspaceId);
    expect(transcript.threads).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: threadId })]),
    );
    const oldestRequest = transcript.messages.find(
      (message) =>
        message.threadId === threadId &&
        message.kind === "input" &&
        message.content.some(
          (part) => part.type === "text" && part.text.includes("Keep this conversation open"),
        ),
    );
    if (!oldestRequest) throw new Error("First authored Home request is missing");
    const found = await stack.api["thread.messages.list"]({
      query: "Keep this conversation open",
      threadId,
    });
    if (!found.ok) throw new Error(`Home search failed: ${found.error.code}`);
    expect(found.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oldestRequest.id,
          author: expect.objectContaining({ kind: "human" }),
        }),
      ]),
    );
    const around = await stack.api["thread.messages.list"]({
      aroundMessageId: oldestRequest.id,
      threadId,
    });
    if (!around.ok) throw new Error(`Home anchored read failed: ${around.error.code}`);
    expect(around.data.messages.some((message) => message.id === oldestRequest.id)).toBe(true);
    expect(
      (
        await testRpcRequest(stack.hostOrigin, "thread.messages.list", {
          aroundMessageId: oldestRequest.id,
          threadId,
        })
      ).status,
    ).toBe(401);
    expect(
      (await testRpcRequest(stack.hostOrigin, "thread.events.list", { threadId })).status,
    ).toBe(401);
    expect((await testRpcRequest(stack.hostOrigin, "workspace.catalog.list", {})).status).toBe(401);
    const beforeRead = await stack.api["thread.events.list"]({ threadId });
    if (!beforeRead.ok) throw new Error(`Home read state failed: ${beforeRead.error.code}`);
    expect(beforeRead.data.readState.unreadSequence).not.toBeNull();
    const latest = around.data.messages.at(-1);
    if (!latest) throw new Error("Home anchored read returned no messages");
    const marked = await stack.api["commands.dispatch"]({
      idempotencyKey: `home-mark-read-${randomUUID()}`,
      threadId,
      throughSequence: latest.sequence,
      type: "thread.read.mark",
    });
    if (!marked.ok || marked.data.type !== "thread.read.mark")
      throw new Error("Home mark read failed");
    if (marked.data.state.readSequence === null) throw new Error("Home read marker was not saved");
    expect(BigInt(marked.data.state.readSequence)).toBeGreaterThanOrEqual(BigInt(latest.sequence));
    const afterRead = await stack.api["thread.events.list"]({ threadId });
    if (!afterRead.ok) throw new Error(`Home read state failed: ${afterRead.error.code}`);
    expect(afterRead.data.readState.readSequence).toBe(marked.data.state.readSequence);
    const muted = await stack.api["commands.dispatch"]({
      idempotencyKey: `home-mute-${randomUUID()}`,
      muted: true,
      type: "workspace.notifications.update",
      workspaceId,
    });
    if (!muted.ok || muted.data.type !== "workspace.notifications.update")
      throw new Error("Home mute failed");
    const muteState = await stack.api["bootstrap.get"]({});
    if (!muteState.ok)
      throw new Error(`Home notification settings failed: ${muteState.error.code}`);
    expect(muteState.data.notificationPreferences).toEqual(
      expect.arrayContaining([expect.objectContaining({ workspaceId, muted: true })]),
    );
    const capture = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: { input?: unknown } });
    const starts = capture.filter((entry) => entry.method === "turn/start");
    expect(starts).toHaveLength(4);
    const historicalContext = starts.map((entry) =>
      JSON.stringify(entry.params?.input).includes("[Opensteer earlier conversation]"),
    );
    expect(historicalContext).toEqual([false, true, false, true]);
    expect(JSON.stringify(starts[1]?.params?.input)).toContain(
      "Keep this conversation open across a route change.",
    );
    expect(JSON.stringify(starts[3]?.params?.input)).toContain(
      "Continue in this same visible conversation.",
    );

    const evidenceRoot =
      process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
      join(tmpdir(), "opensteer-home-acceptance", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "native-continuation.json"),
      JSON.stringify(
        {
          threadId,
          sessions: (await allSessions()).map((session) => ({
            id: session.id,
            active: session.active,
            harnessInstanceId: session.harnessInstanceId,
            hasNativeReference: session.providerSessionReference !== null,
          })),
          runs: runs.map((run) => ({
            id: run.id,
            providerSessionId: run.providerSessionId,
            harnessInstanceId: run.harnessInstanceId,
            runOrdinal: run.runOrdinal,
            status: run.status,
          })),
          freshContextOnTurns: historicalContext,
          lateEventOutcome,
          searchReference: oldestRequest.id,
          readSequence: marked.data.state.readSequence,
          mutedWorkspaceId: workspaceId,
        },
        null,
        2,
      ),
    );
    console.info(`Home native continuation evidence: ${evidenceRoot}`);

    async function selectedSession() {
      const selected = await stack!.host.store.database
        .selectFrom("providerSessions")
        .selectAll()
        .where("threadId", "=", threadId)
        .where("active", "=", true)
        .execute();
      expect(selected).toHaveLength(1);
      return selected[0]!;
    }

    async function allSessions() {
      return stack!.host.store.database
        .selectFrom("providerSessions")
        .selectAll()
        .where("threadId", "=", threadId)
        .orderBy("createdAt", "asc")
        .execute();
    }
  }, 90_000);

  it("freezes only the newest context that fits a small live model route", async () => {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-home-budget-"));
    const capturePath = join(captureRoot, "codex.jsonl");
    stack = await startVerticalStack({
      additionalHarnessInstances: [
        { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
      ],
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(capturePath, "vertical", true),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
    const nextHarness = stack.additionalHarnessInstanceIds[0];
    if (!nextHarness) throw new Error("The second account did not connect");
    const workspaceId = stack.mainWorkspaceId;
    const threadId = await stack.createThread({
      home: true,
      modelSelection,
      title: "Chat",
      workspaceId,
    });
    const first = await stack.sendMessage({
      text: `Old oversized request: ${"X".repeat(8_000)}`,
      threadId,
      workspaceId,
    });
    expect(first.assistantText).toBe("Completed by Codex.");
    const previous = await stack.host.store.database
      .selectFrom("messages")
      .select(["id", "kind"])
      .where("threadId", "=", threadId)
      .orderBy("sequence", "asc")
      .execute();
    expect(previous.map((message) => message.kind)).toEqual(["input", "assistant"]);
    const originalSession = await stack.host.store.database
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", threadId)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    await stack.updateThreadExecution(threadId, modelSelection, {
      expectedProviderSessionId: originalSession.id,
      harnessInstanceId: nextHarness,
    });
    const continued = await stack.sendMessage({
      text: "Continue on the small route.",
      threadId,
      workspaceId,
    });
    expect(continued.assistantText).toBe("Completed by Codex.");
    const frozen = await stack.host.store.database
      .selectFrom("runs")
      .select("initialContext")
      .where("id", "=", continued.runId)
      .executeTakeFirstOrThrow();
    expect(frozen.initialContext).toMatchObject({
      finalized: true,
      omittedCount: 1,
      messageIds: [previous[1]?.id],
    });
    const starts = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: { input?: unknown } })
      .filter((entry) => entry.method === "turn/start");
    expect(starts).toHaveLength(2);
    const secondInput = JSON.stringify(starts[1]?.params?.input);
    expect(secondInput).toContain("[Opensteer earlier conversation]");
    expect(secondInput).toContain("Completed by Codex.");
    expect(secondInput).not.toContain("Old oversized request:");

    const evidenceRoot =
      process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
      join(tmpdir(), "opensteer-home-acceptance", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "small-route-history.json"),
      JSON.stringify(
        {
          threadId,
          firstRunId: first.runId,
          continuationRunId: continued.runId,
          frozenContext: frozen.initialContext,
          priorMessageIds: previous.map((message) => message.id),
          deliveredHistoricalContext: secondInput,
        },
        null,
        2,
      ),
    );
    console.info(`Home small-route budget evidence: ${evidenceRoot}`);
  }, 90_000);

  it("stops Chat's reply without pausing Chat and answers the next message on the switched engine", async () => {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-home-stop-"));
    const capturePath = join(captureRoot, "codex.jsonl");
    stack = await startVerticalStack({
      additionalHarnessInstances: [
        { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
      ],
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(capturePath, "interrupt"),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
    const secondAccountId = stack.additionalHarnessInstanceIds[0];
    if (!secondAccountId) throw new Error("The second account did not connect");
    const workspaceId = stack.mainWorkspaceId;
    const threadId = await stack.createThread({
      home: true,
      modelSelection,
      title: "Chat",
      workspaceId,
    });
    const selected = await stack.host.store.database
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", threadId)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const stopped = await stack.sendMessage({
      text: "Start a response that I will stop.",
      threadId,
      workspaceId,
      onQueued: async (runId) => {
        await waitForRunningRun(stack!, runId);
        await expect(
          stack!.updateThreadExecution(threadId, modelSelection, {
            expectedProviderSessionId: selected.id,
            harnessInstanceId: secondAccountId,
          }),
        ).rejects.toThrow();
        await stack!.interruptRun(threadId, runId);
      },
    });
    expect(stopped.events.some((event) => event.type === "run.interrupted")).toBe(true);
    const afterStop = await stack.host.store.database
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    // A conversation stays open: there is nothing to resume.
    expect(afterStop.inputQueuePaused).toBe(false);
    await stack.updateThreadExecution(threadId, modelSelection, {
      expectedProviderSessionId: selected.id,
      harnessInstanceId: secondAccountId,
    });
    const next = await stack.queueMessage({ text: "Answer this on the other account.", threadId });
    if (!next.runId) throw new Error("The next message did not start a reply");
    await waitForRunningRun(stack, next.runId);
    const nextRun = await stack.host.store.database
      .selectFrom("runs")
      .select(["harnessInstanceId", "seedInputId"])
      .where("id", "=", next.runId)
      .executeTakeFirstOrThrow();
    expect(nextRun).toEqual({ harnessInstanceId: secondAccountId, seedInputId: next.messageId });
    await stack.interruptRun(threadId, next.runId);

    const evidenceRoot =
      process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
      join(tmpdir(), "opensteer-home-acceptance", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "chat-stop-switch.json"),
      JSON.stringify(
        {
          threadId,
          stoppedRunId: stopped.runId,
          queuePausedAfterStop: afterStop.inputQueuePaused,
          nextMessageId: next.messageId,
          nextRunId: next.runId,
          nextRunAccount: nextRun.harnessInstanceId,
        },
        null,
        2,
      ),
    );
    console.info(`Chat stop and switch evidence: ${evidenceRoot}`);
  }, 90_000);

  it("blocks a busy switch, then retains a work Thread's paused input through an idle switch", async () => {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-home-pause-"));
    const capturePath = join(captureRoot, "codex.jsonl");
    stack = await startVerticalStack({
      additionalHarnessInstances: [
        { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
      ],
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(capturePath, "interrupt"),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
    const secondAccountId = stack.additionalHarnessInstanceIds[0];
    if (!secondAccountId) throw new Error("The second account did not connect");
    const workspaceId = stack.mainWorkspaceId;
    // A work Thread's Stop pauses its queue; Chat's does not (see above).
    const threadId = await stack.createThread({
      modelSelection,
      title: "Task",
      workspaceId,
    });
    const selected = await stack.host.store.database
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", threadId)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const owner = await stack.host.store.database
      .selectFrom("workspaceMemberships")
      .select("userId")
      .where("workspaceId", "=", workspaceId)
      .where("role", "=", "owner")
      .executeTakeFirstOrThrow();
    let firstReport: Awaited<ReturnType<typeof stack.host.store.enqueueThreadInput>> | undefined;
    let secondReport: Awaited<ReturnType<typeof stack.host.store.enqueueThreadInput>> | undefined;
    const interrupted = await stack.sendMessage({
      text: "Start a response that I will stop.",
      threadId,
      workspaceId,
      onQueued: async (runId) => {
        await waitForRunningRun(stack!, runId);
        firstReport = await stack!.host.store.enqueueThreadInput({
          content: [{ text: "First specialist report", type: "text" }],
          idempotencyKey: `home-report-first-${randomUUID()}`,
          policy: "report",
          requestedBy: owner.userId,
          source: { kind: "agent", runId },
          threadId,
        });
        secondReport = await stack!.host.store.enqueueThreadInput({
          content: [{ text: "Second specialist report", type: "text" }],
          idempotencyKey: `home-report-second-${randomUUID()}`,
          policy: "report",
          requestedBy: owner.userId,
          source: { kind: "agent", runId },
          threadId,
        });
        await expect(
          stack!.updateThreadExecution(threadId, modelSelection, {
            expectedProviderSessionId: selected.id,
            harnessInstanceId: secondAccountId,
          }),
        ).rejects.toThrow();
        await stack!.interruptRun(threadId, runId);
      },
    });
    expect(interrupted.events.some((event) => event.type === "run.interrupted")).toBe(true);
    if (!firstReport || !secondReport) throw new Error("Specialist reports were not published");
    const publishedSecondReport = secondReport;
    const reportsReadState = await stack.api["thread.events.list"]({ threadId });
    if (!reportsReadState.ok) throw new Error("Report read state failed");
    expect(reportsReadState.data.readState.unreadSequence).toBe(secondReport.message.sequence);
    // A report is context for Chat's next turn, never a message to the person,
    // and a Run the person stopped is not a failure: read the whole log and
    // nothing in this Thread alerts.
    const notificationStore = new NotificationStore(stack.host.store.database);
    const notificationEvents = await stack.host.store.database
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("threadId", "=", threadId)
      .execute();
    for (const row of notificationEvents) {
      const event = AgentEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
      await expect(notificationStore.decide(event)).resolves.toEqual([]);
    }
    const readFirstReport = await stack.api["commands.dispatch"]({
      idempotencyKey: `home-report-read-${randomUUID()}`,
      threadId,
      throughSequence: firstReport.message.sequence,
      type: "thread.read.mark",
    });
    if (!readFirstReport.ok || readFirstReport.data.type !== "thread.read.mark")
      throw new Error("Report read failed");
    expect(readFirstReport.data.state.unreadSequence).toBe(secondReport.message.sequence);
    const muteReports = await stack.api["commands.dispatch"]({
      idempotencyKey: `home-report-mute-${randomUUID()}`,
      muted: true,
      type: "workspace.notifications.update",
      workspaceId,
    });
    if (!muteReports.ok || muteReports.data.type !== "workspace.notifications.update")
      throw new Error("Report mute failed");
    const stillPublished = await stack.api["thread.messages.list"]({
      threadId,
      query: "Second specialist report",
    });
    if (!stillPublished.ok)
      throw new Error(`Muted report history failed: ${stillPublished.error.code}`);
    expect(
      stillPublished.data.messages.some(
        (message) => message.id === publishedSecondReport.message.id,
      ),
    ).toBe(true);
    const pending = await stack.queueMessage({
      text: "Keep this input paused while changing AI.",
      threadId,
    });
    expect(pending.runId).toBeNull();
    const before = await stack.host.store.database
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    expect(before.inputQueuePaused).toBe(true);

    await stack.updateThreadExecution(threadId, modelSelection, {
      expectedProviderSessionId: selected.id,
      harnessInstanceId: secondAccountId,
    });
    const after = await stack.host.store.database
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    expect(after.inputQueuePaused).toBe(true);
    const queued = await stack.host.store.database
      .selectFrom("threadInputs")
      .select(["state", "runId"])
      .where("messageId", "=", pending.messageId)
      .executeTakeFirstOrThrow();
    expect(queued).toMatchObject({ state: "pending", runId: null });
    const hidden = await stack.api["thread.messages.list"]({
      threadId,
      query: "Keep this input paused",
    });
    if (!hidden.ok) throw new Error(`Pending input search failed: ${hidden.error.code}`);
    expect(hidden.data.messages).toHaveLength(0);
    const pendingReadState = await stack.api["thread.events.list"]({ threadId });
    if (!pendingReadState.ok) throw new Error("Pending input read state failed");
    expect(pendingReadState.data.readState.unreadSequence).toBe(secondReport.message.sequence);
    const forbiddenQuote = await stack.api["commands.dispatch"]({
      content: [{ text: "Quote a pending input", type: "text" }],
      idempotencyKey: `pending-quote-${randomUUID()}`,
      quotedMessageId: pending.messageId,
      threadId,
      type: "thread.sendMessage",
    });
    expect(forbiddenQuote.ok).toBe(false);
    const firstInput = (await stack.host.store.workspaceSnapshot(workspaceId)).messages.find(
      (message) =>
        message.threadId === threadId &&
        message.kind === "input" &&
        message.content.some(
          (part) => part.type === "text" && part.text.includes("Start a response"),
        ),
    );
    if (!firstInput) throw new Error("Completed input was not retained for quote");
    const quoted = await stack.api["commands.dispatch"]({
      content: [{ text: "Refer to the stopped request", type: "text" }],
      idempotencyKey: `visible-quote-${randomUUID()}`,
      quotedMessageId: firstInput.id,
      threadId,
      type: "thread.sendMessage",
    });
    if (!quoted.ok || quoted.data.type !== "thread.sendMessage")
      throw new Error("Visible quote failed");
    expect(quoted.data.run).toBeNull();
    expect(quoted.data.message.quote).toMatchObject({ messageId: firstInput.id, threadId });
    const ownInputReadState = await stack.api["thread.events.list"]({ threadId });
    if (!ownInputReadState.ok) throw new Error("Own input read state failed");
    expect(ownInputReadState.data.readState.unreadSequence).toBe(secondReport.message.sequence);
    const quoteRow = await stack.host.store.database
      .selectFrom("messages")
      .select("quote")
      .where("id", "=", quoted.data.message.id)
      .executeTakeFirstOrThrow();
    expect(quoteRow.quote).toMatchObject({ messageId: firstInput.id, threadId });
    const sessions = await stack.host.store.database
      .selectFrom("providerSessions")
      .select(["id", "active"])
      .where("threadId", "=", threadId)
      .execute();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.active)?.id).not.toBe(selected.id);
    const runs = await stack.host.store.database
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", threadId)
      .execute();
    expect(runs).toEqual([{ id: interrupted.runId }]);

    const evidenceRoot =
      process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
      join(tmpdir(), "opensteer-home-acceptance", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "paused-switch.json"),
      JSON.stringify(
        {
          threadId,
          interruptedRunId: interrupted.runId,
          pendingMessageId: pending.messageId,
          quotedMessageId: quoted.data.message.id,
          quoteSourceMessageId: firstInput.id,
          reportMessageIds: [firstReport.message.id, secondReport.message.id],
          queuePausedBefore: before.inputQueuePaused,
          queuePausedAfter: after.inputQueuePaused,
          pendingRunId: queued.runId,
          selectedSessionId: sessions.find((session) => session.active)?.id,
        },
        null,
        2,
      ),
    );
    console.info(`Home paused switch evidence: ${evidenceRoot}`);
  }, 90_000);

  it("accepts a specialist's Home report through agent control while Home changes accounts", async () => {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-home-specialist-"));
    stack = await startVerticalStack({
      additionalHarnessInstances: [
        { config: {}, driverKind: "codex", sourceId: "openai", stateKind: "isolated" },
      ],
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(join(captureRoot, "codex.jsonl"), "vertical-delayed"),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
    const secondAccountId = stack.additionalHarnessInstanceIds[0];
    if (!secondAccountId) throw new Error("The second account did not connect");
    const homeId = await stack.createThread({
      home: true,
      modelSelection,
      title: "Chat",
      workspaceId: stack.mainWorkspaceId,
    });
    const originalSelection = await stack.host.store.database
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", homeId)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const specialistWorkspace = await stack.createWorkspace("Specialist reports");
    const specialistId = await stack.createThread({
      modelSelection,
      title: "Research task",
      workspaceId: specialistWorkspace.id,
    });
    const ordinaryMainId = await stack.createThread({
      idempotencyKey: `ordinary-main-${randomUUID()}`,
      modelSelection,
      title: "Ordinary Main task",
      workspaceId: stack.mainWorkspaceId,
    });
    const [home, ordinaryMain, specialistRow] = await Promise.all([
      stack.host.store.database
        .selectFrom("threads")
        .select(["role", "capabilityProfileId"])
        .where("id", "=", homeId)
        .executeTakeFirstOrThrow(),
      stack.host.store.database
        .selectFrom("threads")
        .select(["role", "capabilityProfileId"])
        .where("id", "=", ordinaryMainId)
        .executeTakeFirstOrThrow(),
      stack.host.store.database
        .selectFrom("threads")
        .select(["role", "capabilityProfileId"])
        .where("id", "=", specialistId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(home.role).toBe("conversation");
    expect(ordinaryMain.role).toBe("work");
    expect(specialistRow.role).toBe("work");
    expect(home.capabilityProfileId).toBe("main");
    expect(ordinaryMain.capabilityProfileId).toBe("main");

    const foreignUserId = await stack.host.store.createUser("Other owner");
    const foreignPlacement = await createForeignPlacement(stack, foreignUserId);
    const foreignWorkspace = await stack.host.store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `foreign-home-${randomUUID()}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: foreignUserId,
      idempotencyKey: `foreign-home-workspace-${randomUUID()}`,
      name: "Other Main",
      status: "ready",
    });
    const foreignHome = await stack.host.store.createThread({
      createdBy: foreignUserId,
      environmentId: foreignPlacement.environmentId,
      harnessInstanceId: foreignPlacement.harnessInstanceId,
      home: true,
      idempotencyKey: `foreign-home-thread-${randomUUID()}`,
      modelSelection,
      title: "Chat",
      workspaceId: foreignWorkspace.id,
    });

    let claims: AgentControlRunScope | null = null;
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected agent-control dependency");
    };
    const service = new AgentControlService({
      browserSources: { agentSignIn: unexpected },
      machineFullDiskAccess: { request: unexpected },
      browser: {
        createProfile: unexpected,
        profileSiteData: unexpected,
        closeAgentSession: unexpected,
        listAgentSessions: unexpected,
        listGrantedProfiles: unexpected,
        openAgentSession: unexpected,
        requestAccess: unexpected,
        requestSaveProfile: unexpected,
      },
      canRunHarness: () => true,
      commands: new CommandService({
        admission: new KeyedAdmissionQueue({
          maxInFlight: 4,
          maxQueuedBytes: 4_000_000,
          maxQueuedCommands: 64,
        }),
        onExecutionQueued: vi.fn(),
        onWorkspaceEvent: vi.fn(),
        store: stack.host.store,
      }),
      defaultWorkspaceBacking: "portablefs",
      environmentWorkspaceBackings: () => ["portablefs"],
      isEnvironmentConnected: () => true,
      onWorkspaceEvent: vi.fn(),
      store: stack.host.store,
      tokens: {
        authenticate: async () => {
          if (!claims) throw new Error("Child Run has no claim");
          return claims;
        },
      } as unknown as AgentControlTokenService,
      workspaceMounts: { mount: unexpected },
      workspaces: { create: unexpected },
    });
    let reportMessageId: string | undefined;
    let selectedAfterSwitch: string | undefined;
    const specialist = await stack.sendMessage({
      text: "Research the migration while Home changes accounts.",
      threadId: specialistId,
      workspaceId: specialistWorkspace.id,
      onQueued: async (runId) => {
        await waitForRunningRun(stack!, runId);
        const run = await stack!.host.store.database
          .selectFrom("runs")
          .select(["membershipGeneration", "requestedBy"])
          .where("id", "=", runId)
          .executeTakeFirstOrThrow();
        const source = await stack!.host.store.getThreadForOwner(specialistId, run.requestedBy);
        const session = await stack!.host.store.database
          .selectFrom("providerSessions")
          .select(["bindingGeneration", "runnerBootId", "runnerId"])
          .where("threadId", "=", specialistId)
          .where("active", "=", true)
          .executeTakeFirstOrThrow();
        if (!source || !session.runnerId || !session.runnerBootId)
          throw new Error("Specialist binding is incomplete");
        claims = {
          aud: "opensteer-agent-control",
          bindingGeneration: session.bindingGeneration,
          capabilityProfileId: source.capabilityProfileId,
          environmentId: stack!.environmentId,
          exp: Math.floor(Date.now() / 1_000) + 60,
          iat: Math.floor(Date.now() / 1_000),
          iss: "opensteer-host",
          jti: randomUUID(),
          membershipGeneration: Number(run.membershipGeneration),
          requestedBy: run.requestedBy,
          runId,
          runnerBootId: session.runnerBootId,
          runnerId: session.runnerId,
          threadId: specialistId,
          workspaceId: specialistWorkspace.id,
        };
        await stack!.updateThreadExecution(homeId, modelSelection, {
          expectedProviderSessionId: originalSelection.id,
          harnessInstanceId: secondAccountId,
        });
        selectedAfterSwitch = (
          await stack!.host.store.database
            .selectFrom("providerSessions")
            .select("id")
            .where("threadId", "=", homeId)
            .where("active", "=", true)
            .executeTakeFirstOrThrow()
        ).id;
        await expect(
          service.handle("child-token", {
            content: [{ text: "Wrong owner's Home", type: "text" }],
            delivery: "report",
            requestId: randomUUID(),
            threadId: foreignHome.thread.id,
            type: "thread.message",
          }),
        ).rejects.toMatchObject({ code: "forbidden" });
        const sent = await service.handle("child-token", {
          content: [{ text: "Specialist findings for Home", type: "text" }],
          delivery: "report",
          requestId: randomUUID(),
          threadId: "home",
          type: "thread.message",
        });
        if (sent.type !== "thread.message.result")
          throw new Error("Agent-control report response mismatch");
        expect(sent.result.thread.id).toBe(homeId);
        expect(sent.result.run).toBeNull();
        reportMessageId = sent.result.message.id;
      },
    });
    expect(specialist.assistantText).toBe("Completed by Codex.");
    if (!reportMessageId || !selectedAfterSwitch)
      throw new Error("Specialist did not report after switching Home");
    expect(selectedAfterSwitch).not.toBe(originalSelection.id);
    const childStatus = await stack.host.store.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", specialist.runId)
      .executeTakeFirstOrThrow();
    expect(childStatus.status).toBe("completed");
    expect(
      await stack.host.store.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", homeId)
        .execute(),
    ).toHaveLength(0);
    const report = await stack.api["thread.messages.list"]({
      threadId: homeId,
      query: "Specialist findings for Home",
    });
    if (!report.ok) throw new Error(`Specialist report lookup failed: ${report.error.code}`);
    expect(report.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reportMessageId,
          author: expect.objectContaining({
            kind: "agent",
            threadId: specialistId,
            workspaceId: specialistWorkspace.id,
          }),
        }),
      ]),
    );

    const evidenceRoot =
      process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
      join(tmpdir(), "opensteer-home-acceptance", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "specialist-report.json"),
      JSON.stringify(
        {
          homeId,
          specialistId,
          specialistRunId: specialist.runId,
          specialistRunStatus: childStatus.status,
          originalSelectionId: originalSelection.id,
          selectedAfterSwitch,
          reportMessageId,
          reportSourceWorkspaceId: specialistWorkspace.id,
          homeRunCount: 0,
          foreignHomeIdRefused: foreignHome.thread.id,
        },
        null,
        2,
      ),
    );
  }, 90_000);

  it("returns a task's final reply to Home as soon as the task's last Run ends", async () => {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-home-task-"));
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(join(captureRoot, "codex.jsonl"), "vertical-delayed"),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
      workspaceReconcileClock: new ManualClock(),
    });
    const homeId = await stack.createThread({
      home: true,
      modelSelection,
      title: "Chat",
      workspaceId: stack.mainWorkspaceId,
    });
    let claims: AgentControlRunScope | null = null;
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected agent-control dependency");
    };
    // The Host's own dispatcher, Runner and event reactions run the task; this
    // service only stands in for the MCP endpoint Home's engine would call.
    const service = new AgentControlService({
      browserSources: { agentSignIn: unexpected },
      machineFullDiskAccess: { request: unexpected },
      browser: {
        createProfile: unexpected,
        profileSiteData: unexpected,
        closeAgentSession: unexpected,
        listAgentSessions: unexpected,
        listGrantedProfiles: unexpected,
        openAgentSession: unexpected,
        requestAccess: unexpected,
        requestSaveProfile: unexpected,
      },
      canRunHarness: () => true,
      commands: new CommandService({
        admission: new KeyedAdmissionQueue({
          maxInFlight: 4,
          maxQueuedBytes: 4_000_000,
          maxQueuedCommands: 64,
        }),
        onExecutionQueued: vi.fn(),
        onWorkspaceEvent: vi.fn(),
        store: stack.host.store,
      }),
      defaultWorkspaceBacking: "portablefs",
      environmentWorkspaceBackings: () => ["portablefs"],
      isEnvironmentConnected: () => true,
      onWorkspaceEvent: vi.fn(),
      store: stack.host.store,
      tokens: {
        authenticate: async () => {
          if (!claims) throw new Error("Home Run has no claim");
          return claims;
        },
      } as unknown as AgentControlTokenService,
      workspaceMounts: { mount: unexpected },
      workspaces: { create: unexpected },
    });
    // The periodic reconcile also delivers pending returns. What it delivers
    // is recorded, so the test can tell that path from the immediate one.
    const reconciled: string[] = [];
    const store = stack.host.store;
    const drainReturn = store.drainAssignmentReturn.bind(store);
    const returnedByReaction = Promise.withResolvers<AssignmentId>();
    vi.spyOn(store, "drainAssignmentReturn").mockImplementation(async (id) => {
      const events = await drainReturn(id);
      returnedByReaction.resolve(id);
      return events;
    });
    const drainPending = store.drainPendingAssignmentReturns.bind(store);
    vi.spyOn(store, "drainPendingAssignmentReturns").mockImplementation(async (limit) => {
      const drained = await drainPending(limit);
      for (const event of drained.events) {
        if (event.type === "assignment.updated") reconciled.push(event.data.assignment.id);
      }
      return drained;
    });
    let delegated: { readonly assignmentId: AssignmentId; readonly threadId: ThreadId } | undefined;
    const homeTurn = await stack.sendMessage({
      text: "Compare three mattresses for me as a task.",
      threadId: homeId,
      workspaceId: stack.mainWorkspaceId,
      onQueued: async (runId) => {
        await waitForRunningRun(stack!, runId);
        const run = await stack!.host.store.database
          .selectFrom("runs")
          .select(["membershipGeneration", "requestedBy"])
          .where("id", "=", runId)
          .executeTakeFirstOrThrow();
        const session = await stack!.host.store.database
          .selectFrom("providerSessions")
          .select(["bindingGeneration", "runnerBootId", "runnerId"])
          .where("threadId", "=", homeId)
          .where("active", "=", true)
          .executeTakeFirstOrThrow();
        if (!session.runnerId || !session.runnerBootId)
          throw new Error("Home binding is incomplete");
        claims = {
          aud: "opensteer-agent-control",
          bindingGeneration: session.bindingGeneration,
          capabilityProfileId: "main",
          environmentId: stack!.environmentId,
          exp: Math.floor(Date.now() / 1_000) + 60,
          iat: Math.floor(Date.now() / 1_000),
          iss: "opensteer-host",
          jti: randomUUID(),
          membershipGeneration: Number(run.membershipGeneration),
          requestedBy: run.requestedBy,
          runId,
          runnerBootId: session.runnerBootId,
          runnerId: session.runnerId,
          threadId: homeId,
          workspaceId: stack!.mainWorkspaceId,
        };
        const response = await service.handle("home-token", {
          requestId: randomUUID(),
          task: "Compare three mattresses and recommend one.",
          title: "Mattress comparison",
          type: "thread.delegate",
          workspaceId: stack!.mainWorkspaceId,
        });
        if (response.type !== "thread.delegate.result") throw new Error("Delegation failed");
        delegated = {
          assignmentId: response.result.assignmentId,
          threadId: response.result.thread.id,
        };
      },
    });
    expect(homeTurn.assistantText).toBe("Completed by Codex.");
    if (!delegated) throw new Error("Home did not start the task");
    const task = delegated;

    // No tool finishes the task: its Run ends, and that ends the task.
    expect(await returnedByReaction.promise).toBe(task.assignmentId);
    const returned = await stack.host.store.database
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", task.assignmentId)
      .executeTakeFirstOrThrow();
    expect(returned.resultStatus).toBe("delivered");
    const deliveredAt = returned.completedAt?.getTime() ?? Number.NaN;
    const finishedAt = returned.finishedAt?.getTime() ?? Number.NaN;
    expect(returned).toMatchObject({
      origin: "run",
      resultText: "Completed by Codex.",
      status: "completed",
    });
    // The periodic reconcile cannot run until its clock advances; the
    // Host's reaction must deliver the result on its own.
    expect(reconciled).not.toContain(task.assignmentId);
    const taskRun = await stack.host.store.database
      .selectFrom("runs")
      .select(["id", "status"])
      .where("id", "=", returned.resultRunId!)
      .executeTakeFirstOrThrow();
    expect(taskRun).toEqual({ id: returned.resultRunId, status: "completed" });

    // Home hears the result as its next piece of work and answers from it.
    const homeFollowUp = await waitFor(async () => {
      const runs = await stack!.host.store.database
        .selectFrom("runs")
        .select(["id", "seedInputId", "status"])
        .where("threadId", "=", homeId)
        .orderBy("runOrdinal", "asc")
        .execute();
      return runs[1]?.status === "completed" ? runs : undefined;
    }, 20_000);
    expect(homeFollowUp).toHaveLength(2);
    expect(homeFollowUp[1]?.seedInputId).toBe(returned.resultMessageId);
    const returnMessage = await stack.host.store.database
      .selectFrom("messages")
      .select(["author", "content", "kind"])
      .where("id", "=", returned.resultMessageId!)
      .executeTakeFirstOrThrow();
    expect(returnMessage).toMatchObject({
      author: { cause: "assignment-result", kind: "platform", referenceId: task.assignmentId },
      kind: "continuation",
    });
    expect(JSON.stringify(returnMessage.content)).toContain(
      `Task completed: Mattress comparison\\nTask Thread: ${task.threadId} · Assignment: ${task.assignmentId}\\n\\nCompleted by Codex.`,
    );

    const evidenceRoot =
      process.env.OPENSTEER_HOME_ACCEPTANCE_OUTPUT ??
      join(tmpdir(), "opensteer-home-acceptance", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "home-task-return.json"),
      JSON.stringify(
        {
          assignmentId: task.assignmentId,
          deliveredAfterFinishMs: deliveredAt - finishedAt,
          deliveredByPeriodicReconcile: reconciled.includes(task.assignmentId),
          homeRunIds: homeFollowUp.map(({ id }) => id),
          resultMessageId: returned.resultMessageId,
          resultRunId: returned.resultRunId,
          resultText: returned.resultText,
          taskThreadId: task.threadId,
        },
        null,
        2,
      ),
    );
  }, 90_000);
});

async function waitFor<Value>(
  probe: () => Promise<Value | undefined>,
  timeoutMs: number,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms`);
}

async function createForeignPlacement(stack: VerticalStack, foreignUserId: UserId) {
  const environmentId = await stack.host.store.createEnvironment({
    kind: "managed",
    name: "Other owner's work location",
  });
  const runnerId = createId("runner");
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const descriptor: RunnerDescriptor = {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: [...ThreadAccessModeSchema.options],
            driverKind: HarnessIdSchema.parse("codex"),
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "OpenAI",
                quota: "none",
                sourceId: "openai",
                stateKinds: ["isolated"],
              },
            ],
          },
        ],
        localStorage: null,
        maxConcurrentRuns: 1,
        providerStateModes: ["isolated"],
        workspaceBackings: ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: "Other owner's runner",
    runnerId,
    runnerKind: "managed",
    runtimeVersion: "test",
  };
  const suffix = randomUUID();
  const enrollmentTokenHash = `sha256:${createHash("sha256").update(suffix).digest("base64url")}`;
  await stack.host.store.createRunnerEnrollment({
    allowedModules: ["agents"],
    createdBy: foreignUserId,
    expiresAt: new Date(Date.now() + 60_000),
    id: `ren_${randomUUID()}`,
    idempotencyKey: `foreign-runner-${suffix}`,
    name: descriptor.name,
    requestFingerprint: `sha256:foreign-runner-${suffix}`,
    runnerKind: "managed",
    tokenHash: enrollmentTokenHash,
  });
  await stack.host.store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
    publicKeyPem,
  });
  const harness = await stack.host.store.createHarnessInstance({
    config: {},
    driverKind: HarnessIdSchema.parse("codex"),
    environmentId,
    name: "Other owner's Codex",
    sourceId: "openai",
    stateKind: "isolated",
  });
  return { environmentId, harnessInstanceId: harness.id };
}

async function waitForRunningRun(stack: VerticalStack, runId: RunId): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await stack.host.store.database
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    if (run.status === "running") return;
    if (["completed", "failed", "interrupted"].includes(run.status)) {
      const detail = await stack.host.store.database
        .selectFrom("runs")
        .select("failure")
        .where("id", "=", runId)
        .executeTakeFirst();
      const command = await stack.host.store.database
        .selectFrom("commands")
        .select(["status", "lastError"])
        .where("runId", "=", runId)
        .executeTakeFirst();
      throw new Error(
        `Run terminated before switch race: ${run.status} ${JSON.stringify(detail)} ${JSON.stringify(command)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Run did not reach running state");
}
