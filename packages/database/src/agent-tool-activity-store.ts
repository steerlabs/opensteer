import {
  OpensteerError,
  createToolOutput,
  type AgentEvent,
  type RunId,
  type ThreadId,
  type EnvironmentId,
  type ToolOutput,
} from "@opensteer/core";
import { sql, type Transaction, type Kysely } from "kysely";
import type { DeploymentEventRow } from "./schema.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { type HostDeploymentEventInput, eventFromRow } from "./deployment-events.js";

type Started = Extract<AgentEvent, { type: "tool.started" }>;
type Completed = Extract<AgentEvent, { type: "tool.completed" }>;
export interface AgentToolActivityContext {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly bindingGeneration: number;
}
/** The event fence serializes replay and completion, including after Host restart. */
export class AgentToolActivityStore<Schema> {
  readonly database: Kysely<Schema>;
  readonly append: (
    tx: Transaction<Schema>,
    input: HostDeploymentEventInput,
  ) => Promise<AgentEvent>;
  constructor(
    database: Kysely<Schema>,
    append: (tx: Transaction<Schema>, input: HostDeploymentEventInput) => Promise<AgentEvent>,
  ) {
    this.database = database;
    this.append = append;
  }

  async start(
    context: AgentToolActivityContext,
    callId: string,
    name: string,
    args: unknown,
  ): Promise<{
    started: Started;
    replay: boolean;
    completed: Completed | null;
  }> {
    if (!callId.startsWith(`harness:${context.runId}:${context.bindingGeneration}:`))
      throw new TypeError("Harness activity must name its Run attempt");
    return withPersonalTransaction(this.database, async (tx) => {
      const previous = (
        await sql<DeploymentEventRow>`select * from deployment_events where run_id = ${context.runId} and type in ('tool.started', 'tool.completed') and data->>'callId' = ${callId} order by sequence`.execute(
          tx,
        )
      ).rows;
      const events = previous.map(eventFromRow);
      const started = events.find((event): event is Started => event.type === "tool.started");
      if (started) {
        const equal = await sql<{
          equal: boolean;
        }>`select ${JSON.stringify(started.data.arguments)}::jsonb = ${JSON.stringify(args)}::jsonb as equal`.execute(
          tx,
        );
        if (started.data.tool.name !== name || !equal.rows[0]?.equal)
          throw new OpensteerError({
            code: "conflict",
            message: "This callId already names different tool arguments.",
          });
        return {
          started,
          replay: true,
          completed:
            events.find((event): event is Completed => event.type === "tool.completed") ?? null,
        };
      }
      const run = (
        await sql<{
          status: string;
          threadId: string;
          environmentId: string;
          bindingGeneration: number;
        }>`select status, thread_id, environment_id, binding_generation from runs where id = ${context.runId}`.execute(
          tx,
        )
      ).rows[0];
      if (
        !run ||
        !["starting", "running", "waiting"].includes(run.status) ||
        run.threadId !== context.threadId ||
        run.environmentId !== context.environmentId ||
        run.bindingGeneration !== context.bindingGeneration
      )
        throw new OpensteerError({ code: "forbidden", message: "Run tool authority has ended." });
      const event = await this.append(tx, {
        runId: context.runId,
        threadId: context.threadId,
        environmentId: context.environmentId,
        type: "tool.started",
        data: { callId, tool: { namespace: "opensteer", name }, arguments: args },
      });
      if (event.type !== "tool.started") throw new Error("Tool activity did not start");
      return { started: event, replay: false, completed: null };
    });
  }

  /** At startup or Run end, interrupted calls complete once without replaying effects. */
  async finalize(runId?: RunId): Promise<Completed[]> {
    const rows = (
      await sql<DeploymentEventRow>`select started.* from deployment_events started
      where started.type = 'tool.started' and started.data->>'callId' like 'harness:%'
      and (${runId ?? null}::text is null or started.run_id = ${runId ?? null})
      and not exists (select 1 from deployment_events completed where completed.run_id = started.run_id and completed.type = 'tool.completed' and completed.data->>'callId' = started.data->>'callId')`.execute(
        this.database,
      )
    ).rows;
    const completed: Completed[] = [];
    for (const row of rows) {
      const started = eventFromRow(row);
      if (started.type !== "tool.started") continue;
      completed.push(
        await this.complete(
          started,
          createToolOutput(
            JSON.stringify({
              content: [
                {
                  type: "text",
                  text: "Tool call interrupted; observe before repeating an effect.",
                },
              ],
              structuredContent: {
                error: {
                  code: "outcome_unknown",
                  message: "This tool call was interrupted.",
                  next: "Observe before repeating an effectful call.",
                },
              },
              isError: true,
            }),
          ),
          true,
        ),
      );
    }
    return completed;
  }

  async complete(started: Started, output: ToolOutput, isError: boolean): Promise<Completed> {
    return withPersonalTransaction(this.database, async (tx) => {
      const existing = (
        await sql<DeploymentEventRow>`select * from deployment_events where run_id = ${started.runId} and type = 'tool.completed' and data->>'callId' = ${started.data.callId}`.execute(
          tx,
        )
      ).rows[0];
      const event = existing
        ? eventFromRow(existing)
        : await this.append(tx, {
            runId: started.runId,
            threadId: started.threadId,
            environmentId: started.environmentId,
            type: "tool.completed",
            data: { callId: started.data.callId, output, isError },
          });
      if (event.type !== "tool.completed") throw new Error("Tool activity did not complete");
      return event;
    });
  }
}
