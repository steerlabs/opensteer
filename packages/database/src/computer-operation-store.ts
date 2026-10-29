import { computerUseActHeadline } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import {
  AgentEventSchema,
  createToolOutput,
  type AgentEvent,
  type EnvironmentId,
  type IntegrationCallSubject,
  type RunId,
  type ThreadId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { withRequestWorkspaceLocks } from "./request-workspace-locks.js";

type Started = Extract<AgentEvent, { type: "tool.started" }>;
interface Context {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
}
export type ComputerOperationStatus = "succeeded" | "failed" | "cancelled";
/** Durable pairs share the Workspace sequence allocator with every Host event. */
export class ComputerOperationStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }
  async start(input: {
    readonly context: Context;
    readonly operation: string;
    readonly subject: IntegrationCallSubject;
    readonly window?: number;
  }): Promise<Started> {
    const event = await withRequestWorkspaceLocks(
      this.#database,
      async () => [input.context.workspaceId],
      (transaction) =>
        appendHostWorkspaceEvent(transaction, {
          ...input.context,
          type: "tool.started",
          data: {
            callId: `computer:${randomUUID()}`,
            tool: { namespace: "opensteer.integrations", name: `computer.${input.operation}` },
            arguments: input.window === undefined ? {} : { window: input.window },
            integration: input.subject,
          },
        }),
    );
    if (event.type !== "tool.started") throw new Error("Computer operation did not start");
    return event;
  }
  async complete(
    started: Started,
    input: {
      readonly status: ComputerOperationStatus;
      readonly headline: string;
      readonly performed: readonly string[];
    },
  ): Promise<AgentEvent | undefined> {
    return withRequestWorkspaceLocks(
      this.#database,
      async () => [started.workspaceId],
      async (transaction) => {
        const completed = await transaction
          .selectFrom("workspaceEvents")
          .select("eventId")
          .where("workspaceId", "=", started.workspaceId)
          .where("runId", "=", started.runId)
          .where("type", "=", "tool.completed")
          .where(sql<boolean>`data->>'callId' = ${started.data.callId}`)
          .executeTakeFirst();
        if (completed) return undefined;
        return appendHostWorkspaceEvent(transaction, {
          environmentId: started.environmentId,
          workspaceId: started.workspaceId,
          threadId: started.threadId,
          runId: started.runId,
          type: "tool.completed",
          data: {
            callId: started.data.callId,
            isError: input.status !== "succeeded",
            output: createToolOutput(
              [
                input.status === "cancelled"
                  ? computerUseActHeadline({
                      performed: input.performed,
                      stoppedBecause: "This step was cancelled.",
                    })
                  : input.headline,
                ...input.performed,
              ].join("\n"),
            ),
          },
        });
      },
    );
  }
  /** Called at restart and Run end. Idempotent against a racing settle. */
  async finalize(runId?: RunId): Promise<AgentEvent[]> {
    const rows = await this.#database
      .selectFrom("workspaceEvents as started")
      .selectAll("started")
      .where("started.type", "=", "tool.started")
      .where(sql<boolean>`started.data->'tool'->>'name' LIKE 'computer.%'`)
      .where("started.runnerOrdinal", "is", null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("workspaceEvents as completed")
              .select("completed.eventId")
              .whereRef("completed.runId", "=", "started.runId")
              .where("completed.type", "=", "tool.completed")
              .where(sql<boolean>`completed.data->>'callId' = started.data->>'callId'`),
          ),
        ),
      )
      .$if(runId !== undefined, (query) => query.where("started.runId", "=", runId!))
      .orderBy("started.sequence")
      .execute();
    const result: AgentEvent[] = [];
    for (const row of rows) {
      const event = AgentEventSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        sequence: String(row.sequence),
      });
      if (event.type !== "tool.started") continue;
      const completed = await this.complete(event, {
        status: "cancelled",
        headline: computerUseActHeadline({
          performed: [],
          stoppedBecause: "This step was cancelled.",
        }),
        performed: [],
      });
      if (completed) result.push(completed);
    }
    return result;
  }
}
