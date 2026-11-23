import { describe, expect, it } from "vitest";
import type { AgentGrant, ThreadAccessMode, UserId } from "@opensteer/core";
import { commandHolds, commandRule } from "@opensteer/database";
import type { HostApiCommand } from "@opensteer/protocol";
import {
  commandFace,
  commandTable,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import { sampleCommand } from "@opensteer/protocol/test-support/command-samples";
import type { AdministrationService } from "../administration/administration-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { commandMark } from "../mcp/handlers/commands.js";
import { agentCommandRegistry } from "./agent-door.js";
import { dispatchCommand, type AgentCommandDoor } from "./dispatch.js";
import { proposedCommand } from "./requests.js";

const userId = "usr_owner" as UserId;
const types = Object.keys(commandTable) as CommandType[];
const selected: AgentGrant = { scope: "selected", tasks: true, resources: [] };
const everything: AgentGrant = { scope: "everything" };

const run = (accessMode: ThreadAccessMode, grant?: AgentGrant): AgentCaller =>
  ({
    kind: "run",
    key: "run:run_1",
    userId,
    accessMode,
    thread: {},
    claims: {},
    ...(grant
      ? {
          agentConnection: {
            agentConnectionId: "conn_1",
            grant,
            grantRevision: 1,
            consentVersion: 2,
            accessMode,
          },
        }
      : {}),
  }) as unknown as AgentCaller;
const connection = (accessMode: ThreadAccessMode, grant: AgentGrant): AgentCaller =>
  ({
    kind: "connection",
    key: "connection:conn_1",
    userId,
    accessMode,
    connectionId: "conn_1",
    grant,
    grantRevision: 1,
  }) as unknown as AgentCaller;

/** Every kind of agent the Home authenticates, at and below Full access. */
const agents: readonly (readonly [string, AgentCaller])[] = [
  ["your own agent, Full access", run("full-access")],
  ["your own agent, Auto", run("auto")],
  ["your own agent, Approval required", run("approval-required")],
  ["a Run for a connection with everything", run("full-access", everything)],
  ["a Run for a connection with a selected grant", run("full-access", selected)],
  ["a connection with everything", connection("full-access", everything)],
  ["a connection with everything, Auto", connection("auto", everything)],
  ["a connection with everything, Approval required", connection("approval-required", everything)],
  ["a connection with a selected grant", connection("full-access", selected)],
];
const grantOf = (agent: AgentCaller) =>
  agent.kind === "connection" ? agent.grant : agent.agentConnection?.grant;

/** What an agent sends: a valid command of the type, never a value only the person types. */
const sample = (type: CommandType) =>
  ({
    ...proposedCommand(commandTable[type] as CommandRow, sampleCommand(type).command),
    idempotencyKey: "k",
  }) as unknown as HostApiCommand;

/** The agents' own registry, with an administration service that only says it ran. */
const registry = agentCommandRegistry({
  execute: async (_caller: unknown, command: { readonly type: string }) => ({
    type: command.type,
  }),
} as unknown as AdministrationService);

/** The door with the rule as admission, for a thing in or outside the caller's own lineage. */
function door(agent: AgentCaller, own: boolean): AgentCommandDoor {
  const grant = grantOf(agent);
  return {
    registry,
    scope: async () => ({
      scope: grant?.scope ?? null,
      grant: grant ?? null,
      mode: agent.accessMode,
    }),
    admit: async (_actor, command) => {
      const row = commandTable[command.type as CommandType] as CommandRow;
      const face = commandFace(command as never);
      const rule = commandRule(row, face, {
        connection: grant ? { grant: grant.scope } : null,
        mode: agent.accessMode,
        reach: true,
        ownWork: own,
        ownLineage: own,
      });
      return { ...rule, face, execution: null } as never;
    },
    propose: async () => ({ status: "pending", requestId: "req_1", existing: false }) as never,
  };
}

/** What dispatch did: ran it now, asked the person, or found nothing. */
async function did(agent: AgentCaller, type: CommandType, own: boolean) {
  return dispatchCommand(agent, sample(type), door(agent, own)).then(
    (outcome) => (outcome.status === "done" ? "now" : "ask"),
    (error: { readonly code?: string }) => error.code ?? "error",
  );
}

describe("the listing tells the truth about dispatch (ruling 2)", () => {
  it("marks every command, for every kind of caller, as dispatch then answers it", async () => {
    const wrong: string[] = [];
    for (const [name, agent] of agents) {
      const grant = grantOf(agent);
      for (const type of types) {
        if (!sampleCommand(type).valid) continue;
        const held = commandHolds(type, {
          scope: grant?.scope ?? null,
          grant: grant ?? null,
          mode: agent.accessMode,
        });
        const outcomes = new Set([await did(agent, type, true), await did(agent, type, false)]);
        if (!held) {
          if (!outcomes.has("not_found") || outcomes.size !== 1)
            wrong.push(`${name} ${type}: not listed, dispatch ${[...outcomes]}`);
          continue;
        }
        // The mark for the face this command is on (all faces where only the store can tell).
        const face = commandFace(sample(type) as never);
        const { answer } = commandMark(
          type,
          { scope: grant?.scope ?? null, mode: agent.accessMode },
          registry,
          face,
        );
        const marked = new Set(answer === "now or ask" ? ["now", "ask"] : [answer]);
        const listed = [...marked].sort().join("|");
        const done = [...outcomes].sort().join("|");
        // Where only the store can tell the face, dispatch takes the strictest: one of the marks.
        const agrees =
          face === undefined ? [...outcomes].every((o) => marked.has(o)) : listed === done;
        if (!agrees) wrong.push(`${name} ${type}: listed ${listed}, dispatch ${done}`);
      }
    }
    expect(wrong).toEqual([]);
    // Nine kinds of caller, every type, in and outside its lineage: some seconds of real work.
  }, 60_000);

  it("keeps an ask for want of an agent handler apart from an ask of the rule", () => {
    // A connected agent with everything at Full access: the commands the rule would run now that
    // still ask, because their handler is the person's until a later step.
    const waiting = types.filter((type) =>
      commandMark(type, { scope: "everything", mode: "full-access" }, registry).asks.includes(
        "no agent handler yet",
      ),
    );
    const byRule = types.filter((type) =>
      commandMark(type, { scope: "everything", mode: "full-access" }, registry).asks.includes(
        "by rule",
      ),
    );
    expect(waiting.length).toBeGreaterThan(0);
    expect({ waiting: waiting.length, byRule: byRule.length }).toMatchSnapshot();
  });
});
