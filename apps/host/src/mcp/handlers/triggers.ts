import {
  OpensteerError,
  formatReferenceLink,
  TriggerIdSchema,
  RunIdSchema,
  type RequestId,
  type ThreadId,
  type TriggerId,
  type UserId,
} from "@opensteer/core";
import {
  beginAgentSession,
  commandAdmission,
  commandNotFoundMessage,
  type CommandIdentity,
  type CommandRequestOrigin,
  type DatabaseSchema,
} from "@opensteer/database";
import type { HostApiCommand } from "@opensteer/protocol";
import { commandTable, type CommandType } from "@opensteer/protocol/command-table";
import { triggerSourceFromInput, type TriggerControlInput } from "@opensteer/triggers";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
  agentAutomationTypes,
  agentCommandDoor,
  type AgentAutomationExecutor,
  type TriggerCommand,
} from "../../commands/agent-door.js";
import {
  dispatchCommand,
  type AgentCommandDoor,
  type AgentCommandOutcome,
  type CommandAuthority,
} from "../../commands/dispatch.js";
import type { CommandRegistry } from "../../commands/registry.js";
import {
  proposerLineageKey,
  type CommandProposer,
  type CommandRequestService,
} from "../../commands/requests.js";
import { callerLineage, callerThread, type AgentCaller } from "../agent-caller.js";
import { idempotencyKey, operationId } from "../operations.js";
import type { ToolCall } from "./types.js";

export interface AgentTriggerManager {
  manage(
    ownerId: UserId,
    input: TriggerControlInput,
    actorThreadId: ThreadId | null,
    context?: {
      readonly commandIdentity?: Pick<CommandIdentity, "admit">;
      readonly operationKey?: string;
      readonly originConnectionId?: string;
      readonly agentConnectionId?: string;
    },
  ): Promise<unknown>;
  setSecrets?(
    ownerId: UserId,
    input: {
      readonly remove?: readonly string[] | undefined;
      readonly set?: Readonly<Record<string, string>> | undefined;
      readonly triggerId: TriggerId;
    },
    actorThreadId: ThreadId | null,
    commandIdentity?: CommandIdentity | Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ): Promise<{ readonly secretNames: readonly string[] }>;
}

export interface TriggerLineage {
  readonly database?: Kysely<DatabaseSchema>;
  triggerOrigins(
    ownerId: UserId,
    ids: readonly TriggerId[],
  ): Promise<ReadonlyMap<TriggerId, string | null>>;
}

export interface TriggerToolHandlerOptions {
  readonly database?: Kysely<DatabaseSchema>;
  readonly requests?: () => CommandRequestService | undefined;
  readonly secretDigestKey?: Buffer;
  /** Unit-test seam when no PostgreSQL database is wired. */
  readonly door?: (caller: AgentCaller, registry: CommandRegistry) => AgentCommandDoor;
}

const personOnlyHandler = {
  accepts: "person" as const,
  run: async (): Promise<never> => {
    throw new OpensteerError({
      code: "internal",
      message: "Not an automation command",
    });
  },
};

export class TriggerToolHandlers implements AgentAutomationExecutor {
  readonly triggers: AgentTriggerManager;
  readonly lineage: TriggerLineage;
  readonly #database: Kysely<DatabaseSchema> | undefined;
  readonly #requests: () => CommandRequestService | undefined;
  readonly #secretDigestKey: Buffer | undefined;
  readonly #customDoor: TriggerToolHandlerOptions["door"];

  constructor(
    triggers: AgentTriggerManager,
    lineage: TriggerLineage,
    options?: TriggerToolHandlerOptions,
  ) {
    this.triggers = triggers;
    this.lineage = lineage;
    this.#database = options?.database ?? lineage.database;
    this.#requests = options?.requests ?? (() => undefined);
    this.#secretDigestKey = options?.secretDigestKey;
    this.#customDoor = options?.door;
  }

