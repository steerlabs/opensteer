import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  AgentGrant,
  AuthenticatedSession,
  OpensteerError,
  ThreadAccessMode,
  UserId,
} from "@opensteer/core";
import { commandHolds, commandRule } from "@opensteer/database";
import type { HostApiCommand, HostApiServerContext } from "@opensteer/protocol";
import {
  commandFace,
  commandTable,
  type CommandRow,
  type CommandType,
} from "@opensteer/protocol/command-table";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { personActor, type PersonActor } from "./actor.js";
import { OperationOutcomeUnknown } from "../agent-sessions/agent-session-service.js";
import { dispatchCommand, type AgentCommandOutcome } from "./dispatch.js";
import type { CommandRegistry, PersonCommandHandler } from "./registry.js";
import { sampleCommand } from "@opensteer/protocol/test-support/command-samples";
import { proposedCommand } from "./requests.js";

const userId = "usr_owner" as UserId;
const session = { id: "ses_1", user: { id: userId } } as unknown as AuthenticatedSession;
const context = { session } as unknown as HostApiServerContext;
const types = Object.keys(commandTable) as CommandType[];

/** A command of each type its own schema accepts, where its JSON Schema can say how. */
function sample(type: CommandType): HostApiCommand {
  // What an agent sends: never a value only the person types.
  return {
    ...proposedCommand(commandTable[type] as CommandRow, sampleCommand(type).command),
    idempotencyKey: "k",
  } as unknown as HostApiCommand;
}
const parses = (type: CommandType) => sampleCommand(type).valid;

/** Whether the door holds a type for this agent, from its grant: the listing's own answer. */
const holds = (agent: AgentCaller, type: CommandType) => {
  const grant = agent.kind === "connection" ? agent.grant : agent.agentConnection?.grant;
  return commandHolds(type, {
    scope: grant?.scope ?? null,
    grant: grant ?? null,
    mode: agent.accessMode,
  });
};

