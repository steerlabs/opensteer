import { OpensteerError } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { commandTable, type CommandType } from "@opensteer/protocol/command-table";
import type { Kysely } from "kysely";
import {
  agentAdministrationTypes,
  type AdministrationCommand,
  type AdministrationService,
} from "../administration/administration-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { commandAttempts } from "./command-effect.js";
import {
  agentCommandAdmission,
  agentCommandReadmission,
  agentCommandScope,
  type AgentCommandDoor,
} from "./dispatch.js";
import type { CommandRegistry } from "./registry.js";

/**
 * The registry agents meet: a command the administration service runs for agents takes the
 * agent, and the service admits it again at commit; every other command is still the person's,
 * so the door puts it to them.
 */
export function agentCommandRegistry(administration: AdministrationService): CommandRegistry {
  const personOnly = {
    accepts: "person" as const,
    run: async (): Promise<never> => {
      throw new OpensteerError({
        code: "internal",
        message: "The person's handler is not on the agents' door",
      });
    },
  };
  return Object.fromEntries(
    (Object.keys(commandTable) as CommandType[]).map((type) => [
      type,
      agentAdministrationTypes.has(type)
        ? {
            accepts: "any" as const,
            run: async (actor: { readonly kind: string }, command: unknown) => {
              if (actor.kind === "person")
                throw new OpensteerError({ code: "internal", message: "Not the person's door" });
              return administration.execute(actor as AgentCaller, command as AdministrationCommand);
            },
          }
        : personOnly,
    ]),
  ) as unknown as CommandRegistry;
}

/** The door for one agent's call: the one admission, the scope as the Home has it, its asks. */
export function agentCommandDoor(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly registry: CommandRegistry;
  readonly propose?: AgentCommandDoor["propose"];
  /** A connection's direct-session task it named: what it does there is its own work. */
  readonly taskId?: string;
}): AgentCommandDoor {
  return {
    registry: input.registry,
    admit: agentCommandAdmission(input.database, input.taskId),
    scope: agentCommandScope(input.database, input.taskId),
    attempts: commandAttempts(input.database),
    readmit: agentCommandReadmission(input.taskId),
    ...(input.propose ? { propose: input.propose } : {}),
  };
}
