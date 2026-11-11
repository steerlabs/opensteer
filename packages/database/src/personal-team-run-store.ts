import { MessageContentSchema, OpensteerError, type RunId } from "@opensteer/core";
import type { PersonalTeamRequest } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import { runReply } from "./run-reply.js";
import { eventFromRow } from "./deployment-events.js";
import { requirePersonalOwner, personalSettings } from "./personal-settings-store.js";
import type { DatabaseSchema } from "./schema.js";

export interface PersonalTeamRunOutcome {
  readonly runId: RunId | null;
  readonly state: "pending" | "working" | "needs_you" | "done" | "failed" | "stopped" | "cancelled";
  readonly finalMessage: string | null;
}

export async function personalTeamRunOutcome(
  database: Kysely<DatabaseSchema>,
  request: PersonalTeamRequest,
): Promise<PersonalTeamRunOutcome> {
  return database
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (tx) => {
      await requirePersonalOwner(tx, (await personalSettings(tx)).ownerId);
      const receipt = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", request.teamId)
        .where("requestId", "=", request.requestId)
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
        .select(["id", "status"])
        .where("threadId", "=", receipt.localTaskId)
        .where("seedInputId", "=", receipt.localInputId)
        .where("teamRequestId", "=", request.requestId)
        .executeTakeFirst();
      const runId = run?.id ?? null;
      if (input.state === "cancelled" || receipt.terminalState === "cancelled")
        return { runId, state: "cancelled", finalMessage: null };
      if (!run) return { runId, state: "pending", finalMessage: null };
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
        return { runId, state, finalMessage: null };
      const terminalRow = await tx
        .selectFrom("deploymentEvents")
        .selectAll()
        .where("runId", "=", run.id)
        .where("type", "=", "run.completed")
        .orderBy("sequence", "desc")
        .executeTakeFirst();
      const terminal = terminalRow ? eventFromRow(terminalRow) : null;
      // Only the completion projection chooses a publishable answer; later private turns cannot replace it.
      const messageId = terminal?.type === "run.completed" ? terminal.data.replyMessageId : null;
      const message =
        state !== "done"
          ? await runReply(tx, { id: run.id, threadId: receipt.localTaskId })
          : messageId
            ? await tx
                .selectFrom("messages")
                .select("content")
                .where("id", "=", messageId)
                .where("threadId", "=", receipt.localTaskId)
                .where("runId", "=", run.id)
                .where("kind", "=", "assistant")
                .where("addressedToUserId", "is", null)
                .executeTakeFirst()
            : null;
      const text = message
        ? MessageContentSchema.parse(message.content)
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim()
        : "";
      return { runId, state, finalMessage: text || null };
    });
}