  #door(caller: AgentCaller, registry: CommandRegistry): AgentCommandDoor {
    if (this.#customDoor) return this.#customDoor(caller, registry);
    if (!this.#database)
      throw new OpensteerError({
        code: "internal",
        message: "Automation door has no database",
      });
    const database = this.#database;
    const requests = this.#requests();
    return agentCommandDoor({
      database,
      registry,
      secretDigestKey: this.#secretDigestKey ?? Buffer.alloc(0),
      ...(requests
        ? {
            propose: async (agent, command, ask, face) => {
              if (caller.kind === "connection") {
                const { session } = await beginAgentSession(database, {
                  userId: caller.userId,
                  agentConnectionId: caller.connectionId,
                });
                return requests.propose({
                  ownerUserId: agent.userId,
                  command,
                  ask,
                  face,
                  proposer: await triggerProposer(database, caller, session.threadId),
                  origin: { agentSessionId: session.id },
                  originatingThreadId: session.threadId,
                  callKey: (command as { idempotencyKey: string }).idempotencyKey,
                });
              }
              const origin: CommandRequestOrigin =
                caller.kind === "run"
                  ? { runId: caller.claims.runId }
                  : caller.program.kind === "watch"
                    ? { watchActivationId: caller.program.activationId }
                    : { occurrenceId: caller.program.occurrenceId };
              const originatingThreadId =
                caller.kind === "run" ? caller.thread.id : caller.anchor.id;
              return requests.propose({
                ownerUserId: agent.userId,
                command,
                ask,
                face,
                proposer: await triggerProposer(database, caller, originatingThreadId),
                origin,
                originatingThreadId,
                callKey: (command as { idempotencyKey: string }).idempotencyKey,
              });
            },
          }
        : {}),
    });
  }

  async execute(
    actor: AgentCaller,
    command: TriggerCommand,
    authority: CommandAuthority,
    options?: { readonly operationKey?: string; readonly ownTask?: true },
  ): Promise<unknown> {
    const actorThreadId = actor.kind === "connection" ? null : callerThread(actor).id;
    const lineage = callerLineage(actor);
    const context = {
      commandIdentity: authority.identity,
      operationKey: options?.operationKey ?? command.idempotencyKey,
      ...(lineage ? { agentConnectionId: lineage.agentConnectionId } : {}),
    };
    let control: TriggerControlInput;
    switch (command.type) {
      case "trigger.create":
        control = {
          operation: "create",
          anchorThreadId: command.input.anchorThreadId,
          idempotencyKey: command.idempotencyKey,
          name: command.input.name,
          script: command.input.script,
          source: command.input.source,
          ...(options?.ownTask ? { ownTask: true } : {}),
        };
        break;
      case "trigger.update":
        control = {
          operation: "update",
          triggerId: command.triggerId,
          expectedRevisionId: command.input.expectedRevisionId,
          ...(command.input.name === undefined ? {} : { name: command.input.name }),
          ...(command.input.script === undefined ? {} : { script: command.input.script }),
          ...(command.input.source === undefined ? {} : { source: command.input.source }),
        };
        break;
      case "trigger.status.set":
        control = {
          operation: "set_status",
          triggerId: command.triggerId,
          status: command.status,
        };
        break;
      case "trigger.run":
        control = {
          operation: "run",
          triggerId: command.triggerId,
          ...(command.payload === undefined ? {} : { payload: command.payload }),
        };
        break;
      case "trigger.cancel":
        control = {
          operation: "cancel",
          triggerId: command.triggerId,
          ...(command.occurrenceId === undefined ? {} : { occurrenceId: command.occurrenceId }),
        };
        break;
      case "trigger.secrets.set": {
        if (!this.triggers.setSecrets) {
          throw new OpensteerError({
            code: "internal",
            message: "Automation secrets are unavailable.",
          });
        }
        const updated = await this.triggers.setSecrets(
          actor.userId,
          {
            triggerId: command.triggerId,
            ...(command.clearAll === true ? { clearAll: true as const } : {}),
            ...(command.remove === undefined ? {} : { remove: command.remove }),
            ...(command.set === undefined ? {} : { set: command.set }),
          },
          actorThreadId,
          context.commandIdentity,
          context.agentConnectionId,
        );
        return {
          secretNames: [...updated.secretNames],
          type: command.type,
        };
      }
      default:
        throw new OpensteerError({ code: "internal", message: "Unexpected automation command" });
    }
    const result = await this.triggers.manage(actor.userId, control, actorThreadId, context);
    if (command.type === "trigger.status.set") return { trigger: result };
    return result;
  }

  #registry(writeKey: string, ownTask?: true): CommandRegistry {
    return Object.fromEntries(
      (Object.keys(commandTable) as CommandType[]).map((type) => [
        type,
        agentAutomationTypes.has(type)
          ? {
              accepts: "any" as const,
              run: async (
                actor: { readonly kind: string },
                command: HostApiCommand,
                extra: { readonly authority: CommandAuthority | null },
              ) => {
                if (actor.kind === "person" || !extra.authority)
                  throw new OpensteerError({ code: "internal", message: "Not the person's door" });
                return this.execute(
                  actor as AgentCaller,
                  command as TriggerCommand,
                  extra.authority,
                  { operationKey: writeKey, ...(ownTask ? { ownTask } : {}) },
                );
              },
            }
          : personOnlyHandler,
      ]),
    ) as unknown as CommandRegistry;
  }

