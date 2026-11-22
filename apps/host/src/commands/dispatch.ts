import { OpensteerError } from "@opensteer/core";
import {
  admitCommand,
  commandSubject,
  type CommandAdmission,
  type CommandAskReason,
  type DatabaseSchema,
} from "@opensteer/database";
import type {
  HostApiCommand,
  HostApiCommandOutput,
  HostApiServerContext,
} from "@opensteer/protocol";
import { commandRow, type CommandRow } from "@opensteer/protocol/command-table";
import type { Kysely } from "kysely";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { Actor, PersonActor } from "./actor.js";
import type { CommandRegistry } from "./registry.js";

/** An agent's command that waits for the person. Nothing ran. */
export interface CommandAsk {
  readonly status: "ask";
  readonly reason: CommandAskReason;
}

export interface CommandDoor {
  readonly registry: CommandRegistry;
}
/** The door as an agent meets it: the same registry, and the one admission. */
export interface AgentCommandDoor extends CommandDoor {
  readonly admit: (caller: AgentCaller, command: HostApiCommand) => Promise<CommandAdmission>;
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

/**
 * The one door every Home command passes. The person's command runs as it always has: no
 * statement before the handler, the same handler. An agent's command is admitted by the one rule;
 * a handler written for the person is never given an agent, so the agent's command waits for the
 * person instead.
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
): Promise<CommandAsk>;
export async function dispatchCommand(
  actor: Actor,
  command: HostApiCommand,
  door: CommandDoor | AgentCommandDoor,
  context?: HostApiServerContext,
): Promise<HostApiCommandOutput | CommandAsk> {
  if (actor.kind === "person") {
    if (!context) throw new OpensteerError({ code: "internal", message: "Missing request" });
    const handler = door.registry[command.type] as CommandRegistry[HostApiCommand["type"]];
    return handler.run(actor, command as never, context);
  }
  if (!("admit" in door))
    throw new OpensteerError({ code: "internal", message: "This door admits no agent" });
  const row = commandRow(command.type) as CommandRow;
  assertNoSecretFields(row, command);
  const admission = await door.admit(actor, command);
  if (admission.answer === "not_found")
    throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
  // Every handler takes the person's session as its authority in this step: even a `now` waits.
  return {
    status: "ask",
    reason: admission.answer === "now" ? "step" : (admission.reason ?? "step"),
  };
}

/** A value only the person types never passes through an agent. */
function assertNoSecretFields(row: CommandRow, command: HostApiCommand): void {
  for (const field of row.secretFields ?? [])
    if (field in command && (command as Record<string, unknown>)[field] !== undefined)
      throw new OpensteerError({
        code: "bad_request",
        message: `Leave ${field} out: the person types it.`,
      });
}
