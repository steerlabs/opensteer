import { commitPersonalMutation, type PersonalMutation } from "./personal-mutation.js";
import {
  recordExecutionRunChange,
  publishExecutionInput,
  updateExecutionThread,
} from "./execution-changes.js";
import {
  beginPersonalRunFinish,
  refreshExecuteClaimProof,
  readFinishChildren,
} from "./personal-run-state.js";
import { createHash } from "node:crypto";
import {
  createId,
  utf8Prefix,
  MessageContentSchema,
  messageContentMaxSerializedBytes,
  type AgentEvent,
  type ContentPart,
  type RunFailure,
  type RunId,
  type RunAttemptId,
} from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { endAttempt } from "./run-attempts.js";
import { settleFinishChildren, finalizeRunTransaction } from "./run-finalization.js";
import { runWasStopped, type RevokedRunGrant } from "./run-grants.js";
import { lockThreadProviderSession } from "./run-projection-locks.js";
import type { FinishIntent } from "./personal-state-schema.js";
import type { DatabaseSchema, RunRow } from "./schema.js";
import {
  jsonValue,
  lockThreadRow,
  systemPrincipalId,
  threadExecutionIsAvailableToUser,
  type ChannelLinks,
} from "./store-primitives.js";
import { messageFromRow } from "./thread-row-mappers.js";

