import {
  AgentGrantTargetSchema,
  OpensteerError,
  type RequestId,
  type ThreadId,
} from "@opensteer/core";
import {
  commandGrantScope,
  commandGrantTarget,
  commandHeld,
  commandNotFoundMessage,
  commandRule,
  type CommandRequestOrigin,
  type DatabaseSchema,
} from "@opensteer/database";
import { hostApi, type HostApiCommand } from "@opensteer/protocol";
import {
  commandFaceStep,
  commandFamilies,
  commandRow,
  commandTable,
  type CommandResource,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import { commandTitles } from "@opensteer/protocol/command-words";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { AgentSessionService } from "../../agent-sessions/agent-session-service.js";
import { agentCommandDoor } from "../../commands/agent-door.js";
import {
  agentCommandScope,
  dispatchCommand,
  type AgentCommandOutcome,
} from "../../commands/dispatch.js";
import type { CommandRegistry } from "../../commands/registry.js";
import {
  proposerLineageKey,
  type CommandProposer,
  type CommandRequestService,
} from "../../commands/requests.js";
import type { AgentCaller } from "../agent-caller.js";
import { operationId } from "../operations.js";
import type { AdministrationToolHandlers } from "./administration.js";
import { requireDirectWork } from "./direct.js";
import type { ToolCall } from "./types.js";

type Answer = "now" | "ask" | "now or ask";
const notFound = () => new OpensteerError({ code: "not_found", message: commandNotFoundMessage });

/** Each command type's own schemas, by type. */
const variants = (() => {
  const byType = new Map<string, z.ZodObject[]>();
  for (const option of (
    hostApi["commands.dispatch"].payload as unknown as z.ZodUnion<z.ZodObject[]>
  ).options) {
    const type = (option.shape.type as z.ZodLiteral<string>).value;
    byType.set(type, [...(byType.get(type) ?? []), option]);
  }
  return byType;
})();

/**
 * The three tools for Home commands. What a caller may change is listed from the one rule, cut
 * to what it holds; a command goes through the one door, and a connection's call is one recorded
 * operation of its session (`AgentSessionService.run`).
 */
export class CommandTools {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #registry: CommandRegistry;
  readonly #requests: () => CommandRequestService | undefined;
  readonly #sessions: AgentSessionService | undefined;
  readonly #administration: AdministrationToolHandlers;
  constructor(options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly registry: CommandRegistry;
    readonly requests: () => CommandRequestService | undefined;
    readonly sessions?: AgentSessionService | undefined;
    readonly administration: AdministrationToolHandlers;
  }) {
    this.#database = options.database;
    this.#registry = options.registry;
    this.#requests = options.requests;
    this.#sessions = options.sessions;
    this.#administration = options.administration;
  }

  /** What this caller holds, and how the Home answers each: from the rule, cut to the caller. */
  async #held(caller: AgentCaller) {
    const scope = await agentCommandScope(this.#database)(caller);
    if (scope === "gone") return [];
    const connection = scope ? { grant: scope } : null;
    const grant = caller.kind === "connection" ? caller.grant : caller.agentConnection?.grant;
    return (Object.keys(commandTable) as CommandType[]).flatMap((type) => {
      const row = commandRow(type) as CommandRow;
      if (!commandHeld(row, { connection, mode: caller.accessMode })) return [];
      // A selected grant lists only what it could name: nothing of a kind it does not hold.
      if (scope === "selected" && grant?.scope === "selected" && !selectedCovers(type, row, grant))
        return [];
      const answers = new Set<"now" | "ask">();
      row.faces.forEach((_, face) => {
        for (const own of [true, false]) {
          const rule = commandRule(row, face, {
            connection,
            mode: caller.accessMode,
            reach: true,
            ownWork: own,
            ownLineage: own,
          });
          if (rule.answer === "not_found") continue;
          const step = commandFaceStep(row, face, {
            connection: connection !== null,
            selected: scope === "selected",
          });
          // A `now` whose handler is still the person's waits for the person too.
          answers.add(
            rule.answer === "now" && step === "A" && this.#registry[type].accepts === "any"
              ? "now"
              : "ask",
          );
        }
      });
      const answer: Answer = answers.size === 2 ? "now or ask" : answers.has("now") ? "now" : "ask";
      return [{ type, family: row.family, title: commandTitles[type], answer }];
    });
  }

  async opensteer_commands({ caller, input }: ToolCall<"opensteer_commands">) {
    const held = await this.#held(caller);
    if (input.type) {
      const found = held.find((entry) => entry.type === input.type);
      if (!found) throw notFound();
      const row = commandRow(found.type) as CommandRow;
      const omitted = Object.fromEntries(
        ["idempotencyKey", ...(row.secretFields ?? []).filter((path) => !path.includes("."))].map(
          (key) => [key, true],
        ),
      );
      const schemas = (variants.get(found.type) ?? []).map((variant) =>
        z.toJSONSchema(
          variant.omit(
            Object.fromEntries(
              Object.keys(omitted)
                .filter((key) => key in variant.shape)
                .map((key) => [key, true]),
            ) as never,
          ),
          { io: "input", unrepresentable: "any" },
        ),
      );
      return {
        type: found.type,
        title: found.title,
        answer: found.answer,
        input: (schemas.length === 1 ? schemas[0]! : { anyOf: schemas }) as Record<string, unknown>,
      };
    }
    if (input.family) {
      const commands = held.filter((entry) => entry.family === input.family);
      if (!commands.length) throw notFound();
      return {
        family: input.family,
        commands: commands.map(({ type, title, answer }) => ({ type, title, answer })),
      };
    }
    return {
      families: commandFamilies.flatMap((family) => {
        const commands = held.filter((entry) => entry.family === family);
        return commands.length
          ? [
              {
                family,
                title: family,
                now: commands.filter((entry) => entry.answer !== "ask").length,
                ask: commands.filter((entry) => entry.answer !== "now").length,
              },
            ]
          : [];
      }),
    };
  }

  async opensteer_command({ caller, input, operationKey }: ToolCall<"opensteer_command">) {
    const requests = this.#requests();
    if ((input.command === undefined) === (input.withdraw === undefined))
      throw new OpensteerError({
        code: "bad_request",
        message: "Send a command or withdraw a Request, one of them.",
      });
    if (input.withdraw) {
      if (!requests) throw notFound();
      return requests.withdraw({
        ownerUserId: caller.userId,
        requestId: input.withdraw as RequestId,
        proposerKey: await proposerLineageKey(this.#database, caller),
      });
    }
    const command = {
      ...input.command,
      idempotencyKey: operationId(caller, operationKey, "opensteer_command"),
    } as unknown as HostApiCommand;
    const reason = input.reason;
    if (caller.kind !== "connection") {
      const origin: CommandRequestOrigin =
        caller.kind === "run"
          ? { runId: caller.claims.runId }
          : caller.program.kind === "watch"
            ? { watchActivationId: caller.program.activationId }
            : { occurrenceId: caller.program.occurrenceId };
      const task = caller.kind === "run" ? caller.thread : caller.anchor;
      return tooled(
        await dispatchCommand(caller, command, this.#door(caller, origin, task.id, reason)),
      );
    }
    // A connected agent's command is one recorded operation of its session, about the thing it
    // governs: a grant admits the operation because it holds that thing. What governs the Home
    // itself is a Home-scoped target, which only `everything` holds. An unknown type is nothing.
    if (!Object.hasOwn(commandTable, command.type)) throw notFound();
    const row = commandRow(command.type as CommandType) as CommandRow;
    let governed: CommandResource | undefined;
    try {
      governed = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    } catch {
      governed = undefined;
    }
    const named = governed ? commandGrantTarget(governed) : null;
    const grantTarget = named ? AgentGrantTargetSchema.safeParse(named).data : undefined;
    const result = await requireDirectWork(this.#sessions).run({
      ownerUserId: caller.userId,
      agentConnectionId: caller.connectionId,
      taskId: input.taskId as ThreadId | undefined,
      operationKey,
      tool: "opensteer_command",
      input,
      target: {
        grant: grantTarget ?? { kind: "device" },
        name: commandTitles[command.type as CommandType] ?? "A Home command",
        device: null,
      },
      effect: "write",
      calls: `opensteer_command ${canonicalJson(input.command)}`,
      ...(reason ? { reason } : {}),
      execute: async (context) =>
        tooled(
          await dispatchCommand(
            { ...caller, key: context.bindingId },
            command,
            this.#door(caller, { agentSessionId: context.sessionId }, context.taskId, reason),
          ),
        ),
    });
    if (result.status === "completed" && result.result) return result.result;
    if (result.status === "pending" && result.requestId)
      return { status: "pending" as const, requestId: result.requestId, next: result.next };
    throw new OpensteerError({
      code: "conflict",
      message: "next" in result ? result.next : "The command did not run.",
    });
  }

  async opensteer_state({ caller, input }: ToolCall<"opensteer_state">) {
    const scope =
      caller.kind === "connection"
        ? commandGrantScope({ grant: caller.grant, bridgeSenders: null })
        : null;
    // Settings are the person's own: not there for a selected grant.
    if (input.area === "settings" && scope === "selected") throw notFound();
    return { area: input.area, view: await this.#administration.settingsView(caller) };
  }

  #door(
    caller: AgentCaller,
    origin: CommandRequestOrigin,
    originatingThreadId: ThreadId,
    reason: string | undefined,
  ) {
    const requests = this.#requests();
    return agentCommandDoor({
      database: this.#database,
      registry: this.#registry,
      ...(requests
        ? {
            propose: async (agent, command, ask, face) =>
              requests.propose({
                ownerUserId: agent.userId,
                command,
                ask,
                face,
                proposer: await this.#proposer(caller, originatingThreadId),
                origin,
                originatingThreadId,
                callKey: (command as { idempotencyKey: string }).idempotencyKey,
                ...(reason ? { reason } : {}),
              }),
          }
        : {}),
    });
  }

  /** Who asks, as the person knows them, and the root of its lineage. */
  async #proposer(caller: AgentCaller, taskId: ThreadId): Promise<CommandProposer> {
    const database = this.#database;
    const task = await database
      .selectFrom("threads")
      .select(["title", "harnessInstanceId"])
      .where("id", "=", taskId)
      .executeTakeFirst();
    const connectionId =
      caller.kind === "connection"
        ? caller.connectionId
        : caller.agentConnection?.agentConnectionId;
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
}

/**
 * Whether a selected grant holds anything of the kind a command type governs: its tasks, a
 * browser profile or a paired Chrome, a plugin, a device app; its own connection always.
 */
function selectedCovers(
  type: CommandType,
  row: CommandRow,
  grant: Extract<NonNullable<AgentCaller["agentConnection"]>["grant"], { scope: "selected" }>,
): boolean {
  const has = (kind: string) => grant.resources.some((resource) => resource.kind === kind);
  switch (row.family) {
    case "connections":
      return row.scope === "connection";
    case "tasks":
    case "automations":
      return grant.tasks;
    case "browser":
      return type.startsWith("browser.source.") ? has("chrome-tabs") : has("browser-profile");
    case "tabs-apps":
      return type.startsWith("tab.") && (has("browser-profile") || has("chrome-tabs"));
    case "plugins":
      return has("plugin");
    case "device-apps":
      return type === "plugin.remove"
        ? grant.resources.some(
            (resource) => resource.kind === "plugin" && resource.target.kind === "local-server",
          )
        : has("computer-app");
    default:
      return false;
  }
}

/** What the door's answer reads as to the tool's caller. */
function tooled(outcome: AgentCommandOutcome) {
  switch (outcome.status) {
    case "done":
      return { status: "done" as const, result: outcome.output };
    case "pending":
      return {
        status: "pending" as const,
        requestId: outcome.requestId as RequestId,
        next: "The person decides in Opensteer. Read it with opensteer_request_read; it may be changed before it is approved.",
      };
    case "ask":
      throw new OpensteerError({
        code: "conflict",
        reason: "asks-person",
        message:
          outcome.answers?.kind === "request"
            ? "That answers a Request the person has. They answer it in Opensteer."
            : "This waits for the person in Opensteer.",
      });
    case "answered":
      return {
        status: "answered" as const,
        requestId: outcome.requestId as RequestId,
        outcome: outcome.outcome,
      };
    default:
      return { status: outcome.status, requestId: outcome.requestId as RequestId };
  }
}
