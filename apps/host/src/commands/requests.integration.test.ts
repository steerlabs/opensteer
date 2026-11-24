import { randomUUID } from "node:crypto";
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
  commandSubject,
  needsYouPage,
} from "@opensteer/database";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import type { HostApiCommand, HostApiServerContext } from "@opensteer/protocol";
import { commandTable, type CommandType } from "@opensteer/protocol/command-table";
import { expect } from "vitest";
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
    const approve = (
      requestId: string,
      command: Record<string, unknown>,
      idempotencyKey: string = randomUUID(),
    ) =>
      storeFixture.store.requests.revision(requestId as never).then((expectedRevision) =>
        service.approve(
          personActor(context),
          {
            requestId: requestId as never,
            expectedRevision: expectedRevision!,
            command,
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
      failWith: (error: Error) => (fail = error),
    };
  }

  it("puts a command to the person and runs it as the person, as they changed it", async ({
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
    // Changing what it changes is refused; changing how is the person's to do.
    await expect(
      approve(requestId, {
        ...request.command!.command,
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "command-changed" });
    expect(ran).toEqual([]);
    const outcome = await approve(requestId, {
      ...request.command!.command,
      name: "Work, renamed",
    });
    expect(outcome).toEqual({
      status: "done",
      result: { type: "harness.rename", harness: { name: "Work, renamed" } },
    });
    expect(ran).toHaveLength(1);
    expect(ran[0]!.command).toMatchObject({ name: "Work, renamed" });
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

  it("never runs it for any declining answer, and hands the agent its words", async ({
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
      if (index === 1)
        expect(commandContinuation(declined)).toContain("Not now, I'll do it myself");
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

  it("records what ran apart from what was proposed, and who proposed it (X2)", async ({
    storeFixture,
  }) => {
    const { f, database, store, run, door, rename, approve } = await setup(storeFixture);
    const proposed = (await dispatchCommand(
      run,
      rename("Work", "hin_00000000-0000-4000-8000-000000000601"),
      door(run),
    )) as { requestId: string };
    const asked = (await store.requests.get(proposed.requestId as never))!.command!;
    await approve(proposed.requestId, { ...asked.command, name: "Work, renamed" });
    const settled = (await store.requests.get(proposed.requestId as never))!.command!;
    expect(settled.command).toMatchObject({ name: "Work" });
    expect(settled.approved).toEqual({
      command: { ...asked.command, name: "Work, renamed" },
      changed: true,
    });
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
        changed: true,
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
    expect(request.presentation.title).toContain("Asked by the agent “Opensteer: routine");
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
    await expect(
      approve(
        proposed.requestId,
        (await store.requests.get(proposed.requestId as never))!.command!.command,
      ),
    ).rejects.toMatchObject({ code: "forbidden", reason: "proposer-gone" });
    expect(ran).toEqual([]);
    expect(await store.requests.get(proposed.requestId as never)).toMatchObject({
      status: "cancelled",
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
        "connectionId",
        "expectedRevision",
        "label",
        "grant.scope",
        "grant.tasks",
        "grant.resources.0.kind",
        "grant.resources.0.profileId",
        "grant.resources.0.access",
      ].sort(),
    );
    // Beside them, only the Home's words: what an id names, what a changed setting is now. The
    // label it would keep has nothing beside it.
    expect(part.notes).toEqual([
      { path: "connectionId", name: "“Research”" },
      { path: "grant.resources.0.profileId", name: "“Work”" },
      { path: "grant", current: commandReviewText({ scope: "everything" }) },
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
          command: request.command!.command,
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
    const { store, ran, run, door, rename } = await setup(storeFixture);
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
    expect(ran).toEqual([]);
    expect((await store.requests.get(requestId as never))!.status).toBe("pending");
  });
});
