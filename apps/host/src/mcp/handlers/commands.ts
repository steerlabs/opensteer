import { OpensteerError, type RequestId, type ThreadId } from "@opensteer/core";
import {
  beginAgentSession,
  commandHolds,
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
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import { commandTitles } from "@opensteer/protocol/command-words";
import type { Kysely } from "kysely";
import { z } from "zod";
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
  readonly #administration: AdministrationToolHandlers;
  constructor(options: {
    readonly database: Kysely<DatabaseSchema>;
    readonly registry: CommandRegistry;
    readonly requests: () => CommandRequestService | undefined;
    readonly sessions?: unknown;
    readonly administration: AdministrationToolHandlers;
  }) {
    this.#database = options.database;
    this.#registry = options.registry;
    this.#requests = options.requests;
    this.#administration = options.administration;
  }

  /** What this caller holds, and how the Home answers each: from the rule, cut to the caller. */
  async #held(caller: AgentCaller) {
    // The live grant, as the door reads it, and the one function the door asks (AD1).
    const holder = await agentCommandScope(this.#database)(caller);
    if (holder === "gone") return [];
    const scope = holder?.scope ?? null;
    const connection = scope ? { grant: scope } : null;
    return (Object.keys(commandTable) as CommandType[]).flatMap((type) => {
      const row = commandRow(type) as CommandRow;
      if (
        !commandHolds(type, {
          scope,
          grant: holder?.grant ?? null,
          mode: caller.accessMode,
        })
      )
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
      const schemas = commandInputSchemas(found.type);
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
    // A connected agent's command goes through the door as the connection, like any agent's:
    // admitted by the one rule in the statement that admits it and again at commit, asked by
    // the door's own Request, recorded by the store as the connection's.
    return tooled(
      await dispatchCommand(caller, command, this.#connectionDoor(caller, input.taskId, reason)),
    );
  }

  /** A connection's door: what asks opens in its direct-work session's task, begun if needed. */
  #connectionDoor(
    caller: Extract<AgentCaller, { readonly kind: "connection" }>,
    taskId: string | undefined,
    reason: string | undefined,
  ) {
    const requests = this.#requests();
    return agentCommandDoor({
      database: this.#database,
      registry: this.#registry,
      ...(requests
        ? {
            propose: async (agent, command, ask, face) => {
              const { session } = await beginAgentSession(this.#database, {
                userId: caller.userId,
                agentConnectionId: caller.connectionId,
                ...(taskId ? { taskId: taskId as ThreadId } : {}),
              });
              return requests.propose({
                ownerUserId: agent.userId,
                command,
                ask,
                face,
                proposer: await this.#proposer(caller, session.threadId),
                origin: { agentSessionId: session.id },
                originatingThreadId: session.threadId,
                callKey: (command as { idempotencyKey: string }).idempotencyKey,
                ...(reason ? { reason } : {}),
              });
            },
          }
        : {}),
    });
  }

  async opensteer_state({ caller, input }: ToolCall<"opensteer_state">) {
    // Admitted like a command: the live scope from the same read the door makes (AD2). An ended
    // connection reads nothing; a chat anyone may speak in counts as selected.
    const holder = await agentCommandScope(this.#database)(caller);
    if (holder === "gone") throw notFound();
    // Settings are the person's own: not there for a selected grant.
    if (input.area === "settings" && holder?.scope === "selected") throw notFound();
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
 * One command's input as JSON Schemas, one per variant: without its key, and without any value
 * only the person types, at whatever depth the table's paths name it.
 */
export function commandInputSchemas(type: CommandType): Record<string, unknown>[] {
  const row = commandRow(type) as CommandRow;
  return (variants.get(type) ?? []).map((variant) => {
    const schema = z.toJSONSchema(
      "idempotencyKey" in variant.shape ? variant.omit({ idempotencyKey: true } as never) : variant,
      { io: "input", unrepresentable: "any" },
    ) as Record<string, unknown>;
    for (const path of row.secretFields ?? []) dropPath(schema, path.split("."));
    return schema;
  });
}

/** Removes a dotted path from a JSON Schema, through its properties and its unions. */
function dropPath(node: unknown, path: readonly string[]): void {
  if (!node || typeof node !== "object" || path.length === 0) return;
  const schema = node as Record<string, unknown>;
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(schema[key])) for (const option of schema[key]) dropPath(option, path);
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || !(path[0]! in properties)) return;
  if (path.length === 1) {
    delete properties[path[0]!];
    if (Array.isArray(schema.required))
      schema.required = (schema.required as string[]).filter((name) => name !== path[0]);
    return;
  }
  dropPath(properties[path[0]!], path.slice(1));
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
