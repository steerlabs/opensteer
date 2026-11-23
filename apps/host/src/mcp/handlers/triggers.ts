import {
  OpensteerError,
  formatReferenceLink,
  TriggerIdSchema,
  RunIdSchema,
  type TriggerId,
  type UserId,
  type ThreadId,
} from "@opensteer/core";
import { triggerSourceFromInput, type TriggerControlInput } from "@opensteer/triggers";
import { z } from "zod";
import { callerLineage, callerThread } from "../agent-caller.js";
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
      readonly originConnectionId?: string;
      readonly agentConnectionId?: string;
    },
  ): Promise<unknown>;
}

export interface TriggerLineage {
  admitExecution?: (input: {
    readonly ownerUserId: UserId;
    readonly subject:
      | { readonly kind: "binding"; readonly bindingId: string }
      | { readonly kind: "connection"; readonly agentConnectionId: string };
  }) => Promise<{ readonly mode: import("@opensteer/core").ThreadAccessMode }>;
  triggerOrigins(
    ownerId: UserId,
    ids: readonly TriggerId[],
  ): Promise<ReadonlyMap<TriggerId, string | null>>;
}

export class TriggerToolHandlers {
  readonly triggers: AgentTriggerManager;
  readonly lineage: TriggerLineage;
  constructor(triggers: AgentTriggerManager, lineage: TriggerLineage) {
    this.triggers = triggers;
    this.lineage = lineage;
  }
  /**
   * A selected grant sees only automations in its own lineage, and no connected agent replaces
   * the program of an automation outside its lineage: that program would run with authority the
   * connection does not hold.
   */
  async #assertLineage(
    caller: ToolCall<"opensteer_automation_read">["caller"],
    id: TriggerId,
    program: boolean,
  ) {
    const lineage = callerLineage(caller);
    if (!lineage) return;
    const origin = (await this.lineage.triggerOrigins(caller.userId, [id])).get(id) ?? null;
    if (lineage.grant.scope === "selected" && origin !== lineage.agentConnectionId)
      throw new OpensteerError({ code: "not_found", message: "Automation not found" });
    if (program && origin !== lineage.agentConnectionId)
      throw new OpensteerError({
        code: "forbidden",
        message: "A connected agent cannot replace the program of an automation it did not create.",
      });
  }
  async read(call: ToolCall<"opensteer_automation_list"> | ToolCall<"opensteer_automation_read">) {
    const { caller, input } = call;
    if ("automationId" in input) await this.#assertLineage(caller, input.automationId, false);
    const lineage = callerLineage(caller);
    const output = automationOutput(
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
        {
          accessMode: caller.accessMode,
          ...(lineage?.grant.scope === "selected"
            ? { originConnectionId: lineage.agentConnectionId }
            : {}),
        },
      ),
    );
    const hasWebhook = (item: Record<string, unknown>) =>
      Boolean(item["webhookRouteKey"]) || Boolean(item["webhook"]);
    const needsOrigins =
      Boolean(lineage) ||
      (output.trigger !== undefined &&
        (hasWebhook(output.trigger) || Boolean("webhook" in output && output.webhook))) ||
      (output.triggers?.some(hasWebhook) ?? false);
    // The store already scoped the page; this keeps any other path honest and checks lineage for webhook addresses.
    const origins =
      needsOrigins && output.triggers
        ? await this.lineage.triggerOrigins(
            caller.userId,
            output.triggers.map(({ id }) => id),
          )
        : needsOrigins && output.trigger
          ? await this.lineage.triggerOrigins(caller.userId, [output.trigger.id])
          : undefined;
    const liveAccessMode = this.lineage.admitExecution
      ? await this.lineage
          .admitExecution({
            ownerUserId: caller.userId,
            subject:
              caller.kind === "connection"
                ? { kind: "connection", agentConnectionId: caller.connectionId }
                : { kind: "binding", bindingId: caller.key },
          })
          .then((result) => result.mode)
          .catch(() => null)
      : null;
    const canSeeWebhook = (id: TriggerId): boolean => {
      if (liveAccessMode !== "full-access") return false;
      if (!lineage) return origins !== undefined && (origins.get(id) ?? null) === null;
      return origins?.get(id) === lineage.agentConnectionId;
    };
    const redactWebhookField = (webhook: unknown) => {
      if (webhook && typeof webhook === "object" && "scope" in webhook) {
        return { ...(webhook as Record<string, unknown>), url: null };
      }
      return webhook;
    };
    const redactWebhook = <
      T extends {
        readonly id: TriggerId;
        readonly webhookRouteKey?: unknown;
        readonly webhook?: unknown;
      },
    >(
      item: T,
    ): T => {
      if (canSeeWebhook(item.id)) return item;
      const next: Record<string, unknown> = { ...item };
      if ("webhookRouteKey" in item && item.webhookRouteKey) next.webhookRouteKey = null;
      if ("webhook" in item && item.webhook) next.webhook = redactWebhookField(item.webhook);
      return next as T;
    };
    if (output.trigger) {
      const allowed = canSeeWebhook(output.trigger.id);
      return {
        ...output,
        trigger: redactWebhook(output.trigger),
        ...("webhook" in output && output.webhook && !allowed
          ? { webhook: redactWebhookField(output.webhook) }
          : {}),
      };
    }
    if (!output.triggers) return output;
    const visible =
      lineage?.grant.scope === "selected"
        ? output.triggers.filter(({ id }) => origins?.get(id) === lineage.agentConnectionId)
        : output.triggers;
    return {
      ...output,
      triggers: visible.map(redactWebhook),
    };
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
    if ("automationId" in input)
      await this.#assertLineage(
        caller,
        input.automationId,
        !("action" in input) && (input.script !== undefined || input.source !== undefined),
      );
    else if (input.ownTask && callerLineage(caller)?.grant.scope === "selected")
      throw new OpensteerError({
        code: "bad_request",
        message: "Name the taskId of one of your tasks for this automation.",
      });
    if (!("automationId" in input)) {
      const anchor =
        input.taskId ?? (caller.kind === "connection" ? undefined : callerThread(caller).id);
      if (!anchor)
        throw new OpensteerError({ code: "bad_request", message: "Connections must name taskId" });
      operation = {
        operation: "create",
        anchorThreadId: anchor,
        name: input.name,
        script: { interpreter: input.script.interpreter ?? null, text: input.script.text },
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
        ...(input.script === undefined
          ? {}
          : {
              script: {
                interpreter: input.script.interpreter ?? null,
                text: input.script.text,
              },
            }),
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
          // Persisted on a new automation and rechecked under the store's own fence.
          ...(callerLineage(caller)
            ? { agentConnectionId: callerLineage(caller)!.agentConnectionId }
            : {}),
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
