import { connectionStateAreas } from "@opensteer/agent-tools/tools";
import {
  OpensteerError,
  type RequestId,
  type ThreadAccessMode,
  type ThreadId,
} from "@opensteer/core";
import {
  beginAgentSession,
  commandHolds,
  commandNotFoundMessage,
  commandRule,
  connectionRequests,
  withDatabaseTransaction,
  type CommandRequestOrigin,
  type DatabaseSchema,
} from "@opensteer/database";
import type { HostApiCommand } from "@opensteer/protocol";
import {
  commandFamilies,
  commandRow,
  commandTable,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import { commandTitles } from "@opensteer/protocol/command-words";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { agentCommandDoor } from "../../commands/agent-door.js";
import {
  agentCommandScope,
  agentRunsNow,
  commandVariants,
  dispatchCommand,
  type AgentCommandOutcome,
} from "../../commands/dispatch.js";
import type { CommandRegistry } from "../../commands/registry.js";
import {
  proposerLineageKey,
  rootTask,
  type CommandProposer,
  type CommandRequestService,
} from "../../commands/requests.js";
import { callerLineage, type AgentCaller } from "../agent-caller.js";
import { operationId } from "../operations.js";
import type { AdministrationToolHandlers } from "./administration.js";
import type { ToolCall } from "./types.js";

type Answer = "now" | "ask" | "now or ask";
const notFound = () => new OpensteerError({ code: "not_found", message: commandNotFoundMessage });

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
  readonly #reads: () => Readonly<Record<string, unknown>> | undefined;
  readonly #policy: (() => Promise<unknown>) | undefined;
  constructor(options: {
    /** The person's read handlers, as the Host registered them. */
    readonly reads?: () => Readonly<Record<string, unknown>> | undefined;
    /** The organization's effective policy on a work Home; nothing on a personal one. */
    readonly policy?: () => Promise<unknown>;
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
    this.#reads = options.reads ?? (() => undefined);
    this.#policy = options.policy;
  }

  /** What this caller holds, and how the Home answers each: from the rule, cut to the caller. */
  async #held(caller: AgentCaller) {
    // The live grant, as the door reads it, and the one function the door asks (AD1).
    const holder = await agentCommandScope(this.#database)(caller);
    if (holder === "gone") return [];
    // The live mode, as admission reads it, never the one cached at sign-in.
    const { scope, mode } = holder;
    return (Object.keys(commandTable) as CommandType[]).flatMap((type) => {
      const row = commandRow(type) as CommandRow;
      if (!commandHolds(type, holder)) return [];
      const { answer } = commandMark(type, { scope, mode }, this.#registry);
      return [{ type, family: row.family, title: commandTitles[type], answer }];
    });
  }

  async opensteer_commands({ caller, input }: ToolCall<"opensteer_commands">) {
    const held = await this.#held(caller);
    if (input.type) {
      const found = held.find((entry) => entry.type === input.type);
      if (!found) throw notFound();
      const schemas = commandInputSchemas(found.type, callerLineage(caller) !== null);
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
      ...(taskId ? { taskId } : {}),
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
    // Admitted like a command: the live grant from the same read the door makes (AD2). An ended
    // connection reads nothing; a chat anyone may speak in counts as selected.
    const holder = await agentCommandScope(this.#database)(caller);
    if (holder === "gone") throw notFound();
    const { scope, grant, mode } = holder;
    // Under a connection's grant only what its listing names, by the same function (rule 5).
    if (grant && !connectionStateAreas(grant).includes(input.area)) throw notFound();
    const connectionId =
      caller.kind === "connection"
        ? caller.connectionId
        : caller.agentConnection?.agentConnectionId;
    // The person's own read, by its handler; the area is cut afterwards, never widened.
    const read = async (name: string, request: Record<string, unknown>) => {
      const handler = this.#reads()?.[name] as
        | ((input: unknown, context: unknown) => Promise<{ ok?: boolean; data?: unknown }>)
        | undefined;
      if (!handler) throw notFound();
      const reply = await handler(request, {
        // The person as their own apps sign in: the owner, not disabled.
        session: {
          id: `ses_state_${caller.userId}`,
          user: { id: caller.userId, disabledAt: null },
        },
        headers: {},
        afterResponse: () => undefined,
        setHeader: () => undefined,
      });
      return (reply && typeof reply === "object" && "data" in reply ? reply.data : reply) as Record<
        string,
        unknown
      >;
    };
    switch (input.area) {
      case "settings":
        if (scope === "selected") throw notFound();
        return { area: input.area, view: await this.#administration.settingsView(caller) };
      case "connections": {
        const view = await read("connections.list", {});
        const all = (view.connections ?? []) as readonly { readonly id: string }[];
        // A connected agent sees itself only: other connections are other principals (X13).
        if (!connectionId) return { area: input.area, view };
        return {
          area: input.area,
          view: { connections: all.filter(({ id }) => id === connectionId), endedConnections: [] },
        };
      }
      case "chats":
        // A chat account and its chats are other connections (X13).
        if (connectionId) throw notFound();
        return { area: input.area, view: await read("channels.get", {}) };
      case "devices": {
        const view = await read("machines.list", {});
        const machines = (view.machines ?? []) as readonly { readonly id: string }[];
        if (scope !== "selected" || grant?.scope !== "selected")
          return { area: input.area, view: { machines } };
        // A selected grant sees the devices of the apps it was given, as its tools do.
        const devices = new Set<string>(
          grant.resources.flatMap((resource) =>
            resource.kind === "computer-app" ? [resource.deviceId as string] : [],
          ),
        );
        return {
          area: input.area,
          view: { machines: machines.filter(({ id }) => devices.has(id)) },
        };
      }
      case "engines": {
        if (scope === "selected") throw notFound();
        // The person's own read of their engine accounts, the snapshot's `harness` resource;
        // cut to leave out `config`, the source fields the person typed for an engine.
        // A page of the snapshot's resource: its rows under `data`.
        const view = await read("resources.detail.get", { kind: "harness" });
        const page = (view.data ?? {}) as {
          readonly harnesses?: readonly Record<string, unknown>[];
        };
        const harnesses = (page.harnesses ?? []).map(({ config: _config, ...harness }) => harness);
        return { area: input.area, view: { harnesses } };
      }
      case "requests": {
        const view = await read("requests.list", {});
        // Each item as the person's Needs you list holds it: the Request, and how it is shown.
        const requests = (view.requests ?? []) as readonly {
          readonly request: { readonly id: string };
        }[];
        // Your own agents at Full access see what the person sees; anyone else, its lineage's:
        // a connected agent's, the task tree it works in, or the automation's own task.
        if (!connectionId && mode === "full-access")
          return { area: input.area, view: { requests } };
        // A connection's lineage sees what the one predicate gives it (connectionRequests): the
        // same Requests its task tools count and read, and nothing a hidden one changes (K5).
        const mine = new Set(
          connectionId
            ? await withDatabaseTransaction(this.#database, async (transaction) =>
                (
                  await (
                    await connectionRequests(transaction, {
                      kind: "connection",
                      userId: caller.userId,
                      connectionId,
                      accessMode: mode,
                    })
                  )
                    .clearSelect()
                    .select("requests.id")
                    .execute()
                ).map(({ id }) => id as string),
              )
            : await lineageRequests(
                this.#database,
                caller.kind === "run"
                  ? await rootTask(this.#database, caller.thread.id)
                  : (caller as Extract<AgentCaller, { kind: "program" }>).anchor.id,
              ),
        );
        return {
          area: input.area,
          view: { requests: requests.filter(({ request }) => mine.has(request.id)) },
        };
      }
      case "activity":
        return {
          area: input.area,
          view: connectionId
            ? await read("connections.activity", { connectionId })
            : await read("threads.activity", {
                threadId:
                  caller.kind === "run"
                    ? caller.thread.id
                    : (caller as Extract<AgentCaller, { kind: "program" }>).anchor.id,
              }),
        };
      case "policy":
        return { area: input.area, view: { policy: (await this.#policy?.()) ?? null } };
    }
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
export function commandInputSchemas(
  type: CommandType,
  underConnection = false,
): Record<string, unknown>[] {
  const row = commandRow(type) as CommandRow;
  return commandVariants(type, underConnection).map((variant) => {
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

/** Why a listed command asks the person: by the rule, or because no agent handler exists yet. */
export type CommandAskReason = "by rule" | "no agent handler yet";

/**
 * How the listing marks one command for a caller: what dispatch will do, over its faces and over
 * a thing in and outside its own lineage. A `now` of the rule whose handler is still the
 * person's asks too, for its own reason, so a later step that adds the handler flips only that.
 */
export function commandMark(
  type: CommandType,
  caller: { readonly scope: "everything" | "selected" | null; readonly mode: ThreadAccessMode },
  registry: CommandRegistry,
  face?: number,
): { readonly answer: Answer; readonly asks: readonly CommandAskReason[] } {
  const row = commandRow(type) as CommandRow;
  const connection = caller.scope ? { grant: caller.scope } : null;
  const answers = new Set<"now" | "ask">();
  const asks = new Set<CommandAskReason>();
  row.faces.forEach((_, index) => {
    if (face !== undefined && index !== face) return;
    for (const own of [true, false]) {
      const rule = commandRule(row, index, {
        connection,
        mode: caller.mode,
        reach: true,
        ownWork: own,
        ownLineage: own,
      });
      if (rule.answer === "not_found") continue;
      if (rule.answer === "ask") {
        answers.add("ask");
        asks.add("by rule");
        continue;
      }
      // The one predicate dispatch uses: a rule's `now` runs at once only where agents can.
      if (agentRunsNow(row, index, registry[type], caller.scope)) answers.add("now");
      else {
        answers.add("ask");
        asks.add("no agent handler yet");
      }
    }
  });
  return {
    answer: answers.size === 2 ? "now or ask" : answers.has("now") ? "now" : "ask",
    asks: [...asks],
  };
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

/** The Requests raised in a task tree: the root task and every task made under it. */
async function lineageRequests(
  database: Kysely<DatabaseSchema>,
  root: ThreadId,
): Promise<readonly string[]> {
  const { rows } = await sql<{ id: string }>`with recursive down as (
      select id, 0 as depth from threads where id = ${root}
      union all
      select child.id, down.depth + 1
      from threads child join down on child.parent_thread_id = down.id where down.depth < 64
    ) select requests.id from requests join down on requests.originating_thread_id = down.id`.execute(
    database,
  );
  return rows.map(({ id }) => id);
}
