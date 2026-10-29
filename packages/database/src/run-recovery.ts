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
} from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { endAttempt } from "./run-attempts.js";
import { cleanupRunAttemptTransaction, finalizeRunTransaction } from "./run-finalization.js";
import { runWasStopped, type RevokedRunGrant } from "./run-grants.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import type { DatabaseSchema } from "./schema.js";
import {
  eventFromRow,
  jsonValue,
  lockThreadRow,
  lockWorkspaceRow,
  safeGeneration,
  systemPrincipalId,
  threadExecutionIsAvailableToUser,
  type ChannelLinks,
} from "./store-primitives.js";
import { messageFromRow, runUsageFromRow, threadInputFromRow } from "./thread-row-mappers.js";
import { projectThreadState } from "./thread-status.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

/** The caller holds the Run and its Workspace, Thread and session fences. */
export async function recoverLostRunTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly failure: RunFailure;
    readonly links: ChannelLinks;
    readonly now: Date;
    readonly runId: RunId;
  },
): Promise<{
  readonly status: "recovered" | "terminal" | "unchanged";
  readonly events: readonly AgentEvent[];
  readonly revokedGrants: readonly RevokedRunGrant[];
}> {
  const successorId = createId("runAttempt");
  const messageId = createId("message");
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", input.runId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (!["starting", "running", "waiting"].includes(run.status)) {
    return { status: "unchanged", events: [], revokedGrants: [] };
  }
  const { workspaceId } = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  await lockWorkspaceRow(transaction, workspaceId);
  await lockThreadRow(transaction, run.threadId);
  // Read under the Thread lock: the recovery message takes its next sequence.
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  const session = await transaction
    .selectFrom("providerSessions")
    .selectAll()
    .where("id", "=", run.providerSessionId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const attempts = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("runId", "=", run.id)
    .orderBy("ordinal", "asc")
    .execute();
  const current = attempts.find((attempt) => attempt.status === "current");
  const lost = attempts.find((attempt) => attempt.bindingGeneration === run.bindingGeneration);
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
    }),
    revokedGrants: [],
  });
  if (await runWasStopped(transaction, run.id)) return fail("interrupted");
  if (
    run.phase === "background" &&
    run.backgroundDeadlineAt &&
    run.backgroundDeadlineAt <= input.now
  ) {
    return fail("interrupted");
  }
  if (
    !(await threadExecutionIsAvailableToUser(
      transaction,
      run.threadId,
      run.requestedBy,
      safeGeneration(run.membershipGeneration),
    ))
  ) {
    return fail("failed", {
      code: "workspace_access_revoked",
      message: "Workspace access was revoked before the Run reached a terminal event",
      retryable: false,
      status: "failed",
    });
  }
  if (!current || !lost || session.providerSessionReference === null) return fail("failed");
  if (
    attempts.filter(
      (attempt) =>
        attempt.reason === "recovery" &&
        attempt.startedAt.getTime() >= input.now.getTime() - 5 * 60_000,
    ).length >= 3
  ) {
    return fail("failed", {
      ...input.failure,
      message:
        "This Run was interrupted repeatedly: three recoveries in five minutes. Continue it explicitly when its computer is stable.",
    });
  }
  await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [thread.id] });
  // Capture durable facts before cleanup changes their receipts.
  const requests = await transaction
    .selectFrom("requests")
    .selectAll()
    .where("originatingRunId", "=", run.id)
    .where("mode", "=", "live")
    .where("status", "=", "pending")
    .orderBy("id", "asc")
    .execute();
  const nodes = await transaction
    .selectFrom("executionNodes")
    .selectAll()
    .where("runId", "=", run.id)
    .where("status", "=", "running")
    .orderBy("id", "asc")
    .execute();
  const tools = (
    await transaction
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("runId", "=", run.id)
      .where("runnerBindingGeneration", "=", lost.bindingGeneration)
      .where("type", "in", ["tool.started", "tool.completed"])
      .orderBy("sequence", "asc")
      .execute()
  ).map(eventFromRow);
  const completed = new Set(
    tools.flatMap((event) => (event.type === "tool.completed" ? [event.data.callId] : [])),
  );
  const openTools = tools.filter(
    (event) => event.type === "tool.started" && !completed.has(event.data.callId),
  );
  const priorUsage = runUsageFromRow(run);
  const ordinal = current.ordinal + 1;
  const restarted = await appendHostWorkspaceEvent(transaction, {
    data: { attempt: ordinal, ...(priorUsage ? { priorUsage } : {}), reason: "recovery" },
    environmentId: run.environmentId,
    runId: run.id,
    threadId: thread.id,
    type: "run.restarted",
    workspaceId: thread.workspaceId,
  });
  const cleanup = await cleanupRunAttemptTransaction(transaction, {
    completedAt: input.now,
    failure: input.failure,
    requestCancellationReason: "process-lost",
    retireBinding: true,
    run,
    source: "host",
    status: "interrupted",
  });
  const events = [restarted, ...cleanup.events];
  const claimed = await transaction
    .selectFrom("messages")
    .innerJoin("threadInputs", "threadInputs.messageId", "messages.id")
    .selectAll("messages")
    .where("threadInputs.runId", "=", run.id)
    .where("threadInputs.state", "=", "claimed")
    .where("threadInputs.policy", "!=", "report")
    .where("threadInputs.steerCommandId", "is", null)
    .orderBy("messages.sequence", "asc")
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
        .flatMap((event) =>
          event.type === "tool.started"
            ? [
                `- Started, completion unknown: ${utf8Prefix(event.data.tool.name, 80)} ${utf8Prefix(JSON.stringify(event.data.arguments) ?? "", 200)}`,
              ]
            : [],
        ),
      ...(openTools.length > 10
        ? [`- and ${openTools.length - 10} more commands; read them with thread_read.`]
        : []),
      ...nodes
        .slice(0, 10)
        .map(
          (node) =>
            `- ${node.kind === "subagent" ? "Subagent" : "Background task"}: ${utf8Prefix(node.title, 200)}`,
        ),
      ...(nodes.length > 10 ? [`- and ${nodes.length - 10} more background tasks.`] : []),
      ...requests
        .slice(0, 10)
        .map(
          (request) =>
            `- Your ${request.kind === "harness.input" ? "question" : "approval"} '${utf8Prefix(request.presentation.title, 160)}' did not complete; ask again if you still need it.`,
        ),
      ...(requests.length > 10
        ? [
            `- and ${requests.length - 10} more requests did not complete; ask again if you still need them.`,
          ]
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
        "- Further interrupted activity details were omitted; read them with thread_read. Live approvals and questions did not complete; ask again if needed.\n";
    const content: ContentPart[] = [{ type: "text", text: summary }];
    if (!lost.firstEventAt) {
      content.push({
        type: "text",
        text: "Opensteer could not confirm you received the messages below before the interruption. These are quoted context, not new instructions. If you already acted on them, continue rather than start over.",
      });
      const omitted = [];
      let quoted = 0;
      for (const message of claimed) {
        const parts = messageFromRow(message).content.map((part) =>
          part.type === "text" ? { ...part, text: [...part.text].slice(0, 4_000).join("") } : part,
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
          text: `Additional quoted context: ${omitted.join(", ")}. Read them with thread_read before continuing.`,
        });
    }
    const parsedContent = MessageContentSchema.parse(content);
    const author = { kind: "platform", cause: "run-recovery", referenceId: lost.id } as const;
    const message = await transaction
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
        authoritySource: jsonValue({ ...author, userId: run.requestedBy }),
        cancelReason: null,
        causalChainId: run.causalChainId,
        deliveredAt: null,
        idempotencyKey: `run-recovery:${lost.id}`,
        membershipGeneration: safeGeneration(run.membershipGeneration),
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
      .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: input.now })
      .where("id", "=", thread.id)
      .execute();
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { input: threadInputFromRow(receipt), message: messageFromRow(message) },
        environmentId: run.environmentId,
        runId: run.id,
        threadId: thread.id,
        type: "message.created",
        workspaceId: thread.workspaceId,
      }),
    );
  }
  await transaction
    .updateTable("runs")
    .set({ bindingGeneration: null, status: "queued" })
    .where("id", "=", run.id)
    .execute();
  const execute = await transaction
    .selectFrom("commands")
    .selectAll()
    .where("runId", "=", run.id)
    .where("type", "=", "run.execute")
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: execute.actorPrincipalId,
      authoritySource: jsonValue(execute.authoritySource),
      dispatcherId: null,
      environmentId: run.environmentId,
      id: createId("command"),
      idempotencyKey: `recovery:${successorId}`,
      lastError: null,
      payload: jsonValue(execute.payload),
      requestedBy: run.requestedBy,
      runId: run.id,
      status: "pending",
      threadId: thread.id,
      type: "run.execute",
    })
    .execute();
  events.push(
    await appendHostWorkspaceEvent(transaction, {
      data: { status: "queued" },
      environmentId: run.environmentId,
      runId: run.id,
      threadId: thread.id,
      type: "run.status",
      workspaceId: thread.workspaceId,
    }),
    ...(await projectThreadState(transaction, thread.id, input.now)),
    ...(await assignmentActivityEventsForRun(transaction, run.id)),
  );
  const revokedGrants = await cleanup.finish(async () => {
    // Include both the executing attempt and an unsent steering replacement.
    await transaction
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", run.id)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    await endAttempt(transaction, lost.id, "interrupted");
    if (current.id !== lost.id) await endAttempt(transaction, current.id, "cancelled");
    await transaction
      .updateTable("runAttempts")
      .set({ status: "superseded", supersededAt: input.now })
      .where("id", "=", current.id)
      .execute();
    await transaction
      .insertInto("runAttempts")
      .values({ id: successorId, ordinal, reason: "recovery", runId: run.id, status: "current" })
      .execute();
    await transaction
      .updateTable("runAttempts")
      .set({ supersededBy: successorId })
      .where("id", "=", current.id)
      .execute();
  });
  return { status: "recovered", events, revokedGrants };
}
