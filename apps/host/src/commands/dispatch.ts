import { OpensteerError } from "@opensteer/core";
import { commandRule, type CommandAskReason } from "@opensteer/database";
import type {
  HostApiCommand,
  HostApiCommandOutput,
  HostApiServerContext,
} from "@opensteer/protocol";
import { commandFace, commandRow, type CommandRow } from "@opensteer/protocol/command-table";
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
  door: CommandDoor,
): Promise<CommandAsk>;
export async function dispatchCommand(
  actor: Actor,
  command: HostApiCommand,
  door: CommandDoor,
  context?: HostApiServerContext,
): Promise<HostApiCommandOutput | CommandAsk> {
  if (actor.kind === "person") {
    if (!context) throw new OpensteerError({ code: "internal", message: "Missing request" });
    const handler = door.registry[command.type] as CommandRegistry[HostApiCommand["type"]];
    return handler.run(actor, command as never, context);
  }
  const row = commandRow(command.type) as CommandRow;
  assertNoSecretFields(row, command);
  const admission = commandRule(row, commandFace(command), {
    connection: agentConnectionGrant(actor),
    mode: actor.accessMode,
    // Until the Home reads what the caller reaches, it reaches nothing it would have to prove.
    reach: false,
  });
  if (admission.answer === "not_found")
    throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
  // Every handler takes the person's session as its authority in this step.
  return { status: "ask", reason: admission.reason ?? "step" };
}

/** The grant the caller's lineage works under, as the rule reads it; null for your own agents. */
function agentConnectionGrant(
  caller: AgentCaller,
): { readonly grant: "everything" | "selected" } | null {
  const grant = caller.kind === "connection" ? caller.grant : caller.agentConnection?.grant;
  if (!grant) return null;
  // Work from a chat anyone may speak in reaches no more than a selected grant would.
  const personal = caller.agentConnection?.bridgeSenders !== "anyone";
  return { grant: personal ? grant.scope : "selected" };
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
