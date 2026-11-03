import { OpensteerError } from "@opensteer/core";
import {
  requiredTriggerToolField,
  triggerSourceFromInput,
  type TriggerControlInput,
  type TriggerWriteInput,
} from "@opensteer/triggers";
import type { AgentTriggerManager } from "../../agents/agent-control-service.js";
import { callerThread } from "../agent-caller.js";
import { idempotencyKey, operationId } from "../operations.js";
import type { ToolCall } from "./index.js";
export class TriggerToolHandlers {
  readonly triggers: AgentTriggerManager;
  constructor(triggers: AgentTriggerManager) {
    this.triggers = triggers;
  }
  async trigger_read({ caller, input }: ToolCall<"trigger_read">) {
    const context = { action: input.action, tool: "trigger_read" } as const;
    return this.triggers.manage(
      caller.userId,
      input.action === "list"
        ? {
            operation: "list",
            limit: input.limit,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          }
        : {
            operation: "get",
            triggerId: requiredTriggerToolField(input.triggerId, "triggerId", context),
            occurrenceLimit: input.occurrenceLimit,
          },
      callerThread(caller).id,
    );
  }
  async trigger_write({ caller, input, operationKey }: ToolCall<"trigger_write">) {
    const { operationKey: _operationKey, ...write } = input;
    const requestId = operationId(caller, operationKey, "trigger_write");
    const operation = triggerWriteOperation(
      write,
      idempotencyKey(caller, requestId, "trigger.create"),
    );
    return this.triggers.manage(caller.userId, operation, callerThread(caller).id);
  }
}
function triggerWriteOperation(write: TriggerWriteInput, requestId: string): TriggerControlInput {
  const context = { action: write.action, tool: "trigger_write" } as const;
  // The flat input is the union of every action's fields; a field the chosen
  // action would silently drop is refused so the caller learns it had no effect.
  const accepted: Readonly<Record<TriggerWriteInput["action"], readonly string[]>> = {
    cancel: ["occurrenceId", "triggerId"],
    create: ["anchorThreadId", "name", "program", "source"],
    run: ["payload", "triggerId"],
    set_next_fire: ["nextFireAt", "triggerId"],
    set_status: ["status", "triggerId"],
    update: ["expectedRevisionId", "name", "program", "source", "triggerId"],
  };
  const stray = Object.entries(write)
    .filter(
      ([field, value]) =>
        field !== "action" && value !== undefined && !accepted[write.action].includes(field),
    )
    .map(([field]) => field);
  if (stray.length > 0) {
    throw new OpensteerError({
      code: "bad_request",
      message: `trigger_write action "${write.action}" does not accept ${stray.join(", ")}`,
    });
  }
  switch (write.action) {
    case "create":
      return {
        anchorThreadId: requiredTriggerToolField(write.anchorThreadId, "anchorThreadId", context),
        // The model never chooses the key: the control service rewrites this
        // into a key scoped to the authority the call arrived with.
        idempotencyKey: requestId,
        name: requiredTriggerToolField(write.name, "name", context),
        operation: "create",
        program: requiredTriggerToolField(write.program, "program", context),
        source: triggerSourceFromInput(requiredTriggerToolField(write.source, "source", context)),
      };
    case "update":
      return {
        expectedRevisionId: requiredTriggerToolField(
          write.expectedRevisionId,
          "expectedRevisionId",
          context,
        ),
        ...(write.name === undefined ? {} : { name: write.name }),
        operation: "update",
        ...(write.program === undefined ? {} : { program: write.program }),
        ...(write.source === undefined ? {} : { source: triggerSourceFromInput(write.source) }),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "set_status":
      return {
        operation: "set_status",
        status: requiredTriggerToolField(write.status, "status", context),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "set_next_fire":
      return {
        operation: "set_next_fire",
        nextFireAt: requiredTriggerToolField(write.nextFireAt, "nextFireAt", context),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "run":
      return {
        operation: "run",
        ...(write.payload === undefined ? {} : { payload: write.payload }),
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
    case "cancel":
      return {
        ...(write.occurrenceId === undefined ? {} : { occurrenceId: write.occurrenceId }),
        operation: "cancel",
        triggerId: requiredTriggerToolField(write.triggerId, "triggerId", context),
      };
  }
}
