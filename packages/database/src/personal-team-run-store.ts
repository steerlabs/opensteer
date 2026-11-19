import { MessageContentSchema, OpensteerError, type MessageId, type RunId } from "@opensteer/core";
import type { PersonalTeamRequest } from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import { requirePersonalOwner, personalSettings } from "./personal-settings-store.js";
import type { DatabaseSchema } from "./schema.js";

export interface PersonalTeamRunOutcome {
  readonly runId: RunId | null;
  readonly state: "pending" | "working" | "needs_you" | "done" | "failed" | "stopped" | "cancelled";
  readonly finalMessage: string | null;
  readonly answerMessageId: MessageId | null;
}

export async function personalTeamRunOutcome(
  database: Kysely<DatabaseSchema>,
  request: PersonalTeamRequest,
): Promise<PersonalTeamRunOutcome> {
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (tx) => {
      const { ownerId } = await personalSettings(tx);
      await requirePersonalOwner(tx, ownerId);
      const receipt = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", request.teamId)
        .where("requestId", "=", request.requestId)
        .where(
          "localTaskId",
          "in",
          tx
            .selectFrom("threads")
            .select("id")
            .where("id", "=", request.taskId)
            .where("createdBy", "=", ownerId)
            .where("removedAt", "is", null),
        )
        .executeTakeFirst();
      if (
        !receipt ||
        receipt.localTaskId !== request.taskId ||
        receipt.localInputId !== request.inputId ||
        receipt.triggerMessageId !== request.triggerMessageId
      )
        throw new OpensteerError({
          code: "forbidden",
          message: "This team request does not own that task input",
        });
      const input = await tx
        .selectFrom("threadInputs")
        .select(["state", "teamRequestId"])
        .where("messageId", "=", receipt.localInputId)
        .where("threadId", "=", receipt.localTaskId)
        .executeTakeFirst();
      if (!input || input.teamRequestId !== request.requestId)
        throw new OpensteerError({
          code: "conflict",
          message: "The saved team request input is unavailable",
        });
      const run = await tx
        .selectFrom("runs")
        .select(["id", "status", "terminalReplyMessageId"])
        .where("threadId", "=", receipt.localTaskId)
        .where("seedInputId", "=", receipt.localInputId)
        .where("requestedBy", "=", ownerId)
        .where(sql<string>`reply_target->>'requestId'`, "=", request.requestId)
        .where(sql<string>`reply_target->>'teamId'`, "=", request.teamId)
        .limit(1)
        .executeTakeFirst();
      const runId = run?.id ?? null;
      if (input.state === "cancelled" || receipt.terminalState === "cancelled")
        return { runId, state: "cancelled", finalMessage: null, answerMessageId: null };
      if (receipt.kind === "ask" && !receipt.releasedAt)
        return { runId: null, state: "needs_you", finalMessage: null, answerMessageId: null };
      if (!run) return { runId, state: "pending", finalMessage: null, answerMessageId: null };
      const state =
        run.status === "completed"
          ? "done"
          : run.status === "failed"
            ? "failed"
            : run.status === "interrupted"
              ? "stopped"
              : run.status === "waiting"
                ? "needs_you"
                : run.status === "queued"
                  ? "pending"
                  : "working";
      if (!["done", "failed", "stopped"].includes(state))
        return { runId, state, finalMessage: null, answerMessageId: null };
      const messageId = state === "done" ? run.terminalReplyMessageId : null;
      const message = messageId
        ? await tx
            .selectFrom("messages")
            .select("content")
            .where("id", "=", messageId)
            .where("threadId", "=", receipt.localTaskId)
            .where("runId", "=", run.id)
            .where("kind", "=", "assistant")
            .where("addressedToUserId", "is", null)
            .where("published", "=", true)
            .executeTakeFirst()
        : null;
      const text = message
        ? MessageContentSchema.parse(message.content)
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim()
        : "";
      return {
        runId,
        state,
        finalMessage: text || null,
        answerMessageId: message ? messageId : null,
      };
    });
}
