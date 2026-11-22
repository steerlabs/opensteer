import { randomUUID } from "node:crypto";
import {
  OpensteerError,
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
import { CommandRequestService } from "./requests.js";

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
    const service = new CommandRequestService({
      store: new CommandRequestStore(database, store.requests),
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
            key: `task:${f.threadId}`,
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
    const approve = (requestId: string, command: Record<string, unknown>) =>
      storeFixture.store.requests.revision(requestId as never).then((expectedRevision) =>
        service.approve(
          personActor(context),
          { requestId: requestId as never, expectedRevision: expectedRevision!, command },
          (person, approved) => dispatchCommand(person, approved, { registry }, context),
          (proposal) => personActor(context, proposal),
        ),
      );
    return {
      f,
      database,
      store,
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
    expect(request.presentation.title).toBe(
      "Claude Code, from the task “Tidy up”, wants to: Rename an AI engine account",
    );
    expect(request.presentation.detail).toContain(
      "Approving this needs an up-to-date Opensteer app.",
    );
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
      proposal: { requestId, proposedBy: { name: "Claude Code", key: `task:${f.threadId}` } },
    });
    const settled = (await store.requests.get(requestId as never))!;
    expect(settled).toMatchObject({
      status: "fulfilled",
      command: { outcome: { status: "done" } },
    });
    expect(commandContinuation(settled)).toContain("it was made");
  });

  it("never runs it for any answer a released app's form can send, and hands the agent its words", async ({
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
    // Asked again within the day: declined at once, nothing new for the person.
    expect(
      await dispatchCommand(
        run,
        rename("Name 0", "hin_00000000-0000-4000-8000-000000000100"),
        door(run),
      ),
    ).toMatchObject({ status: "declined" });
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
      proposer: { kind: "run", name: "Claude Code", taskTitle: null, key: `task:${f.threadId}` },
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

  it("settles an approval whose outcome was lost as unknown, and refusals as failed", async ({
    storeFixture,
  }) => {
    const { store, ran, run, door, rename, approve, failWith } = await setup(storeFixture);
    const first = (await dispatchCommand(
      run,
      rename("One", "hin_00000000-0000-4000-8000-000000000201"),
      door(run),
    )) as { requestId: string };
    failWith(new Error("The Runner went away mid-call"));
    expect(
      await approve(
        first.requestId,
        (await store.requests.get(first.requestId as never))!.command!.command,
      ),
    ).toEqual({
      status: "unknown",
    });
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
      message: "AI engine not found",
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
});
