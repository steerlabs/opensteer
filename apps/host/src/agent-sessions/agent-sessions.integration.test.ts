import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  TabSchema,
  createId,
  type AgentGrant,
  type BrowserProfileId,
  type RequestId,
  type ThreadAccessMode,
} from "@opensteer/core";
import { AgentConnectionStore } from "@opensteer/database";
import { createStoreFixture, describeStore } from "@opensteer/database/test-support/store";
import { expect } from "vitest";
import { TabToolHandlers } from "../mcp/handlers/tabs.js";
import {
  clients,
  commands,
  connection,
  errorText,
  serveMcp,
} from "../mcp/connection-caller.test-support.js";
import type { TabActor, TabServicePort } from "../tabs/ports.js";
import { AgentSessionService, OperationOutcomeUnknown } from "./agent-session-service.js";

type Fixture = Awaited<ReturnType<typeof createStoreFixture>>;
const profile = createId("browserProfile") as BrowserProfileId;
const other = createId("browserProfile") as BrowserProfileId;
const granted: AgentGrant = {
  scope: "selected",
  tasks: false,
  resources: [{ kind: "browser-profile", profileId: profile }],
};
const page = (profileId: BrowserProfileId) => ({
  kind: "page" as const,
  url: "https://example.test/",
  profileId,
});
const tab = TabSchema.parse({
  tabId: "page-opened-by-session",
  kind: "page",
  title: "Page",
  url: "https://example.test",
  profile: null,
  computer: { computerId: createId("runner"), name: "Mac" },
  groupId: null,
  state: "open",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

/** The tab service as the tools reach it: it records who acted, and can hold an effect open. */
function recordingTabs() {
  const opened: { actor: TabActor; target: unknown }[] = [];
  let hold: Promise<void> | null = null;
  let entered: (() => void) | null = null;
  const tabs = {
    list: async () => ({ tabs: [], groups: [], nextCursor: null }),
    open: async (actor: TabActor, target: unknown) => {
      opened.push({ actor, target });
      entered?.();
      if (hold) {
        const signal = actor.kind === "browser-binding" ? actor.signal : undefined;
        await Promise.race([
          hold,
          new Promise<never>((_, reject) =>
            signal?.addEventListener("abort", () => reject(new OperationOutcomeUnknown()), {
              once: true,
            }),
          ),
        ]);
      }
      return { tab };
    },
    close: async () => ({ closed: [], failed: [] }),
  } as unknown as TabServicePort;
  return {
    tabs,
    opened,
    /** The next open blocks until released; resolves when it has started. */
    holdNext() {
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      hold = release.promise;
      entered = () => started.resolve();
      return { started: started.promise, release: () => release.resolve() };
    },
  };
}

async function setUp(
  storeFixture: Fixture,
  key: string,
  options: { readonly accessMode?: ThreadAccessMode; readonly grant?: AgentGrant } = {},
) {
  const f = await storeFixture.startRunFixture(key);
  const recorded = recordingTabs();
  const sessions = new AgentSessionService({ store: storeFixture.store, holdMs: 0 });
  const url = await serveMcp(storeFixture, {
    tabHandlers: new TabToolHandlers(recorded.tabs, sessions, async () => "Work"),
  });
  const agent = await connection(storeFixture.store, url, {
    userId: f.userId,
    accessMode: options.accessMode ?? "full-access",
    grant: options.grant ?? granted,
  });
  const call = async (name: string, args: Record<string, unknown>, client = agent.client) => {
    const result = await client.callTool({ name, arguments: args });
    return result;
  };
  const ok = async (name: string, args: Record<string, unknown>, client = agent.client) => {
    const result = await call(name, args, client);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown> & { taskId: string };
  };
  return { f, sessions, url, agent, call, ok, ...recorded };
}

describeStore("an external agent's direct work through sessions", (it) => {
  it("starts a session on the first direct call, continues it across transports, and refuses input to its task", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-start");
    // A browser-only agent works on a Home where no native engine is enabled.
    await database.updateTable("harnessInstances").set({ enabled: false }).execute();
    const first = await s.ok("tab_list", {});
    expect(first).toMatchObject({ status: "completed", tabs: [] });
    const task = await database
      .selectFrom("threads")
      .select(["id", "worker", "listed", "status", "originConnectionId"])
      .where("id", "=", first.taskId as never)
      .executeTakeFirstOrThrow();
    expect(task).toMatchObject({
      worker: "external",
      listed: true,
      status: "running",
      originConnectionId: s.agent.id,
    });
    // A second transport of the same connection continues the one session.
    const second = new Client({ name: "second-transport", version: "1" });
    clients.push(second);
    await second.connect(
      new StreamableHTTPClientTransport(s.url, {
        requestInit: { headers: { Authorization: `Bearer ${s.agent.token}` } },
      }) as unknown as Transport,
      { timeout: 5000 },
    );
    expect((await s.ok("tab_list", {}, second)).taskId).toBe(first.taskId);
    await expect(
      store.enqueueThreadInput({
        requestedBy: s.f.userId,
        threadId: first.taskId as never,
        content: [{ type: "text", text: "Do something else" }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: "input-to-session-task",
      }),
    ).rejects.toMatchObject({ reason: "external-agent-task" });
  });

  it("ends a session on Stop: calls naming it are refused, the next one is told once, then a new one starts", async ({
    storeFixture,
  }) => {
    const s = await setUp(storeFixture, "session-stop");
    const { taskId } = await s.ok("tab_list", {});
    const session = await storeFixture.database
      .selectFrom("agentSessions")
      .select("id")
      .where("threadId", "=", taskId as never)
      .executeTakeFirstOrThrow();
    // A late Stop for some other session on this task ends nothing.
    expect(
      await s.sessions.stopSession({
        ownerUserId: s.f.userId,
        threadId: taskId as never,
        sessionId: createId("agentSession"),
      }),
    ).toEqual({ ended: false });
    expect(
      await s.sessions.stopSession({
        ownerUserId: s.f.userId,
        threadId: taskId as never,
        sessionId: session.id,
      }),
    ).toEqual({ ended: true });
    expect(
      await storeFixture.database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "idle" });
    const stopped = "The person stopped this work. Do not continue it; ask before starting again.";
    expect(errorText(await s.call("tab_list", { taskId }))).toBe(stopped);
    expect(errorText(await s.call("tab_list", {}))).toBe(stopped);
    const next = await s.ok("tab_list", {});
    expect(next.taskId).not.toBe(taskId);
    expect(errorText(await s.call("tab_list", { taskId }))).toBe(stopped);
  });

  it("asks the person in approval-required, executes an approval exactly once under two resumes, and refuses a denial", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-approval", { accessMode: "approval-required" });
    const pending = await s.ok("tab_open", { target: page(profile), operationKey: "open-1" });
    expect(pending).toMatchObject({ status: "pending", requestId: expect.any(String) });
    expect(s.opened).toEqual([]);
    const request = await database
      .selectFrom("requests")
      .select(["id", "kind", "status", "originatingAgentSessionId", "revision"])
      .where("id", "=", pending.requestId as never)
      .executeTakeFirstOrThrow();
    expect(request).toMatchObject({ kind: "person.question", status: "pending" });
    expect(request.originatingAgentSessionId).toBeTruthy();
    expect(
      await database
        .selectFrom("threads")
        .select("status")
        .where("id", "=", pending.taskId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "waiting" });
    // A repeat before the answer is still pending, and a different call cannot take its key.
    expect(await s.ok("tab_open", { target: page(profile), operationKey: "open-1" })).toMatchObject(
      {
        status: "pending",
      },
    );
    expect(
      errorText(
        await s.call("tab_open", {
          target: { ...page(profile), url: "https://elsewhere.test/" },
          operationKey: "open-1",
        }),
      ),
    ).toBe("This operationKey already names a different call.");
    await s.sessions.respond({
      requestId: request.id as RequestId,
      expectedRevision: request.revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    // A stale approval never executes a different operation.
    expect(await s.ok("tab_open", { target: page(profile), operationKey: "open-2" })).toMatchObject(
      { status: "pending" },
    );
    expect(s.opened).toEqual([]);
    const held = s.holdNext();
    const resumes = [
      s.ok("tab_open", { target: page(profile), operationKey: "open-1" }),
      s.ok("tab_open", { target: page(profile), operationKey: "open-1" }),
    ];
    await held.started;
    held.release();
    const both = await Promise.all(resumes);
    expect(both.map(({ status }) => status)).toEqual(["completed", "completed"]);
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0]!.actor).toMatchObject({
      kind: "browser-binding",
      threadId: pending.taskId,
      authority: { agentBindingId: expect.stringMatching(/^session:/) },
    });
    // The person declines the second: resuming it is refused and nothing runs.
    const second = await database
      .selectFrom("agentOperations")
      .innerJoin("requests", "requests.id", "agentOperations.requestId")
      .select(["requests.id", "requests.revision"])
      .where("agentOperations.operationKey", "=", "open-2")
      .executeTakeFirstOrThrow();
    await s.sessions.respond({
      requestId: second.id as RequestId,
      expectedRevision: second.revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["deny"] } },
    });
    expect(
      errorText(await s.call("tab_open", { target: page(profile), operationKey: "open-2" })),
    ).toBe("The person did not allow it.");
    expect(s.opened).toHaveLength(1);
  });

  it("needs a fresh review when the grant changed between approval and resume, and refuses an ungranted profile", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const s = await setUp(storeFixture, "session-regrant", { accessMode: "approval-required" });
    expect(
      errorText(await s.call("tab_open", { target: page(other), operationKey: "elsewhere" })),
    ).toBe("This browser profile is not shared with this connected agent.");
    const pending = await s.ok("tab_open", { target: page(profile), operationKey: "regrant" });
    const request = await database
      .selectFrom("requests")
      .select(["id", "revision"])
      .where("id", "=", pending.requestId as never)
      .executeTakeFirstOrThrow();
    await s.sessions.respond({
      requestId: request.id as RequestId,
      expectedRevision: request.revision,
      resolvedBy: s.f.userId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    await new AgentConnectionStore(database).update(s.f.userId, {
      connectionId: s.agent.id,
      expectedRevision: 1,
      grant: {
        ...granted,
        resources: [...granted.resources, { kind: "browser-profile", profileId: other }],
      },
    });
    const resumed = await s.ok("tab_open", { target: page(profile), operationKey: "regrant" });
    expect(resumed).toMatchObject({ status: "pending" });
    expect(resumed.requestId).not.toBe(request.id);
    expect(s.opened).toEqual([]);
  });

  it("on Disconnect ends the session, settles its Request, records an unknown outcome, and leaves a second agent working", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const s = await setUp(storeFixture, "session-disconnect");
    const second = await connection(store, s.url, {
      userId: s.f.userId,
      accessMode: "approval-required",
      grant: granted,
    });
    const theirs = await second.client.callTool({
      name: "tab_open",
      arguments: { target: page(profile), operationKey: "theirs" },
    });
    expect(theirs.structuredContent).toMatchObject({ status: "pending" });
    const held = s.holdNext();
    const inFlight = s.call("tab_open", { target: page(profile), operationKey: "in-flight" });
    await held.started;
    const disconnect = commands(storeFixture, s.f.userId, {
      afterStop: (connectionId, reason) =>
        s.sessions.closeConnection(connectionId, reason === "disconnect"),
    });
    await disconnect.revoke(s.agent.id);
    // Disconnect closed the agent's MCP session, so its in-flight call gets no answer; the
    // executor saw its signal abort and could not confirm the effect.
    await inFlight.then(
      () => null,
      () => null,
    );
    await s.sessions.drain();
    const operation = await database
      .selectFrom("agentOperations")
      .select(["state", "outcome"])
      .where("operationKey", "=", "in-flight")
      .executeTakeFirstOrThrow();
    expect(operation).toEqual({ state: "unknown", outcome: "unknown" });
    await disconnect.effects.driveCleanups();
    const [revoked] = await new AgentConnectionStore(database)
      .list(s.f.userId, {
        includeRevoked: true,
      })
      .then((rows) => rows.filter(({ id }) => id === s.agent.id));
    expect(revoked).toMatchObject({ state: "stopped" });
    expect(
      await database
        .selectFrom("agentConnections")
        .select("lastActionUncertain")
        .where("id", "=", s.agent.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ lastActionUncertain: { kind: "operation", tool: "tab_open" } });
    expect(
      await database
        .selectFrom("agentSessions")
        .select(["connectionId", "status"])
        .orderBy("connectionId")
        .execute(),
    ).toEqual(
      [
        { connectionId: s.agent.id, status: "ended" },
        { connectionId: second.id, status: "active" },
      ].sort((a, b) => a.connectionId.localeCompare(b.connectionId)),
    );
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", (theirs.structuredContent as { requestId: string }).requestId as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "pending" });
  });
});