  async read(call: ToolCall<"opensteer_automation_list"> | ToolCall<"opensteer_automation_read">) {
    const { caller, input } = call;
    const lineage = callerLineage(caller);
    const door =
      this.#customDoor || this.#database ? this.#door(caller, this.#registry("read")) : undefined;
    if ("automationId" in input && door) {
      const admission = await door.admit(caller, {
        type: "trigger.cancel",
        idempotencyKey: "read",
        triggerId: input.automationId,
      });
      if (admission.answer === "not_found")
        throw new OpensteerError({ code: "not_found", message: "Automation not found" });
    }
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
        lineage?.grant.scope === "selected"
          ? { originConnectionId: lineage.agentConnectionId }
          : undefined,
      ),
    );
    const hasWebhook = (item: Record<string, unknown>) =>
      Boolean(item["webhookRouteKey"]) || Boolean(item["webhook"]);
    const webhookIds = new Set<TriggerId>();
    if (
      output.trigger &&
      (hasWebhook(output.trigger) || Boolean("webhook" in output && output.webhook))
    )
      webhookIds.add(output.trigger.id);
    for (const item of output.triggers ?? []) {
      if (hasWebhook(item)) webhookIds.add(item.id);
    }
    const needsOrigins = Boolean(lineage) || webhookIds.size > 0;
    const origins =
      needsOrigins && output.triggers
        ? await this.lineage.triggerOrigins(
            caller.userId,
            output.triggers.map(({ id }) => id),
          )
        : needsOrigins && output.trigger
          ? await this.lineage.triggerOrigins(caller.userId, [output.trigger.id])
          : undefined;
    const webhookAllowed = new Map<TriggerId, boolean>();
    for (const id of webhookIds) {
      if (!door) {
        webhookAllowed.set(id, false);
        continue;
      }
      const admission = await door
        .admit(caller, {
          type: "trigger.run",
          idempotencyKey: "read-webhook",
          triggerId: id,
        })
        .catch(() => ({ answer: "ask" as const }));
      // Until the door enforces own-lineage for your own agents, also redact foreign-lineage webhooks.
      const ownLineage = lineage
        ? origins?.get(id) === lineage.agentConnectionId
        : origins !== undefined && (origins.get(id) ?? null) === null;
      webhookAllowed.set(id, admission.answer === "now" && ownLineage);
    }
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
      if (webhookAllowed.get(item.id)) return item;
      const next: Record<string, unknown> = { ...item };
      if ("webhookRouteKey" in item && item.webhookRouteKey) next.webhookRouteKey = null;
      if ("webhook" in item && item.webhook) next.webhook = redactWebhookField(item.webhook);
      return next as T;
    };
    if (output.trigger) {
      const allowed = webhookAllowed.get(output.trigger.id) ?? false;
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
    const writeKey = idempotencyKey(caller, requestId, "trigger.write");
    const actorThreadId = caller.kind === "connection" ? null : callerThread(caller).id;
    const lineage = callerLineage(caller);

    if ("action" in input && input.action === "reschedule") {
      const admitCmd: HostApiCommand = {
        type: "trigger.status.set",
        idempotencyKey: writeKey,
        triggerId: input.automationId,
        status: "active",
      };
      const door = this.#door(caller, this.#registry(writeKey));
      const admission = await door.admit(caller, admitCmd);
      if (admission.answer === "not_found")
        throw new OpensteerError({ code: "not_found", message: commandNotFoundMessage });
      if (admission.answer === "ask") throw askAsForbidden(admission.reason);
      const updated = await this.triggers.manage(
        caller.userId,
        {
          operation: "set_next_fire",
          triggerId: input.automationId,
          nextFireAt: input.nextFireAt!,
        },
        actorThreadId,
        {
          commandIdentity: commandAdmission({
            ownerUserId: caller.userId,
            // As the door just admitted it.
            subject: admission.execution!.subject,
            command: admitCmd,
          }),
          operationKey: writeKey,
          ...(lineage ? { agentConnectionId: lineage.agentConnectionId } : {}),
        },
      );
      return automationOutput({ trigger: updated });
    }

    let command: HostApiCommand;
    let ownTask: true | undefined;
    if (!("automationId" in input)) {
      const anchor =
        input.taskId ?? (caller.kind === "connection" ? undefined : callerThread(caller).id);
      if (!anchor)
        throw new OpensteerError({ code: "bad_request", message: "Connections must name taskId" });
      ownTask = input.ownTask ? true : undefined;
      command = {
        type: "trigger.create",
        idempotencyKey: idempotencyKey(caller, requestId, "trigger.create"),
        input: {
          anchorThreadId: anchor,
          name: input.name,
          script: { interpreter: input.script.interpreter ?? null, text: input.script.text },
          source: triggerSourceFromInput(input.source),
        },
      };
    } else if (!("action" in input)) {
      command = {
        type: "trigger.update",
        idempotencyKey: writeKey,
        triggerId: input.automationId,
        input: {
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
        },
      };
    } else {
      const triggerId = input.automationId;
      switch (input.action) {
        case "pause":
        case "resume":
        case "archive":
          command = {
            type: "trigger.status.set",
            idempotencyKey: writeKey,
            triggerId,
            status:
              input.action === "pause"
                ? "paused"
                : input.action === "resume"
                  ? "active"
                  : "archived",
          };
          break;
        case "run_now":
          command = {
            type: "trigger.run",
            idempotencyKey: writeKey,
            triggerId,
            ...(input.payload === undefined ? {} : { payload: input.payload }),
          };
          break;
        case "cancel_pending":
          command = {
            type: "trigger.cancel",
            idempotencyKey: writeKey,
            triggerId,
            ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId }),
          };
          break;
        default:
          throw new OpensteerError({ code: "internal", message: "Unexpected automation action" });
      }
    }

    const outcome = await dispatchCommand(
      caller,
      command,
      this.#door(caller, this.#registry(writeKey, ownTask)),
    );
    return toToolWriteResult(outcome);
  }
}

