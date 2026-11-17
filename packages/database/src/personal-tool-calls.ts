import {
  OpensteerError,
  IntegrationCallSubjectSchema,
  ToolIdentitySchema,
  ToolOutputSchema,
  type ToolIdentity,
  type ToolOutput,
  type IntegrationCallSubject,
} from "@opensteer/core";
import { sql, type Selectable } from "kysely";
import type { PersonalMutation, PersonalMutationTransaction } from "./personal-mutation.js";
import { personalArgumentDigest } from "./personal-runner-receipts.js";
import type { ToolCallTable } from "./personal-state-schema.js";
import { retainedToolImages, toolCallId, transcriptPreview } from "./transcript-store.js";

type ToolKey = Pick<
  ToolCallTable,
  "threadId" | "runId" | "attemptId" | "bindingGeneration" | "nodeId" | "callId" | "origin"
>;
type Transaction = PersonalMutationTransaction;

async function lockToolScope(tx: Transaction, key: ToolKey) {
  const run = await tx
    .selectFrom("runs")
    .select(["threadId", "finishIntent", "status"])
    .where("id", "=", key.runId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!run || run.threadId !== key.threadId)
    throw new OpensteerError({ code: "forbidden", message: "Tool call is outside its Run" });
  const thread = await tx
    .selectFrom("threads")
    .select(["id", "removedAt"])
    .where("id", "=", key.threadId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!thread || thread.removedAt)
    throw new OpensteerError({ code: "forbidden", message: "Tool call task is unavailable" });
  if (key.nodeId) {
    const node = await tx
      .selectFrom("executionNodes")
      .select("id")
      .where("id", "=", key.nodeId)
      .where("runId", "=", key.runId)
      .where("attemptId", "=", key.attemptId)
      .executeTakeFirst();
    if (!node)
      throw new OpensteerError({ code: "forbidden", message: "Tool call is outside its node" });
  }
  if (key.origin === "runner") {
    if (
      !key.attemptId ||
      key.bindingGeneration === null ||
      key.callId.startsWith("harness:") ||
      key.callId.startsWith("computer:")
    )
      throw new OpensteerError({ code: "conflict", message: "Invalid Runner tool call identity" });
    const attempt = await tx
      .selectFrom("runAttempts")
      .select("id")
      .where("id", "=", key.attemptId)
      .where("runId", "=", key.runId)
      .where("bindingGeneration", "=", key.bindingGeneration)
      .where("status", "=", "current")
      .where("endedAt", "is", null)
      .executeTakeFirst();
    if (!attempt)
      throw new OpensteerError({ code: "conflict", message: "Tool call binding has ended" });
  } else {
    const namespace = key.origin === "host-harness" ? "harness:" : "computer:";
    if (!key.callId.startsWith(namespace))
      throw new OpensteerError({ code: "conflict", message: "Invalid Host tool call identity" });
  }
  return run;
}

function requireToolAdmission(run: Awaited<ReturnType<typeof lockToolScope>>) {
  if (
    run.finishIntent ||
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "interrupted"
  )
    throw new OpensteerError({
      code: "conflict",
      message: "The Run no longer accepts tool activity",
    });
}

async function allocatePosition(tx: Transaction, key: ToolKey, revision: string) {
  const thread = await tx
    .updateTable("threads")
    .set({
      nextTranscriptPosition: sql<string>`next_transcript_position + 1`,
      revision,
    })
    .where("id", "=", key.threadId)
    .returning("nextTranscriptPosition")
    .executeTakeFirstOrThrow();
  return thread.nextTranscriptPosition;
}

async function storeToolCard(
  tx: Transaction,
  mutation: PersonalMutation,
  call: Selectable<ToolCallTable>,
  position: string,
) {
  const id = `tool:${call.id}`;
  const view = transcriptPreview({
    title: call.tool?.name,
    status: call.status,
    preview: call.output?.text,
  });
  const row = await tx
    .insertInto("transcriptItems")
    .values({
      id,
      threadId: call.threadId,
      runId: call.runId,
      attemptId: call.attemptId,
      nodeId: call.nodeId,
      kind: "tool",
      position,
      revision: mutation.sequence,
      visible: true,
      isTurnStart: false,
      createdAt: call.startedAt ?? call.completedAt!,
      toolCallId: call.id,
      view,
    })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet((eb) => ({
        revision: eb.ref("excluded.revision"),
        view: eb.ref("excluded.view"),
      })),
    )
    .returning(["position", "revision", "createdAt"])
    .executeTakeFirstOrThrow();
  mutation.change(
    {
      scopeKey: call.nodeId ? `node:${call.nodeId}` : `thread:${call.threadId}`,
      entityKind: "item",
      entityId: id,
      operation: "upsert",
    },
    () => ({
      ...row,
      id,
      kind: "tool",
      runId: call.runId,
      attemptId: call.attemptId,
      nodeId: call.nodeId,
      toolCallId: call.id,
      isTurnStart: false,
      view,
    }),
  );
}