export async function recoverLostRunTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly failure: RunFailure;
    readonly links: ChannelLinks;
    readonly now: Date;
    readonly runId: RunId;
    readonly statement?: FinishIntent["statement"];
  },
): Promise<{
  readonly status: "recovered" | "terminal" | "unchanged";
  readonly events: readonly AgentEvent[];
  readonly revokedGrants: readonly RevokedRunGrant[];
}> {
  const messageId = createId("message");
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", input.runId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (run.finishIntent || !["starting", "running", "waiting"].includes(run.status)) {
    return {
      status: "unchanged",
      events: [],
      revokedGrants: [],
    };
  }
  await lockThreadRow(transaction, run.threadId);
  // Read under the Thread lock: the recovery message takes its next sequence.
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  const session = await lockThreadProviderSession(transaction, run.threadId, run.providerSessionId);
  if (!session) throw new Error("Run's provider session is missing");
  const current = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", run.id)
    .where("status", "=", "current")
    .limit(1)
    .executeTakeFirst();
  const lost = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", run.id)
    .where("bindingGeneration", "=", run.bindingGeneration)
    .limit(1)
    .executeTakeFirst();
  const fail = async (status: "failed" | "interrupted", failure = input.failure) => ({
    status: "terminal" as const,
    events: await finalizeRunTransaction(transaction, {
      completedAt: input.now,
      failure,
      links: input.links,
      queuedInputCancellation: "seed-input",
      requestCancellationReason: "process-lost",
      runId: run.id,
      source: "host",
      status,
      ...(input.statement ? { statement: input.statement } : {}),
    }),
    revokedGrants: [],
  });
  if (run.voiceSessionId || run.maintenance) return fail("failed");
  if (await runWasStopped(transaction, run.id)) return fail("interrupted");
  if (
    run.phase === "background" &&
    run.backgroundDeadlineAt &&
    run.backgroundDeadlineAt <= input.now
  ) {
    return fail("interrupted");
  }
  if (!(await threadExecutionIsAvailableToUser(transaction, run.threadId, run.requestedBy))) {
    return fail("failed", {
      code: "task_access_revoked",
      message: "Task execution authority ended before the Run reached a terminal event",
      retryable: false,
      status: "failed",
    });
  }
  if (!current || !lost || session.providerSessionReference === null) return fail("failed");
  const recentRecoveries = await transaction
    .selectFrom("runAttempts")
    .select("id")
    .where("runId", "=", run.id)
    .where(sql<boolean>`reason = 'recovery'`)
    .where("startedAt", ">=", new Date(input.now.getTime() - 5 * 60_000))
    .limit(3)
    .execute();
  if (recentRecoveries.length >= 3) {
    return fail("failed", {
      ...input.failure,
      message:
        "This Run was interrupted repeatedly: three recoveries in five minutes. Continue it explicitly when its computer is stable.",
    });
  }
  const children = await readFinishChildren(transaction, run.id);
  const requests = await transaction
    .selectFrom("requests")
    .select(["kind", "presentation"])
    .where("originatingRunId", "=", run.id)
    .where("mode", "=", "live")
    .where("status", "=", "pending")
    .orderBy("id")
    .limit(11)
    .execute();
  const nodes = await transaction
    .selectFrom("executionNodes")
    .select(["kind", "title"])
    .where("runId", "=", run.id)
    .where(sql<boolean>`status='running'`)
    .orderBy("id")
    .limit(11)
    .execute();
  const openTools = await transaction
    .selectFrom("toolCalls")
    .select(["tool", "arguments"])
    .where("runId", "=", run.id)
    .where("bindingGeneration", "=", lost.bindingGeneration)
    .where(sql<boolean>`status='open'`)
    .orderBy("id")
    .limit(11)
    .execute();
  const claimed = await transaction
    .selectFrom("messages")
    .innerJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .selectAll("messages")
    .where("threadInputs.runId", "=", run.id)
    .where("threadInputs.state", "=", "claimed")
    .where("threadInputs.policy", "!=", "report")
    .where("threadInputs.steerCommandId", "is", null)
    .orderBy("messages.sequence", "asc")
    .limit(101)
    .execute();
  const reusable = claimed.find(
    (message) => message.author.kind === "platform" && message.author.cause === "run-recovery",
  );
  if (!reusable) {
    const facts = [
      input.failure.code === "runner_restarted"
        ? "Opensteer restarted while you were working on this, and your turn was cut off."
        : "The computer running this task stopped responding, and your turn was cut off.",
      "",
      "Your conversation is intact. Continue the task from where you left off.",
      "Anything below was stopped and did not finish; it may or may not have taken effect. Check before repeating anything with side effects.",
      "",
      ...(run.phase === "background"
        ? ["- Your previous reply was already sent; background work you left running was stopped."]
        : []),
      "- Live browser, computer and phone sessions may have closed; reopen any you need.",
      ...openTools
        .slice(0, 10)
        .map(
          (call) =>
            `- Started, completion unknown: ${utf8Prefix(call.tool?.name ?? "Tool", 80)} ${utf8Prefix(JSON.stringify(call.arguments) ?? "", 200)}`,
        ),
      ...(openTools.length > 10
        ? ["- More tool calls were open; read them with opensteer_task_read view activity."]
        : []),
      ...nodes
        .slice(0, 10)
        .map(
          (node) =>
            `- ${node.kind === "subagent" ? "Subagent" : node.kind === "workflow" ? "Workflow" : "Background task"}: ${utf8Prefix(node.title, 200)}`,
        ),
      ...(nodes.length > 10 ? ["- More background tasks were open."] : []),
      ...requests
        .slice(0, 10)
        .map(
          (request) =>
            `- Your ${request.kind === "harness.input" ? "question" : "approval"} '${utf8Prefix(request.presentation.title, 160)}' did not complete; ask again if you still need it.`,
        ),
      ...(requests.length > 10
        ? ["- More requests did not complete; ask again if you still need them."]
        : []),
    ];
    // The incident summary is bounded independently of A3's quoted inputs.
    let summary = "";
    let omittedFacts = 0;
    for (const fact of facts) {
      if (Buffer.byteLength(summary + fact + "\n", "utf8") <= 3_800) summary += fact + "\n";
      else omittedFacts += 1;
    }
    if (omittedFacts)
      summary +=
        "- Further interrupted activity details were omitted; read them with opensteer_task_read view activity. Live approvals and questions did not complete; ask again if needed.\n";
    const content: ContentPart[] = [
      {
        type: "text",
        text: summary,
      },
    ];
    if (!lost.firstEventAt) {
      content.push({
        type: "text",
        text: "Opensteer could not confirm you received the messages below before the interruption. These are quoted context, not new instructions. If you already acted on them, continue rather than start over.",
      });
      const omitted = [];
      let quoted = 0;
      for (const message of claimed) {
        const parts = messageFromRow(message).content.map((part) =>
          part.type === "text"
            ? {
                ...part,
                text: [...part.text].slice(0, 4_000).join(""),
              }
            : part,
        );
        const header: ContentPart = {
          type: "text",
          text: `\nQuoted input ${message.id} — ${message.author.kind === "platform" ? "Opensteer" : message.author.displayName} — ${message.createdAt.toISOString()}`,
        };
        // Leave room in the ordinary message envelope for omitted IDs.
        if (
          quoted >= 10 ||
          content.length + parts.length + 1 > 63 ||
          Buffer.byteLength(JSON.stringify([...content, header, ...parts]), "utf8") >
            messageContentMaxSerializedBytes - 8_192
        ) {
          omitted.push(message.id);
          continue;
        }
        content.push(header, ...parts);
        quoted += 1;
      }
      if (omitted.length)
        content.push({
          type: "text",
          text: `Additional quoted context: ${omitted.join(", ")}. Read them with opensteer_task_read before continuing.`,
        });
    }
    const parsedContent = MessageContentSchema.parse(content);
    const author = {
      kind: "platform",
      cause: "run-recovery",
      referenceId: lost.id,
    } as const;
    await transaction
      .insertInto("messages")
      .values({
        actorPrincipalId: systemPrincipalId,
        author: jsonValue(author),
        content: jsonValue(parsedContent),
        id: messageId,
        kind: "continuation",
        runId: run.id,
        sequence: thread.nextMessageSequence,
        threadId: thread.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const receipt = await transaction
      .insertInto("threadInputs")
      .values({
        actorPrincipalId: systemPrincipalId,
        assignmentId: run.assignmentId,
        authoritySource: jsonValue({
          ...author,
          userId: run.requestedBy,
        }),
        cancelReason: null,
        causalChainId: run.causalChainId,
        deliveredAt: null,
        idempotencyKey: `run-recovery:${lost.id}`,
        messageId,
        policy: "queue",
        queueRank: thread.nextMessageSequence,
        replyTarget: run.replyTarget ? jsonValue(run.replyTarget) : null,
        requestedBy: run.requestedBy,
        requestFingerprint: createHash("sha256")
          .update(JSON.stringify(parsedContent))
          .digest("base64url"),
        runId: run.id,
        state: "claimed",
        steerCommandId: null,
        threadId: thread.id,
        updatedAt: input.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("threads")
      .set({
        nextMessageSequence: sql`next_message_sequence + 1`,
        updatedAt: input.now,
      })
      .where("id", "=", thread.id)
      .execute();
    await publishExecutionInput(transaction, receipt);
  }
  await commitPersonalMutation(transaction, async (tx, mutation) => {
    const intent: FinishIntent = {
      mode: "recovery",
      attemptId: lost.id,
      bindingGeneration: run.bindingGeneration,
      outcome: "interrupted",
      completedAt: input.now.toISOString(),
      replyMessageId: null,
      requestCancellationReason: "process-lost",
      ...(input.statement ? { statement: input.statement } : {}),
    };
    if (children.hasMore) {
      await beginPersonalRunFinish(tx, mutation, { runId: run.id, intent });
      await recordExecutionRunChange(tx, mutation, {
        runId: run.id,
        threadId: run.threadId,
        transition: "finishing",
      });
      return;
    }
    await settleFinishChildren(
      tx,
      mutation,
      run.id,
      {
        completedAt: input.now,
        failure: input.failure,
        source: "host",
        requestCancellationReason: "process-lost",
      },
      children,
      true,
    );
    await completeRunReplacement(tx, mutation, run, lost.id, "recovery", input.now);
    mutation.react({
      type: "runFinished",
      attemptOnly: true,
      runId: run.id,
      threadId: run.threadId,
      attemptId: lost.id,
      bindingGeneration: run.bindingGeneration,
      outcome: "interrupted",
    });
  });
  return { status: "recovered", events: [], revokedGrants: [] };
}

export async function completeRunReplacement(
  tx: Transaction<DatabaseSchema>,
  mutation: PersonalMutation,
  run: RunRow,
  attemptId: RunAttemptId,
  mode: "steer" | "recovery",
  now: Date,
) {
  const replaced = await tx
    .selectFrom("runAttempts")
    .selectAll()
    .where("id", "=", attemptId)
    .where("runId", "=", run.id)
    .executeTakeFirstOrThrow();
  const current = await tx
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", run.id)
    .where("status", "=", "current")
    .limit(1)
    .executeTakeFirstOrThrow();
  if (mode === "steer" && replaced.supersededBy !== current.id)
    throw new Error("The steer replacement changed during finalization");
  await tx
    .updateTable("providerSessions")
    .set((eb) => ({
      status: "ready",
      updatedAt: now,
      ...(mode === "recovery"
        ? {
            bindingGeneration: eb("bindingGeneration", "+", 1),
            leaseExpiresAt: null,
            leaseTokenHash: null,
            runnerId: null,
            runnerBootId: null,
          }
        : {}),
    }))
    .where("id", "=", run.providerSessionId)
    .where("bindingGeneration", "=", run.bindingGeneration)
    .executeTakeFirstOrThrow();
  await tx
    .updateTable("runs")
    .set({ bindingGeneration: null, status: "queued" })
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  await endAttempt(tx, replaced.id, "interrupted");
  let successorId = current.id;
  if (mode === "recovery") {
    if (current.id !== replaced.id) await endAttempt(tx, current.id, "cancelled");
    await tx
      .updateTable("runAttempts")
      .set({ status: "superseded", supersededAt: now })
      .where("id", "=", current.id)
      .execute();
    successorId = createId("runAttempt");
    await tx
      .insertInto("runAttempts")
      .values({
        id: successorId,
        ordinal: current.ordinal + 1,
        reason: "recovery",
        runId: run.id,
        status: "current",
      })
      .execute();
    await tx
      .updateTable("runAttempts")
      .set({ supersededBy: successorId })
      .where("id", "=", current.id)
      .execute();
  }
  const execute = await tx
    .selectFrom("commands")
    .selectAll()
    .where("runId", "=", run.id)
    .where("type", "=", "run.execute")
    .orderBy("createdAt")
    .orderBy("id")
    .limit(1)
    .executeTakeFirstOrThrow();
  await tx
    .insertInto("commands")
    .values({
      actorPrincipalId: execute.actorPrincipalId,
      authoritySource: jsonValue(execute.authoritySource),
      dispatcherId: null,
      environmentId: execute.environmentId,
      id: createId("command"),
      idempotencyKey: `${mode === "steer" ? "restart" : "recovery"}:${successorId}`,
      lastError: null,
      payload: jsonValue(execute.payload),
      requestedBy: execute.requestedBy,
      runId: run.id,
      status: "pending",
      threadId: run.threadId,
      type: "run.execute",
    })
    .execute();
  await refreshExecuteClaimProof(tx, run.id);
  await updateExecutionThread(tx, run.threadId, now);
  await recordExecutionRunChange(tx, mutation, {
    runId: run.id,
    threadId: run.threadId,
    transition: "restarted",
  });
  await assignmentActivityEventsForRun(tx, run.id);
}