function askAsForbidden(reason: string | undefined): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    reason: "asks-person",
    message:
      reason === "lineage"
        ? "Only the person or an agent in this automation's own lineage can change or run it."
        : "Full access is required to change or run an automation; pause, archive, resume, reschedule, and cancel stay available.",
  });
}

function toToolWriteResult(outcome: AgentCommandOutcome) {
  switch (outcome.status) {
    case "done":
      return automationOutput(outcome.output);
    case "pending":
      return {
        status: "pending" as const,
        requestId: outcome.requestId as RequestId,
        next: "The person decides in Opensteer. Read it with opensteer_request_read; it may be changed before it is approved.",
      };
    case "answered":
      return {
        status: "answered" as const,
        requestId: outcome.requestId as RequestId,
        outcome: outcome.outcome,
      };
    case "ask":
      throw askAsForbidden(outcome.reason);
    default:
      return { status: outcome.status, requestId: outcome.requestId as RequestId };
  }
}

async function triggerProposer(
  database: Kysely<DatabaseSchema>,
  caller: AgentCaller,
  taskId: ThreadId,
): Promise<CommandProposer> {
  const task = await database
    .selectFrom("threads")
    .select(["title", "harnessInstanceId"])
    .where("id", "=", taskId)
    .executeTakeFirst();
  const connectionId =
    caller.kind === "connection" ? caller.connectionId : caller.agentConnection?.agentConnectionId;
  const connection = connectionId
    ? await database
        .selectFrom("agentConnections")
        .select(["label", "grantRevision"])
        .where("id", "=", connectionId)
        .executeTakeFirst()
    : undefined;
  const name =
    caller.kind === "connection"
      ? (connection?.label ?? "A connected agent")
      : caller.kind === "program"
        ? ((
            await database
              .selectFrom("triggers")
              .select("name")
              .where(
                "id",
                "=",
                caller.program.kind === "watch"
                  ? caller.program.triggerId
                  : (
                      await database
                        .selectFrom("triggerOccurrences")
                        .select("triggerId")
                        .where("id", "=", caller.program.occurrenceId)
                        .executeTakeFirstOrThrow()
                    ).triggerId,
              )
              .executeTakeFirst()
          )?.name ?? "An automation")
        : ((
            await database
              .selectFrom("harnessInstances")
              .select("name")
              .where("id", "=", task?.harnessInstanceId ?? ("" as never))
              .executeTakeFirst()
          )?.name ?? "Your agent");
  return {
    kind: caller.kind,
    name: name.slice(0, 200),
    taskTitle: task?.title?.slice(0, 240) ?? null,
    key: await proposerLineageKey(database, caller),
    ...(connectionId && connection
      ? { connectionId, grantRevision: connection.grantRevision }
      : {}),
  };
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
