import { createHash, randomUUID } from "node:crypto";
import type { CommandRequestPart, RequestId, RequestPresentation } from "@opensteer/core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { beginAgentSession } from "./agent-session-store.js";
import {
  CommandRequestStore,
  commandAskLimits,
  type CommandRequestOpened,
} from "./command-request-store.js";
import { connectionAttempts } from "./connection-disconnect.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
function part(input: {
  readonly askKey: string;
  readonly args?: string;
  readonly proposerKey?: string;
  readonly connection?: { readonly id: string; readonly grantRevision: number };
}): CommandRequestPart {
  return {
    type: "harness.rename",
    family: "engines",
    face: "preference",
    summary: "Claude Code, from the task “Tidy up”, wants to: Rename an AI engine account",
    gives: null,
    command: { name: "Work" },
    secretPaths: [],
    governs: { kind: "engine", id: "hin_1" },
    askKey: hex(input.askKey),
    argumentsDigest: hex(input.args ?? "a"),
    proposer: {
      kind: "run",
      name: "Claude Code",
      taskTitle: "Tidy up",
      key: input.proposerKey ?? "task:one",
      ...(input.connection
        ? { connectionId: input.connection.id, grantRevision: input.connection.grantRevision }
        : {}),
    },
    agentReason: null,
    editor: { screen: "ai-engines" },
  };
}
const presentation: RequestPresentation = {
  kind: "form",
  title: "Claude Code, from the task “Tidy up”, wants to: Rename an AI engine account",
  detail: "What changes: Rename an AI engine account",
  fields: [
    {
      id: "decision",
      prompt: "Decline it here, or approve it on its own screen.",
      choices: [{ label: "Decline", value: "decline" }],
      custom: true,
      multiSelect: false,
      secret: false,
    },
  ],
};

