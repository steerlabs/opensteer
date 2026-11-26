import { connectionStateAreas } from "@opensteer/agent-tools/tools";
import {
  commandAgentStatus,
  CommandRequestPartSchema,
  OpensteerError,
  raisedBeforeEffect,
  type RequestId,
  type ThreadAccessMode,
  type ThreadId,
} from "@opensteer/core";
import {
  beginAgentSession,
  chatWaitingError,
  readConnectionRowStanding,
  commandHolds,
  commandNotFoundMessage,
  commandRule,
  commandSubject,
  connectionRequests,
  grantedDeviceApprovals,
  requestFromRow,
  stillReaches,
  storedProposal,
  withDatabaseTransaction,
  type CommandRequestOrigin,
  type DatabaseSchema,
} from "@opensteer/database";
import { PluginCommandResultSchema, type HostApiCommand } from "@opensteer/protocol";
import { commandActivity } from "../../commands/activity.js";
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
  type CommandAuthority,
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
import { lentDevice, lentNow, lentMachineView } from "../lent-now.js";
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
  readonly #secretDigestKey: Buffer;
  constructor(options: {
    /** The person's read handlers, as the Host registered them. */
    readonly reads?: () => Readonly<Record<string, unknown>> | undefined;
    readonly database: Kysely<DatabaseSchema>;
    readonly registry: CommandRegistry;
    readonly requests: () => CommandRequestService | undefined;
    readonly sessions?: unknown;
    readonly administration: AdministrationToolHandlers;
    readonly secretDigestKey: Buffer;
  }) {
    this.#database = options.database;
    this.#registry = options.registry;
    this.#requests = options.requests;
    this.#administration = options.administration;
    this.#reads = options.reads ?? (() => undefined);
    this.#secretDigestKey = options.secretDigestKey;
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
      return [{ type, family: row.family, title: commandTitles[type], answer, mode, scope }];
    });
  }

  async opensteer_commands({ caller, input }: ToolCall<"opensteer_commands">) {
    const held = await this.#held(caller);
    if (input.type) {
      const found = held.find((entry) => entry.type === input.type);
      if (!found) throw notFound();
      const row = commandRow(found.type) as CommandRow;
      let allowedSecretPaths: readonly string[] = [];
      // S2: only commands declaring `agentMaySet` can expose a secret field, and only when the
      // caller's live admission can run that face directly.
      if (row.agentMaySet?.length) {
        const connection = found.scope ? { grant: found.scope } : null;
        const setFaceIndex = found.type === "trigger.secrets.set" ? 1 : 0;
        const canRunInOwnLineage =
          commandRule(row, setFaceIndex, {
            connection,
            mode: found.mode,
            reach: true,
            ownWork: true,
            ownLineage: true,
          }).answer === "now" &&
          agentRunsNow(row, setFaceIndex, this.#registry[found.type], found.scope);
        if (canRunInOwnLineage) allowedSecretPaths = row.agentMaySet;
      }
      const schemas = commandInputSchemas(
        found.type,
        callerLineage(caller) !== null,
        allowedSecretPaths,
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

  /**
   * An older task tool's write, as the same command through the one door, whoever sends it
   * (rule 2, A3): admitted by admitCommand (the table's lineage and widening faces included),
   * put to the person by the door's own Request where the table says so, and run only by the
   * door, with the authority its write admits again in its own transaction. These writes are one
   * store transaction each: the Home's own refusal there wrote nothing.
   */
  async through<T>(
    caller: AgentCaller,
    command: HostApiCommand,
    act: (authority: CommandAuthority) => Promise<T>,
  ): Promise<T> {
    let ran: { readonly value: T } | undefined;
    const registry = {
      ...this.#registry,
      [command.type]: {
        accepts: "any",
        run: async (
          _actor: unknown,
          _command: unknown,
          on: { readonly authority: CommandAuthority | null },
        ) => {
          if (!on.authority)
            throw new OpensteerError({ code: "internal", message: "Not the person's door" });
          try {
            ran = { value: await act(on.authority) };
          } catch (error) {
            throw error instanceof OpensteerError ? raisedBeforeEffect(error) : error;
          }
          return { type: command.type };
        },
      },
    } as unknown as CommandRegistry;
    const door =
      caller.kind === "connection"
        ? this.#connectionDoor(caller, undefined, undefined, registry)
        : this.#door(
            caller,
            caller.kind === "run"
              ? { runId: caller.claims.runId }
              : caller.program.kind === "watch"
                ? { watchActivationId: caller.program.activationId }
                : { occurrenceId: caller.program.occurrenceId },
            caller.kind === "run" ? caller.thread.id : caller.anchor.id,
            undefined,
            registry,
          );
    let outcome: AgentCommandOutcome;
    try {
      outcome = await dispatchCommand(caller, command, door);
    } catch (error) {
      // A chat's message whose chat was paused meanwhile waits for it, as it always has: the one
      // standing read says whether the chat is paused or has ended.
      if (
        caller.kind === "connection" &&
        caller.chat &&
        error instanceof OpensteerError &&
        error.code === "not_found" &&
        (await readConnectionRowStanding(this.#database, caller.userId, caller.connectionId))
          .waiting
      )
        throw chatWaitingError();
      throw error;
    }
    if (outcome.status === "done" && ran) return ran.value;
    // Put to the person: the tool says so, and where it waits; nothing ran.
    throw new OpensteerError({
      code: "conflict",
      reason: "asks-person",
      message:
        outcome.status === "pending"
          ? "This waits for the person in Opensteer."
          : "This needs the person in Opensteer.",
      ...(outcome.status === "pending"
        ? {
            next: "See it with opensteer_state, area requests.",
            details: { requestId: outcome.requestId },
          }
        : {}),
    });
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
      const lineage =
        caller.kind === "connection"
          ? caller.connectionId
          : caller.agentConnection?.agentConnectionId;
      return requests.withdraw({
        ownerUserId: caller.userId,
        requestId: input.withdraw as RequestId,
        proposerKey: await proposerLineageKey(this.#database, caller),
        // Under a connection's grant, the caller's own reach now, in the withdraw's transaction.
        ...(lineage ? { caller: commandSubject(caller.key) } : {}),
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
    registry: CommandRegistry = this.#registry,
  ) {
    const requests = this.#requests();
    return agentCommandDoor({
      database: this.#database,
      registry,
      secretDigestKey: this.#secretDigestKey,
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
        // A selected grant sees the devices of what the one rule lends it now, as its tools do:
        // an approval blocked, on a removed device, or made again as a new row is no device of it.
        // Of each, only what the approvals it holds there need (lentMachineView).
        const lent = await lentNow(caller, (owner, lineageGrant) =>
          grantedDeviceApprovals(this.#database, owner, lineageGrant),
        );
        const shown = lentDevice(lent);
        return {
          area: input.area,
          view: {
            machines: machines
              .filter(({ id }) => shown(id))
              .map((machine) =>
                lentMachineView(
                  machine,
                  (lent?.approvals ?? []).filter(({ deviceId }) => deviceId === machine.id),
                ),
              ),
          },
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
        // Under a connection's grant (a connected agent, or a Run or automation in its lineage)
        // the caller reads a command Request only while it still reaches what it governs now.
        const grantBound = Boolean(connectionId);
        const subject = commandSubject(caller.key);
        // A command Request as an agent reads it: what it sent, the status and a confirmed
        // failure or import warnings of its own command. The card, notes and other successful
        // results can name things beyond its grant (rule 5).
        const project = async (item: AgentReadRequest): Promise<AgentReadRequest | null> => {
          if (!item.request.command) return item;
          return withDatabaseTransaction(this.#database, async (transaction) => {
            const row = await transaction
              .selectFrom("requests")
              .select(["id", "status", "command", "response"])
              .where("id", "=", item.request.id as RequestId)
              .executeTakeFirst();
            if (!row?.command) return null;
            const part = CommandRequestPartSchema.parse(row.command);
            if (grantBound) {
              const command = storedProposal(part);
              if (!command || !(await stillReaches(transaction, caller.userId, subject, command)))
                return null;
            }
            const own = !grantBound || part.proposer.connectionId === connectionId;
            const status = commandAgentStatus({
              status: row.status,
              response: row.response as never,
              command: part,
            });
            const install =
              own && part.type === "plugins.install" && part.outcome?.status === "done"
                ? PluginCommandResultSchema.safeParse(part.outcome.result).data
                : undefined;
            const warnings =
              install?.type === "plugins.install" && install.result.status === "installed"
                ? install.result.warnings
                : undefined;
            return {
              request: {
                id: row.id,
                kind: "command",
                status,
                type: part.type,
                // What it sent: never what the Home added for the card.
                command: Object.fromEntries(
                  Object.entries(part.command).filter(([key]) => !part.homeAdded?.includes(key)),
                ),
                reason: part.agentReason,
                ...(own && status === "declined"
                  ? { next: "The person declined. Do not ask again unless something changes." }
                  : {}),
                ...(warnings?.length ? { warnings } : {}),
                ...(own
                  ? part.outcome?.status === "failed" && part.outcome.result !== undefined
                    ? { message: part.outcome.message }
                    : part.outcome?.status === "unknown" && part.outcome.progress
                      ? { progress: part.outcome.progress }
                      : {}
                  : {}),
              },
            } as unknown as AgentReadRequest;
          });
        };
        const view = await read("requests.list", {});
        const personItems = (view.requests ?? []) as readonly AgentReadRequest[];
        // Your own agents at Full access see what the person sees; anyone else, its lineage's:
        // a connected agent's, the task tree it works in, or the automation's own task, taken
        // as its own page before any limit (K5).
        let items: readonly AgentReadRequest[] = personItems;
        if (connectionId || mode !== "full-access") {
          const mine = connectionId
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
              );
          const page = mine.length
            ? await this.#database
                .selectFrom("requests")
                .select("id")
                .where("id", "in", mine as RequestId[])
                .where((eb) =>
                  eb.or([
                    eb("status", "=", "pending"),
                    eb.and([
                      eb("status", "in", ["fulfilled", "declined"]),
                      eb("command", "is not", null),
                      eb("resolvedAt", ">=", new Date(Date.now() - 86_400_000)),
                      ...(connectionId
                        ? [sql<boolean>`command->'proposer'->>'connectionId' = ${connectionId}`]
                        : []),
                    ]),
                  ]),
                )
                .orderBy(sql<boolean>`status = 'pending'`, "desc")
                .orderBy(sql<Date>`coalesce(resolved_at, created_at)`, "desc")
                .orderBy("id", "desc")
                .limit(stateRequestsLimit)
                .execute()
            : [];
          const byId = new Map(personItems.map((item) => [item.request.id, item]));
          const own: AgentReadRequest[] = [];
          for (const { id } of page) {
            const known = byId.get(id);
            if (known) {
              own.push(known);
              continue;
            }
            const row = await this.#database
              .selectFrom("requests")
              .selectAll()
              .where("id", "=", id)
              .executeTakeFirst();
            if (row)
              own.push({ request: requestFromRow(row) as unknown as AgentReadRequest["request"] });
          }
          items = own;
        }
        const projected: AgentReadRequest[] = [];
        for (const item of items) {
          const shown = await project(item);
          if (shown) projected.push(shown);
        }
        return { area: input.area, view: { requests: projected } };
      }
      case "activity": {
        const of = connectionId
          ? { connectionId }
          : {
              threadId:
                caller.kind === "run"
                  ? caller.thread.id
                  : (caller as Extract<AgentCaller, { kind: "program" }>).anchor.id,
            };
        const view = connectionId
          ? await read("connections.activity", { connectionId })
          : await read("threads.activity", of);
        // The door's commands as an agent reads them: no Home sentence or looked-up name, and,
        // under a connection's grant, only what it still reaches now, read in one transaction.
        const subject = commandSubject(caller.key);
        const commands = await withDatabaseTransaction(this.#database, (transaction) =>
          commandActivity(
            transaction,
            {
              name: async () => null,
              reconcileShown: (rows) => this.#requests()?.reconcileShown(rows) ?? Promise.resolve(),
            },
            { userId: caller.userId, ...of } as Parameters<typeof commandActivity>[2],
            {
              reaches: async (command) =>
                !connectionId ||
                stillReaches(transaction, caller.userId, subject, command as HostApiCommand),
            },
          ),
        );
        return { area: input.area, view: { ...view, commands: [...commands] } };
      }
      case "problems": {
        // Home-wide, like settings: an everything grant or the person's own agents only.
        if (scope === "selected") throw notFound();
        // The person's own read, its problems only: what this Home would send is not an
        // agent's to see or to shape, and nothing here sends it.
        const view = await read("problems.get", {});
        return { area: input.area, view: { problems: view.problems ?? [] } };
      }
    }
  }

  #door(
    caller: AgentCaller,
    origin: CommandRequestOrigin,
    originatingThreadId: ThreadId,
    reason: string | undefined,
    registry: CommandRegistry = this.#registry,
  ) {
    const requests = this.#requests();
    return agentCommandDoor({
      database: this.#database,
      registry,
      secretDigestKey: this.#secretDigestKey,
      ...(requests
        ? {
            propose: async (agent, command, ask, face) =>
              requests.propose({
                ownerUserId: agent.userId,
                command,
                ask,
                face,
                proposer: await this.#proposer(caller, originatingThreadId),
                proposerCallerKey: agent.key,
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
        ? {
            connectionId,
            grantRevision: connection.grantRevision,
            // A Run or automation under a connection: the card names whose it is.
            ...(caller.kind !== "connection"
              ? { connectionName: connection.label.slice(0, 200) }
              : {}),
          }
        : {}),
    };
  }
}

/**
 * One command's input as JSON Schemas, one per variant: without its key, and without any secret
 * path unless that path is explicitly in `allowedSecretPaths` (S1/S2).
 */
export function commandInputSchemas(
  type: CommandType,
  underConnection = false,
  allowedSecretPaths: readonly string[] = [],
): Record<string, unknown>[] {
  const row = commandRow(type) as CommandRow;
  const allowed = new Set(allowedSecretPaths);
  return commandVariants(type, underConnection).map((variant) => {
    const schema = z.toJSONSchema(variant, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    dropPath(schema, ["idempotencyKey"]);
    for (const path of row.secretFields ?? []) {
      if (allowed.has(path) && row.agentMaySet?.includes(path)) {
        const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
        if (type === "trigger.secrets.set" && path === "set" && properties?.set) {
          properties.set.description =
            "Values to set (accepted directly only at Full access on automations in your own lineage; otherwise omit set and pass names to ask the person).";
        }
        continue;
      }
      dropPath(schema, path.split("."));
    }
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
        // A tool every caller holds: a connection has no opensteer_request_read (G6).
        next: "The person decides in Opensteer: they approve exactly this, or decline it. See it with opensteer_state, area requests.",
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

type AgentReadRequest = {
  readonly request: {
    readonly id: string;
    readonly command?: unknown;
  };
};

/** The most Requests an agent reads in one look at its waiting ones. */
const stateRequestsLimit = 50;