/** The grant as the Home has it now: in these doors, the one the caller signed in with. */
const signedIn = async (agent: AgentCaller) => {
  const grant = agent.kind === "connection" ? agent.grant : agent.agentConnection?.grant;
  return { scope: grant?.scope ?? null, grant: grant ?? null, mode: agent.accessMode };
};

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
function withPath(command: HostApiCommand, path: string, given: unknown): HostApiCommand {
  // A secret of the shape its schema reads: text, or a set of named values.
  const value = /(?:^|\.)(?:secrets|credentials|fields|set)$/u.test(path)
    ? { TOKEN: String(given) }
    : given;
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

/** A value its schema accepts at that path, as a person would type it. */
function validSecret(type: CommandType, path: string): unknown {
  let at: unknown = sampleCommand(type).command;
  for (const key of path.split(".")) at = (at as Record<string, unknown> | undefined)?.[key];
  return at ?? "typed-by-the-agent";
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

  it("ends a computer-use session for the person at once, never as an ask, with nothing added (AD10 route 7)", async () => {
    // The person's Stop of a computer-use session is the handler the route called, run once:
    // the door's person path reads no admission, no scope and opens no Request, so it costs
    // what the route cost and cannot become an ask.
    const { registry, calls } = spyRegistry();
    const admit = vi.fn(async () => ({ answer: "ask" as const, face: 0, execution: null }));
    const scope = vi.fn(async () => null);
    const propose = vi.fn();
    const command = {
      type: "integration.computer.session.stop",
      idempotencyKey: "k",
      sessionId: "cus_00000000-0000-4000-8000-000000000001",
    } as unknown as HostApiCommand;
    const output = await dispatchCommand(
      personActor(context),
      command,
      { registry, admit, scope, propose } as never,
      context,
    );
    expect(output).toEqual({ type: "integration.computer.session.stop" });
    expect(calls).toEqual(["integration.computer.session.stop"]);
    expect(admit).not.toHaveBeenCalled();
    expect(scope).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
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
          const held = holds(agent, type);
          const answer = held ? admitted.answer : "not_found";
          const outcome = dispatchCommand(agent, command, { registry, admit, scope: signedIn });
          if (held && !parses(type))
            await expect(outcome, type).rejects.toMatchObject({ code: "bad_request" });
          else if (answer === "not_found")
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
            dispatchCommand(agent, sample(type), { registry, admit: byRule, scope: signedIn }),
            type,
          ).rejects.toThrow("That item is unavailable.");
    });
  });

  it("settles an outside command whose handler throws after acting as unknown (G4, rule 4)", async () => {
    const thrown = new Error("The computer stopped answering mid-revoke");
    const registry = {
      ...spyRegistry().registry,
      "machine.revoke": {
        accepts: "any",
        run: async () => {
          throw thrown;
        },
      },
    } as unknown as CommandRegistry;
    const settled: string[] = [];
    const door = {
      registry,
      admit: async () => ({ answer: "now" as const, face: 0, execution: null }),
      scope: signedIn,
      attempts: {
        begin: async () => ({ kind: "begun" as const, id: "cat_1" }),
        settle: async (_id: string, state: string) => {
          settled.push(state);
        },
      },
    };
    const outcome = dispatchCommand(run("full-access"), sample("machine.revoke"), door);
    await expect(outcome).rejects.toBeInstanceOf(OperationOutcomeUnknown);
    expect(settled).toEqual(["unknown"]);
  });

  it("reads a folder install under a connection's grant like a kind the schema does not know (rule 5)", async () => {
    const { registry } = spyRegistry();
    const asked = async () => ({ answer: "ask" as const, face: 0, execution: null });
    const install = (source: Record<string, unknown>) =>
      ({
        type: "plugins.install",
        idempotencyKey: "install-1",
        source,
      }) as unknown as HostApiCommand;
    const refusal = (caller: AgentCaller, source: Record<string, unknown>) =>
      dispatchCommand(caller, install(source), { registry, admit: asked, scope: signedIn }).catch(
        (error: unknown) => error,
      );
    for (const caller of [connection("full-access", everything), run("full-access", everything)]) {
      const folder = await refusal(caller, { kind: "folder", directory: "draft" });
      const unknown = await refusal(caller, { kind: "unheard-of", directory: "draft" });
      expect(folder).toMatchObject({ code: "bad_request" });
      expect(folder).toEqual(unknown);
    }
    // Your own agent's folder install is a command the door reads and puts to the person.
    await expect(
      dispatchCommand(run("full-access"), install({ kind: "folder", directory: "draft" }), {
        registry,
        admit: asked,
        scope: signedIn,
      }),
    ).resolves.toMatchObject({ status: "ask" });
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
            scope: signedIn,
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
        { registry, admit: admitted, scope: signedIn },
      ),
    ).resolves.toMatchObject({ status: "ask" });
    expect(calls).toEqual([]);
  });

  it("points an ask about an ask at the Request the person already has, opening nothing", async () => {
    const theirs = "req_00000000-0000-4000-8000-0000000000aa";
    const { registry, calls } = spyRegistry();
    const proposed: string[] = [];
    const door = {
      registry,
      scope: signedIn,
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
          requestId: theirs,
          expectedRevision: "1",
          command: {},
        } as unknown as HostApiCommand,
        door,
      ),
    ).resolves.toEqual({
      status: "pending",
      requestId: theirs,
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

  it("answers a type the caller does not hold before touching its input (D8)", async () => {
    const { registry, calls } = spyRegistry();
    const admit = async () => {
      throw new Error("A type the caller does not hold was admitted");
    };
    for (const [name, agent] of agents)
      for (const type of types) {
        if (holds(agent, type)) continue;
        // What reaches the agent: everything but where in the Home it was thrown.
        const said = (error: unknown) => {
          const { code, message, reason, next, details } = error as OpensteerError;
          return JSON.stringify({ code, message, reason, next, details });
        };
        const malformed = dispatchCommand(agent, { type } as unknown as HostApiCommand, {
          registry,
          admit,
          scope: signedIn,
        }).catch(said);
        const wellFormed = dispatchCommand(agent, sample(type), {
          registry,
          admit,
          scope: signedIn,
        }).catch(said);
        const [left, right] = await Promise.all([malformed, wellFormed]);
        expect(left, `${name} ${type}`).toBe(right);
        expect(JSON.parse(left as string)).toMatchObject({
          code: "not_found",
          message: "That item is unavailable.",
        });
      }
    expect(calls).toEqual([]);
    // A held type is read with its schema: a malformed one may say what is wrong.
    await expect(
      dispatchCommand(run("full-access"), { type: "thread.rename" } as unknown as HostApiCommand, {
        registry,
        admit,
        scope: signedIn,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
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
        { registry, admit: outside, scope: signedIn },
      ),
    ).rejects.toMatchObject(fixed);
    // Outside the grant with a secret in it: the same not found, not "leave it out".
    for (const type of types)
      for (const path of parses(type)
        ? ((commandTable[type] as CommandRow).secretFields ?? [])
        : [])
        await expect(
          dispatchCommand(
            connection("full-access", selected),
            withPath(sample(type), path, validSecret(type, path)),
            { registry, admit: outside, scope: signedIn },
          ),
          `${type}.${path}`,
        ).rejects.toMatchObject(fixed);
    expect(calls).toEqual([]);
  });

  it("decides whether a caller holds a type from its grant as the Home has it now (X15)", async () => {
    const { registry, calls } = spyRegistry();
    // Signed in with everything; since then narrowed to selected, opened to anyone, or ended.
    const agent = connection("full-access", everything);
    // Not even valid: a type it no longer holds must not say what is wrong with its input.
    const bad = { type: "harness.rename", idempotencyKey: "k" } as unknown as HostApiCommand;
    const narrowed = { scope: "selected" as const, grant: selected, mode: "full-access" as const };
    for (const now of [narrowed, "gone" as const])
      await expect(
        dispatchCommand(agent, bad, { registry, admit: admitNothing, scope: async () => now }),
        String(now),
      ).rejects.toMatchObject({ code: "not_found", message: "That item is unavailable." });
    expect(calls).toEqual([]);
  });

  it("lists a type exactly where the door holds it, and parses nothing it does not (AD1)", async () => {
    const shapes: Record<string, AgentGrant> = {
      empty: { scope: "selected", tasks: false, resources: [] },
      tasks: { scope: "selected", tasks: true, resources: [] },
      profile: {
        scope: "selected",
        tasks: false,
        resources: [
          { kind: "browser-profile", profileId: "bpr_00000000-0000-4000-8000-000000000001" },
        ],
      },
      chrome: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "chrome-tabs", sourceId: "bsr_00000000-0000-4000-8000-000000000001" }],
      },
      plugin: {
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "plugin",
            target: { kind: "installed", pluginId: "notes" },
            access: "read-write",
          },
        ],
      },
      everything: { scope: "everything" },
    } as unknown as Record<string, AgentGrant>;
    for (const [name, grant] of Object.entries(shapes)) {
      const agent = connection("full-access", grant);
      const door = {
        registry: spyRegistry().registry,
        admit: async () => ({ answer: "now" as const, face: 0, execution: null }),
        scope: async () => ({ scope: grant.scope, grant, mode: "full-access" as const }),
      };
      for (const type of types) {
        const listed = commandHolds(type, { scope: grant.scope, grant, mode: "full-access" });
        // Not even valid: only a type it holds may say what is wrong with its input.
        const answer = await dispatchCommand(
          agent,
          { type, idempotencyKey: "k" } as unknown as HostApiCommand,
          door,
        ).then(
          () => "ran",
          (error: OpensteerError) => error.code,
        );
        expect(answer === "not_found", `${type} for ${name}`).toBe(!listed);
      }
    }
    // The reader's case: a grant with no plugin, removing one, is told nothing of its input.
    expect(
      commandHolds("plugins.remove", {
        scope: "selected",
        grant: shapes.tasks!,
        mode: "full-access",
      }),
    ).toBe(false);
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
      dispatchCommand(agent, command, {
        registry: spyRegistry().registry,
        admit: admitNothing,
        scope: signedIn,
      });
    // An agent's dispatch never hands back a handler's raw output: what it may read, or what waits.
    expectTypeOf<ReturnType<typeof dispatchAsAgent>>().toEqualTypeOf<
      Promise<AgentCommandOutcome>
    >();
    expect(() => personActor({ session: null } as unknown as HostApiServerContext)).toThrow(
      "Authentication required",
    );
  });
});