describeStore("command Requests in the store", (it) => {
  async function setup(storeFixture: StoreFixture) {
    const f = await storeFixture.startRunFixture(`command-requests-${randomUUID().slice(0, 8)}`);
    const store = new CommandRequestStore(storeFixture.database, storeFixture.store.requests);
    const open = (input: Parameters<typeof part>[0], callId: string = randomUUID()) =>
      store.open({
        ownerUserId: f.userId,
        callId,
        origin: { runId: f.run.id },
        originatingThreadId: f.threadId,
        part: part(input),
        // Each ask its own card, as the Home writes them.
        presentation: { ...presentation, detail: `${presentation.detail} ${input.askKey}` },
      });
    return { f, store, open, database: storeFixture.database };
  }
  /** The Request an open answered with, whatever became of it. */
  const idOf = (opened: CommandRequestOpened): RequestId =>
    "request" in opened ? opened.request.id : opened.requestId;

  it("keeps one open ask per proposer and thing", async ({ storeFixture }) => {
    const { open } = await setup(storeFixture);
    const first = await open({ askKey: "a1" }, "call-1");
    expect(first).toMatchObject({ status: "pending", replayed: false });
    // The same call, and the same ask with the same arguments, are the same Request.
    expect(await open({ askKey: "a1" }, "call-1")).toMatchObject({
      status: "pending",
      replayed: true,
      request: { id: idOf(first) },
    });
    expect(await open({ askKey: "a1" }, "call-2")).toMatchObject({
      request: { id: idOf(first) },
    });
    // The same ask with other arguments waits for the answer to the first.
    await expect(open({ askKey: "a1", args: "b" }, "call-3")).rejects.toMatchObject({
      code: "conflict",
      reason: "command-already-asked",
    });
    // Another proposer asking about the same thing is its own ask.
    expect(await open({ askKey: "a2", proposerKey: "task:two" })).toMatchObject({
      replayed: false,
    });
  });

  it("lets an ask wait until it is answered, and answers the same declined proposal as declined for a day", async ({
    storeFixture,
  }) => {
    const { f, store, open, database } = await setup(storeFixture);
    // At most five asks of one proposer wait at once; a sixth is refused, and opens nothing.
    const many = [];
    for (let index = 0; index < commandAskLimits.pendingPerProposer; index++)
      many.push(await open({ askKey: `many${index}` }));
    for (const opened of many) expect(opened).toMatchObject({ status: "pending", replayed: false });
    await expect(open({ askKey: "many-too-many" })).rejects.toMatchObject({
      code: "conflict",
      reason: "too-many-asks",
    });
    // No lifetime ends one: days later it still waits, and the person may still approve it.
    await database
      .updateTable("requests")
      .set({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) })
      .where("id", "=", idOf(many[0]!))
      .execute();
    expect(await open({ askKey: "many0" })).toMatchObject({
      status: "pending",
      request: { id: idOf(many[0]!) },
    });
    // Declined, the same proposal is answered as declined, with nothing opened, for a day.
    await store.decline({
      requestId: idOf(many[1]!),
      expectedRevision: (await storeFixture.store.requests.revision(idOf(many[1]!)))!,
      resolvedBy: f.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(await open({ askKey: "many1" })).toEqual({
      status: "declined",
      requestId: idOf(many[1]!),
    });
    // Other arguments are another proposal.
    const other = await open({ askKey: "many1", args: "b" });
    expect(other).toMatchObject({ status: "pending", replayed: false });
    await store.decline({
      requestId: idOf(other),
      expectedRevision: (await storeFixture.store.requests.revision(idOf(other)))!,
      resolvedBy: f.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    // A day later the same proposal may be asked again: a new Request.
    await database
      .updateTable("requests")
      .set({ resolvedAt: new Date(Date.now() - 25 * 60 * 60_000) })
      .where("id", "=", idOf(many[1]!))
      .execute();
    const again = await open({ askKey: "many1" });
    expect(again).toMatchObject({ status: "pending", replayed: false });
    expect(idOf(again)).not.toBe(idOf(many[1]!));
  });

  it("records the answer before it runs and an outcome lost to a restart as unknown", async ({
    storeFixture,
  }) => {
    const { f, store, open } = await setup(storeFixture);
    const opened = await open({ askKey: "u1" });
    await store.beginApproval({
      requestId: idOf(opened),
      expectedRevision: (await storeFixture.store.requests.revision(idOf(opened)))!,
      resolvedBy: f.userId,
      accept: () => undefined,
      approvalKey: randomUUID(),
      approved: { command: {} },
    });
    expect(await storeFixture.store.requests.get(idOf(opened))).toMatchObject({
      status: "fulfilled",
      command: { outcome: { status: "running" } },
    });
    // The Home stopped here: on restart it is unknown, and settling it again changes nothing.
    expect(await store.recoverRunning()).toEqual({ recovered: [idOf(opened)] });
    await store.settle(idOf(opened), { status: "done" });
    expect(await storeFixture.store.requests.get(idOf(opened))).toMatchObject({
      command: { outcome: { status: "unknown" } },
    });
  });

  it("strips invisible characters before storing the approved failure's card", async ({
    storeFixture,
  }) => {
    const { f, store, open } = await setup(storeFixture);
    const requestId = idOf(await open({ askKey: "diagnostic" }));
    await store.beginApproval({
      requestId,
      expectedRevision: (await storeFixture.store.requests.revision(requestId))!,
      resolvedBy: f.userId,
      accept: () => undefined,
      approvalKey: randomUUID(),
      approved: { command: {} },
    });
    await store.settle(requestId, {
      status: "failed",
      code: "bad_request",
      message: "Unsupported path /p\u202eets\u200b",
      result: { type: "plugins.install" },
    });
    expect(await storeFixture.store.requests.get(requestId)).toMatchObject({
      presentation: {
        detail: expect.stringContaining("You approved this, but unsupported path /pets"),
      },
    });
  });

  it("closes a connection's ask once its grant is narrowed below the one it asked with (X9)", async ({
    storeFixture,
  }) => {
    const { f, store, database } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const current = await database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    const opened = await store.open({
      ownerUserId: f.userId,
      callId: randomUUID(),
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      part: part({
        askKey: "n1",
        proposerKey: `connection:${connection.id}`,
        connection: { id: connection.id, grantRevision: current.grantRevision },
      }),
      presentation,
    });
    await connections.update(f.userId, {
      connectionId: connection.id,
      expectedRevision: current.grantRevision,
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    // Losing reach ends the ask in the narrowing's own transaction (D5): closed, nothing left for
    // the Disconnect set to wait on.
    expect(await storeFixture.store.requests.get(idOf(opened))).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
    expect(await connectionAttempts(database, connection.id)).not.toContainEqual(
      expect.objectContaining({ kind: "request", id: idOf(opened) }),
    );
  });

  it("puts a connection's ask in its Disconnect set", async ({ storeFixture }) => {
    const { f, store, database } = await setup(storeFixture);
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: f.userId,
      label: "Agent",
      clientName: "Agent",
      accessMode: "full-access",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60_000),
      grant: { scope: "everything" },
    });
    await connections.activate(connection.id, `hash-${randomUUID()}`);
    const { session } = await beginAgentSession(database, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const opened = await store.open({
      ownerUserId: f.userId,
      callId: randomUUID(),
      origin: { agentSessionId: session.id },
      originatingThreadId: session.threadId,
      part: part({ askKey: "s1", proposerKey: `connection:${connection.id}` }),
      presentation,
    });
    await connections.revoke(f.userId, connection.id);
    expect(await connectionAttempts(database, connection.id)).toContainEqual(
      expect.objectContaining({ kind: "request", id: idOf(opened) }),
    );
  });
});
