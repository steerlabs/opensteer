import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ModelSelectionSchema, type RunId, type ThreadId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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
  options: {
    effort: "low",
  },
  providerId: "openai",
});
interface Journey {
  readonly name: string;
  readonly [fact: string]: unknown;
}
integration("conversation delivery across Host and Runner", () => {
  let stack: VerticalStack | undefined;
  let captureRoot: string | undefined;
  const journeys: Journey[] = [];
  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    if (captureRoot)
      await rm(captureRoot, {
        force: true,
        recursive: true,
      });
    captureRoot = undefined;
  }, 60_000);
  afterAll(async () => {
    const directory =
      process.env.OPENSTEER_CONVERSATION_DELIVERY_OUTPUT ??
      join(tmpdir(), "opensteer-conversation-delivery", randomUUID());
    await mkdir(directory, {
      recursive: true,
    });
    const artifact = join(directory, "vertical-journeys.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Conversation delivery journeys: ${artifact}`);
  });
  async function codexStack() {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-conversation-codex-"));
    const capturePath = join(captureRoot, "codex.jsonl");
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new CodexHarnessDriver({
            launch: {
              arguments: [
                fakeCodexAppServer,
                "--scenario=conversation",
                `--capture=${capturePath}`,
                "--unique-threads",
                "--unique-turns",
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 30_000,
    });
    return stack;
  }

  it("keeps a work Thread's message in its queue until the person steers it", async () => {
    const active = await codexStack();
    const threadId = await active.createThread({
      modelSelection,
      title: "Task",
    });
    const first = await active.queueMessage({
      text: "[hold] Audit the deploy",
      threadId,
    });
    const runId = await running(active, first.runId);
    const queued = await active.queueMessage({
      text: "Also check the logs",
      threadId,
    });
    expect(queued.runId).toBeNull();
    const view = await active.api["thread.inputQueue.get"]({
      threadId,
    });
    if (!view.ok) throw new Error(view.error.message);
    expect(view.data.items.map(({ canSteer, message }) => [message.id, canSteer])).toEqual([
      [queued.messageId, true],
    ]);
    const steered = await active.api["commands.dispatch"]({
      expectedRunId: runId,
      idempotencyKey: `steer-${randomUUID()}`,
      messageId: queued.messageId,
      threadId,
      type: "thread.input.steer",
    });
    expect(steered.ok).toBe(true);
    await settled(active, runId);
    const journey = await record("work-queue-steer", active, threadId, runId);
    expect(journey.reply).toContain("Also check the logs");
    expect(journey.runs).toHaveLength(1);
  }, 90_000);

  async function record(
    name: string,
    active: VerticalStack,
    threadId: ThreadId,
    runId: RunId,
  ): Promise<
    Journey & {
      readonly reply: string | null;
    }
  > {
    const database = active.host.store.database;
    const [inputs, commands, runs, attempts, reply, replyInput] = await Promise.all([
      database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select([
          "messages.content",
          "messages.sequence",
          "threadInputs.cancelReason",
          "threadInputs.policy",
          "threadInputs.runId",
          "threadInputs.state",
        ])
        .where("threadInputs.threadId", "=", threadId)
        .orderBy("messages.sequence", "asc")
        .execute(),
      database
        .selectFrom("commands")
        .select(["type", "status", "idempotencyKey"])
        .where("threadId", "=", threadId)
        .orderBy("createdAt", "asc")
        .execute(),
      database
        .selectFrom("runs")
        .select(["id", "status", "runOrdinal"])
        .where("threadId", "=", threadId)
        .orderBy("runOrdinal", "asc")
        .execute(),
      database
        .selectFrom("runAttempts")
        .select(["ordinal", "reason", "outcome"])
        .where("runId", "=", runId)
        .orderBy("ordinal", "asc")
        .execute(),
      database
        .selectFrom("messages")
        .select("content")
        .where("runId", "=", runId)
        .where("kind", "=", "assistant")
        .orderBy("sequence", "desc")
        .executeTakeFirst(),
      database
        .selectFrom("messages")
        .select("content")
        .where("runId", "=", runId)
        .where("kind", "=", "input")
        .orderBy("sequence", "asc")
        .executeTakeFirst(),
    ]);
    const journey = {
      attempts,
      commands,
      inputs: inputs.map((row) => ({
        ...row,
        text: textOf(row.content),
        content: undefined,
      })),
      name,
      reply: reply ? textOf(reply.content) : null,
      replyInput: replyInput ? textOf(replyInput.content) : null,
      runStatus: (await runStatus(active, runId)).status,
      runs,
    };
    journeys.push(journey);
    return journey;
  }
});
async function running(active: VerticalStack, runId: RunId | null): Promise<RunId> {
  if (!runId) throw new Error("The message did not start a Run");
  await waitFor(async () => (await runStatus(active, runId)).status === "running", "the reply");
  return runId;
}
async function settled(active: VerticalStack, runId: RunId): Promise<void> {
  await waitFor(
    async () =>
      ["completed", "failed", "interrupted"].includes((await runStatus(active, runId)).status),
    "the Run to end",
    60_000,
  );
}
function runStatus(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(50);
  }
}
function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .flatMap((part: { readonly text?: unknown }) =>
          typeof part.text === "string" ? [part.text] : [],
        )
        .join("")
    : "";
}

/** The shared client every app uses, signed in as the stack's person. */
