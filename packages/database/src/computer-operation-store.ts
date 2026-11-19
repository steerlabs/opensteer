import { computerUseActHeadline } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  createToolOutput,
  computerToolNamespace,
  type EnvironmentId,
  type IntegrationCallSubject,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  completePersonalHostToolCall,
  startPersonalToolCall,
  type HostToolEffectHandle,
} from "./personal-tool-calls.js";
import { interruptOpenHostTools } from "./agent-tool-activity-store.js";

interface Context {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
}
export type ComputerOperationStatus = "succeeded" | "failed" | "cancelled";

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
  }): Promise<HostToolEffectHandle> {
    const { context } = input;
    const callId = `computer:${randomUUID()}`;
    return commitPersonalMutation(this.#database, async (tx, mutation) => {
      const run = await tx
        .selectFrom("runs")
        .select(["threadId", "environmentId", "bindingGeneration"])
        .where("id", "=", context.runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!run || run.threadId !== context.threadId || run.environmentId !== context.environmentId)
        throw new OpensteerError({
          code: "forbidden",
          message: "Computer operation is outside its Run",
        });
      const attempt =
        run.bindingGeneration === null
          ? null
          : await tx
              .selectFrom("runAttempts")
              .select("id")
              .where("runId", "=", context.runId)
              .where("bindingGeneration", "=", run.bindingGeneration)
              .where("status", "=", "current")
              .where("endedAt", "is", null)
              .limit(1)
              .executeTakeFirst();
      const result = await startPersonalToolCall(tx, mutation, {
        ...context,
        attemptId: attempt?.id ?? null,
        bindingGeneration: run.bindingGeneration,
        nodeId: null,
        callId,
        origin: "host-computer",
        tool: { namespace: computerToolNamespace, name: `computer.${input.operation}` },
        arguments: input.window === undefined ? {} : { window: input.window },
        integration: input.subject,
      });
      if (!result.started || !result.handle) throw new Error("Computer operation did not start");
      return result.handle;
    });
  }

  async complete(
    handle: HostToolEffectHandle,
    input: {
      readonly status: ComputerOperationStatus;
      readonly headline: string;
      readonly performed: readonly string[];
    },
  ): Promise<void> {
    await commitPersonalMutation(this.#database, (tx, mutation) =>
      completePersonalHostToolCall(tx, mutation, handle, {
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
      }),
    );
  }

  async finalize(runId?: RunId) {
    await interruptOpenHostTools(this.#database, "host-computer", runId);
  }
}
