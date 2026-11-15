import {
  OpensteerError,
  formatReferenceLink,
  TriggerIdSchema,
  RunIdSchema,
  type UserId,
  type ThreadId,
} from "@opensteer/core";
import { triggerSourceFromInput, type TriggerControlInput } from "@opensteer/triggers";
import { z } from "zod";
import { callerThread } from "../agent-caller.js";
import { idempotencyKey, operationId } from "../operations.js";
import type { ToolCall } from "./types.js";
export interface AgentTriggerManager {
  manage(
    ownerId: UserId,
    input: TriggerControlInput,
    actorThreadId: ThreadId | null,
    context?: {
      readonly accessMode: import("@opensteer/core").ThreadAccessMode;
      readonly operationKey?: string;
    },
  ): Promise<unknown>;
}

export class TriggerToolHandlers {
  readonly triggers: AgentTriggerManager;
  constructor(triggers: AgentTriggerManager) {
    this.triggers = triggers;
  }
  async read(call: ToolCall<"opensteer_automation_list"> | ToolCall<"opensteer_automation_read">) {
    const { caller, input } = call;
    return automationOutput(
      await this.triggers.manage(
        caller.userId,
        "automationId" in input
          ? {
              operation: "get",
              triggerId: input.automationId,
              occurrenceLimit: input.occurrenceLimit,
            }
          : {
              operation: "list",
              limit: input.limit,
              ...(input.systemRole ? { systemRole: input.systemRole } : {}),
            },
        caller.kind === "connection" ? null : callerThread(caller).id,
        { accessMode: caller.accessMode },
      ),
    );
  }
  async write(
    call:
      | ToolCall<"opensteer_automation_create">
      | ToolCall<"opensteer_automation_update">
      | ToolCall<"opensteer_automation_control">,
  ) {
    const { caller, input, operationKey } = call;
    const requestId = operationId(
      caller,
      operationKey,
      !("automationId" in input)
        ? "opensteer_automation_create"
        : "action" in input
          ? "opensteer_automation_control"
          : "opensteer_automation_update",
    );
    let operation: TriggerControlInput;
    if (!("automationId" in input)) {
      const anchor =
        input.taskId ?? (caller.kind === "connection" ? undefined : callerThread(caller).id);
      if (!anchor)
        throw new OpensteerError({ code: "bad_request", message: "Connections must name taskId" });
      operation = {
        operation: "create",
        anchorThreadId: anchor,
        name: input.name,
        program: input.program,
        source: triggerSourceFromInput(input.source),
        ...(input.ownTask ? { ownTask: true } : {}),
        idempotencyKey: idempotencyKey(caller, requestId, "trigger.create"),
      };
    } else if (!("action" in input)) {
      operation = {
        operation: "update",
        triggerId: input.automationId,
        expectedRevisionId: input.expectedRevisionId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.program === undefined ? {} : { program: input.program }),
        ...(input.source === undefined ? {} : { source: triggerSourceFromInput(input.source) }),
      };
    } else {
      const triggerId = input.automationId;
      switch (input.action) {
        case "pause":
        case "resume":
        case "archive":
          operation = {
            operation: "set_status",
            triggerId,
            status:
              input.action === "pause"
                ? "paused"
                : input.action === "resume"
                  ? "active"
                  : "archived",
          };
          break;
        case "reschedule":
          operation = { operation: "set_next_fire", triggerId, nextFireAt: input.nextFireAt! };
          break;
        case "run_now":
          operation = {
            operation: "run",
            triggerId,
            ...(input.payload === undefined ? {} : { payload: input.payload }),
          };
          break;
        case "cancel_pending":
          operation = {
            operation: "cancel",
            triggerId,
            ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId }),
          };
          break;
      }
    }
    return automationOutput(
      await this.triggers.manage(
        caller.userId,
        operation,
        caller.kind === "connection" ? null : callerThread(caller).id,
        {
          accessMode: caller.accessMode,
          operationKey: idempotencyKey(caller, requestId, "trigger.write"),
        },
      ),
    );
  }
}

const automation = z.looseObject({ id: TriggerIdSchema, name: z.string() });
const automationResult = z.looseObject({
  trigger: automation.optional(),
  triggers: z.array(automation).optional(),
  downstreamRuns: z
    .array(
      z.looseObject({
        run: z.looseObject({ id: RunIdSchema, runOrdinal: z.number() }),
        threadTitle: z.string(),
      }),
    )
    .optional(),
});
function automationOutput(value: unknown) {
  const result = automationResult.parse(value);
  return {
    ...result,
    ...(result.trigger
      ? {
          trigger: {
            ...result.trigger,
            link: formatReferenceLink(result.trigger.id, result.trigger.name),
          },
        }
      : {}),
    ...(result.triggers
      ? {
          triggers: result.triggers.map((trigger) => ({
            ...trigger,
            link: formatReferenceLink(trigger.id, trigger.name),
          })),
        }
      : {}),
    ...(result.downstreamRuns
      ? {
          downstreamRuns: result.downstreamRuns.map((row) => ({
            ...row,
            run: {
              ...row.run,
              link: formatReferenceLink(
                row.run.id,
                `Run ${row.run.runOrdinal} · ${row.threadTitle}`,
              ),
            },
          })),
        }
      : {}),
  };
}