async function currentCall(tx: Transaction, id: string) {
  return tx
    .selectFrom("toolCalls")
    .selectAll()
    .where("id", "=", id)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

export async function startPersonalToolCall(
  tx: Transaction,
  mutation: PersonalMutation,
  input: ToolKey & {
    readonly tool: ToolIdentity;
    readonly arguments: unknown;
    readonly integration?: IntegrationCallSubject;
    readonly provisional?: true;
  },
) {
  const run = await lockToolScope(tx, input);
  const tool = ToolIdentitySchema.parse(input.tool);
  const integration = input.integration
    ? IntegrationCallSubjectSchema.parse(input.integration)
    : null;
  const id = toolCallId(input);
  const existing = await currentCall(tx, id);
  const args = JSON.stringify(input.arguments) ?? "null";
  if (Buffer.byteLength(args) > 480 * 1024)
    throw new OpensteerError({
      code: "resource_exhausted",
      message: "Tool arguments exceed their retained limit",
    });
  const digest = personalArgumentDigest(JSON.parse(args));
  if (existing) {
    if (
      existing.origin !== input.origin ||
      existing.tool?.name !== tool.name ||
      existing.tool.namespace !== tool.namespace
    )
      throw new OpensteerError({
        code: "conflict",
        message: "Tool call identity was already used",
      });
    const matches = (existing.argumentDigest ?? personalArgumentDigest(existing.arguments)).equals(
      digest,
    );
    if (input.origin !== "runner" && matches) return { call: existing, started: false };
    requireToolAdmission(run);
    if (existing.status !== "open")
      throw new OpensteerError({ code: "conflict", message: "Tool call has already finished" });
    if (existing.provisional && !input.provisional) {
      const updated = await tx
        .updateTable("toolCalls")
        .set({
          arguments: sql`${args}::jsonb`,
          provisional: false,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const card = await tx
        .selectFrom("transcriptItems")
        .select("position")
        .where("toolCallId", "=", id)
        .executeTakeFirstOrThrow();
      await storeToolCard(tx, mutation, updated, card.position!);
      return { call: updated, started: false };
    }
    if (matches && (existing.provisional || !input.provisional))
      return { call: existing, started: false };
    throw new OpensteerError({
      code: "conflict",
      message: "Tool call arguments have already been recorded",
    });
  }
  if (input.provisional && input.origin !== "runner")
    throw new OpensteerError({
      code: "bad_request",
      message: "Only a Runner can report a provisional tool call",
    });
  requireToolAdmission(run);
  const position = await allocatePosition(tx, input, mutation.sequence);
  const call = await tx
    .insertInto("toolCalls")
    .values({
      id,
      threadId: input.threadId,
      runId: input.runId,
      attemptId: input.attemptId,
      bindingGeneration: input.bindingGeneration,
      nodeId: input.nodeId,
      callId: input.callId,
      origin: input.origin,
      tool,
      integration,
      arguments: sql`${args}::jsonb`,
      argumentDigest: input.origin === "runner" ? null : digest,
      provisional: input.provisional ?? false,
      status: "open",
      startedAt: mutation.state.now,
      output: null,
      isError: null,
      completedAt: null,
      completionOrder: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await storeToolCard(tx, mutation, call, position);
  return { call, started: true };
}

export async function completePersonalToolCall(
  tx: Transaction,
  mutation: PersonalMutation,
  input: ToolKey & {
    readonly output: ToolOutput;
    readonly isError: boolean;
  },
) {
  const run = await lockToolScope(tx, input);
  const id = toolCallId(input);
  const call = await currentCall(tx, id);
  if (call?.origin && call.origin !== input.origin)
    throw new OpensteerError({
      code: "conflict",
      message: "Tool call belongs to another namespace",
    });
  if (call?.status === "completed" || call?.status === "interrupted")
    return { call, completed: false };
  requireToolAdmission(run);
  const output = ToolOutputSchema.parse(input.output);
  const order = await allocatePosition(tx, input, mutation.sequence);
  const final = {
    status: "completed" as const,
    output,
    isError: input.isError,
    completedAt: mutation.state.now,
    completionOrder: order,
  };
  const completed = call
    ? await tx
        .updateTable("toolCalls")
        .set(final)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await tx
        .insertInto("toolCalls")
        .values({
          id,
          threadId: input.threadId,
          runId: input.runId,
          attemptId: input.attemptId,
          bindingGeneration: input.bindingGeneration,
          nodeId: input.nodeId,
          callId: input.callId,
          origin: input.origin,
          tool: null,
          integration: null,
          arguments: null,
          argumentDigest: null,
          startedAt: null,
          ...final,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
  await storeToolCard(tx, mutation, completed, order);
  const images = retainedToolImages(completed, output.images ?? [], order);
  if (images.length) await tx.insertInto("toolOutputImages").values(images).execute();
  return { call: completed, completed: true };
}

export async function interruptPersonalToolCalls(
  tx: Transaction,
  mutation: PersonalMutation,
  runId: ToolKey["runId"],
  ids: readonly string[],
) {
  if (!ids.length) return;
  if (ids.length > 128) throw new Error("A tool interruption batch exceeded the Run fence");
  const current = await tx
    .selectFrom("toolCalls")
    .select("id")
    .where("id", "in", [...ids])
    .where("runId", "=", runId)
    .where("status", "=", "open")
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  if (!current.length) return;
  const calls = await tx
    .updateTable("toolCalls")
    .set({ status: "interrupted", completedAt: mutation.state.now })
    .where(
      "id",
      "in",
      current.map(({ id }) => id),
    )
    .returningAll()
    .execute();
  const cards = await tx
    .selectFrom("transcriptItems")
    .select(["id", "toolCallId", "position"])
    .where(
      "id",
      "in",
      calls.map(({ id }) => `tool:${id}`),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const position = new Map(cards.map((row) => [row.toolCallId, row.position]));
  for (const call of calls) await storeToolCard(tx, mutation, call, position.get(call.id)!);
}
