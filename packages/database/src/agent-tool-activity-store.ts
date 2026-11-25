import { redactToolArgumentsForStorage } from "@opensteer/protocol/command-table";
import {
  OpensteerError,
  type RunId,
  type ThreadId,
  type EnvironmentId,
  type ToolOutput,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  completePersonalHostToolCall,
  interruptPersonalToolCalls,
  startPersonalToolCall,
  type HostToolEffectHandle,
} from "./personal-tool-calls.js";

export interface AgentToolActivityContext {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly bindingGeneration: number;
}

export class AgentToolActivityStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  async start(
    context: AgentToolActivityContext,
    callId: string,
    name: string,
    args: unknown,
    argumentDigest?: Buffer,
  ) {
    if (!callId.startsWith(`harness:${context.runId}:${context.bindingGeneration}:`))
      throw new TypeError("Harness activity must name its Run attempt");
    return commitPersonalMutation(this.#database, async (tx, mutation) => {
      const run = await tx
        .selectFrom("runs")
        .select(["status", "bindingGeneration", "threadId", "environmentId", "finishIntent"])
        .where("id", "=", context.runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !run ||
        run.finishIntent ||
        !["starting", "running", "waiting"].includes(run.status) ||
        run.threadId !== context.threadId ||
        run.environmentId !== context.environmentId ||
        run.bindingGeneration !== context.bindingGeneration
      )
        throw new OpensteerError({ code: "forbidden", message: "Run tool authority has ended." });
      const attempt = await tx
        .selectFrom("runAttempts")
        .select("id")
        .where("runId", "=", context.runId)
        .where("bindingGeneration", "=", context.bindingGeneration)
        .where("status", "=", "current")
        .where("endedAt", "is", null)
        .limit(1)
        .executeTakeFirst();
      if (!attempt)
        throw new OpensteerError({ code: "forbidden", message: "Run tool attempt has ended." });
      const origin = "host-harness";
      const result = await startPersonalToolCall(tx, mutation, {
        ...context,
        attemptId: attempt.id,
        nodeId: null,
        callId,
        origin,
        tool: { namespace: "opensteer", name },
        arguments: redactToolArgumentsForStorage(args),
        ...(argumentDigest ? { argumentDigest } : {}),
      });
      return {
        handle: { toolCallId: result.call.id, origin } satisfies HostToolEffectHandle,
        replay: !result.started,
        completed:
          result.call.status === "completed" && result.call.output
            ? { output: result.call.output, isError: result.call.isError === true }
            : null,
      };
    });
  }

  async complete(handle: HostToolEffectHandle, output: ToolOutput, isError: boolean) {
    return commitPersonalMutation(this.#database, (tx, mutation) =>
      completePersonalHostToolCall(tx, mutation, handle, { output, isError }),
    );
  }

  async finalize(runId?: RunId) {
    await interruptOpenHostTools(this.#database, "host-harness", runId);
  }
}

export async function interruptOpenHostTools(
  database: Kysely<DatabaseSchema>,
  origin: HostToolEffectHandle["origin"],
  runId?: RunId,
) {
  let remaining: boolean;
  do {
    remaining = await commitPersonalMutation(database, async (tx, mutation) => {
      const rows = await tx
        .selectFrom("toolCalls")
        .select(["id", "runId"])
        .where("origin", "=", origin)
        .where(sql<boolean>`status='open'`)
        .$if(runId !== undefined, (query) => query.where("runId", "=", runId!))
        .orderBy("runId")
        .orderBy("id")
        .limit(129)
        .execute();
      const runs = new Map<RunId, string[]>();
      for (const row of rows.slice(0, 128)) {
        const ids = runs.get(row.runId) ?? [];
        ids.push(row.id);
        runs.set(row.runId, ids);
      }
      for (const [id, toolIds] of runs) {
        await tx
          .selectFrom("runs")
          .select("id")
          .where("id", "=", id)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await interruptPersonalToolCalls(tx, mutation, id, toolIds);
      }
      return rows.length > 128;
    });
  } while (remaining);
}
