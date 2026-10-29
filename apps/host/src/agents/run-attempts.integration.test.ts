import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { foldTranscriptEvent, type TranscriptEntry } from "@opensteer/client/host";
import {
  AgentEventSchema,
  ModelSelectionSchema,
  type RunAttempt,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { HarnessRegistry, nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { OpencodeHarnessDriver } from "@opensteer/harness-opencode";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * OpenCode has no way to take a message mid-turn, so a steer restarts the Run:
 * the attempt it was steering is interrupted, and a new attempt in the same
 * Run and conversation starts with the message. Each journey drives the real
 * Host, Runner and OpenCode driver against a fake `opencode serve` whose held
 * turns work until aborted and whose other turns answer with exactly what they
 * were asked, so the restarted attempt's input is visible in its reply.
 *
 * The artifact records each journey's attempts as `run.attempts.list` serves
 * them, the Run's stored event types, and the steered messages' fates.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeOpencodeServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-opencode/src/test-fixtures/fake-opencode-server.mjs",
    import.meta.url,
  ),
);

interface Journey {
  readonly attempts: readonly RunAttempt[];
  readonly events: readonly string[];
  readonly inputs: readonly { readonly cancelReason: string | null; readonly state: string }[];
  readonly name: string;
  readonly reply: string | null;
  readonly runStatus: string;
  readonly runUsage: { readonly inputTokens: string | null; readonly outputTokens: string | null };
}

