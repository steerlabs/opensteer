import { createHash, randomUUID } from "node:crypto";
import type { CommandRequestPart, RequestPresentation } from "@opensteer/core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { beginAgentSession } from "./agent-session-store.js";
import {
  commandRequestLifetimeMs,
  commandRequestsPerProposer,
  CommandRequestStore,
} from "./command-request-store.js";
import { connectionAttempts } from "./connection-disconnect.js";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
function part(input: {
  readonly askKey: string;
  readonly args?: string;
  readonly proposerKey?: string;
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
    },
    agentReason: null,
    editor: { screen: "ai-engines" },
  };
}
const presentation: RequestPresentation = {
  kind: "form",
  title: "Claude Code, from the task “Tidy up”, wants to: Rename an AI engine account",
  detail: "Approving this needs an up-to-date Opensteer app.",
  fields: [
    {
      id: "decision",
      prompt: "Decline it here, or approve it in an up-to-date Opensteer app.",
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

  it("keeps one open ask per proposer and thing", async ({ storeFixture }) => {
    const { open } = await setup(storeFixture);
    const first = await open({ askKey: "a1" }, "call-1");
    expect(first).toMatchObject({ status: "pending", replayed: false });
    // The same call, and the same ask with the same arguments, are the same Request.
    expect(await open({ askKey: "a1" }, "call-1")).toMatchObject({
      status: "pending",
      replayed: true,
      request: { id: first.request.id },
    });
    expect(await open({ askKey: "a1" }, "call-2")).toMatchObject({
      request: { id: first.request.id },
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

  it("caps open asks per proposer", async ({ storeFixture }) => {
    const { open } = await setup(storeFixture);
    for (let index = 0; index < commandRequestsPerProposer; index++)
      await open({ askKey: `cap${index}` });
    await expect(open({ askKey: "cap-over" })).rejects.toMatchObject({
      code: "resource_exhausted",
      reason: "command-requests-full",
    });
  });

  it("remembers a decline for a day and answers it at once", async ({ storeFixture }) => {
    const { f, store, open, database } = await setup(storeFixture);
    const first = await open({ askKey: "d1" });
    await store.decline({
      requestId: first.request.id,
      expectedRevision: (await storeFixture.store.requests.revision(first.request.id))!,
      resolvedBy: f.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    const again = await open({ askKey: "d1", args: "other" });
    expect(again).toMatchObject({ status: "declined", request: { id: first.request.id } });
    const open_ = await database
      .selectFrom("requests")
      .select("id")
      .where("status", "=", "pending")
      .where("command", "is not", null)
      .execute();
    expect(open_).toEqual([]);
    // After the day it may be asked again.
    await database
      .updateTable("requests")
      .set({ resolvedAt: new Date(Date.now() - commandRequestLifetimeMs - 60_000) })
      .where("id", "=", first.request.id)
      .execute();
    expect(await open({ askKey: "d1" })).toMatchObject({ status: "pending", replayed: false });
  });

  it("expires an ask no one answered, and refuses to approve it", async ({ storeFixture }) => {
    const { f, store, open, database } = await setup(storeFixture);
    const opened = await open({ askKey: "e1" });
    await database
      .updateTable("requests")
      .set({ createdAt: new Date(Date.now() - commandRequestLifetimeMs - 60_000) })
      .where("id", "=", opened.request.id)
      .execute();
    const revision = (await storeFixture.store.requests.revision(opened.request.id))!;
    await expect(
      store.beginApproval({
        requestId: opened.request.id,
        expectedRevision: revision,
        resolvedBy: f.userId,
        accept: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "request-expired" });
    expect(await store.expire()).toEqual([opened.request.id]);
    expect(await storeFixture.store.requests.get(opened.request.id)).toMatchObject({
      status: "cancelled",
      command: { expired: true },
    });
  });

  it("records the answer before it runs and an outcome lost to a restart as unknown", async ({
    storeFixture,
  }) => {
    const { f, store, open } = await setup(storeFixture);
    const opened = await open({ askKey: "u1" });
    await store.beginApproval({
      requestId: opened.request.id,
      expectedRevision: (await storeFixture.store.requests.revision(opened.request.id))!,
      resolvedBy: f.userId,
      accept: () => undefined,
    });
    expect(await storeFixture.store.requests.get(opened.request.id)).toMatchObject({
      status: "fulfilled",
      command: { outcome: { status: "running" } },
    });
    // The Home stopped here: on restart it is unknown, and settling it again changes nothing.
    expect(await store.recoverRunning()).toEqual([opened.request.id]);
    await store.settle(opened.request.id, { status: "done" });
    expect(await storeFixture.store.requests.get(opened.request.id)).toMatchObject({
      command: { outcome: { status: "unknown" } },
    });
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
      expect.objectContaining({ kind: "request", id: opened.request.id }),
    );
  });
});
