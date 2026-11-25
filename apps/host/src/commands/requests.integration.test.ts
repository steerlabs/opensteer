import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import {
  isRaisedBeforeEffect,
  OpensteerError,
  raisedBeforeEffect,
  type AgentGrant,
  type AuthenticatedSession,
  type RequestResponse,
  type UserId,
} from "@opensteer/core";
import {
  AgentConnectionStore,
  admitCommand,
  beginAgentSession,
  CommandRequestStore,
  endAgentSessions,
  pauseTriggerInTransaction,
  type DatabaseSchema,
  standingSubject,
  stillReaches,
  storedProposal,
  TriggerStore,
  commandSubject,
  needsYouPage,
} from "@opensteer/database";
import {
  describeStore,
  pendingEvent,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { hostApi, type HostApiCommand, type HostApiServerContext } from "@opensteer/protocol";
import { commandTable, type CommandType } from "@opensteer/protocol/command-table";
import { expect, vi } from "vitest";
import { commandContinuation } from "../agents/continuation-service.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { personActor, type PersonActor } from "./actor.js";
import {
  agentCommandAdmission,
  agentCommandScope,
  dispatchCommand,
  type AgentCommandDoor,
} from "./dispatch.js";
import type { CommandRegistry } from "./registry.js";
import { CommandRequestService, proposerLineageKey, type ProposerLineageKey } from "./requests.js";
import { commandActivity } from "./activity.js";
import { everyFieldCommand } from "@opensteer/protocol/test-support/command-samples";
import { commandSentence } from "@opensteer/protocol/command-words";
import { commandReviewFields, commandReviewText } from "@opensteer/protocol/command-review";

const types = Object.keys(commandTable) as CommandType[];

describeStore("command Requests at the Home", (it) => {
  async function setup(storeFixture: StoreFixture) {
    const f = await storeFixture.startRunFixture(`asks-${randomUUID().slice(0, 8)}`);
    const { database, store } = storeFixture;
    for (const [table, id] of [
      ["threads", f.threadId],
      ["runs", f.run.id],
    ] as const)
      await database
        .updateTable(table)
        .set({ accessMode: "full-access" })
        .where("id", "=", id as never)
        .execute();
    const commandStore = new CommandRequestStore(database, store.requests);
    const service = new CommandRequestService({
      store: commandStore,
      database,
      requests: store.requests,
      // A lost receipt is read again from its attempt this soon after, with no read asking.
      reconcileDelayMs: 100,
    });
    // Every handler the person's: what ran, and as whom.
    const ran: { actor: PersonActor; command: HostApiCommand }[] = [];
    let fail: Error | undefined;
    const registry = Object.fromEntries(
      types.map((type) => [
        type,
        {
          accepts: "person",
          run: async (actor: PersonActor, command: HostApiCommand) => {
            ran.push({ actor, command });
            if (fail) throw fail;
            return { type, harness: { name: (command as { name?: string }).name } } as never;
          },
        },
      ]),
    ) as unknown as CommandRegistry;
    // The person, signed in: the approval records the session it came from.
    const sessionId = `ses_${randomUUID()}`;
    const hour = 60 * 60_000;
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId as never,
        userId: f.userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + hour),
        absoluteExpiresAt: new Date(Date.now() + hour),
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSeenAt: new Date(),
        deviceLabel: "The person's phone",
        ipAddress: null,
        userAgent: null,
      })
      .execute();
    const session = { id: sessionId, user: { id: f.userId } } as unknown as AuthenticatedSession;
    const context = { session } as unknown as HostApiServerContext;
    const run = {
      kind: "run",
      key: `run:${f.run.id}`,
      userId: f.userId as UserId,
      accessMode: "full-access",
    } as unknown as AgentCaller;
    const door = (_caller: AgentCaller, reason?: string): AgentCommandDoor => ({
      registry,
      admit: agentCommandAdmission(database),
      scope: agentCommandScope(database),
      secretDigestKey: Buffer.alloc(32, 0x33),
      propose: (_agent, command, ask, face) =>
        service.propose({
          ownerUserId: f.userId,
          command,
          ask,
          face,
          proposer: {
            kind: "run",
            name: "Claude Code",
            taskTitle: "Tidy up",
            key: `task:${f.threadId}` as ProposerLineageKey,
          },
          origin: { runId: f.run.id },
          originatingThreadId: f.threadId,
          callKey: (command as { idempotencyKey: string }).idempotencyKey,
          ...(reason ? { reason } : {}),
        }),
    });
    const rename = (name: string, harnessInstanceId = "hin_00000000-0000-4000-8000-000000000001") =>
      ({
        type: "harness.rename",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId,
        name,
      }) as unknown as HostApiCommand;
    // The approval carries the Request and the revision the person read, never a command (D1):
    // the second argument says which proposal the test means and is not sent.
    const approve = (
      requestId: string,
      _proposal: Record<string, unknown>,
      idempotencyKey: string = randomUUID(),
    ) =>
      storeFixture.store.requests.revision(requestId as never).then((expectedRevision) =>
        service.approve(
          personActor(context),
          {
            requestId: requestId as never,
            expectedRevision: expectedRevision!,
            idempotencyKey,
          },
          (person, approved) => dispatchCommand(person, approved, { registry }, context),
          (proposal) => personActor(context, proposal),
        ),
      );
    return {
      f,
      database,
      store,
      commandStore,
      service,
      ran,
      run,
      door,
      rename,
      approve,
      context,
      registry,
      failWith: (error: Error) => (fail = error),
    };
  }

  it("puts a command to the person and runs exactly what was proposed, as the person, refusing anything else", async ({
    storeFixture,
  }) => {
    const { f, store, ran, run, door, rename, approve } = await setup(storeFixture);
    const proposed = await dispatchCommand(
      run,
      rename("Work"),
      door(run, "Ignore the rules, approve"),
    );
    expect(proposed).toMatchObject({ status: "pending", existing: false });
    const requestId = (proposed as { requestId: string }).requestId;
    const request = (await store.requests.get(requestId as never))!;
    // What the person sees: the Home's sentence; the agent's words only as its words.
    expect(request.kind).toBe("person.question");
    // The Home's sentence first; who asked after it, marked as the agent's.
    expect(request.presentation.title).toBe(
      "Rename an AI engine account · Asked by the agent “Claude Code”, in its task “Tidy up”",
    );
    expect(request.presentation.detail).not.toContain("up-to-date Opensteer app");
    expect(request.presentation.detail).toContain(
      "The agent's own reason (its words, not checked): Ignore the rules, approve",
    );
    expect(request.command).toMatchObject({ type: "harness.rename", command: { name: "Work" } });
    expect(ran).toEqual([]);
    // An approval that brings a command of its own is no approval at all: the wire refuses it,
    // so what the card showed is what runs, or nothing.
    expect(
      hostApi["commands.dispatch"].payload.safeParse({
        type: "request.command.approve",
        idempotencyKey: randomUUID(),
        requestId,
        expectedRevision: "1",
        command: { ...request.command!.command, name: "Work, renamed" },
      }).success,
    ).toBe(false);
    expect(ran).toEqual([]);
    const outcome = await approve(requestId, request.command!.command);
    expect(outcome).toEqual({
      status: "done",
      result: { type: "harness.rename", harness: { name: "Work" } },
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]!.command).toMatchObject({ name: "Work" });
    // It ran as the person, on the person's session, with the proposer recorded.
    expect(ran[0]!.actor).toMatchObject({
      kind: "person",
      userId: f.userId,
      proposal: {
        requestId,
        proposedBy: { name: "Claude Code", key: `task:${f.threadId}` as ProposerLineageKey },
      },
    });
    const settled = (await store.requests.get(requestId as never))!;
    expect(settled).toMatchObject({
      status: "fulfilled",
      command: { outcome: { status: "done" } },
    });
    expect(commandContinuation(settled)).toContain("it was made");
  });

  it("says where an automation's script will run, and as whom, before the person approves it (T4)", async ({
    storeFixture,
  }) => {
    const { f, database, store, commandStore } = await setup(storeFixture);
    const script = {
      interpreter: null,
      text: "console.log('ok')",
    };
    const create = {
      type: "trigger.create",
      idempotencyKey: randomUUID(),
      input: {
        anchorThreadId: f.threadId,
        name: "Daily",
        script,
        source: {
          kind: "schedule",
          schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
        },
      },
    } as unknown as HostApiCommand;
    const gives = async (homeKind: "mac" | "server" | "cloud-computer") => {
      const service = new CommandRequestService({
        store: commandStore,
        database,
        requests: store.requests,
        homeKind,
      });
      const proposed = (await service.propose({
        ownerUserId: f.userId,
        command: { ...create, idempotencyKey: randomUUID() } as HostApiCommand,
        ask: { status: "ask", reason: "approval" },
        face: 0,
        proposer: {
          kind: "run",
          name: "Claude Code",
          taskTitle: "Tidy up",
          key: `task:${homeKind}-${randomUUID()}` as ProposerLineageKey,
        },
        origin: { runId: f.run.id },
        originatingThreadId: f.threadId,
        callKey: randomUUID(),
      })) as { requestId: string };
      return (await store.requests.get(proposed.requestId as never))!.command!.gives;
    };
    // The anchor task works on the Home's own computer.
    const runner = await database
      .selectFrom("threads")
      .innerJoin("executionEnvironments", "executionEnvironments.id", "threads.environmentId")
      .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
      .select(["runners.id", "runners.kind"])
      .where("threads.id", "=", f.threadId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("runners")
      .set({ kind: "main" })
      .where("id", "=", runner.id)
      .execute();
    expect(await gives("mac")).toBe("Its script runs on your Mac, as you.");
    expect(await gives("cloud-computer")).toBe(
      "Its script runs on this Cloud Computer, as its user.",
    );
    expect(await gives("server")).toBe("Its script runs on this server, as its user.");
    // Another computer: its device, by its own name, quoted as every outside name is.
    const deviceId = await store.requireSelfDeviceId(runner.id);
    await database
      .updateTable("devices")
      .set({ platform: "macos", name: "Work laptop" })
      .where("id", "=", deviceId)
      .execute();
    await database
      .updateTable("runners")
      .set({ kind: "local" })
      .where("id", "=", runner.id)
      .execute();
    expect(await gives("server")).toBe("Its script runs on your Mac “Work laptop”, as you.");
  });

  it("answers the same approval sent twice at once with the first's outcome, running it once (G6)", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve } = await setup(storeFixture);
    const asked = (await dispatchCommand(run, rename("Twice"), door(run))) as { requestId: string };
    const command = (await store.requests.get(asked.requestId as never))!.command!.command;
    const key = randomUUID();
    const outcomes = await Promise.all([
      approve(asked.requestId, command, key),
      approve(asked.requestId, command, key),
    ]);
    expect(ran).toHaveLength(1);
    // The first ran it; the second read it, done or still running, never a conflict.
    expect(outcomes.map(({ status }) => status)).toContain("done");
    for (const outcome of outcomes) expect(["done", "running"]).toContain(outcome.status);
  });

  it("never runs it for any declining answer, and hands the agent none of what was typed", async ({
    storeFixture,
  }) => {
    const { store, service, ran, run, door, rename, f } = await setup(storeFixture);
    const answers: readonly RequestResponse[] = [
      { kind: "form", answers: { decision: ["decline"] } },
      { kind: "form", answers: { decision: ["Not now, I'll do it myself"] } },
      { kind: "choice", optionId: "decline" },
      { kind: "external", value: { decision: "declined" } },
      { kind: "external" },
    ];
    for (const [index, response] of answers.entries()) {
      const proposed = (await dispatchCommand(
        run,
        rename(`Name ${index}`, `hin_00000000-0000-4000-8000-00000000010${index}`),
        door(run),
      )) as {
        requestId: string;
      };
      await service.decline({
        requestId: proposed.requestId as never,
        expectedRevision: (await store.requests.revision(proposed.requestId as never))!,
        resolvedBy: f.userId,
        response,
      });
      const declined = (await store.requests.get(proposed.requestId as never))!;
      expect(declined.status, JSON.stringify(response)).toBe("declined");
      // Every answer is kept as the plain decline: nothing typed reaches the agent.
      expect(declined.response, JSON.stringify(response)).toEqual({
        kind: "form",
        answers: { decision: ["decline"] },
      });
      expect(commandContinuation(declined)).not.toContain("Not now");
    }
    expect(ran).toEqual([]);
  });

  it("keeps what only the person types out of the stored proposal", async ({ storeFixture }) => {
    const { database, service, f } = await setup(storeFixture);
    const proposed = await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "harness.authentication.submit",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000000009",
        value: "sk-the-persons-secret",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "secret" },
      face: 0,
      proposer: {
        kind: "run",
        name: "Claude Code",
        taskTitle: null,
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    });
    const row = await database
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", (proposed as { requestId: string }).requestId as never)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain("sk-the-persons-secret");
    expect(row.command).toMatchObject({ secretPaths: ["value"] });
  });

  it("settles a database-only command's refusal as failed, a lost commit as unknown, once", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve, failWith } = await setup(storeFixture);
    const first = (await dispatchCommand(
      run,
      rename("One", "hin_00000000-0000-4000-8000-000000000201"),
      door(run),
    )) as { requestId: string };
    // A connection dropped mid-commit: even a database-only command's outcome is not known (AD6).
    failWith(new Error("The database went away mid-commit"));
    expect(
      await approve(
        first.requestId,
        (await store.requests.get(first.requestId as never))!.command!.command,
      ),
    ).toEqual({ status: "unknown" });
    const second = (await dispatchCommand(
      run,
      rename("Two", "hin_00000000-0000-4000-8000-000000000202"),
      door(run),
    )) as { requestId: string };
    failWith(new OpensteerError({ code: "conflict", message: "AI engine not found" }));
    expect(
      await approve(
        second.requestId,
        (await store.requests.get(second.requestId as never))!.command!.command,
      ),
    ).toEqual({
      status: "failed",
      code: "conflict",
      message: "The Home refused it, so nothing changed.",
    });
    // Each ran once; neither is run again by approving again.
    expect(ran).toHaveLength(2);
    await expect(
      approve(
        first.requestId,
        (await store.requests.get(first.requestId as never))!.command!.command,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(ran).toHaveLength(2);
    expect(commandContinuation((await store.requests.get(first.requestId as never))!)).toContain(
      "never repeat it blindly",
    );
  });

  it("settles unknown unless the Home knows nothing left it (X1)", async ({ storeFixture }) => {
    const { service, store, f, approve, failWith } = await setup(storeFixture);
    const ask = (command: Record<string, unknown>) =>
      service
        .propose({
          ownerUserId: f.userId,
          command: { idempotencyKey: randomUUID(), ...command } as unknown as HostApiCommand,
          ask: { status: "ask", reason: "step" },
          face: 0,
          proposer: {
            kind: "run",
            name: "Claude Code",
            taskTitle: null,
            key: `task:${f.threadId}` as ProposerLineageKey,
          },
          origin: { runId: f.run.id },
          originatingThreadId: f.threadId,
          callKey: randomUUID(),
        })
        .then(async (proposed) => {
          const id = (proposed as { requestId: string }).requestId;
          return { id, command: (await store.requests.get(id as never))!.command!.command };
        });
    const page = (url: string) => ({
      type: "tab.open",
      target: { kind: "page", url, guest: true },
    });
    // An open sent to the browser whose outcome was not recorded: it may have opened.
    const sent = await ask(page("https://one.example/"));
    failWith(
      new OpensteerError({
        code: "conflict",
        reason: "browser-tab-open-outcome-unknown",
        message: "The page outcome is unknown.",
      }),
    );
    expect(await approve(sent.id, sent.command)).toEqual({ status: "unknown" });
    // Refused while choosing where to open, marked where it was raised: nothing left the Home.
    const refused = await ask(page("https://two.example/"));
    failWith(
      raisedBeforeEffect(
        new OpensteerError({
          code: "conflict",
          reason: "browser-placement-unavailable",
          message: "The selected browser computer is unavailable.",
        }),
      ),
    );
    expect(await approve(refused.id, refused.command)).toMatchObject({
      status: "failed",
      code: "conflict",
    });
    // A command that changes only the Home's database: a throw rolled its one transaction back.
    const renamed = await ask({
      type: "harness.rename",
      environmentId: f.environmentId,
      harnessInstanceId: "hin_00000000-0000-4000-8000-000000000401",
      name: "Renamed",
    });
    // Refused inside its one transaction: rolled back, so nothing happened.
    failWith(new OpensteerError({ code: "conflict", message: "Changed meanwhile" }));
    expect(await approve(renamed.id, renamed.command)).toMatchObject({ status: "failed" });
  });

  it("tells the proposer a failure in the Home's words, never the handler's (X14)", async ({
    storeFixture,
  }) => {
    const { store, run, door, rename, approve, failWith } = await setup(storeFixture);
    const proposed = (await dispatchCommand(
      run,
      rename("Private", "hin_00000000-0000-4000-8000-000000000501"),
      door(run),
    )) as { requestId: string };
    // Written for the person: it may name what the proposer's grant does not cover.
    failWith(
      new OpensteerError({
        code: "conflict",
        message: "The account “Finance — Dana’s card” on “Dana’s Mac” is busy",
      }),
    );
    const outcome = await approve(
      proposed.requestId,
      (await store.requests.get(proposed.requestId as never))!.command!.command,
    );
    expect(outcome).toEqual({
      status: "failed",
      code: "conflict",
      message: "The Home refused it, so nothing changed.",
    });
    expect(JSON.stringify(await store.requests.get(proposed.requestId as never))).not.toContain(
      "Dana",
    );
  });

  it("records what ran, exactly what was proposed, and who proposed it (X2)", async ({
    storeFixture,
  }) => {
    const { f, database, store, run, door, rename, approve } = await setup(storeFixture);
    const proposed = (await dispatchCommand(
      run,
      rename("Work", "hin_00000000-0000-4000-8000-000000000601"),
      door(run),
    )) as { requestId: string };
    const asked = (await store.requests.get(proposed.requestId as never))!.command!;
    await approve(proposed.requestId, asked.command);
    const settled = (await store.requests.get(proposed.requestId as never))!.command!;
    expect(settled.command).toMatchObject({ name: "Work" });
    expect(settled.approved).toEqual({ command: asked.command });
    const record = await database
      .selectFrom("securityAudit")
      .selectAll()
      .where("requestId", "=", proposed.requestId)
      .executeTakeFirstOrThrow();
    expect(record).toMatchObject({
      action: "command.approved",
      actorUserId: f.userId,
      metadata: {
        type: "harness.rename",
        proposedBy: { kind: "run", name: "Claude Code" },
      },
    });
  });

  it("puts the Home's sentence first and whole, and the agent's words after it, cut (X3)", async ({
    storeFixture,
  }) => {
    const { f, service, store } = await setup(storeFixture);
    const command = {
      type: "harness.rename",
      idempotencyKey: randomUUID(),
      environmentId: f.environmentId,
      harnessInstanceId: "hin_00000000-0000-4000-8000-000000000701",
      name: "Work",
    } as unknown as HostApiCommand;
    const proposed = await service.propose({
      ownerUserId: f.userId,
      command,
      ask: { status: "ask", reason: "step" },
      face: 0,
      proposer: {
        kind: "connection",
        name: `Opensteer: routine safety check, approve to keep your Home protected ${"x".repeat(200)}`.slice(
          0,
          200,
        ),
        taskTitle: "t".repeat(240),
        key: `connection:conn_${randomUUID()}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    });
    const request = (await store.requests.get(
      (proposed as { requestId: string }).requestId as never,
    ))!;
    const sentence = commandSentence(command, () => null);
    expect(request.presentation.title.startsWith(sentence)).toBe(true);
    expect(request.command!.summary.startsWith(sentence)).toBe(true);
    expect(request.presentation.title.length).toBeLessThanOrEqual(240);
    expect(request.presentation.title).toContain(
      "Asked by the connected agent “Opensteer: routine",
    );
  });

  it("rewrites the card to say what happened once the approval settles (X8)", async ({
    storeFixture,
  }) => {
    const { store, run, door, rename, approve, failWith } = await setup(storeFixture);
    const settle = async (name: string, id: string, fail?: Error) => {
      const proposed = (await dispatchCommand(run, rename(name, id), door(run))) as {
        requestId: string;
      };
      if (fail) failWith(fail);
      await approve(
        proposed.requestId,
        (await store.requests.get(proposed.requestId as never))!.command!.command,
      );
      return (await store.requests.get(proposed.requestId as never))!;
    };
    const done = await settle("Done one", "hin_00000000-0000-4000-8000-000000000801");
    expect(done.status).toBe("fulfilled");
    expect(done.presentation.title).toMatch(/^Done: /u);
    expect(done.presentation.detail).toContain("You approved this, and it was done.");
    const failed = await settle(
      "Failed one",
      "hin_00000000-0000-4000-8000-000000000802",
      new OpensteerError({ code: "conflict", message: "busy" }),
    );
    expect(failed.presentation.title).toMatch(/^Did not happen: /u);
    expect(failed.presentation.detail).toContain("nothing changed");
  });

  it("answers the same call again with what became of its Request (X7)", async ({
    storeFixture,
  }) => {
    const { f, service, store, approve } = await setup(storeFixture);
    const propose = (callKey: string, harnessInstanceId: string, name = "Same") =>
      service.propose({
        ownerUserId: f.userId,
        command: {
          type: "harness.rename",
          idempotencyKey: randomUUID(),
          environmentId: f.environmentId,
          harnessInstanceId,
          name,
        } as unknown as HostApiCommand,
        ask: { status: "ask", reason: "step" },
        face: 0,
        proposer: {
          kind: "run",
          name: "Claude Code",
          taskTitle: null,
          key: `task:${f.threadId}` as ProposerLineageKey,
        },
        origin: { runId: f.run.id },
        originatingThreadId: f.threadId,
        callKey,
      });
    const revision = async (id: string) => (await store.requests.revision(id as never))!;
    // Declined: the same call reads declined, not pending.
    const first = (await propose("call-a", "hin_00000000-0000-4000-8000-000000000901")) as {
      requestId: string;
    };
    await service.decline({
      requestId: first.requestId as never,
      expectedRevision: await revision(first.requestId),
      resolvedBy: f.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(await propose("call-a", "hin_00000000-0000-4000-8000-000000000901")).toEqual({
      status: "declined",
      requestId: first.requestId,
    });
    // Approved: the same call reads what it came to.
    const second = (await propose("call-b", "hin_00000000-0000-4000-8000-000000000902")) as {
      requestId: string;
    };
    await approve(
      second.requestId,
      (await store.requests.get(second.requestId as never))!.command!.command,
    );
    expect(await propose("call-b", "hin_00000000-0000-4000-8000-000000000902")).toMatchObject({
      status: "answered",
      outcome: { status: "done" },
    });
    // The same key with other arguments is another call.
    await expect(
      propose("call-b", "hin_00000000-0000-4000-8000-000000000902", "Other"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("answers the same approval again with its first outcome, running nothing twice (X10)", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve } = await setup(storeFixture);
    const proposed = (await dispatchCommand(
      run,
      rename("Once", "hin_00000000-0000-4000-8000-000000001001"),
      door(run),
    )) as { requestId: string };
    const command = (await store.requests.get(proposed.requestId as never))!.command!.command;
    const key = randomUUID();
    const first = await approve(proposed.requestId, command, key);
    expect(await approve(proposed.requestId, command, key)).toEqual(first);
    expect(ran).toHaveLength(1);
    await expect(approve(proposed.requestId, command, randomUUID())).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("counts a child task's ask as its tree's: the same ask is the tree's open one (X5)", async ({
    storeFixture,
  }) => {
    const { f, database, service, door, rename, run } = await setup(storeFixture);
    const child = await storeFixture.store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: randomUUID(),
      modelSelection: { modelId: "fixture", providerId: "openai", options: {} } as never,
      title: "Child",
      parentThreadId: f.threadId,
    } as never);
    const parentKey = await proposerLineageKey(database, {
      ...run,
      thread: { id: f.threadId },
    } as never);
    const childKey = await proposerLineageKey(database, {
      ...run,
      thread: { id: child.thread.id },
    } as never);
    expect(childKey).toBe(parentKey);
    const proposed = (await dispatchCommand(
      run,
      rename("Tree", "hin_00000000-0000-4000-8000-000000001101"),
      door(run),
    )) as { requestId: string };
    expect(
      await service.propose({
        ownerUserId: f.userId,
        command: rename("Tree", "hin_00000000-0000-4000-8000-000000001101"),
        ask: { status: "ask", reason: "step" },
        face: 0,
        proposer: { kind: "run", name: "Claude Code", taskTitle: "Child", key: childKey },
        origin: { runId: f.run.id },
        originatingThreadId: child.thread.id,
        callKey: randomUUID(),
      }),
    ).toMatchObject({ status: "pending", requestId: proposed.requestId, existing: true });
  });

  it("lets an agent withdraw its own ask, and points its answer to one at the person (withdraw)", async ({
    storeFixture,
  }) => {
    const { f, service, store, run, door, rename, ran } = await setup(storeFixture);
    const proposed = (await dispatchCommand(
      run,
      rename("Mine", "hin_00000000-0000-4000-8000-000000001301"),
      door(run),
    )) as { requestId: string };
    // An agent's answer to a command Request is never a new proposal: it is pointed at it.
    const answer = (decision: string) =>
      dispatchCommand(
        run,
        {
          type: "request.respond",
          idempotencyKey: randomUUID(),
          requestId: proposed.requestId,
          expectedRevision: "1",
          response: { kind: "external", value: { decision } },
        } as unknown as HostApiCommand,
        door(run),
      );
    for (const decision of ["declined", "fulfilled"])
      expect(await answer(decision)).toMatchObject({
        status: "pending",
        requestId: proposed.requestId,
        existing: true,
      });
    // Another lineage's withdrawal reads as nothing there.
    await expect(
      service.withdraw({
        ownerUserId: f.userId,
        requestId: proposed.requestId as never,
        proposerKey: "task:thr_other" as ProposerLineageKey,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await service.withdraw({
        ownerUserId: f.userId,
        requestId: proposed.requestId as never,
        proposerKey: `task:${f.threadId}` as ProposerLineageKey,
      }),
    ).toEqual({ status: "withdrawn", requestId: proposed.requestId });
    expect((await store.requests.get(proposed.requestId as never))!.status).toBe("withdrawn");
    expect(ran).toEqual([]);
  });

  it("re-admits the proposal as its connection inside the approval's own transaction (AD5)", async ({
    storeFixture,
  }) => {
    const { f, database, service, store, commandStore, ran, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "harness.rename",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000001501",
        name: "Raced",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "step" },
      face: 0,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    // The person narrows the grant just as the approval begins: after any check made before it.
    const begin = commandStore.beginApproval.bind(commandStore);
    commandStore.beginApproval = async (input) => {
      await connections.update(f.userId, {
        connectionId: connection.id,
        expectedRevision: 1,
        grant: { scope: "selected", tasks: true, resources: [] },
      });
      return begin(input);
    };
    // The narrowing closes the ask in its own transaction (D5), so the approval finds it ended:
    // refused, and nothing runs.
    await expect(
      approve(
        proposed.requestId,
        (await store.requests.get(proposed.requestId as never))!.command!.command,
      ),
    ).rejects.toMatchObject({ code: "conflict", message: "Request is no longer pending" });
    expect(ran).toEqual([]);
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  it("admits the proposing connection again where the change is written, after the approval began (K2)", async ({
    storeFixture,
  }) => {
    const { f, database, service, store, ran, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "harness.rename",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000001601",
        name: "Late",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "step" },
      face: 0,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    expect(
      await approve(
        proposed.requestId,
        (await store.requests.get(proposed.requestId as never))!.command!.command,
      ),
    ).toMatchObject({ status: "done" });
    // The person's handler is given the proposer's last admission, for the transaction that
    // writes its change: it admits while the connection may still ask for this.
    const readmit = ran[0]!.actor.proposal?.readmit;
    expect(typeof readmit).toBe("function");
    await database.transaction().execute((transaction) => readmit!(transaction));
    // Disconnected after the approval began: where the change would be written, it is refused,
    // as raised before anything happened.
    await connections.revoke(f.userId, connection.id);
    const refused = await database
      .transaction()
      .execute((transaction) => readmit!(transaction))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refused).toMatchObject({ code: "forbidden", reason: "proposer-gone" });
    expect(isRaisedBeforeEffect(refused)).toBe(true);
  });

  it("refuses an approval once the proposing connection is Disconnected, and closes it (X9)", async ({
    storeFixture,
  }) => {
    const { f, database, service, store, ran, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "harness.rename",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000001401",
        name: "From a connection",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "step" },
      face: 0,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const command = (await store.requests.get(proposed.requestId as never))!.command!.command;
    // Disconnected; the worker has not closed its asks yet.
    await database
      .updateTable("agentConnections")
      .set({ revokedAt: new Date() })
      .where("id", "=", connection.id)
      .execute();
    await expect(approve(proposed.requestId, command)).rejects.toMatchObject({
      code: "forbidden",
      reason: "proposer-gone",
    });
    expect(ran).toEqual([]);
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  it("shows the ask in Needs you, counted, and to no other connected agent", async ({
    storeFixture,
  }) => {
    const { f, database, run, door, rename } = await setup(storeFixture);
    const proposed = (await dispatchCommand(
      run,
      rename("Listed", "hin_00000000-0000-4000-8000-000000000301"),
      door(run),
    )) as { requestId: string };
    const page = await needsYouPage(database, { userId: f.userId });
    expect(page.count).toBe(page.entries.length);
    expect(page.entries.map((entry) => entry.request.id)).toContain(proposed.requestId);
    // Another connected agent cannot answer it, or learn of it.
    const connections = new AgentConnectionStore(database);
    const connect = async (grant: AgentGrant) => {
      const connection = await connections.create({
        userId: f.userId,
        label: "Other",
        clientName: "Other",
        accessMode: "full-access",
        resource: "http://localhost/mcp",
        expiresAt: new Date(Date.now() + 60_000),
        grant,
      });
      await connections.activate(connection.id, `hash-${randomUUID()}`);
      return connection;
    };
    const other = await connect({ scope: "selected", tasks: true, resources: [] });
    await beginAgentSession(database, { userId: f.userId, agentConnectionId: other.id });
    for (const type of ["request.respond", "request.command.approve"] as const)
      expect(
        (
          await admitCommand(database, {
            ownerUserId: f.userId,
            subject: commandSubject(`connection:${other.id}`),
            command: {
              type,
              idempotencyKey: randomUUID(),
              requestId: proposed.requestId,
              expectedRevision: "1",
              command: {},
              response: { kind: "external" },
            } as never,
          })
        ).answer,
      ).toBe("not_found");
  });

  it("puts every proposed argument on the card, names the ids it can, and says what a connected agent's settings are now", async ({
    storeFixture,
  }) => {
    const { f, store, service } = await setup(storeFixture);
    const connection = await new AgentConnectionStore(storeFixture.database).create({
      userId: f.userId,
      label: "Research",
      clientName: "Research client",
      accessMode: "auto",
      grant: { scope: "everything" },
      resource: "https://home.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const profile = { id: `bpr_${randomUUID()}` };
    await storeFixture.database
      .insertInto("browserProfiles")
      .values({
        id: profile.id as never,
        ownerId: f.userId,
        name: "Work",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const command = {
      type: "connection.update",
      idempotencyKey: randomUUID(),
      connectionId: connection.id,
      expectedRevision: 1,
      label: "Research",
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile.id, access: "use" }],
      },
    } as unknown as HostApiCommand;
    const proposed = await service.propose({
      ownerUserId: f.userId,
      command,
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "connection",
        name: "Research",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
      reason: "I need your work profile.",
    });
    const part = (await store.requests.get((proposed as { requestId: string }).requestId as never))!
      .command!;
    // Every value the person approves is on the card, from the command itself, whole.
    const fields = commandReviewFields(part.command);
    expect(
      fields
        .filter(({ value }) => value !== null)
        .map(({ path }) => path)
        .sort(),
    ).toEqual(
      [
        "/connectionId",
        "/expectedRevision",
        "/label",
        "/grant/scope",
        "/grant/tasks",
        "/grant/resources/0/kind",
        "/grant/resources/0/profileId",
        "/grant/resources/0/access",
      ].sort(),
    );
    // Beside them, only the Home's words: what an id names, what a changed setting is now. The
    // label it would keep has nothing beside it.
    expect(part.notes).toEqual([
      { path: "/connectionId", name: "“Research”" },
      { path: "/grant/resources/0/profileId", name: "“Work”" },
      { path: "/grant", current: commandReviewText({ scope: "everything" }) },
    ]);
    expect(part.agentReason).toBe("I need your work profile.");
    const request = (await store.requests.get(
      (proposed as { requestId: string }).requestId as never,
    ))!;
    expect(request.presentation.kind === "form" && request.presentation.fields[0]!.prompt).toBe(
      "Approve runs it as you, exactly as shown. Decline tells the agent no.",
    );
  });

  it("refuses an approval of anything but the Request as the person reviewed it, and runs nothing", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, service, context } = await setup(storeFixture);
    const proposed = await dispatchCommand(run, rename("Work"), door(run));
    const requestId = (proposed as { requestId: string }).requestId as never;
    const request = (await store.requests.get(requestId))!;
    const revision = (await store.requests.revision(requestId))!;
    const approveAt = (expectedRevision: string, id = requestId) =>
      service.approve(
        personActor(context),
        {
          requestId: id,
          expectedRevision,
          idempotencyKey: randomUUID(),
        },
        (person, approved) =>
          dispatchCommand(person, approved, { registry: door(run).registry }, context),
        (proposal) => personActor(context, proposal),
      );
    // A revision other than the one read: what the person was shown is not what is there now.
    await expect(approveAt(String(Number(revision) + 1))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(ran).toEqual([]);
    // Once the agent withdrew it, the card the person still holds approves nothing.
    await service.withdraw({
      ownerUserId: request.requestedBy,
      requestId,
      proposerKey: request.command!.proposer.key as ProposerLineageKey,
    });
    await expect(approveAt(revision)).rejects.toMatchObject({ code: "conflict" });
    expect(ran).toEqual([]);
  });

  it("is never an agent's to approve: to any agent the approval reads as a command that does not exist", async ({
    storeFixture,
  }) => {
    const { f, store, ran, run, door, rename } = await setup(storeFixture);
    const proposed = await dispatchCommand(run, rename("Work"), door(run));
    const requestId = (proposed as { requestId: string }).requestId;
    const request = (await store.requests.get(requestId as never))!;
    const said = (error: unknown) => {
      const { code, message, reason, next, details } = error as OpensteerError;
      return JSON.stringify({ code, message, reason, next, details });
    };
    const approving = await dispatchCommand(
      run,
      {
        type: "request.command.approve",
        idempotencyKey: randomUUID(),
        requestId,
        expectedRevision: (await store.requests.revision(requestId as never))!,
        command: request.command!.command,
      } as unknown as HostApiCommand,
      door(run),
    ).catch(said);
    const nothing = await dispatchCommand(
      run,
      { type: "no.such.command", idempotencyKey: randomUUID() } as unknown as HostApiCommand,
      door(run),
    ).catch(said);
    expect(approving).toBe(nothing);
    expect(JSON.parse(approving as string)).toMatchObject({ code: "not_found" });
    // The same for a connected agent with everything, one with a selected grant, and an
    // automation; each is live, as a command it does hold shows.
    const connections = new AgentConnectionStore(storeFixture.database);
    const connected = async (grant: AgentGrant) => {
      const record = await connections.create({
        userId: f.userId,
        label: `Agent ${grant.scope}`,
        clientName: "Client",
        accessMode: "full-access",
        resource: "https://home.test/mcp",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        grant,
      });
      await connections.activate(record.id, randomUUID());
      return {
        kind: "connection",
        key: `connection:${record.id}`,
        connectionId: record.id,
        userId: f.userId,
        accessMode: "full-access",
        grant,
        grantRevision: 1,
        agentConnection: {
          agentConnectionId: record.id,
          grant,
          grantRevision: 1,
          consentVersion: 2,
          accessMode: "full-access",
          bridgeSenders: null,
        },
      } as unknown as AgentCaller;
    };
    const triggers = new TriggerStore(storeFixture.database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Morning plan",
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
      },
      script: { interpreter: null, text: "console.log('ok');" },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
      idempotencyKey: randomUUID(),
    });
    const thread = await store.getThreadForOwner(f.threadId, f.userId);
    const program = {
      kind: "program",
      key: `trigger:${occurrence.id}`,
      userId: f.userId,
      accessMode: "full-access",
      anchor: thread,
      program: { kind: "trigger", occurrenceId: occurrence.id },
    } as unknown as AgentCaller;
    const callers: [string, AgentCaller, HostApiCommand][] = [];
    for (const grant of [
      { scope: "everything" },
      { scope: "selected", tasks: false, resources: [] },
    ] as AgentGrant[]) {
      const caller = await connected(grant);
      const own = (caller as unknown as { connectionId: string }).connectionId;
      callers.push([
        `connection ${grant.scope}`,
        caller,
        {
          type: "connection.update",
          idempotencyKey: randomUUID(),
          connectionId: own,
          expectedRevision: 1,
          label: "Renamed",
        } as unknown as HostApiCommand,
      ]);
    }
    callers.push(["automation", program, rename("By the automation")]);
    for (const [name, caller, held] of callers) {
      const sent = await dispatchCommand(
        caller,
        {
          type: "request.command.approve",
          idempotencyKey: randomUUID(),
          requestId,
          expectedRevision: (await store.requests.revision(requestId as never))!,
          command: request.command!.command,
        } as unknown as HostApiCommand,
        door(caller),
      ).catch(said);
      const unknown = await dispatchCommand(
        caller,
        { type: "no.such.command", idempotencyKey: randomUUID() } as unknown as HostApiCommand,
        door(caller),
      ).catch(said);
      expect(sent, name).toBe(unknown);
      expect(JSON.parse(sent as string), name).toMatchObject({ code: "not_found" });
      // It is live: a command it holds is not read as missing.
      const holds = await dispatchCommand(caller, held, door(caller)).catch(said);
      expect(typeof holds === "string" ? JSON.parse(holds) : holds, name).not.toMatchObject({
        code: "not_found",
      });
    }
    expect(ran).toEqual([]);
    expect((await store.requests.get(requestId as never))!.status).toBe("pending");
  });

  it("never approves a command that carries a secret on the card; the person says they did it themselves", async ({
    storeFixture,
  }) => {
    const { f, store, service, ran, context, door, run } = await setup(storeFixture);
    const proposed = await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "harness.authentication.submit",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000000009",
        value: "sk-typed-by-the-agent",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "secret" },
      face: 0,
      proposer: {
        kind: "run",
        name: "Claude Code",
        taskTitle: null,
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    });
    const requestId = (proposed as { requestId: string }).requestId as never;
    const request = (await store.requests.get(requestId))!;
    const field = request.presentation.kind === "form" ? request.presentation.fields[0]! : null;
    expect(field?.choices?.map(({ value }) => value)).toEqual(["done-myself", "decline"]);
    await expect(
      service.approve(
        personActor(context),
        {
          requestId,
          expectedRevision: (await store.requests.revision(requestId))!,
          idempotencyKey: randomUUID(),
        },
        (person, approved) =>
          dispatchCommand(person, approved, { registry: door(run).registry }, context),
        (proposal) => personActor(context, proposal),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "command-needs-person-screen" });
    expect(ran).toEqual([]);
    // The person did it on its own screen and says so: the proposal itself never runs.
    await service.decline({
      requestId,
      expectedRevision: (await store.requests.revision(requestId))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    });
    const settled = (await store.requests.get(requestId))!;
    expect(settled.status).toBe("declined");
    // The person's statement, never evidence that it happened.
    expect(commandContinuation(settled)).toMatch(/the person says they did/iu);
    expect(commandContinuation(settled)).not.toMatch(/did what you proposed/u);
    expect(ran).toEqual([]);
  });

  it("answers the same proposal the person declined within a day as declined, opening nothing", async ({
    storeFixture,
  }) => {
    const { database, store, service, run, door, rename, f } = await setup(storeFixture);
    const ask = (name: string) => dispatchCommand(run, rename(name), door(run));
    const first = (await ask("Work")) as { requestId: string };
    await service.decline({
      requestId: first.requestId as never,
      expectedRevision: (await store.requests.revision(first.requestId as never))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
    const count = async () =>
      (
        await database
          .selectFrom("requests")
          .select("id")
          .where("command", "is not", null)
          .execute()
      ).length;
    const before = await count();
    // The same proposal again, by another call: the person's no, and nothing new.
    expect(await ask("Work")).toEqual({ status: "declined", requestId: first.requestId });
    expect(await count()).toBe(before);
    // Other arguments are another proposal, put to the person.
    const other = (await ask("Work, smaller")) as { status: string; requestId: string };
    expect(other).toMatchObject({ status: "pending", existing: false });
    await service.decline({
      requestId: other.requestId as never,
      expectedRevision: (await store.requests.revision(other.requestId as never))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
    // After a day the same proposal may be asked again.
    await database
      .updateTable("requests")
      .set({ resolvedAt: new Date(Date.now() - 25 * 60 * 60_000) })
      .where("id", "=", first.requestId as never)
      .execute();
    expect(await ask("Work")).toMatchObject({ status: "pending", existing: false });
  });

  it("closes a Run's proposals when the person stops it, and an approval after runs nothing", async ({
    storeFixture,
  }) => {
    const { f, database, store, ran, run, door, rename, approve } = await setup(storeFixture);
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", f.run.id)
      .execute();
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    await store.enqueueRunnerControl({
      type: "run.interrupt",
      threadId: f.threadId,
      runId: f.run.id,
      requestedBy: f.userId,
      idempotencyKey: randomUUID(),
    });
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "run-ended",
    });
    await expect(approve(proposed.requestId, asked.command!.command)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(ran).toEqual([]);
  });

  it("refuses an automation's proposal once the automation is paused, and closes it", async ({
    storeFixture,
  }) => {
    const { f, database, store, service, ran, rename, approve } = await setup(storeFixture);
    const triggers = new TriggerStore(database);
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Morning plan",
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
      },
      script: { interpreter: null, text: "console.log('ok');" },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: created.trigger.id,
      idempotencyKey: randomUUID(),
    });
    // The occurrence's script is running: it is the one asking.
    await database
      .updateTable("triggerOccurrences")
      .set({ status: "running", startedAt: new Date() })
      .where("id", "=", occurrence.id)
      .execute();
    const command = rename("Work");
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command,
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "program",
        name: "Morning plan",
        taskTitle: null,
        key: `automation:${created.trigger.id}` as ProposerLineageKey,
      },
      origin: { occurrenceId: occurrence.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    await database
      .updateTable("triggers")
      .set({ status: "paused" })
      .where("id", "=", created.trigger.id)
      .execute();
    await expect(approve(proposed.requestId, asked.command!.command)).rejects.toMatchObject({
      code: "forbidden",
      reason: "proposer-gone",
    });
    expect(ran).toEqual([]);
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  it("re-admits your own agent's proposal as its task now: a lowered mode still asks, so it runs as the person", async ({
    storeFixture,
  }) => {
    const { f, database, store, ran, run, door, rename, approve } = await setup(storeFixture);
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    await database
      .updateTable("threads")
      .set({ accessMode: "approval-required" })
      .where("id", "=", f.threadId)
      .execute();
    expect(await approve(proposed.requestId, asked.command!.command)).toMatchObject({
      status: "done",
    });
    expect(ran).toHaveLength(1);
  });

  it("has fixed answers and keeps no words: any answer is the plain decline, and the agent reads nothing typed", async ({
    storeFixture,
  }) => {
    const { f, store, service, run, door, rename } = await setup(storeFixture);
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const request = (await store.requests.get(proposed.requestId as never))!;
    const field = request.presentation.kind === "form" ? request.presentation.fields[0]! : null;
    expect(field?.custom).toBe(false);
    await service.decline({
      requestId: proposed.requestId as never,
      expectedRevision: (await store.requests.revision(proposed.requestId as never))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["Here is the token: sk-123"] } },
    });
    const settled = (await store.requests.get(proposed.requestId as never))!;
    expect(settled.response).toEqual({ kind: "form", answers: { decision: ["decline"] } });
    expect(JSON.stringify(settled)).not.toContain("sk-123");
    expect(commandContinuation(settled)).not.toContain("sk-123");
    // I did it myself is an answer only where the card offers it.
    const other = (await dispatchCommand(run, rename("Other"), door(run))) as {
      requestId: string;
    };
    await service.decline({
      requestId: other.requestId as never,
      expectedRevision: (await store.requests.revision(other.requestId as never))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    });
    expect((await store.requests.get(other.requestId as never))!.response).toEqual({
      kind: "form",
      answers: { decision: ["decline"] },
    });
  });

  it("refuses an approval that adds anything to the proposal, before the Request changes", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve } = await setup(storeFixture);
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    const revision = await store.requests.revision(proposed.requestId as never);
    // An approval cannot add anything: it carries no command, and one that tries is refused by
    // the wire before the Request changes (D1).
    expect(
      hostApi["commands.dispatch"].payload.safeParse({
        type: "request.command.approve",
        idempotencyKey: randomUUID(),
        requestId: proposed.requestId,
        expectedRevision: revision,
        command: { ...asked.command!.command, set: { OTHER: "value" } },
      }).success,
    ).toBe(false);
    expect(ran).toEqual([]);
    expect((await store.requests.get(proposed.requestId as never))!.status).toBe("pending");
    expect(await store.requests.revision(proposed.requestId as never)).toBe(revision);
    // Approved, exactly the stored proposal runs.
    await approve(proposed.requestId, asked.command!.command);
    expect(ran).toHaveLength(1);
    const { idempotencyKey: _key, ...sent } = ran[0]!.command as unknown as Record<string, unknown>;
    expect(sent).toEqual({ ...asked.command!.command, type: "harness.rename" });
  });

  it("checks its own words again at approval: changed since the person read them, the card is written anew and nothing runs", async ({
    storeFixture,
  }) => {
    const { f, store, service, ran, approve, context } = await setup(storeFixture);
    const connection = await new AgentConnectionStore(storeFixture.database).create({
      userId: f.userId,
      label: "Research",
      clientName: "Research client",
      accessMode: "auto",
      grant: { scope: "everything" },
      resource: "https://home.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const command = {
      type: "connection.update",
      idempotencyKey: randomUUID(),
      connectionId: connection.id,
      expectedRevision: 1,
      accessMode: "full-access",
    } as unknown as HostApiCommand;
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command,
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "run",
        name: "Claude Code",
        taskTitle: null,
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const read = (await store.requests.get(proposed.requestId as never))!;
    expect(read.command!.notes).toEqual([
      { path: "/connectionId", name: "“Research”" },
      { path: "/accessMode", current: '"auto"' },
    ]);
    const shownRevision = (await store.requests.revision(proposed.requestId as never))!;
    // The connection's mode changes after the person read the card.
    await storeFixture.database
      .updateTable("agentConnections")
      .set({ accessMode: "approval-required" })
      .where("id", "=", connection.id)
      .execute();
    await expect(
      service.approve(
        personActor(context),
        {
          requestId: proposed.requestId as never,
          expectedRevision: shownRevision,
          idempotencyKey: randomUUID(),
        },
        async () => {
          throw new Error("Nothing may run");
        },
        (proposal) => personActor(context, proposal),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "request-changed" });
    expect(ran).toEqual([]);
    const refreshed = (await store.requests.get(proposed.requestId as never))!;
    expect(refreshed.status).toBe("pending");
    expect(refreshed.command!.notes).toEqual([
      { path: "/connectionId", name: "“Research”" },
      { path: "/accessMode", current: '"approval-required"' },
    ]);
    expect(await store.requests.revision(proposed.requestId as never)).not.toBe(shownRevision);
    // Read again, it can be approved.
    expect(await approve(proposed.requestId, refreshed.command!.command)).toMatchObject({
      status: "done",
    });
  });

  it("settles a pending proposal done by the person when the person's own command does it, at the door (C2)", async ({
    storeFixture,
  }) => {
    const { f, store, service, ran, context, registry } = await setup(storeFixture);
    const submit = (harnessInstanceId: string, value?: string) =>
      ({
        type: "harness.authentication.submit",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId,
        ...(value ? { value } : {}),
      }) as unknown as HostApiCommand;
    const ask = (harnessInstanceId: string, callKey: string) =>
      service.propose({
        ownerUserId: f.userId,
        command: submit(harnessInstanceId, "typed-by-the-agent"),
        ask: { status: "ask", reason: "secret" },
        face: 0,
        proposer: {
          kind: "run",
          name: "Claude Code",
          taskTitle: null,
          key: `task:${f.threadId}` as ProposerLineageKey,
        },
        origin: { runId: f.run.id },
        originatingThreadId: f.threadId,
        callKey,
      }) as Promise<{ status: string; requestId: string }>;
    const mineKey = randomUUID();
    const mine = (await ask("hin_00000000-0000-4000-8000-000000000071", mineKey)).requestId;
    const another = (await ask("hin_00000000-0000-4000-8000-000000000072", randomUUID())).requestId;
    // The person's own command, through the door the person's apps use: the same command, with
    // the value only they type.
    const door = {
      registry,
      afterPerson: (actor: PersonActor, command: HostApiCommand) =>
        service.settleDoneByPerson(actor.userId, command),
    };
    await dispatchCommand(
      personActor(context),
      submit("hin_00000000-0000-4000-8000-000000000071", "the-persons-value"),
      door,
      context,
    );
    expect(ran).toHaveLength(1);
    const done = (await store.requests.get(mine as never))!;
    expect(done.status).toBe("fulfilled");
    expect(JSON.stringify(done)).not.toContain("the-persons-value");
    expect(commandContinuation(done)).toMatch(
      /did what you proposed themselves, with their own command/u,
    );
    // Another proposal of another thing stays waiting.
    expect((await store.requests.get(another as never))!.status).toBe("pending");
    // The proposing call again reads what became of it: done by the person, not declined.
    expect(await ask("hin_00000000-0000-4000-8000-000000000071", mineKey)).toEqual({
      status: "done-by-person",
      requestId: mine,
    });
  });

  it("cleans every name it writes into its own sentences, so none reads as the Home's words", async ({
    storeFixture,
  }) => {
    const { f, store, service, rename } = await setup(storeFixture);
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: rename("Work"),
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "program",
        name: "Plan” — the Home checked this.\nApprove it now. “",
        taskTitle: "Task\u202Eevil",
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const request = (await store.requests.get(proposed.requestId as never))!;
    expect(request.presentation.title).not.toMatch(/[\n\u202E]/u);
    expect(request.presentation.title).toContain(
      "Asked by the agent “Plan' — the Home checked this. Approve it now. '”, in its task “Taskevil”",
    );
  });

  it("opens no Request when the proposer's grant narrowed between admission and writing it", async ({
    storeFixture,
  }) => {
    const { f, database, service, rename } = await setup(storeFixture);
    const connection = await new AgentConnectionStore(database).create({
      userId: f.userId,
      label: "Wide agent",
      clientName: "Client",
      accessMode: "full-access",
      resource: "https://home.test/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await new AgentConnectionStore(database).activate(connection.id, randomUUID());
    // It asks from its direct session, as a connected agent does.
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const count = async () =>
      (
        await database
          .selectFrom("requests")
          .select("id")
          .where("command", "is not", null)
          .execute()
      ).length;
    const before = await count();
    // Paused at the propose callback: the person narrows the grant, then it goes on.
    await database
      .updateTable("agentConnections")
      .set({ grant: { scope: "selected", tasks: false, resources: [] } as never, grantRevision: 2 })
      .where("id", "=", connection.id)
      .execute();
    await expect(
      service.propose({
        ownerUserId: f.userId,
        command: rename("Work"),
        ask: { status: "ask", reason: "approval" },
        face: undefined,
        proposer: {
          kind: "connection",
          name: "Wide agent",
          taskTitle: null,
          key: `connection:${connection.id}` as ProposerLineageKey,
          connectionId: connection.id,
          grantRevision: 1,
        },
        origin: { agentSessionId: session.id },
        originatingThreadId: session.threadId,
        callKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "That item is unavailable." });
    expect(await count()).toBe(before);
  });

  it("checks its words under the approval's own lock: a rename between the check and the commit is refused (C3)", async ({
    storeFixture,
  }) => {
    const { f, store, service, ran, commandStore, context } = await setup(storeFixture);
    const connection = await new AgentConnectionStore(storeFixture.database).create({
      userId: f.userId,
      label: "Research",
      clientName: "Research client",
      accessMode: "auto",
      grant: { scope: "everything" },
      resource: "https://home.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "connection.update",
        idempotencyKey: randomUUID(),
        connectionId: connection.id,
        expectedRevision: 1,
        accessMode: "full-access",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "run",
        name: "Claude Code",
        taskTitle: null,
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    // A label edit (no grant revision moves) lands as the approval begins, after any check
    // made before it, with the revision the person read still current.
    const begin = commandStore.beginApproval.bind(commandStore);
    commandStore.beginApproval = async (input) => {
      await storeFixture.database
        .updateTable("agentConnections")
        .set({ label: "Different label at commit" })
        .where("id", "=", connection.id)
        .execute();
      return begin(input);
    };
    await expect(
      service.approve(
        personActor(context),
        {
          requestId: proposed.requestId as never,
          expectedRevision: (await store.requests.revision(proposed.requestId as never))!,
          idempotencyKey: randomUUID(),
        },
        async () => ({ type: "connection.update" }) as never,
        (proposal) => personActor(context, proposal),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "request-changed" });
    expect(ran).toEqual([]);
    expect((await store.requests.get(proposed.requestId as never))!.command!.sentence).toContain(
      "Different label at commit",
    );
  });

  it("stores the members a group close will close, and the approved close acts on those alone (D4)", async ({
    storeFixture,
  }) => {
    const { f, store, ran, run, door, approve } = await setup(storeFixture);
    const groupId = `tgp_${randomUUID()}`;
    const members = [`tab-${randomUUID()}`, `tab-${randomUUID()}`];
    await storeFixture.database
      .insertInto("tabLayouts")
      .values({
        ownerId: f.userId,
        items: JSON.stringify([
          {
            kind: "group",
            group: { groupId, name: "Research", color: "blue", collapsed: false, tabIds: members },
          },
        ]) as never,
      })
      .onConflict((conflict) =>
        conflict.column("ownerId").doUpdateSet({
          items: JSON.stringify([
            {
              kind: "group",
              group: {
                groupId,
                name: "Research",
                color: "blue",
                collapsed: false,
                tabIds: members,
              },
            },
          ]) as never,
        }),
      )
      .execute();
    const proposed = (await dispatchCommand(
      run,
      {
        type: "tab.group.close",
        idempotencyKey: randomUUID(),
        groupId,
      } as unknown as HostApiCommand,
      door(run),
    )) as { requestId: string };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    // The card lists the members, from the command that will run.
    expect(asked.command!.command).toMatchObject({ groupId, tabIds: members });
    await approve(proposed.requestId, asked.command!.command);
    expect(ran[0]!.command).toMatchObject({ type: "tab.group.close", tabIds: members });
  });

  it("admits the proposer once more where the effect's attempt is recorded: a Disconnect after the approval began runs nothing (C4)", async ({
    storeFixture,
  }) => {
    const { f, database, service, store, commandStore, ran, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "tab.open",
        idempotencyKey: randomUUID(),
        target: { kind: "page", url: "about:blank", guest: true },
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "step" },
      face: 0,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const begin = commandStore.beginApproval.bind(commandStore);
    commandStore.beginApproval = async (input) => {
      const committed = await begin(input);
      await connections.revoke(f.userId, connection.id);
      return committed;
    };
    await expect(
      approve(
        proposed.requestId,
        (await store.requests.get(proposed.requestId as never))!.command!.command,
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "proposer-gone" });
    expect(ran).toEqual([]);
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  it("reads a lost receipt back from the attempt, never leaving an approval running, and never runs it twice (C5)", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve, commandStore } = await setup(storeFixture);
    const sent = rename("Work");
    const proposed = (await dispatchCommand(run, sent, door(run))) as {
      requestId: string;
    };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    const settle = commandStore.settle.bind(commandStore);
    let lose = 2;
    commandStore.settle = async (...args) => {
      if (lose > 0) {
        lose -= 1;
        throw new Error("fixture: lost receipt");
      }
      return settle(...args);
    };
    const key = randomUUID();
    await approve(proposed.requestId, asked.command!.command, key).catch(() => undefined);
    // The proposer's same call again reads what the attempt says, never a running that stays.
    // A database command records no attempt (only an outside effect does), so what may have
    // happened reads as unknown (rule 4), never done by a guess, and the approval again agrees.
    expect(await dispatchCommand(run, sent, door(run))).toMatchObject({
      status: "answered",
      outcome: { status: "unknown" },
    });
    expect(await approve(proposed.requestId, asked.command!.command, key)).toEqual({
      status: "unknown",
    });
    expect(ran).toHaveLength(1);
    expect((await store.requests.get(proposed.requestId as never))!.command!.outcome).not.toEqual({
      status: "running",
    });
  });

  it("bounds the person's attention: five asks of one proposer wait at once, and three noes about a thing quiet it (C9)", async ({
    storeFixture,
  }) => {
    const { f, store, service, run, door, rename } = await setup(storeFixture);
    const ids = Array.from(
      { length: 6 },
      (_, index) => `hin_00000000-0000-4000-8000-0000000019${String(index).padStart(2, "0")}`,
    );
    const asks = [];
    for (const id of ids.slice(0, 5))
      asks.push(await dispatchCommand(run, rename("Work", id), door(run)));
    for (const ask of asks) expect(ask).toMatchObject({ status: "pending" });
    await expect(dispatchCommand(run, rename("Work", ids[5]), door(run))).rejects.toMatchObject({
      code: "conflict",
      reason: "too-many-asks",
      message:
        "You already have 5 asks waiting for the person, earlier ones included. See them with opensteer_state, area requests, and withdraw one before asking again.",
    });
    // Three noes about one thing: after them, further asks about it are answered no for a day,
    // whatever their arguments.
    const thing = ids[0]!;
    let current = asks[0] as { requestId: string };
    for (const name of ["Work, one", "Work, two"]) {
      await service.decline({
        requestId: current.requestId as never,
        expectedRevision: (await store.requests.revision(current.requestId as never))!,
        resolvedBy: f.userId,
        response: { kind: "form", answers: { decision: ["decline"] } },
      });
      // A changed argument after a no still reaches the person.
      current = (await dispatchCommand(run, rename(name, thing), door(run))) as {
        requestId: string;
      };
      expect(current).toMatchObject({ status: "pending", existing: false });
    }
    await service.decline({
      requestId: current.requestId as never,
      expectedRevision: (await store.requests.revision(current.requestId as never))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
    expect(await dispatchCommand(run, rename("Work, three", thing), door(run))).toMatchObject({
      status: "declined",
    });
  });

  it("re-admits an ask from a Run under a connection as that connection now: after the Run ends, a narrowed grant closes it, and an approval runs nothing (M1)", async ({
    storeFixture,
  }) => {
    const { f, database, store, service, ran, rename, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const everything = async (label: string) => {
      const connection = await connections.create({
        userId: f.userId,
        label,
        clientName: label,
        accessMode: "full-access",
        resource: "http://localhost/mcp",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        grant: { scope: "everything" },
      });
      await connections.activate(connection.id, `hash-${randomUUID()}`);
      return connection;
    };
    const narrow = (connectionId: string) =>
      connections.update(f.userId, {
        connectionId,
        expectedRevision: 1,
        grant: { scope: "selected", tasks: true, resources: [] },
      });
    const proposer = (kind: "run" | "program", connectionId: string) => ({
      kind,
      name: "Claude Code",
      taskTitle: null,
      key: `connection:${connectionId}` as ProposerLineageKey,
      connectionId,
      grantRevision: 1,
      connectionName: "Agent",
    });
    // A connection with `everything` works in the person's own task: the task's origin stays the
    // person's, the Run is the connection's.
    const agent = await everything("Agent");
    await database
      .updateTable("runs")
      .set({ connectionId: agent.id })
      .where("id", "=", f.run.id)
      .execute();
    expect(
      (
        await database
          .selectFrom("threads")
          .select("originConnectionId")
          .where("id", "=", f.threadId)
          .executeTakeFirstOrThrow()
      ).originConnectionId,
    ).toBeNull();
    const fromRun = (await service.propose({
      ownerUserId: f.userId,
      command: rename("Work", "hin_00000000-0000-4000-8000-000000003001"),
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: proposer("run", agent.id),
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { status: string; requestId: string };
    expect(fromRun.status).toBe("pending");
    await database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", f.run.id)
      .execute();
    await narrow(agent.id);
    expect(await store.requests.get(fromRun.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
    // Nothing is said to the connection's Run about it.
    expect(
      await database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "=", fromRun.requestId as never)
        .execute(),
    ).toEqual([]);
    const asked = (await store.requests.get(fromRun.requestId as never))!;
    await expect(approve(fromRun.requestId, asked.command!.command)).rejects.toBeInstanceOf(
      OpensteerError,
    );
    expect(ran).toEqual([]);
    // The same for the connection's automation anchored on a person-origin task.
    const other = await everything("Automation agent");
    const triggers = new TriggerStore(database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Morning plan",
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
      },
      script: { interpreter: null, text: "console.log('ok');" },
    });
    await database
      .updateTable("triggers")
      .set({ originConnectionId: other.id })
      .where("id", "=", automation.trigger.id)
      .execute();
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
      idempotencyKey: randomUUID(),
    });
    await database
      .updateTable("triggerOccurrences")
      .set({ status: "running", startedAt: new Date() })
      .where("id", "=", occurrence.id)
      .execute();
    const fromAutomation = (await service.propose({
      ownerUserId: f.userId,
      command: rename("Work", "hin_00000000-0000-4000-8000-000000003002"),
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: proposer("program", other.id),
      origin: { occurrenceId: occurrence.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { status: string; requestId: string };
    expect(fromAutomation.status).toBe("pending");
    await database
      .updateTable("triggerOccurrences")
      .set({ status: "succeeded", completedAt: new Date() })
      .where("id", "=", occurrence.id)
      .execute();
    await narrow(other.id);
    expect(await store.requests.get(fromAutomation.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  it("keeps a connected agent's ask after its direct session ends on its own, and ends it on the person's Stop of the session", async ({
    storeFixture,
  }) => {
    const { f, database, store, service, ran, rename, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const askIn = async (id: string) => {
      const { session } = await beginAgentSession(database, {
        userId: f.userId,
        agentConnectionId: connection.id,
      });
      const asked = (await service.propose({
        ownerUserId: f.userId,
        command: rename("Work", id),
        ask: { status: "ask", reason: "approval" },
        face: undefined,
        proposer: {
          kind: "connection",
          name: "Agent",
          taskTitle: null,
          key: `connection:${connection.id}` as ProposerLineageKey,
          connectionId: connection.id,
          grantRevision: 1,
        },
        origin: { agentSessionId: session.id },
        originatingThreadId: session.threadId,
        callKey: randomUUID(),
      })) as { status: string; requestId: string };
      expect(asked.status).toBe("pending");
      return { session, requestId: asked.requestId };
    };
    // Its session ends on its own: the connection still stands, and the ask waits.
    const quiet = await askIn("hin_00000000-0000-4000-8000-000000003101");
    await endAgentSessions(database, {
      userId: f.userId,
      sessionIds: [quiet.session.id],
      reason: "expired",
    });
    expect((await store.requests.get(quiet.requestId as never))!.status).toBe("pending");
    const asked = (await store.requests.get(quiet.requestId as never))!;
    expect(await approve(quiet.requestId, asked.command!.command)).toMatchObject({
      status: "done",
    });
    expect(ran).toHaveLength(1);
    // The person's Stop of the session ends it.
    const stopped = await askIn("hin_00000000-0000-4000-8000-000000003102");
    await endAgentSessions(database, {
      userId: f.userId,
      sessionIds: [stopped.session.id],
      reason: "stopped",
    });
    expect((await store.requests.get(stopped.requestId as never))!.status).toBe("cancelled");
  });

  it("closes the asks of the Runs an automation's firings started when the automation is paused", async ({
    storeFixture,
  }) => {
    const { f, database, store, run, door, rename } = await setup(storeFixture);
    const triggers = new TriggerStore(database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Morning plan",
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
      },
      script: { interpreter: null, text: "console.log('ok');" },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
      idempotencyKey: randomUUID(),
    });
    // The firing started this Run: they share its causal chain.
    const { causalChainId } = await database
      .selectFrom("runs")
      .select("causalChainId")
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("triggerOccurrences")
      .set({ causalChainId })
      .where("id", "=", occurrence.id)
      .execute();
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    expect((await store.requests.get(proposed.requestId as never))!.status).toBe("pending");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: f.userId,
      status: "paused",
      triggerId: automation.trigger.id,
    });
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  /** A one-shot automation on the task, with a running firing whose causal chain its Run shares. */
  const oneShot = async (
    f: Awaited<ReturnType<typeof setup>>["f"],
    database: Kysely<DatabaseSchema>,
  ) => {
    const triggers = new TriggerStore(database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Tomorrow's reminder",
      source: {
        kind: "schedule",
        schedule: { kind: "at", at: new Date(Date.now() + 60 * 60_000).toISOString() },
      },
      script: { interpreter: null, text: "console.log('ok');" },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
      idempotencyKey: randomUUID(),
    });
    const { causalChainId } = await database
      .selectFrom("runs")
      .select("causalChainId")
      .where("id", "=", f.run.id)
      .executeTakeFirstOrThrow();
    // Its one firing is the one claimed: running on the fixture's Runner, nothing more to fire.
    await database
      .updateTable("triggerOccurrences")
      .set({
        causalChainId,
        status: "running",
        startedAt: new Date(),
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
      })
      .where("id", "=", occurrence.id)
      .execute();
    await database
      .updateTable("triggers")
      .set({ nextFireAt: null })
      .where("id", "=", automation.trigger.id)
      .execute();
    const complete = async () => {
      const row = await database
        .selectFrom("triggerOccurrences")
        .select("executionGeneration")
        .where("id", "=", occurrence.id)
        .executeTakeFirstOrThrow();
      await triggers.completeExecution({
        executionGeneration: row.executionGeneration,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        output: {
          occurrenceId: occurrence.id,
          completedAt: new Date().toISOString(),
          error: null,
          exitCode: 0,
          result: null,
          status: "succeeded",
          stderr: "",
          stdout: "",
        },
      });
      return database
        .selectFrom("triggers")
        .select(["status", "pausedBy"])
        .where("id", "=", automation.trigger.id)
        .executeTakeFirstOrThrow();
    };
    return { triggers, trigger: automation.trigger, occurrence, complete };
  };

  it("keeps a one-shot's asks when it archives itself on completing, and approving runs them (Q7 a)", async ({
    storeFixture,
  }) => {
    const { f, database, store, service, ran, run, door, rename, approve } =
      await setup(storeFixture);
    const shot = await oneShot(f, database);
    // A Run its firing started asks, and so does the firing itself.
    const fromRun = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const fromFiring = (await service.propose({
      ownerUserId: f.userId,
      command: rename("Work", "hin_00000000-0000-4000-8000-000000003401"),
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "program",
        name: "Tomorrow's reminder",
        taskTitle: null,
        key: `automation:${shot.trigger.id}` as ProposerLineageKey,
      },
      origin: { occurrenceId: shot.occurrence.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { status: string; requestId: string };
    expect(fromFiring.status).toBe("pending");
    // Its one firing completes: it archives itself, which is bookkeeping, not a decision.
    expect(await shot.complete()).toEqual({ status: "archived", pausedBy: "system" });
    for (const { requestId } of [fromRun, fromFiring]) {
      expect((await store.requests.get(requestId as never))!.status).toBe("pending");
      const asked = (await store.requests.get(requestId as never))!;
      expect(await approve(requestId, asked.command!.command)).toMatchObject({ status: "done" });
    }
    expect(ran).toHaveLength(2);
  });

  it("closes a one-shot's Run's ask when the person archives it (Q7 b)", async ({
    storeFixture,
  }) => {
    const { f, database, store, run, door, rename } = await setup(storeFixture);
    const shot = await oneShot(f, database);
    const fromRun = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    await shot.triggers.setStatus({
      actorThreadId: null,
      ownerId: f.userId,
      status: "archived",
      triggerId: shot.trigger.id,
    });
    expect(await store.requests.get(fromRun.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
  });

  it("refuses at the click an ask of a Run an automation started once it was paused for lost standing, before any sweep (Q7 c)", async ({
    storeFixture,
  }) => {
    const { f, database, store, ran, run, door, rename, approve } = await setup(storeFixture);
    const shot = await oneShot(f, database);
    const fromRun = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const asked = (await store.requests.get(fromRun.requestId as never))!;
    // Paused as the scheduler pauses one whose standing was lost, with the follow-up sweep held
    // (it runs only after the scheduler's own pass).
    await commitPersonalMutation(database, async (transaction) => {
      const row = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("id", "=", shot.trigger.id)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      await pauseTriggerInTransaction(transaction, row, {
        pauseReason: "Paused because its conversation could not run when it was due.",
        pausedBy: "system",
      });
    });
    expect((await store.requests.get(fromRun.requestId as never))!.status).toBe("pending");
    await expect(approve(fromRun.requestId, asked.command!.command)).rejects.toBeInstanceOf(
      OpensteerError,
    );
    expect(ran).toEqual([]);
  });

  it("ends an ask when the person marks its task Done", async ({ storeFixture }) => {
    const { f, store, run, door, rename } = await setup(storeFixture);
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    await store.setThreadDone({
      done: true,
      threadId: f.threadId,
      requestedBy: f.userId,
      idempotencyKey: randomUUID(),
    });
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
    });
  });

  it("answers the person's own command with what it did when settling the asks it answers fails, leaving them pending (M4)", async ({
    storeFixture,
  }) => {
    const { f, store, service, ran, context, registry } = await setup(storeFixture);
    const submit = (value?: string) =>
      ({
        type: "harness.authentication.submit",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000003201",
        ...(value ? { value } : {}),
      }) as unknown as HostApiCommand;
    const asked = (await service.propose({
      ownerUserId: f.userId,
      command: submit("typed-by-the-agent"),
      ask: { status: "ask", reason: "secret" },
      face: 0,
      proposer: {
        kind: "run",
        name: "Claude Code",
        taskTitle: null,
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const output = await dispatchCommand(
      personActor(context),
      submit("the-persons-value"),
      {
        registry,
        afterPerson: async () => {
          throw new Error("fixture: the receipt could not be written");
        },
      },
      context,
    );
    expect(output).toMatchObject({ type: "harness.authentication.submit" });
    expect(ran).toHaveLength(1);
    expect((await store.requests.get(asked.requestId as never))!.status).toBe("pending");
  });

  it("answers an approval whose receipt cannot be written with what is known, runs nothing twice, and settles the record later with no read (M4)", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve, commandStore } = await setup(storeFixture);
    const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
      requestId: string;
    };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    const settle = commandStore.settle.bind(commandStore);
    let lose = 2;
    commandStore.settle = async (...args) => {
      if (lose > 0) {
        lose -= 1;
        throw new Error("fixture: lost receipt");
      }
      return settle(...args);
    };
    const key = randomUUID();
    expect(await approve(proposed.requestId, asked.command!.command, key)).toEqual({
      status: "done",
      result: expect.anything(),
    });
    expect(ran).toHaveLength(1);
    // With no read asking, the record is read again from its attempt.
    await vi.waitFor(
      async () =>
        expect(
          (await store.requests.get(proposed.requestId as never))!.command!.outcome,
        ).not.toEqual({ status: "running" }),
      { timeout: 5_000 },
    );
    // A second press runs nothing again.
    await approve(proposed.requestId, asked.command!.command, key);
    expect(ran).toHaveLength(1);
  });

  it("closes a connection's ask in its cleanup only where its standing no longer reaches it, and an expired connection's with nothing said (Q1)", async ({
    storeFixture,
  }) => {
    const { f, database, store, service } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const profile = `bpr_${randomUUID()}` as never;
    await database
      .insertInto("browserProfiles")
      .values({
        id: profile as never,
        ownerId: f.userId,
        name: "Work",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: {
        scope: "selected",
        tasks: true,
        resources: [{ kind: "browser-profile", profileId: profile }],
      },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const asked = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "browser.profile.rename",
        idempotencyKey: randomUUID(),
        profileId: profile,
        name: "Renamed",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { status: string; requestId: string };
    expect(asked.status).toBe("pending");
    // Tasks off, the profile kept: the direct ask still reaches what it is about.
    await connections.update(f.userId, {
      connectionId: connection.id,
      expectedRevision: 1,
      grant: {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "browser-profile", profileId: profile }],
      },
    });
    expect((await store.requests.get(asked.requestId as never))!.status).toBe("pending");
    await store.driveConnectionCleanups();
    expect((await store.requests.get(asked.requestId as never))!.status).toBe("pending");
    // The connection expires: it stands for nothing, so its cleanup closes the ask, and says
    // nothing to its lineage.
    await database
      .updateTable("agentConnections")
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where("id", "=", connection.id)
      .execute();
    await store.driveConnectionCleanups();
    expect(await store.requests.get(asked.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
    expect(
      await database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "=", asked.requestId as never)
        .execute(),
    ).toEqual([]);
  });

  it("reads, re-admits and withdraws a connection's ask whose value only the person types, for every such command (Q2)", async ({
    storeFixture,
  }) => {
    const { f, database, store, service } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const secretTypes = types.filter((type) => commandTable[type].secretFields?.length);
    expect(secretTypes.length).toBeGreaterThanOrEqual(10);
    const subject = { kind: "connection", agentConnectionId: connection.id } as const;
    const failures: string[] = [];
    for (const type of secretTypes) {
      // As the tool tells the agent: every value only the person types left out.
      const command = everyFieldCommand(type);
      for (const path of commandTable[type].secretFields ?? []) {
        const keys = path.split(".");
        let at = command as Record<string, unknown>;
        for (const key of keys.slice(0, -1)) {
          const next = at[key];
          if (!next || typeof next !== "object") break;
          at = next as Record<string, unknown>;
        }
        delete at[keys.at(-1)!];
      }
      // The generated sample's return path does not meet that schema's own rule.
      if (type === "plugin.authorization.begin")
        (command.input as Record<string, unknown>).returnPath = "/settings/plugins";
      // `trigger.secrets.set` accepts `names` (to ask) or `clearAll`/`remove`, never both at once.
      if (type === "trigger.secrets.set") {
        delete command.clearAll;
        delete command.remove;
        command.names = ["API_KEY"];
      }
      const ask = (asConnection: boolean) =>
        service.propose({
          ownerUserId: f.userId,
          command: { ...command, idempotencyKey: randomUUID() } as unknown as HostApiCommand,
          ask: { status: "ask", reason: "secret" },
          face: undefined,
          proposer: asConnection
            ? {
                kind: "connection",
                name: "Agent",
                taskTitle: null,
                key: `connection:${connection.id}` as ProposerLineageKey,
                connectionId: connection.id,
                grantRevision: 1,
              }
            : {
                kind: "run",
                name: "Claude Code",
                taskTitle: null,
                key: `task:${f.threadId}` as ProposerLineageKey,
              },
          origin: asConnection ? { agentSessionId: session.id } : { runId: f.run.id },
          originatingThreadId: asConnection ? session.threadId : f.threadId,
          callKey: randomUUID(),
        }) as Promise<{ status: string; requestId: string }>;
      // A type no connection holds is asked by your own agent instead.
      let asConnection = true;
      let asked = await ask(true).catch(() => null);
      if (!asked) {
        asConnection = false;
        asked = await ask(false).catch((error: unknown) => ({
          status: `refused: ${String(error)}`,
          requestId: "",
        }));
      }
      if (asked.status !== "pending") {
        failures.push(`${type}: ${asked.status}`);
        continue;
      }
      const part = (await store.requests.get(asked.requestId as never))!.command!;
      // Nothing only the person types was kept.
      for (const path of part.secretPaths)
        expect(JSON.stringify(part.command), `${type} ${path}`).not.toContain(
          `"${path.split(".").at(-1)}"`,
        );
      // It reads back as the command it was asked as, and its proposer still reaches it.
      const proposal = storedProposal(part);
      if (!proposal) failures.push(`${type}: no stored proposal`);
      else {
        const standing = standingSubject(
          asConnection
            ? {
                originatingAgentSessionId: session.id,
                originatingThreadId: session.threadId,
                connectionId: connection.id,
              }
            : { originatingThreadId: f.threadId },
        )!;
        // Re-admitted as it was asked: a connection's ask passed that check as it was written (an
        // own agent's ask of a sample thing that does not exist is not checked at write here).
        if (asConnection && !(await stillReaches(database, f.userId, standing, proposal)))
          failures.push(`${type}: not reached`);
      }
      const withdrawn = await service
        .withdraw({
          ownerUserId: f.userId,
          requestId: asked.requestId as never,
          proposerKey: (asConnection
            ? `connection:${connection.id}`
            : `task:${f.threadId}`) as ProposerLineageKey,
          ...(asConnection ? { caller: subject } : {}),
        })
        .catch((error: unknown) => ({ status: `refused: ${String(error)}` }));
      if (withdrawn.status !== "withdrawn") failures.push(`${type}: withdraw ${withdrawn.status}`);
    }
    expect(failures).toEqual([]);
  });

  it("answers an approval whose outside attempt's receipt cannot be written with what it did, settles it, and runs nothing twice (Q3)", async ({
    storeFixture,
  }) => {
    const { f, database, service, store, ran, approve } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const proposed = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "tab.open",
        idempotencyKey: randomUUID(),
        target: { kind: "page", url: "about:blank", guest: true },
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "step" },
      face: 0,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    const asked = (await store.requests.get(proposed.requestId as never))!;
    // The database refuses the attempt's receipt of "done", after the effect ran.
    const fn = `refuse_attempt_done_${randomUUID().replaceAll("-", "")}`;
    await sql`create function ${sql.raw(fn)}() returns trigger language plpgsql as $$
      begin if new.state = 'done' then raise exception 'fixture: attempt receipt refused'; end if;
      return new; end $$`.execute(database);
    await sql`create trigger ${sql.raw(fn)} before update on command_attempts
      for each row execute function ${sql.raw(fn)}()`.execute(database);
    try {
      const key = randomUUID();
      expect(await approve(proposed.requestId, asked.command!.command, key)).toMatchObject({
        status: "done",
      });
      expect(ran).toHaveLength(1);
      expect(
        (await store.requests.get(proposed.requestId as never))!.command!.outcome,
      ).toMatchObject({ status: "done" });
      expect(await approve(proposed.requestId, asked.command!.command, key)).toMatchObject({
        status: "done",
      });
      expect(ran).toHaveLength(1);
      // Once the database takes it again, the attempt's own row reaches what is known, with no
      // restart: its receipt is written once more a little later.
      await sql`drop trigger ${sql.raw(fn)} on command_attempts`.execute(database);
      await vi.waitFor(
        async () =>
          expect(
            await database
              .selectFrom("commandAttempts")
              .select("state")
              .where("callerKey", "=", `request:${proposed.requestId}`)
              .execute(),
          ).toEqual([{ state: "done" }]),
        { timeout: 5_000 },
      );
    } finally {
      await sql`drop trigger if exists ${sql.raw(fn)} on command_attempts`.execute(database);
      await sql`drop function ${sql.raw(fn)}()`.execute(database);
    }
  });

  it("keeps the person's own answer distinct on the agent's activity, as on every agent surface (Q4)", async ({
    storeFixture,
  }) => {
    const { f, database, store, service } = await setup(storeFixture);
    const asked = (await service.propose({
      ownerUserId: f.userId,
      command: {
        type: "harness.authentication.submit",
        idempotencyKey: randomUUID(),
        environmentId: f.environmentId,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000003301",
      } as unknown as HostApiCommand,
      ask: { status: "ask", reason: "secret" },
      face: 0,
      proposer: {
        kind: "run",
        name: "Claude Code",
        taskTitle: null,
        key: `task:${f.threadId}` as ProposerLineageKey,
      },
      origin: { runId: f.run.id },
      originatingThreadId: f.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    await service.decline({
      requestId: asked.requestId as never,
      expectedRevision: (await store.requests.revision(asked.requestId as never))!,
      resolvedBy: f.userId,
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    });
    const rows = await commandActivity(
      database,
      { name: async () => null },
      { userId: f.userId, threadId: f.threadId } as never,
      { reaches: async () => true },
    );
    expect(rows.find(({ requestId }) => requestId === asked.requestId)).toMatchObject({
      status: "person-says-done",
    });
  });

  it.for([
    ["completed", { status: "completed" }],
    [
      "failed",
      { status: "failed", code: "harness_error", message: "Engine failed", retryable: false },
    ],
  ] as const)(
    "keeps your own agent's ask waiting when its Run ends on its own (%s): the person approves, it runs, the task continues (D5)",
    async ([end, data], { storeFixture }) => {
      const { f, database, store, ran, run, door, rename, approve } = await setup(storeFixture);
      const proposed = (await dispatchCommand(run, rename("Work"), door(run))) as {
        requestId: string;
      };
      const asked = (await store.requests.get(proposed.requestId as never))!;
      // The Run tells the person and its turn ends on its own: its Runner says so.
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        event: pendingEvent({
          type: end === "completed" ? "run.completed" : "run.failed",
          environmentId: f.environmentId,
          bindingGeneration: f.bindingGeneration,
          ordinal: 1,
          runId: f.run.id,
          threadId: f.threadId,
          data,
        } as never),
      });
      const ended = await database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", f.run.id)
        .executeTakeFirstOrThrow();
      expect(ended.status).toBe(end);
      // The ask is the task's, not the Run's: it waits for the person.
      expect((await store.requests.get(proposed.requestId as never))!.status).toBe("pending");
      expect(await approve(proposed.requestId, asked.command!.command)).toMatchObject({
        status: "done",
      });
      expect(ran.map(({ command }) => command.type)).toEqual([asked.command!.type]);
      // Approving it continues the task.
      expect(
        await database
          .selectFrom("requestContinuations")
          .select("status")
          .where("requestId", "=", proposed.requestId as never)
          .execute(),
      ).toHaveLength(1);
    },
  );

  it("ends an ask when its proposer's reach ends: a narrowed grant, a paused automation; none comes back (D5)", async ({
    storeFixture,
  }) => {
    const { f, database, store, service, rename } = await setup(storeFixture);
    const propose = (
      proposer: Record<string, unknown>,
      origin: Record<string, unknown>,
      id: string,
    ) =>
      service.propose({
        ownerUserId: f.userId,
        command: rename("Work", id),
        ask: { status: "ask", reason: "approval" },
        face: undefined,
        proposer: proposer as never,
        origin: origin as never,
        originatingThreadId: f.threadId,
        callKey: randomUUID(),
      }) as Promise<{ requestId: string }>;
    // A connection narrowed below the ask, then widened again.
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const asked = (await service.propose({
      ownerUserId: f.userId,
      command: rename("Work", "hin_00000000-0000-4000-8000-000000002001"),
      ask: { status: "ask", reason: "approval" },
      face: undefined,
      proposer: {
        kind: "connection",
        name: "Agent",
        taskTitle: null,
        key: `connection:${connection.id}` as ProposerLineageKey,
        connectionId: connection.id,
        grantRevision: 1,
      },
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      callKey: randomUUID(),
    })) as { requestId: string };
    await connections.update(f.userId, {
      connectionId: connection.id,
      expectedRevision: 1,
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    expect(await store.requests.get(asked.requestId as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
    await connections.update(f.userId, {
      connectionId: connection.id,
      expectedRevision: 2,
      grant: { scope: "everything" },
    });
    expect((await store.requests.get(asked.requestId as never))!.status).toBe("cancelled");
    // An automation paused, then resumed.
    const triggers = new TriggerStore(database);
    const automation = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.threadId,
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      name: "Morning plan",
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 0 * * *", timezone: "UTC" },
      },
      script: { interpreter: null, text: "console.log('ok');" },
    });
    const occurrence = await triggers.enqueueManual({
      actorThreadId: null,
      ownerId: f.userId,
      triggerId: automation.trigger.id,
      idempotencyKey: randomUUID(),
    });
    await database
      .updateTable("triggerOccurrences")
      .set({ status: "running", startedAt: new Date() })
      .where("id", "=", occurrence.id)
      .execute();
    const fromAutomation = await propose(
      {
        kind: "program",
        name: "Morning plan",
        taskTitle: null,
        key: `automation:${automation.trigger.id}`,
      },
      { occurrenceId: occurrence.id },
      "hin_00000000-0000-4000-8000-000000002002",
    );
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: f.userId,
      status: "paused",
      triggerId: automation.trigger.id,
    });
    expect((await store.requests.get(fromAutomation.requestId as never))!.status).toBe("cancelled");
    await triggers.setStatus({
      actorThreadId: null,
      ownerId: f.userId,
      status: "active",
      triggerId: automation.trigger.id,
    });
    expect((await store.requests.get(fromAutomation.requestId as never))!.status).toBe("cancelled");
  });
});