integration("Run attempts", () => {
  let stack: VerticalStack | undefined;
  const journeys: Journey[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  });

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-run-attempts-"));
    const artifact = join(directory, "attempts.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Run attempts artifact: ${artifact}`);
  });

  async function start(engineArguments: readonly string[] = []) {
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "opencode",
        sourceId: "opencode",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new OpencodeHarnessDriver({
            arguments: [fakeOpencodeServer, "--scenario=steer-restart", ...engineArguments],
            executable: process.execPath,
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const model = stack.catalog.models[0]!;
    const threadId = await stack.createThread({
      modelSelection: ModelSelectionSchema.parse({
        modelId: model.modelId,
        options: {},
        providerId: model.providerId,
      }),
      title: "Restart journey",
      workspaceId: stack.mainWorkspaceId,
    });
    return { active: stack, threadId };
  }

  /** A Run whose OpenCode turn is working and will not finish by itself. */
  async function heldRun(active: VerticalStack, threadId: ThreadId): Promise<RunId> {
    const queued = await active.queueMessage({ text: "[hold] Draft the launch plan", threadId });
    const runId = queued.runId;
    if (!runId) throw new Error("The message did not start a Run");
    await waitFor(
      async () => (await runRow(active, runId)).status === "running",
      "the held turn to run",
    );
    return runId;
  }

  async function settled(active: VerticalStack, runId: RunId) {
    await waitFor(
      async () =>
        ["completed", "failed", "interrupted"].includes((await runRow(active, runId)).status),
      "the Run to end",
    ).catch(async (error: unknown) => {
      const database = active.host.store.database;
      const state = {
        attempts: await database
          .selectFrom("runAttempts")
          .selectAll()
          .where("runId", "=", runId)
          .execute(),
        commands: await database
          .selectFrom("commands")
          .select(["type", "status", "attempts", "lastError", "createdAt"])
          .where("runId", "=", runId)
          .orderBy("createdAt", "asc")
          .execute(),
        events: await eventTypes(active, runId),
        run: await database
          .selectFrom("runs")
          .selectAll()
          .where("id", "=", runId)
          .executeTakeFirst(),
      };
      throw new Error(`${String(error)}\n${JSON.stringify(state, null, 1)}`);
    });
  }

  async function record(
    name: string,
    active: VerticalStack,
    runId: RunId,
    steered: readonly string[],
  ): Promise<Journey> {
    const listed = await active.api["run.attempts.list"]({ runId });
    if (!listed.ok) throw new Error(listed.error.message);
    const run = await runRow(active, runId);
    const inputs = await active.host.store.database
      .selectFrom("threadInputs")
      .select(["cancelReason", "state"])
      .where("messageId", "in", steered as never)
      .execute();
    const reply = await active.host.store.database
      .selectFrom("messages")
      .select("content")
      .where("runId", "=", runId)
      .where("kind", "=", "assistant")
      .orderBy("sequence", "desc")
      .executeTakeFirst();
    const journey: Journey = {
      attempts: listed.data.attempts as RunAttempt[],
      events: await eventTypes(active, runId),
      inputs,
      name,
      reply: reply ? textOf(reply.content) : null,
      runStatus: run.status,
      runUsage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens },
    };
    journeys.push(journey);
    return journey;
  }

  it(
    "restarts the turn with the steered message and keeps one Run",
    { timeout: 120_000 },
    async () => {
      // The new attempt outlives the interrupted one's stop grace, which
      // must end only that attempt's processes.
      const { active, threadId } = await start(["--answer-delay-ms=4500"]);
      const runId = await heldRun(active, threadId);

      const steer = await active.steerMessage({ text: "Use the blue palette", threadId });
      expect(steer.runId).toBe(runId);
      await settled(active, runId);

      const journey = await record("restart", active, runId, [steer.messageId]);
      expect(journey.runStatus).toBe("completed");
      // The new attempt was asked exactly the steered message.
      expect(answeredWith(journey.reply)).toEqual(["Use the blue palette"]);
      expect(journey.attempts).toMatchObject([
        { ordinal: 1, outcome: "interrupted", reason: "initial", status: "superseded" },
        { ordinal: 2, outcome: "completed", reason: "steer_restart", status: "current" },
      ]);
      for (const attempt of journey.attempts) {
        expect(attempt.dispatchedAt).not.toBeNull();
        expect(attempt.startedAt).not.toBeNull();
        expect(attempt.endedAt).not.toBeNull();
        expect(attempt.modelSelection?.providerId).toBe("opencode");
      }
      // The Run consumed what its attempts did, together.
      const stated = journey.attempts.flatMap((attempt) => (attempt.usage ? [attempt.usage] : []));
      expect(stated.length).toBeGreaterThan(0);
      expect(Number(journey.runUsage.inputTokens)).toBe(
        stated.reduce((sum, usage) => sum + usage.inputTokens, 0),
      );
      // The interrupted attempt's end is the restart, not the Run's.
      expect(journey.events).toContain("run.restarted");
      expect(journey.events).not.toContain("run.interrupted");
      expect(journey.events.filter((type) => type === "run.completed")).toHaveLength(1);
      expect(journey.inputs).toEqual([{ cancelReason: null, state: "delivered" }]);
      const runs = await active.host.store.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", threadId)
        .execute();
      expect(runs).toHaveLength(1);
      const grants = await active.host.store.database
        .selectFrom("grants")
        .select(["revokedReason"])
        .where("runId", "=", runId)
        .orderBy("createdAt", "asc")
        .execute();
      expect(grants[0]?.revokedReason).toBe("superseded");

      // A client folding the Thread's history sees one Run, on its second
      // attempt, that consumed what both attempts did.
      const entries = await foldedThread(active, threadId);
      const run = entries.find((entry) => entry.kind === "run" && entry.runId === runId);
      expect(run).toMatchObject({ attempt: 2, kind: "run", status: "completed" });
      if (run?.kind !== "run") throw new Error("The Run has no transcript entry");
      expect(run.usage?.inputTokens).toBe(Number(journey.runUsage.inputTokens));
    },
  );

  it(
    "gives a second steer to the restart that is already waiting",
    { timeout: 120_000 },
    async () => {
      const { active, threadId } = await start(["--abort-delay-ms=2000"]);
      const runId = await heldRun(active, threadId);

      const first = await active.steerMessage({ text: "Use the blue palette", threadId });
      // The interrupted attempt is still winding down: this joins the restart.
      const second = await active.steerMessage({ text: "and a serif font", threadId });
      expect(second.runId).toBe(runId);
      await settled(active, runId);

      const journey = await record("second steer joins", active, runId, [
        first.messageId,
        second.messageId,
      ]);
      expect(journey.runStatus).toBe("completed");
      expect(answeredWith(journey.reply)).toEqual(["Use the blue palette", "and a serif font"]);
      expect(journey.attempts.map((attempt) => [attempt.ordinal, attempt.outcome])).toEqual([
        [1, "interrupted"],
        [2, "completed"],
      ]);
      expect(journey.inputs).toEqual([
        { cancelReason: null, state: "delivered" },
        { cancelReason: null, state: "delivered" },
      ]);
    },
  );

  it(
    "ends a Run stopped while its restart waits, and never sends the message",
    { timeout: 120_000 },
    async () => {
      const { active, threadId } = await start(["--abort-delay-ms=2000"]);
      const runId = await heldRun(active, threadId);

      const steer = await active.steerMessage({ text: "Use the blue palette", threadId });
      await active.interruptRun(threadId, runId);
      await settled(active, runId);

      const journey = await record("stop during restart", active, runId, [steer.messageId]);
      expect(journey.runStatus).toBe("interrupted");
      expect(journey.attempts.map((attempt) => [attempt.ordinal, attempt.outcome])).toEqual([
        [1, "interrupted"],
        [2, "cancelled"],
      ]);
      expect(journey.attempts[1]?.dispatchedAt).toBeNull();
      expect(journey.events).not.toContain("run.restarted");
      expect(journey.inputs).toEqual([{ cancelReason: "steer-not-delivered", state: "cancelled" }]);
      // A stopped Run takes no further steer.
      await expect(active.steerMessage({ text: "one more thing", threadId })).rejects.toThrow();
    },
  );

  it(
    "sends a restart that a stopped Host had claimed but never sent",
    { timeout: 120_000 },
    async () => {
      const { active, threadId } = await start();
      const runId = await heldRun(active, threadId);

      // The Runner is out of reach, so the restart waits to be sent.
      active.network.block();
      const steer = await active.steerMessage({ text: "Use the blue palette", threadId });
      // The Host claims it, and stops before sending it.
      const claimed = await active.host.store.database
        .updateTable("commands")
        .set({ status: "dispatched" })
        .where("runId", "=", runId)
        .where("type", "=", "run.restart")
        .where("status", "=", "pending")
        .executeTakeFirst();
      expect(claimed.numUpdatedRows).toBe(1n);
      await active.restartHost();
      active.network.unblock();
      await settled(active, runId);

      const journey = await record("restart claimed before a Host restart", active, runId, [
        steer.messageId,
      ]);
      expect(journey.runStatus).toBe("completed");
      expect(answeredWith(journey.reply)).toEqual(["Use the blue palette"]);
      expect(journey.attempts.map((attempt) => [attempt.ordinal, attempt.outcome])).toEqual([
        [1, "interrupted"],
        [2, "completed"],
      ]);
    },
  );

  it(
    "keeps the first attempt's answer when it finished before the interrupt landed",
    { timeout: 120_000 },
    async () => {
      const { active, threadId } = await start(["--hold-ms=2500"]);
      const runId = await heldRun(active, threadId);

      // The Runner cannot hear the interrupt until its turn has finished.
      active.network.block();
      const steer = await active.steerMessage({ text: "Use the blue palette", threadId });
      await delay(4_000);
      active.network.unblock();
      await settled(active, runId);

      const journey = await record("finished before the interrupt", active, runId, [
        steer.messageId,
      ]);
      expect(journey.runStatus).toBe("completed");
      expect(journey.reply).toBe("Working on the original request.");
      expect(journey.attempts.map((attempt) => [attempt.ordinal, attempt.outcome])).toEqual([
        [1, "completed"],
        [2, "cancelled"],
      ]);
      expect(journey.events).not.toContain("run.restarted");
      expect(journey.inputs).toEqual([{ cancelReason: "steer-not-delivered", state: "cancelled" }]);
    },
  );
});

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function runRow(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .select(["inputTokens", "outputTokens", "status"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}

async function eventTypes(active: VerticalStack, runId: RunId): Promise<string[]> {
  const rows = await active.host.store.database
    .selectFrom("workspaceEvents")
    .select("type")
    .where("runId", "=", runId)
    .orderBy("sequence", "asc")
    .execute();
  return rows.map((row) => row.type);
}

async function foldedThread(active: VerticalStack, threadId: ThreadId) {
  const rows = await active.host.store.database
    .selectFrom("workspaceEvents")
    .selectAll()
    .where("threadId", "=", threadId)
    .orderBy("sequence", "asc")
    .execute();
  let entries: TranscriptEntry[] = [];
  for (const row of rows) {
    const event = AgentEventSchema.parse({
      createdAt: row.createdAt.toISOString(),
      data: row.data,
      environmentId: row.environmentId,
      eventId: row.eventId,
      runId: row.runId,
      sequence: String(row.sequence),
      threadId: row.threadId,
      type: row.type,
      workspaceId: row.workspaceId,
    });
    entries = foldTranscriptEvent(entries, event);
  }
  return entries;
}

/** The message bodies a fake turn was asked, in order, from its `Answered:` reply. */
function answeredWith(reply: string | null): string[] {
  if (!reply?.startsWith("Answered: ")) throw new Error(`Not an answer: ${reply}`);
  return (
    reply
      .slice("Answered: ".length)
      .split(" | ")
      // Every Run opens with its thread context; the answer is about the messages.
      .filter((input) => !input.startsWith("[Opensteer thread context]"))
      .map((input) => input.split("\n").at(-1) ?? "")
  );
}

function textOf(content: unknown): string {
  return (content as readonly { readonly text?: string; readonly type: string }[])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("");
}
