import { OpensteerError } from "@opensteer/core";
import { z } from "zod";
import {
  admitCommand,
  commandAdmission,
  commandCallerHolder,
  commandHolds,
  commandNotFoundMessage,
  commandSubject,
  type CommandAdmission,
  type CommandAskReason,
  type CommandIdentity,
  type DatabaseSchema,
} from "@opensteer/database";
import {
  hostApi,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiServerContext,
} from "@opensteer/protocol";
import {
  commandAgentOutput,
  commandFaceStep,
  commandRow,
  commandTable,
  type CommandAnsweredAsk,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import type { Kysely } from "kysely";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { isPersonActor, type Actor, type PersonActor } from "./actor.js";
import type { CommandHandler, CommandRegistry } from "./registry.js";
import type { CommandProposed } from "./requests.js";

/**
 * What an agent's command came to. `done`: it ran, and `output` is what an agent may read of the
 * result. `ask`: it waits for the person; nothing ran. When it is the answer to an ask the person
 * already has (a Request, a consent), `answers` names that ask, and no other opens.
 */
export type AgentCommandOutcome =
  | { readonly status: "done"; readonly output: unknown }
  | {
      readonly status: "ask";
      readonly reason: CommandAskReason;
      readonly answers?: CommandAnsweredAsk;
    }
  /** The person has a Request for it: this one, or the one it answers, or the same ask open. */
  | {
      readonly status: "pending";
      readonly requestId: string;
      readonly reason: CommandAskReason;
      readonly existing: boolean;
    }
  /** The person declined this ask within the last day: answered at once, nothing opened. */
  | { readonly status: "declined"; readonly requestId: string }
  /** The same call again, after its Request ended unapproved: what became of it. */
  | { readonly status: "withdrawn" | "closed"; readonly requestId: string }
  /** The same call again, after the person approved it: what it came to. */
  | {
      readonly status: "answered";
      readonly requestId: string;
      readonly outcome: import("@opensteer/core").CommandRequestOutcome;
    };
/** The earlier name of the waiting outcome. */
export type CommandAsk = Extract<AgentCommandOutcome, { readonly status: "ask" }>;

export interface CommandDoor {
  readonly registry: CommandRegistry;
}
/** The door as an agent meets it: the same registry, and the one admission. */
export interface AgentCommandDoor extends CommandDoor {
  readonly admit: (caller: AgentCaller, command: HostApiCommand) => Promise<CommandAdmission>;
  /**
   * The grant the caller's lineage holds as the Home has it now, never as it was at sign-in:
   * `gone` once its connection works for no one. Null for your own agents.
   */
  readonly scope: (caller: AgentCaller) => Promise<
    | {
        readonly scope: "everything" | "selected";
        readonly grant: import("@opensteer/core").AgentGrant;
      }
    | "gone"
    | null
  >;
  /** Opens the person's Request for a command that waits for them; without it, `ask` is returned. */
  readonly propose?: (
    caller: AgentCaller,
    command: HostApiCommand,
    ask: CommandAsk,
    face: number | undefined,
  ) => Promise<CommandProposed>;
}

/** The scope of the caller's connection from its own row; your own agents read nothing. */
export function agentCommandScope(database: Kysely<DatabaseSchema>): AgentCommandDoor["scope"] {
  return (caller) =>
    commandCallerHolder(
      database,
      caller.userId,
      caller.kind === "connection"
        ? caller.connectionId
        : (caller.agentConnection?.agentConnectionId ?? null),
    );
}

/** `admitCommand` for an agent the Home authenticated, from its live execution. */
export function agentCommandAdmission(database: Kysely<DatabaseSchema>): AgentCommandDoor["admit"] {
  return (caller, command) =>
    admitCommand(database, {
      ownerUserId: caller.userId,
      subject: commandSubject(caller.key),
      command,
    });
}

const notFound = () => new OpensteerError({ code: "not_found", message: commandNotFoundMessage });

/**
 * The one door every Home command passes. The person's command runs as it always has: no
 * statement before the handler, the same handler; only an actor `personActor` made is the person.
 * An agent's command is, in this order: a type the table knows, or the fixed not found; admitted
 * by the one rule, and not found if it is outside the agent's reach; free of anything only the
 * person types; then run by a handler written for agents, with the authority the store rechecks at
 * commit, or put to the person.
 */
export function dispatchCommand(
  actor: PersonActor,
  command: HostApiCommand,
  door: CommandDoor,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput>;
export function dispatchCommand(
  actor: AgentCaller,
  command: HostApiCommand,
  door: AgentCommandDoor,
): Promise<AgentCommandOutcome>;
export async function dispatchCommand(
  actor: Actor,
  command: HostApiCommand,
  door: CommandDoor | AgentCommandDoor,
  context?: HostApiServerContext,
): Promise<HostApiCommandOutput | AgentCommandOutcome> {
  if (actor.kind === "person") {
    // A copy, a cast or a structural look-alike is not the person.
    if (!isPersonActor(actor))
      throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
    if (!context) throw new OpensteerError({ code: "internal", message: "Missing request" });
    const handler = door.registry[command.type] as CommandHandler<HostApiCommand["type"]>;
    return handler.accepts === "person"
      ? handler.run(actor, command as never, context)
      : handler.run(actor, command as never, { context, authority: null });
  }
  if (!("admit" in door))
    throw new OpensteerError({ code: "internal", message: "This door admits no agent" });
  if (!Object.hasOwn(commandTable, command.type)) throw notFound();
  const row = commandRow(command.type) as CommandRow;
  // A type this caller does not hold reads as nothing at all, before its input is looked at.
  const holder = await door.scope(actor);
  if (
    holder === "gone" ||
    !commandHolds(command.type as CommandType, {
      scope: holder?.scope ?? null,
      grant: holder?.grant ?? null,
      mode: actor.accessMode,
    })
  )
    throw notFound();
  // A type it holds is read with its schema; what is wrong with it may be said. A value only the
  // person types is left out by the agent, so a schema that requires it reads the rest without it.
  // Under a connection's grant (the scope just read says so) the own-agents-only kinds are absent.
  const parsed = parseHeld(row, command, (holder?.scope ?? null) !== null);
  if (!parsed.success)
    throw new OpensteerError({
      code: "bad_request",
      message: `That ${command.type} command is not valid: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")}`.slice(0, 1_000),
    });
  command = parsed.data as HostApiCommand;
  const admission = await door.admit(actor, command);
  if (admission.answer === "not_found") throw notFound();
  assertNoSecretPaths(row, command);
  const handler = door.registry[command.type] as CommandHandler<HostApiCommand["type"]>;
  if (
    admission.answer === "now" &&
    handler.accepts === "any" &&
    agentRunsNow(row, admission.face, handler, holder?.scope ?? null)
  ) {
    const authority = commandAuthority(actor, command);
    const output = await handler.run(actor, command as never, { context: null, authority });
    return { status: "done", output: commandAgentOutput(command, output) };
  }
  const answers =
    row.answersAsk && admission.face !== undefined && row.answersAsk.faces.includes(admission.face)
      ? (row.answersAsk.of as (c: HostApiCommand) => CommandAnsweredAsk)(command)
      : undefined;
  const ask: CommandAsk = {
    status: "ask",
    // A `now` whose handler is still the person's waits for the person too.
    reason: admission.answer === "now" ? "step" : (admission.reason ?? "step"),
    ...(answers ? { answers } : {}),
  };
  // An ask about an ask is not a new ask: the agent is pointed at the one the person has.
  if (answers?.kind === "request")
    return { status: "pending", requestId: answers.id, reason: ask.reason, existing: true };
  if (answers || !door.propose) return ask;
  const proposed = await door.propose(actor, command, ask, admission.face);
  return proposed.status === "pending" ? { ...proposed, reason: ask.reason } : proposed;
}

/**
 * Whether a `now` of the rule runs at once for an agent: its face is built for agents (step A
 * for this caller) and its handler is written for agents. Otherwise it waits for the person,
 * "no agent handler yet". The listing marks a command with this same answer.
 */
export function agentRunsNow(
  row: CommandRow,
  face: number | undefined,
  handler: { readonly accepts: string },
  scope: "everything" | "selected" | null,
): boolean {
  if (handler.accepts !== "any") return false;
  const caller = { connection: scope !== null, selected: scope === "selected" };
  // Where only the store can tell the face, every face it may be must be built for agents.
  const faces = face === undefined ? row.faces.map((_, index) => index) : [face];
  return faces.every((index) => commandFaceStep(row, index, caller) === "A");
}

/** What a handler written for agents is given: the identity its store admits at commit. */
export interface CommandAuthority {
  readonly caller: AgentCaller;
  readonly identity: CommandIdentity;
}
const authorities = new WeakSet<object>();

function commandAuthority(caller: AgentCaller, command: HostApiCommand): CommandAuthority {
  const { type, idempotencyKey, ...request } = command as HostApiCommand & {
    readonly idempotencyKey?: string;
  };
  if (!idempotencyKey)
    throw new OpensteerError({ code: "bad_request", message: "A command needs its key" });
  const authority = Object.freeze({
    caller,
    identity: {
      requestedBy: caller.userId,
      idempotencyKey,
      type,
      request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
      authoritySource: { kind: "mcp", callerKind: caller.kind, callerKey: caller.key },
      ...commandAdmission({ ownerUserId: caller.userId, callerKey: caller.key, command }),
    },
  });
  authorities.add(authority);
  return authority;
}

/** Whether the door made this authority: a store given one admits it again at commit. */
export function isCommandAuthority(value: unknown): value is CommandAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

/** Each command type's own schemas (a type may have more than one variant). */
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

const connectionVariants = new Map<string, readonly z.ZodObject[]>();
/**
 * A command's schemas as a caller may send them: under a connection's grant, without the kinds
 * only your own agents send, so such a kind reads like one the schema does not know.
 */
export function commandVariants(type: string, underConnection: boolean): readonly z.ZodObject[] {
  const all = variants.get(type) ?? [];
  const hidden = Object.hasOwn(commandTable, type)
    ? ((commandRow(type as CommandType) as CommandRow).ownAgentsOnly ?? [])
    : [];
  if (!underConnection || hidden.length === 0) return all;
  const cached = connectionVariants.get(type);
  if (cached) return cached;
  const narrowed = all.map((variant) =>
    hidden.reduce((schema, { field, kind }) => {
      const union = variant.shape[field] as z.ZodDiscriminatedUnion<z.ZodObject[]> | undefined;
      if (!union) return schema;
      const kept = union.options.filter(
        (option) => (option.shape.kind as z.ZodLiteral<string>).value !== kind,
      );
      return schema.extend({ [field]: z.discriminatedUnion("kind", kept as never) });
    }, variant),
  );
  connectionVariants.set(type, narrowed);
  return narrowed;
}

/** Reads a command with its own schema, leaving out each top-level secret field it does not carry. */
function parseHeld(row: CommandRow, command: HostApiCommand, underConnection: boolean) {
  const input = command as unknown as Record<string, unknown>;
  const absent = (row.secretFields ?? []).filter(
    (path) => !path.includes(".") && input[path] === undefined,
  );
  let first: ReturnType<z.ZodObject["safeParse"]> | undefined;
  for (const variant of commandVariants(command.type, underConnection)) {
    const schema = absent.length
      ? variant.omit(Object.fromEntries(absent.map((key) => [key, true])) as never)
      : variant;
    const result = schema.safeParse(command);
    if (result.success) return result;
    first ??= result;
  }
  return first ?? hostApi["commands.dispatch"].payload.safeParse(command);
}

/** A value only the person types never passes through an agent: found by the table's paths. */
function assertNoSecretPaths(row: CommandRow, command: HostApiCommand): void {
  for (const path of row.secretFields ?? []) {
    let at: unknown = command;
    for (const key of path.split(".")) {
      at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[key] : undefined;
      if (at === undefined) break;
    }
    if (at !== undefined)
      throw new OpensteerError({
        code: "bad_request",
        message: `Leave ${path} out: the person types it.`,
      });
  }
}
