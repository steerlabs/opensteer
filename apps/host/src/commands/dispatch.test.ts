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
import { dispatchCommand, type AgentCommandOutcome } from "./dispatch.js";
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
    "browser.password-sign-in.respond": { decision: { kind: "decline" } },
    "connection.authorize": { decision: { kind: "deny" } },
    "plugins.schedule.answer": { action: "decline" },
    "tab.open": { target: { kind: "page", url: "about:blank", guest: true } },
    "settings.plugin.enabled.set": { target: { kind: "plugin", pluginId: "p" } },
    "browser.session.start": { input: { threadId: "thr_x" } },
    "trigger.create": { input: { anchorThreadId: "thr_x" } },
    "iphone.screen.attach": { target: { kind: "new", name: "iPhone" } },
    "integration.computer.policy.set": { input: { runnerId: "run_x", appApproval: "ask" } },
    "integration.grant.create": { input: { connectionId: "ic_x" } },
    "plugin.authorization.prepare": { input: { plugin: "p" } },
    "tab.close": { tabIds: ["t"] },
    "tab.organize": { tabIds: ["t"] },
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
  ["a connection with everything, Auto", connection("auto", everything)],
  ["a connection with a selected grant", connection("full-access", selected)],
];

/** A copy of the command with a value at a dotted path, as an agent might send it. */
function withPath(command: HostApiCommand, path: string, value: unknown): HostApiCommand {
  const copy = structuredClone(command) as Record<string, unknown>;
  const keys = path.split(".");
  let at = copy;
  for (const key of keys.slice(0, -1)) {
    at[key] = typeof at[key] === "object" && at[key] !== null ? at[key] : {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys.at(-1)!] = value;
  return copy as HostApiCommand;
}

/** Refuses at once: nothing may read an admission. */
const admitNothing = async (): Promise<never> => {
  throw new Error("admitted");
};

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
    /** The rule's own answer for this agent, as `admitCommand` would give it on live facts. */
    const byRule = async (caller: AgentCaller, command: HostApiCommand) => {
      const face = commandFace(command);
      const rule = commandRule(commandTable[command.type] as CommandRow, face, {
        connection:
          caller.kind === "connection"
            ? { grant: caller.grant.scope }
            : caller.agentConnection
              ? { grant: caller.agentConnection.grant.scope }
              : null,
        mode: caller.accessMode,
        reach: true,
        ownWork: true,
      });
      return { ...rule, face, execution: null };
    };
    /** An admission that lets everything through: the door alone must still hold the line. */
    const always = async () => ({ answer: "now" as const, face: 0, execution: null });

    it.each([
      ["the rule", byRule],
      ["an admission that says now to everything", always],
    ])(
      "never gives a command to a handler written for the person, for any type (%s)",
      async (_admission, admit) => {
        // Generated from the table: every family, every type. A handler that takes the session's
        // user as authority would make the agent the owner; the agent's command waits instead.
        const { registry, calls } = spyRegistry();
        for (const type of types) {
          const command = sample(type);
          const admitted = await admit(agent, command);
          const answer = admitted.answer;
          const outcome = dispatchCommand(agent, command, { registry, admit });
          if (answer === "not_found")
            await expect(outcome, type).rejects.toMatchObject({
              code: "not_found",
              message: "That item is unavailable.",
            });
          else {
            // An ask about an ask points at the Request the person already has; others wait.
            const row = commandTable[type] as CommandRow;
            const face = admitted.face;
            const pointsAtRequest =
              face !== undefined &&
              row.answersAsk?.faces.includes(face) &&
              (row.answersAsk.of as (c: HostApiCommand) => { kind: string })(command).kind ===
                "request";
            await expect(outcome, type).resolves.toMatchObject({
              status: pointsAtRequest ? "pending" : "ask",
            });
          }
        }
        expect(calls).toEqual([]);
      },
    );

    it("reads every command the person's own screen holds as not found", async () => {
      const { registry } = spyRegistry();
      for (const type of types)
        if ((commandTable[type] as CommandRow).faces.every((f) => f.class === "person-view"))
          await expect(
            dispatchCommand(agent, sample(type), { registry, admit: byRule }),
            type,
          ).rejects.toThrow("That item is unavailable.");
    });
  });

  it("refuses an agent's command that carries a value only the person types, nested included", async () => {
    const { registry, calls } = spyRegistry();
    const admitted = async () => ({ answer: "ask" as const, face: 0, execution: null });
    for (const type of types) {
      const row = commandTable[type] as CommandRow;
      for (const path of row.secretFields ?? [])
        await expect(
          dispatchCommand(run("full-access"), withPath(sample(type), path, "typed-by-the-agent"), {
            registry,
            admit: admitted,
          }),
          `${type}.${path}`,
        ).rejects.toMatchObject({ code: "bad_request" });
    }
    // Only those paths: a custom sign-in app proposed without its client secret is fine.
    await expect(
      dispatchCommand(
        run("full-access"),
        {
          type: "plugin.oauthApp.save",
          idempotencyKey: "k",
          input: { issuer: "https://issuer.example", clientId: "client" },
        } as HostApiCommand,
        { registry, admit: admitted },
      ),
    ).resolves.toMatchObject({ status: "ask" });
    expect(calls).toEqual([]);
  });

  it("points an ask about an ask at the Request the person already has, opening nothing", async () => {
    const { registry, calls } = spyRegistry();
    const proposed: string[] = [];
    const door = {
      registry,
      admit: async () => ({
        answer: "ask" as const,
        face: 0,
        reason: "approval" as const,
        execution: null,
      }),
      propose: async () => {
        proposed.push("opened");
        return { status: "pending" as const, requestId: "req_new" as never, existing: false };
      },
    };
    await expect(
      dispatchCommand(
        run("full-access"),
        {
          type: "request.command.approve",
          idempotencyKey: "k",
          requestId: "req_the_persons",
          expectedRevision: "1",
          command: {},
        } as unknown as HostApiCommand,
        door,
      ),
    ).resolves.toEqual({
      status: "pending",
      requestId: "req_the_persons",
      reason: "approval",
      existing: true,
    });
    expect(proposed).toEqual([]);
    // Anything else that waits for the person is put to them once.
    await expect(
      dispatchCommand(run("full-access"), sample("harness.rename"), door),
    ).resolves.toMatchObject({
      status: "pending",
      requestId: "req_new",
    });
    expect(proposed).toEqual(["opened"]);
    expect(calls).toEqual([]);
  });

  it("answers not found before anything else is said, secrets included", async () => {
    const { registry, calls } = spyRegistry();
    const outside = async () => ({ answer: "not_found" as const, face: 0, execution: null });
    const fixed = { code: "not_found", message: "That item is unavailable." };
    // An unknown type reads like something that does not exist, never a crash.
    await expect(
      dispatchCommand(
        connection("full-access", selected),
        { type: "no.such.command", idempotencyKey: "k" } as unknown as HostApiCommand,
        { registry, admit: outside },
      ),
    ).rejects.toMatchObject(fixed);
    // Outside the grant with a secret in it: the same not found, not "leave it out".
    for (const type of types)
      for (const path of (commandTable[type] as CommandRow).secretFields ?? [])
        await expect(
          dispatchCommand(
            connection("full-access", selected),
            withPath(sample(type), path, "typed-by-the-agent"),
            { registry, admit: outside },
          ),
          `${type}.${path}`,
        ).rejects.toMatchObject(fixed);
    expect(calls).toEqual([]);
  });

  it("refuses at runtime a person's actor that personActor did not make", async () => {
    const { registry, calls } = spyRegistry();
    const real = personActor(context);
    const command = sample("thread.rename");
    for (const [label, forged] of [
      ["a structural copy", { kind: "person", userId, session }],
      ["a spread copy", { ...real }],
      ["a cast", JSON.parse(JSON.stringify(real))],
    ] as const)
      await expect(
        dispatchCommand(forged as unknown as PersonActor, command, { registry }, context),
        label,
      ).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toEqual([]);
    await dispatchCommand(real, command, { registry }, context);
    expect(calls).toEqual(["thread.rename"]);
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
    const dispatchAsAgent = () =>
      dispatchCommand(agent, command, { registry: spyRegistry().registry, admit: admitNothing });
    // An agent's dispatch never hands back a handler's raw output: what it may read, or what waits.
    expectTypeOf<ReturnType<typeof dispatchAsAgent>>().toEqualTypeOf<
      Promise<AgentCommandOutcome>
    >();
    expect(() => personActor({ session: null } as unknown as HostApiServerContext)).toThrow(
      "Authentication required",
    );
  });
});
