import {
  createId,
  MessageAuthorSchema,
  OpensteerError,
  PersonNotifyMessageSchema,
  type AgentEvent,
  type Message,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import {
  admitAgentControlRequestInTransaction,
  type AgentControlAdmissionInput,
} from "./agent-control-admission.js";
import type { DatabaseSchema } from "./schema.js";
import { withRequestWorkspaceLocks } from "./request-workspace-locks.js";
import { jsonValue, systemPrincipalId } from "./store-primitives.js";
import { messageFromRow } from "./thread-row-mappers.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

export interface PersonNotificationInput {
  readonly admission: AgentControlAdmissionInput;
  readonly message: string;
}
export interface PersonNotificationResult {
  readonly message: Message;
  readonly events: readonly AgentEvent[];
  readonly wasDuplicate: boolean;
}

export async function publishPersonNotification(
  database: Kysely<DatabaseSchema>,
  input: PersonNotificationInput,
): Promise<PersonNotificationResult> {
  const text = PersonNotifyMessageSchema.parse(input.message);
  const admission = input.admission;
  if (admission.action !== "person.notify")
    throw new OpensteerError({ code: "bad_request", message: "Invalid notification admission" });
  return withRequestWorkspaceLocks(
    database,
    async () => [admission.workspaceId],
    async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .select(["requestedBy", "actorPrincipalId"])
        .where("id", "=", admission.runId)
        .executeTakeFirstOrThrow();
      const recipient = await transaction
        .selectFrom("workspaceMemberships")
        .innerJoin("users", "users.id", "workspaceMemberships.userId")
        .select("users.id")
        .where("workspaceMemberships.workspaceId", "=", admission.workspaceId)
        .where("workspaceMemberships.userId", "=", run.requestedBy)
        .where("workspaceMemberships.state", "=", "active")
        .where("users.disabledAt", "is", null)
        .forShare("workspaceMemberships")
        .executeTakeFirst();
      if (!recipient)
        throw new OpensteerError({
          code: "forbidden",
          message: "Notification recipient is unavailable",
        });
      const receipt = await transaction
        .selectFrom("agentControlRequests")
        .select("resultMessageId")
        .where("runId", "=", admission.runId)
        .where("requestId", "=", admission.requestId)
        .executeTakeFirstOrThrow();
      if (receipt.resultMessageId) {
        const row = await transaction
          .selectFrom("messages")
          .selectAll()
          .where("id", "=", receipt.resultMessageId)
          .executeTakeFirstOrThrow();
        return { message: messageFromRow(row), events: [], wasDuplicate: true };
      }
      const thread = await transaction
        .selectFrom("threads")
        .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
        .select(["threads.nextMessageSequence", "workspaces.name as workspaceName"])
        .where("threads.id", "=", admission.sourceThreadId)
        .forNoKeyUpdate("threads")
        .executeTakeFirstOrThrow();
      const principal = await transaction
        .selectFrom("principals")
        .select("displayName")
        .where("id", "=", systemPrincipalId)
        .where("kind", "=", "system")
        .executeTakeFirstOrThrow();
      const row = await transaction
        .insertInto("messages")
        .values({
          id: createId("message"),
          threadId: admission.sourceThreadId,
          runId: admission.runId,
          kind: "assistant",
          actorPrincipalId: run.actorPrincipalId,
          addressedToUserId: run.requestedBy,
          author: jsonValue(
            MessageAuthorSchema.parse({
              kind: "agent",
              displayName: principal.displayName,
              runId: admission.runId,
              threadId: admission.sourceThreadId,
              workspaceId: admission.workspaceId,
              workspaceName: thread.workspaceName,
            }),
          ),
          content: jsonValue([{ type: "text", text }]),
          sequence: thread.nextMessageSequence,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("threads")
        .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: new Date() })
        .where("id", "=", admission.sourceThreadId)
        .executeTakeFirstOrThrow();
      const message = messageFromRow(row);
      const event = await appendHostWorkspaceEvent(transaction, {
        type: "message.created",
        data: { input: null, message, addressedToUserId: run.requestedBy },
        environmentId: admission.environmentId,
        runId: admission.runId,
        threadId: admission.sourceThreadId,
        workspaceId: admission.workspaceId,
      });
      await transaction
        .updateTable("agentControlRequests")
        .set({ resultMessageId: message.id })
        .where("runId", "=", admission.runId)
        .where("requestId", "=", admission.requestId)
        .executeTakeFirstOrThrow();
      return { message, events: [event], wasDuplicate: false };
    },
    async (transaction) => {
      await admitAgentControlRequestInTransaction(transaction, admission);
    },
  );
}
