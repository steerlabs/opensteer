import { OpensteerError } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import type { HostApiCommand } from "@opensteer/protocol";
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
  type CommandAuthority,
} from "./dispatch.js";
import type { CommandRegistry } from "./registry.js";

export type TriggerCommand = Extract<HostApiCommand, { readonly type: `trigger.${string}` }>;

export const agentAutomationTypes: ReadonlySet<CommandType> = new Set([
  "trigger.create",
  "trigger.update",
  "trigger.status.set",
  "trigger.run",
  "trigger.cancel",
  "trigger.secrets.set",
]);

export interface AgentAutomationExecutor {
  execute(
    actor: AgentCaller,
    command: TriggerCommand,
    authority: CommandAuthority,
  ): Promise<unknown>;
}

/**
 * The registry agents meet: a command the administration or automation handler runs for agents
 * takes the agent and admits it again at commit; every other command is still the person's, so
 * the door puts it to them.
 */
export function agentCommandRegistry(
  administration: AdministrationService,
  automations?: AgentAutomationExecutor,
): CommandRegistry {
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
        : automations && agentAutomationTypes.has(type)
          ? {
              accepts: "any" as const,
              run: async (
                actor: { readonly kind: string },
                command: unknown,
                { authority }: { readonly authority: CommandAuthority | null },
              ) => {
                if (actor.kind === "person")
                  throw new OpensteerError({ code: "internal", message: "Not the person's door" });
                return automations.execute(
                  actor as AgentCaller,
                  command as TriggerCommand,
                  authority!,
                );
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
  readonly secretDigestKey?: Buffer | undefined;
}): AgentCommandDoor {
  return {
    registry: input.registry,
    admit: agentCommandAdmission(input.database, input.taskId),
    scope: agentCommandScope(input.database, input.taskId),
    attempts: commandAttempts(input.database),
    readmit: agentCommandReadmission(input.taskId),
    ...(input.propose ? { propose: input.propose } : {}),
    ...(input.secretDigestKey ? { secretDigestKey: input.secretDigestKey } : {}),
  };
}
