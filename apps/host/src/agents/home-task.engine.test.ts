import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSelectionSchema, type RunId } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { createHarnessRegistry, parseAgentExecutionConfig } from "@opensteer/runner";
import { afterEach, describe, expect, it } from "vitest";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * Drives Home with a real engine on this machine's own sign-in: Home hands
 * sustained work to a task, answers an unrelated question while the task runs,
 * and answers from the task's final reply once it returns. The task's answer
 * is a verifiable fact, so the journey needs no scripted model output.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const driverKind = process.env.OPENSTEER_HOME_TASK_ENGINE ?? "claude";
const sourceIds: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai" };
const primeCount = "148933";
const largestPrime = "1999993";

function textOf(content: readonly unknown[]): string {
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Digits as a model may format them: 148,933 and 148 933 both read 148933. */
function numerals(text: string): string {
  return text.replace(/(?<=\d)[,\s ](?=\d{3}\b)/gu, "");
}

async function until<T>(
  timeoutMs: number,
  label: string,
  read: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("live Home task", () => {
  let stack: VerticalStack | undefined;

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  }, 60_000);

  it("hands work to a task, stays responsive, and answers from the task's final reply", async () => {
    if (!databaseUrl) throw new Error("Run the engine suite through pnpm test:engines");
    const sourceId = sourceIds[driverKind];
    if (!sourceId) throw new Error(`No first-party source for ${driverKind}`);
    stack = await startVerticalStack({
      catalogTimeoutMs: 180_000,
      databaseUrl,
      harnessInstance: { config: {}, driverKind, sourceId, stateKind: "ambient" },
      harnesses: createHarnessRegistry(parseAgentExecutionConfig(process.env).harnessExecutables, {
        nodeExecutable: process.execPath,
      }),
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      runTimeoutMs: 600_000,
    });
    const live = stack;
    const database = live.host.store.database;
    const model = live.catalog.models.find((candidate) => candidate.isDefault);
    if (!model) throw new Error("The engine has no default model");
    const home = await live.createThread({
      home: true,
      modelSelection: ModelSelectionSchema.parse({
        modelId: model.modelId,
        options: {},
        providerId: model.providerId,
      }),
      title: "Chat",
      workspaceId: live.mainWorkspaceId,
    });

    const startedAt = Date.now();
    const handoff = await live.sendMessage({
      text: "Please start a background task for this and bring the answer back here: write and run a small program that counts the prime numbers below 2,000,000 and finds the largest one. I'll keep chatting with you while it runs.",
      threadId: home,
      workspaceId: live.mainWorkspaceId,
    });
    const handoffMs = Date.now() - startedAt;
    const assignment = await database
      .selectFrom("delegations")
      .selectAll()
      .where("parentThreadId", "=", home)
      .executeTakeFirst();
    if (!assignment) {
      throw new Error(`Home answered without starting a task: ${handoff.assistantText}`);
    }
    expect(assignment).toMatchObject({ origin: "run", parentRunId: handoff.runId });
    const worker = await database
      .selectFrom("threads")
      .select(["id", "parentThreadId", "role"])
      .where("id", "=", assignment.childThreadId)
      .executeTakeFirstOrThrow();
    expect(worker).toMatchObject({ parentThreadId: home, role: "work" });

    const aside = await live.sendMessage({
      text: "Unrelated quick question while that runs: what is 17 times 23? Reply with just the number.",
      threadId: home,
      workspaceId: live.mainWorkspaceId,
    });
    expect(aside.assistantText).toMatch(/\b391\b/u);
    const statusDuringAside = await database
      .selectFrom("delegations")
      .select("status")
      .where("id", "=", assignment.id)
      .executeTakeFirstOrThrow();

    const finished = await until(600_000, "the task to finish and return", async () => {
      const row = await database
        .selectFrom("delegations")
        .selectAll()
        .where("id", "=", assignment.id)
        .executeTakeFirstOrThrow();
      return row.status !== "open" && row.resultStatus === "delivered" ? row : undefined;
    });
    expect(finished.status).toBe("completed");
    expect(numerals(finished.resultText ?? "")).toContain(primeCount);
    expect(numerals(finished.resultText ?? "")).toContain(largestPrime);
    if (!finished.resultRunId || !finished.resultMessageId) {
      throw new Error("A completed task has no result Run or return receipt");
    }
    const finalReply = await database
      .selectFrom("messages")
      .select("content")
      .where("threadId", "=", finished.childThreadId)
      .where("runId", "=", finished.resultRunId)
      .where("kind", "=", "assistant")
      .orderBy("sequence", "desc")
      .executeTakeFirstOrThrow();
    expect(finished.resultText).toContain(textOf(finalReply.content).trim().slice(0, 200));

    const known: readonly RunId[] = [handoff.runId, aside.runId];
    const answer = await until(600_000, "Home to answer from the returned result", async () => {
      const run = await database
        .selectFrom("runs")
        .select(["id", "status"])
        .where("threadId", "=", home)
        .where("id", "not in", [...known])
        .where("status", "in", ["completed", "failed"])
        .orderBy("createdAt", "desc")
        .executeTakeFirst();
      if (!run) return undefined;
      const reply = await database
        .selectFrom("messages")
        .select("content")
        .where("threadId", "=", home)
        .where("runId", "=", run.id)
        .where("kind", "=", "assistant")
        .orderBy("sequence", "desc")
        .executeTakeFirst();
      return { reply: reply ? textOf(reply.content) : "", run };
    });
    expect(answer.run.status).toBe("completed");
    expect(numerals(answer.reply)).toContain(primeCount);
    const homeRuns = await database
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", home)
      .execute();
    const returnMessages = await database
      .selectFrom("messages")
      .select(["id", "content"])
      .where("id", "=", finished.resultMessageId)
      .execute();
    expect(returnMessages).toHaveLength(1);

    const evidenceRoot =
      process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-engine-evidence", randomUUID());
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, `home-task-${driverKind}.json`),
      JSON.stringify(
        {
          engine: driverKind,
          model: model.modelId,
          homeThreadId: home,
          workerThreadId: worker.id,
          assignmentId: assignment.id,
          handoff: { runId: handoff.runId, ms: handoffMs, reply: handoff.assistantText },
          aside: {
            runId: aside.runId,
            reply: aside.assistantText,
            taskStatusWhenAnswered: statusDuringAside.status,
          },
          task: {
            status: finished.status,
            resultRunId: finished.resultRunId,
            resultText: finished.resultText,
            returnMessageId: finished.resultMessageId,
            returnText: textOf(returnMessages[0]?.content ?? []),
          },
          homeAnswer: { runId: answer.run.id, reply: answer.reply },
          homeRunCount: homeRuns.length,
          totalMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
  }, 1_500_000);
});
