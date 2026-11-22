import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AgentGrant, AuthenticatedSession, ThreadAccessMode, UserId } from "@opensteer/core";
import { commandRule } from "@opensteer/database";
import type { HostApiCommand, HostApiServerContext } from "@opensteer/protocol";
import {
  commandFace,
  commandTable,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { personActor, type PersonActor } from "./actor.js";
import { dispatchCommand, type CommandAsk } from "./dispatch.js";
import type { CommandRegistry, PersonCommandHandler } from "./registry.js";

const userId = "usr_owner" as UserId;
const session = { id: "ses_1", user: { id: userId } } as unknown as AuthenticatedSession;
const context = { session } as unknown as HostApiServerContext;
const types = Object.keys(commandTable) as CommandType[];

/** Just enough input for each face to be read; the door reads nothing else of an agent's command. */
function sample(type: CommandType): HostApiCommand {
  const fields: Partial<Record<CommandType, Record<string, unknown>>> = {
    "personal.remoteAccess.request": { intent: { action: "rotate" } },
    "browser.sign-in.respond": { decision: { decision: "decline" } },
    "integration.computer.setup.respond": { decision: "deny" },
  };
  return { type, idempotencyKey: "k", ...fields[type] } as unknown as HostApiCommand;
}

function spyRegistry() {
  const calls: CommandType[] = [];
  const registry = Object.fromEntries(
    types.map((type) => [
      type,
      {
        accepts: "person",
        run: vi.fn(async () => {
          calls.push(type);
          return { type } as never;
        }),
      },
    ]),
  ) as unknown as CommandRegistry;
  return { registry, calls };
}

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
const selected: AgentGrant = { scope: "selected", tasks: true, resources: [] };
const everything: AgentGrant = { scope: "everything" };

/** Every kind of agent the Home authenticates, at and below Full access. */
const agents: readonly (readonly [string, AgentCaller])[] = [
  ["your own agent, Full access", run("full-access")],
  ["your own agent, Auto", run("auto")],
  ["your own agent, Approval required", run("approval-required")],
  ["a program", { ...run("full-access"), kind: "program", anchor: {}, program: {} } as never],
  ["a Run for a connection with everything", run("full-access", everything)],
  ["a Run for a connection with a selected grant", run("full-access", selected)],
  ["a connection with everything", connection("full-access", everything)],
  ["a connection with everything, Supervised", connection("auto", everything)],
  ["a connection with a selected grant", connection("full-access", selected)],
];

describe("dispatchCommand", () => {
  it("runs the person's command in the handler registered for its type, once", async () => {
    for (const type of types) {
      const { registry, calls } = spyRegistry();
      const command = sample(type);
      const actor = personActor(context);
      await dispatchCommand(actor, command, { registry }, context);
      expect(calls).toEqual([type]);
      expect(registry[type].run).toHaveBeenCalledWith(actor, command, context);
    }
  });

  describe.each(agents)("for %s", (_name, agent) => {
    it("never gives a command to a handler written for the person, for any type", async () => {
      // Generated from the table: every family, every type. A handler that takes the session's
      // user as authority would make the agent the owner; the agent's command waits instead.
      const { registry, calls } = spyRegistry();
      for (const type of types) {
        const row = commandTable[type] as CommandRow;
        const outcome = dispatchCommand(agent, sample(type), { registry });
        const rule = commandRule(row, commandFace(sample(type)), {
          connection:
            agent.kind === "connection"
              ? { grant: agent.grant.scope }
              : agent.agentConnection
                ? { grant: agent.agentConnection.grant.scope }
                : null,
          mode: agent.accessMode,
          reach: false,
        });
        if (rule.answer === "not_found")
          await expect(outcome, type).rejects.toMatchObject({
            code: "not_found",
            message: "That item is unavailable.",
          });
        else await expect(outcome, type).resolves.toMatchObject({ status: "ask" });
      }
      expect(calls).toEqual([]);
    });

    it("reads every command the person's own screen holds as not found", async () => {
      const { registry } = spyRegistry();
      for (const type of types)
        if ((commandTable[type] as CommandRow).faces.every((f) => f.class === "person-view"))
          await expect(dispatchCommand(agent, sample(type), { registry }), type).rejects.toThrow(
            "That item is unavailable.",
          );
    });
  });

  it("refuses an agent's command that carries a value only the person types", async () => {
    const { registry, calls } = spyRegistry();
    for (const type of types) {
      const row = commandTable[type] as CommandRow;
      for (const field of row.secretFields ?? [])
        await expect(
          dispatchCommand(
            run("full-access"),
            { ...sample(type), [field]: "typed-by-the-agent" } as HostApiCommand,
            { registry },
          ),
          `${type}.${field}`,
        ).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(calls).toEqual([]);
  });

  it("lets only a held session stand for the person", () => {
    const handler = {} as PersonCommandHandler<"thread.rename">;
    const command = sample("thread.rename") as Extract<HostApiCommand, { type: "thread.rename" }>;
    const agent = run("full-access");
    if (Math.random() > 2) {
      // @ts-expect-error A user id is not the person: only personActor(context) makes one.
      const forged: PersonActor = { kind: "person", userId, session };
      // @ts-expect-error A handler written for the person cannot be given an agent.
      void handler.run(agent, command, context);
      void forged;
    }
    expectTypeOf(
      dispatchCommand(agent, command, { registry: spyRegistry().registry }),
    ).toEqualTypeOf<Promise<CommandAsk>>();
    expect(() => personActor({ session: null } as unknown as HostApiServerContext)).toThrow(
      "Authentication required",
    );
  });
});
