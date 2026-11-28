import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  RequestIdSchema,
  type AgentGrant,
  type ThreadAccessMode,
  type ThreadId,
} from "@opensteer/core";
import { AgentConnectionStore, admitCommand, beginAgentSession } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it, vi } from "vitest";
import {
  connectionCredentialPrefix,
  credentialHash,
} from "../mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../mcp/connections/connection-oauth.js";
import {
  connectCallerMachine,
  dispatchCallerRun,
  startPrivateMachineHost,
  waitForValue,
} from "../runtime/private-machine-host.test-support.js";
import { registeredHostRoutes } from "../server.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { injectRpcRequest, testRpcData } from "../server/test-host-api-request.js";
import { seedDeviceApproval } from "../mcp/device-approvals.test-support.js";

/**
 * The three tools (A5) on a real Home: what a caller may change is listed from the one rule,
 * a command goes through the one door, and what waits for the person opens a Request.
 */
it("lists, runs and puts to the person a Home command, for each kind of agent", async () => {
  const database = await cloneTestDatabase("host");
  const close: (() => Promise<unknown>)[] = [];
  try {
    const host = await startPrivateMachineHost(database.url, { logger: false });
    close.unshift(() => host.close());
    const machine = await connectCallerMachine(host, {
      name: "Commands computer",
      token: host.hostingRunnerEnrollmentToken,
    });
    close.unshift(() => machine.close());
    const owner = host.ownerId;
    const task = async (title: string, accessMode: ThreadAccessMode) =>
      (
        (await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            environmentId: machine.environmentId,
            harnessInstanceId: machine.harnessInstanceId,
            idempotencyKey: randomUUID(),
            modelSelection: {
              modelId: "gpt-5.6-sol",
              options: { effort: "low" },
              providerId: "openai",
            },
            title,
            accessMode,
            type: "thread.create",
          } as never,
          { headers: host.ownerHeaders },
        )) as { thread: { id: ThreadId } }
      ).thread.id;
    const clients: Client[] = [];
    const mcp = async (url: URL, bearer: string) => {
      const client = new Client({ name: "command-tools", version: "1" });
      clients.push(client);
      close.unshift(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        }) as unknown as Transport,
      );
      return client;
    };
    const runIds: Record<string, string> = {};
    const runFor = async (mode: ThreadAccessMode, key: string) => {
      const run = await dispatchCallerRun(host, machine, {
        key,
        title: key,
        threadId: await task(key, mode),
      });
      runIds[key] = run.runId;
      return mcp(new URL(hostInternalRoutePaths.mcp, host.origin), run.toolsToken);
    };
    const connections = new AgentConnectionStore(host.store.database);
    const connect = async (grant: AgentGrant, label = "Commands agent") => {
      const record = await connections.create({
        userId: owner,
        label,
        clientName: label,
        accessMode: "full-access",
        resource: new URL(mcpResourcePath, host.origin).href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        grant,
      });
      const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
      await connections.activate(record.id, credentialHash(token));
      return { id: record.id, client: await mcp(new URL(mcpResourcePath, host.origin), token) };
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: unknown;
      };
    const rename = (name: string) => ({
      command: {
        type: "harness.rename",
        environmentId: machine.environmentId,
        harnessInstanceId: machine.harnessInstanceId,
        name,
      },
    });

    // Your own agent at Full access: it lists the change, reads its input, and makes it now.
    const full = await runFor("full-access", "commands-full");
    const families = await call(full, "opensteer_commands", {});
    expect(families.structuredContent?.families).toEqual(
      expect.arrayContaining([expect.objectContaining({ family: "engines" })]),
    );
    // Its mode as the Home has it now marks its list, never the one its token was minted with
    // (G1): the person lowers this Run's mode, and the same command now asks.
    const marked = async () =>
      (
        ((await call(full, "opensteer_commands", { family: "engines" })).structuredContent
          ?.commands ?? []) as { type: string; answer: string }[]
      ).find(({ type }) => type === "harness.rename")?.answer;
    expect(await marked()).toBe("now");
    await host.store.database
      .updateTable("runs")
      .set({ accessMode: "approval-required" })
      .where("id", "=", runIds["commands-full"] as never)
      .execute();
    expect(await marked()).toBe("ask");
    await host.store.database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", runIds["commands-full"] as never)
      .execute();
    const page = await call(full, "opensteer_commands", { family: "engines" });
    expect(page.structuredContent?.commands).toEqual(
      expect.arrayContaining([
        { type: "harness.rename", title: expect.any(String), answer: "now" },
      ]),
    );
    const schema = await call(full, "opensteer_commands", { type: "harness.rename" });
    expect(JSON.stringify(schema.structuredContent?.input)).not.toContain("idempotencyKey");
    expect((await call(full, "opensteer_command", rename("Work"))).structuredContent).toMatchObject(
      { status: "done" },
    );
    expect(await host.store.getHarnessInstance(machine.harnessInstanceId as never)).toMatchObject({
      name: "Work",
    });
    expect(
      (await call(full, "opensteer_state", { area: "settings" })).structuredContent,
    ).toMatchObject({
      area: "settings",
      view: expect.objectContaining({ accessMode: expect.any(String) }),
    });

    // A door command's admission from a Run reads that Run's row once, in a counted number of
    // statements (rule 7: your own agents' paths stay as cheap as before).
    const counted = await dispatchCallerRun(host, machine, {
      key: "commands-counted",
      title: "commands-counted",
      threadId: await task("commands-counted", "full-access"),
    });
    // Counted on the admission's own connection only: the Home's background work runs on others.
    const issued: { readonly client: pg.Client; readonly text: string }[] = [];
    const query = pg.Client.prototype.query;
    const counting = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { readonly text?: string } | undefined;
      issued.push({
        client: this,
        text: typeof first === "string" ? first : (first?.text ?? "<unknown>"),
      });
      return Reflect.apply(query, this, args) as never;
    });
    const marker = "select 'admission counted from here' as marker";
    try {
      await host.store.database.transaction().execute(async (transaction) => {
        await sql.raw(marker).execute(transaction);
        await admitCommand(transaction, {
          ownerUserId: owner,
          subject: { kind: "binding", bindingId: `run:${counted.runId}` },
          command: rename("Counted").command as never,
        });
      });
    } finally {
      counting.mockRestore();
    }
    // Its slot is the computer's: the Runs below need it.
    await counted.complete();
    const start = issued.findIndex((statement) => statement.text === marker);
    const admitting = issued[start]!.client;
    const admission = issued
      .slice(start + 1)
      .filter((statement) => statement.client === admitting)
      .map((statement) => statement.text);
    admission.splice(admission.findIndex((statement) => /^commit\b/iu.test(statement)));
    expect(
      admission.filter((statement) => /from "runs" inner join "threads"/u.test(statement)),
      admission.join("\n"),
    ).toHaveLength(1);
    // The Run's row, the owner, the Home's settings: the Run read once, not twice.
    expect(admission, admission.join("\n")).toHaveLength(3);

    // Supervised: the same command waits for the person; a Run's call is held for the answer.
    const supervised = await runFor("approval-required", "commands-supervised");
    const held = call(supervised, "opensteer_command", { ...rename("Asked"), reason: "Clearer" });
    const request = await waitForValue(
      async () =>
        (await host.store.database
          .selectFrom("requests")
          .select(["id", "command"])
          .where("status", "=", "pending")
          .where("command", "is not", null)
          .executeTakeFirst()) ?? undefined,
    );
    expect(request.command).toMatchObject({ type: "harness.rename", agentReason: "Clearer" });
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.respond",
        idempotencyKey: randomUUID(),
        requestId: request.id,
        expectedRevision: (await host.store.requests.revision(request.id))!,
        response: { kind: "form", answers: { decision: ["decline"] } },
      } as never,
      { headers: host.ownerHeaders },
    );
    expect((await held).isError).not.toBe(true);
    expect(await host.store.requests.get(request.id)).toMatchObject({ status: "declined" });
    expect(await host.store.getHarnessInstance(machine.harnessInstanceId as never)).toMatchObject({
      name: "Work",
    });

    // A connected agent with everything: through the door as the connection, recorded by the
    // store as the connection's, and no direct-work operation.
    const everything = await connect({ scope: "everything" });
    const done = await call(everything.client, "opensteer_command", rename("From a connection"));
    expect(done.structuredContent).toMatchObject({ status: "done" });
    const ledger = await host.store.database
      .selectFrom("commands")
      .select(["type", "authoritySource"])
      .where("type", "=", "harness.rename")
      .execute();
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authoritySource: expect.objectContaining({ callerKey: `connection:${everything.id}` }),
        }),
      ]),
    );
    expect(
      await host.store.database
        .selectFrom("agentOperations")
        .select("id")
        .where("connectionId", "=", everything.id)
        .execute(),
    ).toEqual([]);

    // Every area reads what the person's apps read, cut to the caller (AC1).
    for (const area of [
      "settings",
      "connections",
      "devices",
      "chats",
      "engines",
      "requests",
      "activity",
    ]) {
      const read = await call(full, "opensteer_state", { area });
      expect(read.isError, `${area}: ${JSON.stringify(read.content)}`).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ area });
    }
    // A selected grant sees the devices of the apps it holds, and no other.
    const devicesSeen = async (client: Client) =>
      (
        (await call(client, "opensteer_state", { area: "devices" })).structuredContent!.view as {
          machines: { id: string }[];
        }
      ).machines.map(({ id }) => id);
    const everyDevice = await devicesSeen(full);
    expect(everyDevice.length).toBeGreaterThan(0);
    // The devices of what the one rule lends the grant now: an approval held shows its device;
    // one blocked, one removed and made again as a new row, and one never made show none, byte
    // for byte alike.
    const mac = everyDevice[0]!;
    const [heldApp, blockedApp, staleApp, renewedApp] = [0, 1, 2, 3].map(
      () => `con_${randomUUID()}`,
    );
    const approve = (
      id: string,
      name: string,
      bundleId: string,
      more: { status?: "revoked"; blockedAt?: Date } = {},
    ) =>
      seedDeviceApproval(host.store.database, {
        id,
        ownerUserId: host.ownerId,
        deviceId: mac,
        name,
        app: { bundleId, displayName: name },
        ...more,
      });
    await approve(heldApp!, "Notes", "com.apple.Notes");
    await approve(blockedApp!, "Mail", "com.apple.mail", { blockedAt: new Date() });
    await approve(staleApp!, "Safari", "com.apple.Safari", { status: "revoked" });
    await approve(renewedApp!, "Safari", "com.apple.Safari");
    const devicesState = async (approvalId: string, bundleId: string) => {
      const holder = await connect({
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "computer-app",
            approvalId,
            deviceId: mac,
            app: { kind: "mac-app", bundleId, teamId: null },
          },
        ],
      } as unknown as AgentGrant);
      return JSON.stringify(
        (await call(holder.client, "opensteer_state", { area: "devices" })).structuredContent,
      );
    };
    expect(await devicesState(heldApp!, "com.apple.Notes")).toContain(mac);
    const never = await devicesState(`con_${randomUUID()}`, "com.apple.mail");
    expect(never).not.toContain(mac);
    expect(await devicesState(blockedApp!, "com.apple.mail")).toBe(never);
    expect(await devicesState(staleApp!, "com.apple.Safari")).toBe(never);
    // Engine accounts as the person's own snapshot reads them, with the work location their
    // commands name, and none of the source fields the person typed (ruling 3).
    const engines = await call(full, "opensteer_state", { area: "engines" });
    const harnesses = (engines.structuredContent!.view as { harnesses: Record<string, unknown>[] })
      .harnesses;
    expect(harnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: machine.harnessInstanceId,
          environmentId: machine.environmentId,
          name: expect.any(String),
          enabled: expect.any(Boolean),
        }),
      ]),
    );
    for (const harness of harnesses) expect(harness).not.toHaveProperty("config");
    // Below Full access, your own agent's requests area is its own task tree's, not every task's.
    const asker = await runFor("approval-required", "commands-asker");
    const stranger = await runFor("approval-required", "commands-stranger");
    const asked = call(asker, "opensteer_command", { ...rename("Asked again"), reason: "Mine" });
    const treeAsk = await waitForValue(
      async () =>
        (await host.store.database
          .selectFrom("requests")
          .select("id")
          .where("status", "=", "pending")
          .where("command", "is not", null)
          .executeTakeFirst()) ?? undefined,
    );
    const requestsOf = async (client: Client) =>
      (
        (await call(client, "opensteer_state", { area: "requests" })).structuredContent!.view as {
          requests: { request: { id: string } }[];
        }
      ).requests.map(({ request }) => request.id);
    expect(await requestsOf(asker)).toContain(treeAsk.id);
    expect(await requestsOf(stranger)).not.toContain(treeAsk.id);
    expect(await requestsOf(full)).toContain(treeAsk.id);
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.respond",
        idempotencyKey: randomUUID(),
        requestId: treeAsk.id,
        expectedRevision: (await host.store.requests.revision(treeAsk.id))!,
        response: { kind: "form", answers: { decision: ["decline"] } },
      } as never,
      { headers: host.ownerHeaders },
    );
    expect((await asked).isError).not.toBe(true);
    const someone = await connect({ scope: "everything" });
    const seen = await call(someone.client, "opensteer_state", { area: "connections" });
    expect(
      (seen.structuredContent!.view as { connections: { id: string }[] }).connections.map(
        ({ id }) => id,
      ),
    ).toEqual([someone.id]);
    // Chats are other connections, for every connected agent.
    const chats = await call(someone.client, "opensteer_state", { area: "chats" });
    const nowhere = await call(someone.client, "opensteer_command", {
      command: { type: "no.such.command" },
    });
    expect(chats.isError).toBe(true);
    expect(JSON.stringify(chats.content)).toBe(JSON.stringify(nowhere.content));
    const tasksOnly = await connect({ scope: "selected", tasks: true, resources: [] });
    for (const area of ["settings", "engines", "chats"])
      expect((await call(tasksOnly.client, "opensteer_state", { area })).isError, area).toBe(true);
    const own = await call(tasksOnly.client, "opensteer_state", { area: "activity" });
    expect(own.isError).not.toBe(true);

    // State is admitted like a command, from the live grant (AD2): narrowed, it is seen at once.
    const narrowing = await connect({ scope: "everything" });
    expect(
      (await call(narrowing.client, "opensteer_state", { area: "settings" })).isError,
    ).not.toBe(true);
    await connections.update(owner, {
      connectionId: narrowing.id,
      expectedRevision: 1,
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const narrowed = await call(narrowing.client, "opensteer_state", { area: "settings" });
    // Not offered any longer, so not there: the tool is gone from its list.
    expect(narrowed.isError).toBe(true);

    // A Supervised connection: exactly one Request, the door's; Disconnect closes it, and
    // nothing runs (X9).
    const asking = await connect({ scope: "everything" });
    await host.store.database
      .updateTable("agentConnections")
      .set({ accessMode: "approval-required" })
      .where("id", "=", asking.id)
      .execute();
    const pending = await call(asking.client, "opensteer_command", rename("Asked by a connection"));
    expect(pending.structuredContent).toMatchObject({ status: "pending" });
    const askedBy = await host.store.database
      .selectFrom("requests")
      .innerJoin("agentSessions", "agentSessions.id", "requests.originatingAgentSessionId")
      .select(["requests.id", "requests.command", "requests.status"])
      .where("agentSessions.connectionId", "=", asking.id)
      .execute();
    expect(askedBy).toHaveLength(1);
    expect(askedBy[0]!.command).toMatchObject({ type: "harness.rename" });
    // The person's Disconnect, as the app sends it: it stops the lineage.
    await testRpcData(
      host.origin,
      "commands.dispatch",
      { type: "connection.revoke", idempotencyKey: randomUUID(), connectionId: asking.id } as never,
      { headers: host.ownerHeaders },
    );
    await waitForValue(async () =>
      (await host.store.requests.get(askedBy[0]!.id as never))?.status === "cancelled"
        ? true
        : undefined,
    );
    expect(await host.store.getHarnessInstance(machine.harnessInstanceId as never)).toMatchObject({
      name: "From a connection",
    });

    // Activity says who did it, in one list (C5, AC5): a connection by its own name, done,
    // asked, declined and approved; your own agent by its engine, from its task.
    type Activity = {
      operations: unknown[];
      commands?: { sentence: string; status: string; outcome: string | null; type: string }[];
    };
    const activityOf = async (input: { connectionId: string } | { threadId: ThreadId }) =>
      (await testRpcData(
        host.origin,
        "connectionId" in input ? "connections.activity" : "threads.activity",
        input as never,
        { headers: host.ownerHeaders },
      )) as Activity;
    const doneByConnection = await activityOf({ connectionId: everything.id });
    expect(doneByConnection.commands).toEqual([
      expect.objectContaining({
        type: "harness.rename",
        status: "done",
        sentence: expect.stringMatching(/^Commands agent renamed an AI engine account/u),
      }),
    ]);
    const reviewed = await connect({ scope: "everything" }, "Reviewed agent");
    await host.store.database
      .updateTable("agentConnections")
      .set({ accessMode: "approval-required" })
      .where("id", "=", reviewed.id)
      .execute();
    const askOf = async (name: string) => {
      expect(
        (await call(reviewed.client, "opensteer_command", rename(name))).structuredContent,
      ).toMatchObject({ status: "pending" });
      return waitForValue(
        async () =>
          (await host.store.database
            .selectFrom("requests")
            .select(["id", "command"])
            .where("status", "=", "pending")
            .where(sql<string>`command->'proposer'->>'key'`, "=", `connection:${reviewed.id}`)
            .executeTakeFirst()) ?? undefined,
      );
    };
    const first = await askOf("Approved name");
    expect((await activityOf({ connectionId: reviewed.id })).commands).toEqual([
      expect.objectContaining({
        status: "asked",
        sentence: expect.stringMatching(/^Reviewed agent asked to rename an AI engine account/u),
      }),
    ]);
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.command.approve",
        idempotencyKey: randomUUID(),
        requestId: first.id,
        expectedRevision: (await host.store.requests.revision(first.id))!,
      } as never,
      { headers: host.ownerHeaders },
    );
    await waitForValue(async () =>
      ((await activityOf({ connectionId: reviewed.id })).commands ?? []).some(
        ({ outcome }) => outcome === "done",
      )
        ? true
        : undefined,
    );
    // A declined ask is answered at once as declined for a while after, so the other is second.
    const second = await askOf("Declined name");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.respond",
        idempotencyKey: randomUUID(),
        requestId: second.id,
        expectedRevision: (await host.store.requests.revision(second.id))!,
        response: { kind: "form", answers: { decision: ["decline"] } },
      } as never,
      { headers: host.ownerHeaders },
    );
    const settled = (await activityOf({ connectionId: reviewed.id })).commands ?? [];
    // One list, newest first: the declined ask, then the approved one, done.
    expect(settled.map(({ status, outcome }) => [status, outcome])).toEqual([
      ["declined", null],
      ["approved", "done"],
    ]);
    for (const { sentence } of settled) expect(sentence).toMatch(/^Reviewed agent asked to /u);
    // A connected agent proposes Done through the person's command and waits for approval.
    const { session } = await beginAgentSession(host.store.database, {
      userId: owner,
      agentConnectionId: reviewed.id,
    });
    const doneAsk = await call(reviewed.client, "opensteer_command", {
      taskId: session.threadId,
      command: { type: "thread.done.set", threadId: session.threadId, done: true },
    });
    expect(doneAsk.structuredContent).toMatchObject({ status: "pending" });
    const doneRequestId = RequestIdSchema.parse(doneAsk.structuredContent?.requestId);
    const sessionRow = () =>
      host.store.database
        .selectFrom("agentSessions")
        .select(["status", "endReason"])
        .where("id", "=", session.id)
        .executeTakeFirstOrThrow();
    expect(await sessionRow()).toEqual({ status: "active", endReason: null });
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.command.approve",
        idempotencyKey: randomUUID(),
        requestId: doneRequestId,
        expectedRevision: (await host.store.requests.revision(doneRequestId))!,
      },
      { headers: host.ownerHeaders },
    );
    expect((await host.store.getThreadForOwner(session.threadId, owner))?.doneAt).toEqual(
      expect.any(String),
    );
    expect(await sessionRow()).toEqual({ status: "ended", endReason: "done" });
    expect(
      await call(reviewed.client, "ask_person", {
        title: "Continue the finished task?",
        questions: [{ question: "Continue?" }],
        taskId: session.threadId,
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: {
        error: { message: "This task's session ended. Leave out taskId to start a new one." },
      },
    });
    // Your own agent: its engine's name, from its task, for what it did and what it asked.
    const engine = (await host.store.getHarnessInstance(machine.harnessInstanceId as never))!.name;
    const fullTask = await host.store.database
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["threads.id", "threads.title"])
      .where("threads.title", "=", "commands-full")
      .executeTakeFirstOrThrow();
    expect((await activityOf({ threadId: fullTask.id })).commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "done",
          sentence: `${engine}, from the task “commands-full”, renamed an AI engine account: “${engine}”`,
        }),
      ]),
    );
    const supervisedTask = await host.store.database
      .selectFrom("threads")
      .select("id")
      .where("title", "=", "commands-supervised")
      .executeTakeFirstOrThrow();
    expect((await activityOf({ threadId: supervisedTask.id })).commands).toEqual([
      expect.objectContaining({
        status: "declined",
        sentence: expect.stringMatching(
          /, from the task “commands-supervised”, asked to rename an AI engine account/u,
        ),
      }),
    ]);

    // A selected grant holds no engine: not listed, and not there, in the same bytes as nothing.
    const selected = await connect({ scope: "selected", tasks: true, resources: [] });
    const listed = await call(selected.client, "opensteer_commands", {});
    expect(JSON.stringify(listed.structuredContent)).not.toContain("engines");
    const outside = await call(selected.client, "opensteer_command", rename("Outside"));
    const unknown = await call(selected.client, "opensteer_command", {
      command: { type: "no.such.command" },
    });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toBe(JSON.stringify(unknown.content));
    expect(
      (await call(selected.client, "opensteer_commands", { type: "harness.rename" })).isError,
    ).toBe(true);

    // A selected grant with Tasks: it renames a task of its own lineage, and a task outside it
    // answers in the bytes of a command that does not exist.
    const lineageTask = await task("Started by the selected agent", "full-access");
    await host.store.database
      .updateTable("threads")
      .set({ originConnectionId: selected.id } as never)
      .where("id", "=", lineageTask)
      .execute();
    // The older task tools are the same commands through the same door (rule 2, A3): one of the
    // person's own agents, at Full access, resuming or reconfiguring this connection's task gives
    // that lineage more than it holds; the door puts it to the person and nothing changes.
    const ownAgent = full;
    await host.store.database
      .updateTable("threads")
      .set({ inputQueuePaused: true, inputQueuePausedBy: owner } as never)
      .where("id", "=", lineageTask)
      .execute();
    const lineageState = async () =>
      host.store.database
        .selectFrom("threads")
        .select(["inputQueuePaused", "modelSelection"])
        .where("id", "=", lineageTask)
        .executeTakeFirstOrThrow();
    const before = await lineageState();
    const resumed = await call(ownAgent, "opensteer_task_resume", { taskId: lineageTask });
    expect(resumed.isError, JSON.stringify(resumed.content)).toBe(true);
    expect(JSON.stringify(resumed.content)).toContain("This waits for the person in Opensteer.");
    const configured = await call(ownAgent, "opensteer_task_configure", {
      taskId: lineageTask,
      modelSelection: { modelId: "gpt-5.6-sol", options: { effort: "high" }, providerId: "openai" },
    });
    expect(configured.isError, JSON.stringify(configured.content)).toBe(true);
    expect(JSON.stringify(configured.content)).toContain("This waits for the person in Opensteer.");
    expect(await lineageState()).toEqual(before);
    await host.store.database
      .updateTable("threads")
      .set({ inputQueuePaused: false, inputQueuePausedBy: null } as never)
      .where("id", "=", lineageTask)
      .execute();

    const renameTask = (threadId: ThreadId, title: string) => ({
      command: { type: "thread.rename", threadId, title },
    });
    // Its own lineage's task is within its reach: the rename is the door's one Request (a task
    // rename has no agents' handler yet, so even a `now` waits for the person), and it runs
    // once the person approves.
    const renaming = await call(
      selected.client,
      "opensteer_command",
      renameTask(lineageTask, "Renamed by it"),
    );
    expect(renaming.structuredContent).toMatchObject({ status: "pending" });
    const renameAsk = (await host.store.requests.get(
      (renaming.structuredContent as { requestId: string }).requestId as never,
    ))!;
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.command.approve",
        idempotencyKey: randomUUID(),
        requestId: renameAsk.id,
        expectedRevision: (await host.store.requests.revision(renameAsk.id))!,
      } as never,
      { headers: host.ownerHeaders },
    );
    await waitForValue(async () =>
      (
        await host.store.database
          .selectFrom("threads")
          .select("title")
          .where("id", "=", lineageTask)
          .executeTakeFirstOrThrow()
      ).title === "Renamed by it"
        ? true
        : undefined,
    );
    const theirs = await task("The person's lineageTask task", "full-access");
    const elsewhere = await call(
      selected.client,
      "opensteer_command",
      renameTask(theirs, "Not its to rename"),
    );
    expect(elsewhere.isError).toBe(true);
    expect(JSON.stringify(elsewhere.content)).toBe(JSON.stringify(unknown.content));
    expect(
      (
        await host.store.database
          .selectFrom("threads")
          .select("title")
          .where("id", "=", theirs)
          .executeTakeFirstOrThrow()
      ).title,
    ).toBe("The person's lineageTask task");

    // The operation is about the thing the command governs (AC3): a grant holding profile A
    // has its session admit an operation on A, and never one on B, whose answer reads as
    // something that does not exist (AC2).
    const profile = (name: string) =>
      host.store.createBrowserProfile({
        name,
        ownerId: owner,
        homeRunnerId: machine.runnerId,
        idempotencyKey: randomUUID(),
      });
    const [a, b] = [await profile("Work"), await profile("Private")];
    const holdsA = await connect({
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: a.id }],
    });
    const renameProfile = (profileId: string) => ({
      command: { type: "browser.profile.rename", profileId, name: "Renamed" },
    });
    const onA = await call(holdsA.client, "opensteer_command", renameProfile(a.id));
    expect(onA.isError, JSON.stringify(onA.content)).not.toBe(true);
    const onB = await call(holdsA.client, "opensteer_command", renameProfile(b.id));
    const nothing = await call(holdsA.client, "opensteer_command", {
      command: { type: "no.such.command" },
    });
    expect(onB.isError).toBe(true);
    expect(JSON.stringify(onB.content)).toBe(JSON.stringify(nothing.content));
    // Nor can a selected grant learn through its own Request what lies outside it (rule 5): one
    // that holds Tasks (so it reads its Requests) and profile A proposes a grant naming profile B,
    // and reads that Request back. The person's card names the profile; what the agent reads
    // carries no note at all.
    const profileAsker = await connect(
      {
        scope: "selected",
        tasks: true,
        resources: [{ kind: "browser-profile", profileId: a.id }],
      },
      "Asking agent",
    );
    const widening = await call(profileAsker.client, "opensteer_command", {
      command: {
        type: "connection.update",
        connectionId: profileAsker.id,
        expectedRevision: 1,
        grant: {
          scope: "selected",
          tasks: false,
          resources: [
            { kind: "browser-profile", profileId: a.id },
            { kind: "browser-profile", profileId: b.id },
          ],
        },
      },
    });
    expect(widening.structuredContent, JSON.stringify(widening.content)).toMatchObject({
      status: "pending",
    });
    const widenAsk = (await host.store.requests.get(
      (widening.structuredContent as { requestId: string }).requestId as never,
    ))!;
    expect(widenAsk.command!.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "“Private”" })]),
    );
    const readBack = await call(profileAsker.client, "opensteer_state", { area: "requests" });
    const readText = JSON.stringify(readBack.structuredContent);
    expect(readText).toContain(widenAsk.id);
    expect(readText).not.toContain("Private");
    expect(readText).not.toContain('"notes"');
    // What it reads of its own proposal is what it sent and a status: never the Home's sentence.
    expect(readText).not.toContain("Change a connected agent");
    // C1: once the person takes away what a proposal is about, the agent no longer sees it at all,
    // in its requests or its activity, while the person keeps a faithful record.
    const holdsAWithTasks = await connect(
      {
        scope: "selected",
        tasks: true,
        resources: [{ kind: "browser-profile", profileId: a.id }],
      },
      "Renaming agent",
    );
    const profileRenaming = await call(holdsAWithTasks.client, "opensteer_command", {
      command: { type: "browser.profile.rename", profileId: a.id, name: "Asked name" },
    });
    expect(
      profileRenaming.structuredContent,
      JSON.stringify(profileRenaming.content),
    ).toMatchObject({
      status: "pending",
    });
    const renameRequest = (profileRenaming.structuredContent as { requestId: string }).requestId;
    const visible = async () =>
      JSON.stringify(
        (await call(holdsAWithTasks.client, "opensteer_state", { area: "requests" }))
          .structuredContent,
      ) +
      JSON.stringify(
        (await call(holdsAWithTasks.client, "opensteer_state", { area: "activity" }))
          .structuredContent,
      );
    expect(await visible()).toContain(renameRequest);
    const revision = (
      await host.store.database
        .selectFrom("agentConnections")
        .select("grantRevision")
        .where("id", "=", holdsAWithTasks.id)
        .executeTakeFirstOrThrow()
    ).grantRevision;
    await connections.update(owner, {
      connectionId: holdsAWithTasks.id,
      expectedRevision: revision,
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    expect(await visible()).not.toContain(renameRequest);
    expect(await host.store.requests.get(renameRequest as never)).toMatchObject({
      status: "cancelled",
      cancellationReason: "authority-revoked",
    });
    // M2: nor does withdrawing it tell the agent the ask exists: it reads exactly like an id that
    // never existed (rule 5). And nothing is said to it of the close.
    const neverAsked = `req_${randomUUID()}`;
    const withdrawGone = await call(holdsAWithTasks.client, "opensteer_command", {
      withdraw: renameRequest,
    });
    const withdrawNever = await call(holdsAWithTasks.client, "opensteer_command", {
      withdraw: neverAsked,
    });
    expect(withdrawNever.isError).toBe(true);
    expect(withdrawGone.isError).toBe(true);
    expect(JSON.stringify(withdrawGone.content)).toBe(JSON.stringify(withdrawNever.content));
    expect(
      await host.store.database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "=", renameRequest as never)
        .execute(),
    ).toEqual([]);
    // Q2: an ask whose value only the person types is still the agent's own to read and to
    // withdraw: it proposes it with the value left out, as the tool tells it to.
    const submitter = await connect({ scope: "everything" }, "Signing-in agent");
    const submitAsk = await call(submitter.client, "opensteer_command", {
      command: {
        type: "harness.authentication.submit",
        environmentId: machine.environmentId,
        harnessInstanceId: machine.harnessInstanceId,
      },
    });
    expect(submitAsk.structuredContent, JSON.stringify(submitAsk.content)).toMatchObject({
      status: "pending",
    });
    const submitRequest = (submitAsk.structuredContent as { requestId: string }).requestId;
    expect(
      JSON.stringify(
        (await call(submitter.client, "opensteer_state", { area: "requests" })).structuredContent,
      ),
    ).toContain(submitRequest);
    const submitWithdrawn = await call(submitter.client, "opensteer_command", {
      withdraw: submitRequest,
    });
    expect(
      submitWithdrawn.structuredContent,
      JSON.stringify(submitWithdrawn.content),
    ).toMatchObject({ status: "withdrawn" });
    // M3: an answered ask reads, on every agent surface, as one value-free status, with nothing
    // of who answered or on which of the person's devices: here a Run's Request tools, on the
    // ask the person approved above.
    const readAnswered = await call(full, "opensteer_request_read", { requestId: first.id });
    expect(readAnswered.isError, JSON.stringify(readAnswered.content)).not.toBe(true);
    const answered = (readAnswered.structuredContent as { request: Record<string, unknown> })
      .request;
    expect(answered.status).toBe("approved-done");
    expect(answered).not.toHaveProperty("settlementProvenance");
    const fullList = JSON.stringify(
      (await call(full, "opensteer_request_list", {})).structuredContent,
    );
    expect(fullList).toContain(first.id);
    expect(fullList).not.toMatch(/deviceLabel|settlementProvenance/u);

    // The reads sent as POST write nothing (AD10 2d): every statement the Home issues while the
    // person makes each is a read, apart from what signing a request in does for any call, which
    // a plain GET of the same session shows.
    const readTask = await task("Read only", "full-access");
    const reads: readonly (readonly [string, Record<string, unknown>])[] = [
      ["apps.view", { appId: `app_${randomUUID()}`, theme: "light" }],
      ["asset.urls", { assets: [{ path: "/tmp/opensteer-read-only.png", variant: "preview" }] }],
      ["attention.get", {}],
      ["browser.password-sign-in.get", { requestId: `req_${randomUUID()}` }],
      ["browser.sources.inspect", { url: "https://example.com" }],
      ["channel.connection.check", { connectionId: `con_${randomUUID()}` }],
      [
        "computer.app.windows",
        {
          machineId: machine.runnerId,
          app: { bundleId: "com.apple.notes", displayName: "Notes", teamId: null },
        },
      ],
      ["file.open", { threadId: readTask, source: { kind: "path", path: "/tmp/none.txt" } }],
      ["harness.modelServers.discover", { environmentId: machine.environmentId }],
      ["integration.computer.apps.installed", { runnerId: machine.runnerId }],
      ["integration.computer.setup.review", { setupRequestId: randomUUID() }],
      ["needsYou.get", {}],
      ["references.resolve", { ids: [readTask] }],
      ["thread.browserUsage.get", { threadId: readTask, runIds: [] }],
      ["thread.messages.list", { threadId: readTask }],
    ];
    // Every agent's MCP client is done before the reads are traced: one still listening signs in
    // again on its own (its connection's last use), which is not the read's write.
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    // Each read is sent in process and traced in its own async context, so a statement counts for
    // the request that issued it, or for work that request started, and never for the Home's
    // background work. A Runner heartbeat that renews a Run's lease is made to land inside every
    // read: it is counted for none of them (it once was, by time alone). Each read's statements
    // are taken only at the end, so a write a read leaves running is still that read's.
    const served = (host as unknown as { runtime: { app: FastifyInstance } }).runtime.app;
    const ownStatements = new AsyncLocalStorage<string[]>();
    let leaseRenewals = 0;
    const clientQuery = pg.Client.prototype.query;
    const traced = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { readonly text?: string } | undefined;
      const text = typeof first === "string" ? first : (first?.text ?? "<unknown>");
      if (/^\s*update "provider_sessions" set "lease_expires_at"/u.test(text)) leaseRenewals++;
      ownStatements.getStore()?.push(text);
      return Reflect.apply(clientQuery, this, args) as never;
    });
    expect(machine.primary.activeRunIds.length).toBeGreaterThan(0);
    const heartbeatRenews = async () => {
      const before = leaseRenewals;
      machine.primary.socket.send(
        JSON.stringify({
          ...machine.primary.fence,
          activeRunIds: [...machine.primary.activeRunIds],
          activeTriggerOccurrenceIds: [],
          activeWatchActivationIds: [],
          sentAt: new Date().toISOString(),
          type: "runner.heartbeat",
        }),
      );
      await vi.waitFor(() => expect(leaseRenewals).toBeGreaterThan(before), { timeout: 10_000 });
    };
    const traces: { readonly name: string; readonly statements: string[] }[] = [];
    const tracedRead = async (name: string, send: () => Promise<unknown>) => {
      const statements: string[] = [];
      traces.push({ name, statements });
      const renewed = ownStatements.exit(heartbeatRenews);
      await ownStatements.run(statements, () => send().catch(() => undefined));
      await renewed;
    };
    const writes = (statements: readonly string[]) =>
      statements.filter((statement) =>
        /^\s*(?:insert|update|delete|merge)\b|\bfor (?:no key )?update\b/iu.test(statement),
      );
    try {
      await tracedRead("sign-in", () =>
        injectRpcRequest(served, "channels.get", {}, host.ownerHeaders),
      );
      for (const [name, input] of reads) {
        await tracedRead(name, () =>
          injectRpcRequest(served, name as never, input, host.ownerHeaders),
        );
        expect(doorRoutes.get(`POST /v1/rpc/${name}`), name).toMatchObject({
          kind: "not a Home command",
          why: expect.stringContaining("writes nothing"),
        });
      }
      // The extension's pair challenge (ruling 3): it signs the extension's nonce with this Home's
      // key and returns it. No row is written, with or without a pairing the person started, so
      // nothing it leaves can outlive the pairing.
      await tracedRead("pair/challenge", async () => {
        const challenged = await served.inject({
          method: "POST",
          url: hostInternalRoutePaths.browserSourcePairChallenge,
          headers: {
            host: new URL(host.origin).host,
            "content-type": "application/json",
            origin: `chrome-extension://${"a".repeat(32)}`,
          },
          payload: JSON.stringify({
            origin: new URL(host.origin).origin,
            routeGeneration: null,
            nonce: randomUUID(),
          }),
        });
        expect(challenged.statusCode, challenged.body).toBe(200);
      });
      // Every signed-in read was traced in its own context: its sign-in's statements are its own.
      // The pair challenge signs in nobody and issues none.
      for (const { name, statements } of traces)
        if (name !== "pair/challenge") expect(statements.length, name).toBeGreaterThan(0);
      const [signIn, ...rest] = traces;
      const signedIn = new Set(writes(signIn!.statements));
      const wrote = rest.flatMap(({ name, statements }) =>
        writes(statements)
          .filter((statement) => !signedIn.has(statement))
          .map((statement) => `${name}: ${statement.slice(0, 160)}`),
      );
      expect(wrote).toEqual([]);
    } finally {
      traced.mockRestore();
    }

    // A change to the Home is a command through one door, whoever sends it (AD10): every route
    // that can change something is the door itself, sends its command there, or is listed here
    // with why it is not a Home command. A route added without a word here fails.
    const app = (host as unknown as { runtime: { app: FastifyInstance } }).runtime.app;
    const mutating = [
      ...new Set(
        registeredHostRoutes(app)
          .filter(({ method }) => !["GET", "HEAD", "OPTIONS"].includes(method))
          .map(({ method, url }) => `${method} ${url}`),
      ),
    ].sort();
    console.log(`MUTATING_ROUTES ${JSON.stringify(mutating)}`);
    expect(mutating).toEqual([...doorRoutes.keys()].sort());
  } finally {
    for (const step of close) await step().catch(() => undefined);
    await database.drop?.();
  }
}, 180_000);

/**
 * Every route a Home answers that can change something, and what it is: the door itself or a
 * route that sends its table command there; the executor's step of a command the door admitted,
 * refused without that operation; or not a Home command, and why. Nothing else.
 */
type DoorRoute =
  | { readonly kind: "door" }
  | { readonly kind: "executor"; readonly of: string; readonly why?: string }
  | { readonly kind: "not a Home command"; readonly why: string };
const doorRoutes = new Map<string, DoorRoute>([
  ["POST /v1/rpc/commands.dispatch", { kind: "door" }],
  ["POST /v1/personal-remote-access/account-link/consume", { kind: "door" }],
  ["POST /v1/personal-remote-access/account-link/proof", { kind: "door" }],
  ["POST /v1/personal-remote-access/account-link/resume", { kind: "door" }],
  ["POST /v1/personal-remote-access/account-unlink/remove-link", { kind: "door" }],
  ["POST /v1/personal-remote-access/account-unlink/revoke-sessions", { kind: "door" }],
  ["POST /v1/personal-remote-access/pairing-codes", { kind: "door" }],
  ["PUT /v1/personal-remote-access", { kind: "executor", of: "personal.remoteAccess.request" }],
  [
    "DELETE /v1/personal-remote-access/connect-resource",
    {
      kind: "executor",
      of: "personal.remoteAccess.request",
      why: "takes away only: needs no operation, so the Mac app's startup cleanup is never refused; recorded as remote-access.connect-removed",
    },
  ],
  [
    "PUT /v1/personal-remote-access/connect-projection",
    {
      kind: "executor",
      of: "personal.remoteAccess.request",
      why: "as off it takes away only and needs no operation (recorded as remote-access.connect-off); as on it is refused without its operation",
    },
  ],
  [
    "POST /v1/personal-remote-access/executor/connect-provision",
    { kind: "executor", of: "personal.remoteAccess.request" },
  ],
  [
    "POST /v1/personal-remote-access/executor/connect-rotate",
    { kind: "executor", of: "personal.remoteAccess.request" },
  ],
  ["POST /internal/v1/browser-sources/pair", { kind: "executor", of: "browser.source.pair" }],
  [
    "POST /internal/v1/browser-sources/pair/challenge",
    {
      kind: "not a Home command",
      why: "signs the extension’s challenge with the invitation’s key so it knows this Home; writes nothing",
    },
  ],
  [
    "POST /v1/runner/leave",
    {
      kind: "not a Home command",
      why: "a device’s own sign-out with its own key, as signing out is; it removes only that device and records device.left",
    },
  ],
  [
    "DELETE /v1/apps/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "an app’s own page, served to it: what it changes is the app’s, inside its own server",
    },
  ],
  [
    "DELETE /v1/plugin-pages/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "a plugin’s own page, served to it: what it changes is the plugin’s",
    },
  ],
  [
    "PATCH /v1/apps/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "an app’s own page, served to it: what it changes is the app’s, inside its own server",
    },
  ],
  [
    "PATCH /v1/plugin-pages/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "a plugin’s own page, served to it: what it changes is the plugin’s",
    },
  ],
  [
    "POST /v1/apps/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "an app’s own page, served to it: what it changes is the app’s, inside its own server",
    },
  ],
  [
    "POST /v1/plugin-pages/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "a plugin’s own page, served to it: what it changes is the plugin’s",
    },
  ],
  [
    "PUT /v1/apps/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "an app’s own page, served to it: what it changes is the app’s, inside its own server",
    },
  ],
  [
    "PUT /v1/plugin-pages/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "a plugin’s own page, served to it: what it changes is the plugin’s",
    },
  ],
  [
    "QUERY /v1/apps/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "an app’s own page, served to it: what it changes is the app’s, inside its own server",
    },
  ],
  [
    "QUERY /v1/plugin-pages/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "a plugin’s own page, served to it: what it changes is the plugin’s",
    },
  ],
  [
    "TRACE /v1/apps/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "an app’s own page, served to it: what it changes is the app’s, inside its own server",
    },
  ],
  [
    "TRACE /v1/plugin-pages/:appId/:theme/:token/*",
    {
      kind: "not a Home command",
      why: "a plugin’s own page, served to it: what it changes is the plugin’s",
    },
  ],
  [
    "DELETE /hooks/v1/plugins/:plugin/:subscription",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an installed plugin’s subscription, answered by the plugin",
    },
  ],
  [
    "PATCH /hooks/v1/plugins/:plugin/:subscription",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an installed plugin’s subscription, answered by the plugin",
    },
  ],
  [
    "POST /hooks/v1/plugins/:plugin/:subscription",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an installed plugin’s subscription, answered by the plugin",
    },
  ],
  [
    "PUT /hooks/v1/plugins/:plugin/:subscription",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an installed plugin’s subscription, answered by the plugin",
    },
  ],
  [
    "QUERY /hooks/v1/plugins/:plugin/:subscription",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an installed plugin’s subscription, answered by the plugin",
    },
  ],
  [
    "TRACE /hooks/v1/plugins/:plugin/:subscription",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an installed plugin’s subscription, answered by the plugin",
    },
  ],
  [
    "DELETE /hooks/v1/:routeKey",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an automation’s webhook trigger, which starts work the person set up",
    },
  ],
  [
    "PATCH /hooks/v1/:routeKey",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an automation’s webhook trigger, which starts work the person set up",
    },
  ],
  [
    "POST /hooks/v1/:routeKey",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an automation’s webhook trigger, which starts work the person set up",
    },
  ],
  [
    "PUT /hooks/v1/:routeKey",
    {
      kind: "not a Home command",
      why: "an outside service’s event for an automation’s webhook trigger, which starts work the person set up",
    },
  ],
  [
    "POST /internal/v1/agent-tools/call",
    {
      kind: "not a Home command",
      why: "the agents’ tools: a direct tool goes through AgentSessionService.run(), opensteer_command through the door",
    },
  ],
  [
    "POST /internal/v1/mcp",
    {
      kind: "not a Home command",
      why: "the agents’ MCP endpoint: a direct tool goes through AgentSessionService.run(), opensteer_command through the door",
    },
  ],
  [
    "DELETE /internal/v1/mcp",
    {
      kind: "not a Home command",
      why: "ends an agent’s MCP transport session, not anything of the Home’s",
    },
  ],
  [
    "POST /internal/v1/browser-agent/pages/bind",
    {
      kind: "not a Home command",
      why: "a Runner binding a page it already opened for a Run to that Run’s session",
    },
  ],
  [
    "POST /internal/v1/egress",
    {
      kind: "not a Home command",
      why: "a Run’s outbound network request through the Home’s egress proxy",
    },
  ],
  [
    "POST /maintenance/v1/desktop-update",
    {
      kind: "not a Home command",
      why: "the Mac app’s own update of itself, by its supervisor’s credential",
    },
  ],
  [
    "POST /oauth/mcp/register",
    {
      kind: "not a Home command",
      why: "a connected agent registering as an OAuth client; it holds nothing until the person consents (connection.authorize, a door command)",
    },
  ],
  [
    "POST /oauth/mcp/token",
    {
      kind: "not a Home command",
      why: "a connected agent’s OAuth token exchange for a consent the person gave",
    },
  ],
  [
    "POST /v1/auth/account-adoption/proofs",
    {
      kind: "not a Home command",
      why: "signing in: proof for adopting an Opensteer account sign-in",
    },
  ],
  [
    "POST /v1/auth/account-adoption/proofs/:proofId/consume",
    { kind: "not a Home command", why: "signing in: consuming that proof" },
  ],
  [
    "POST /v1/auth/session-exchange",
    { kind: "not a Home command", why: "signing in: exchanging a credential for a session" },
  ],
  [
    "POST /v1/rpc/auth.native.complete",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.oidc.begin",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.password.recover",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.password.signIn",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.password.signUp",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.setup.claim",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.setup.exchange",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/auth.signOut",
    { kind: "not a Home command", why: "signing in or out: the person’s own session" },
  ],
  [
    "POST /v1/rpc/apps.view",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/asset.urls",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/attention.get",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/browser.password-sign-in.get",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/browser.sources.inspect",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/channel.connection.check",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/computer.app.windows",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/file.open",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/harness.modelServers.discover",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/integration.computer.apps.installed",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/integration.computer.setup.review",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/needsYou.get",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/references.resolve",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/thread.browserUsage.get",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/thread.messages.list",
    { kind: "not a Home command", why: "a read sent as POST: its handler writes nothing" },
  ],
  [
    "POST /v1/rpc/attachment.upload",
    {
      kind: "not a Home command",
      why: "the bytes of an attachment the person is writing; the message that carries it is a command",
    },
  ],
  [
    "POST /v1/rpc/harness.catalog.refresh",
    {
      kind: "not a Home command",
      why: "re-reads what an engine offers from its computer; nothing the person chose changes",
    },
  ],
  [
    "POST /v1/rpc/voice.context",
    {
      kind: "not a Home command",
      why: "the person’s own live voice call on their signed-in session, as the table’s person-view rows",
    },
  ],
  [
    "POST /v1/rpc/voice.open",
    {
      kind: "not a Home command",
      why: "the person’s own live voice call on their signed-in session, as the table’s person-view rows",
    },
  ],
  [
    "POST /v1/rpc/voice.renew",
    {
      kind: "not a Home command",
      why: "the person’s own live voice call on their signed-in session, as the table’s person-view rows",
    },
  ],
  [
    "POST /v1/rpc/voice.say",
    {
      kind: "not a Home command",
      why: "the person’s own live voice call on their signed-in session, as the table’s person-view rows",
    },
  ],
  [
    "POST /v1/rpc/voice.start",
    {
      kind: "not a Home command",
      why: "the person’s own live voice call on their signed-in session, as the table’s person-view rows",
    },
  ],
  [
    "POST /v1/rpc/voice.stop",
    {
      kind: "not a Home command",
      why: "the person’s own live voice call on their signed-in session, as the table’s person-view rows",
    },
  ],
  [
    "PUT /v1/runner/file-transfers/:id",
    { kind: "not a Home command", why: "the bytes of a file a Run moves between computers" },
  ],
]);

it("reports a failed plugin build to the person and the connected agent that asked", async () => {
  const database = await cloneTestDatabase("host");
  const client = new Client({ name: "plugin-install", version: "1" });
  const host = await startPrivateMachineHost(database.url, { logger: false });
  const building = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const message = "The OpenAPI document contains no supported operations.";
  const install = vi.spyOn(host.runtime.plugins, "install").mockImplementation(async () => {
    building.resolve();
    await finish.promise;
    return {
      status: "build-error",
      error: { message: message.replace("operations", "oper\u202eations\u200b") },
    };
  });
  try {
    const url = new URL(mcpResourcePath, host.origin);
    const connections = new AgentConnectionStore(host.store.database);
    const connection = await connections.create({
      userId: host.ownerId,
      label: "Plugin installer",
      clientName: "Plugin installer",
      accessMode: "approval-required",
      resource: url.href,
      expiresAt: new Date(Date.now() + 60_000),
      grant: { scope: "everything" },
    });
    const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
    expect(await connections.activate(connection.id, credentialHash(token))).toBe(true);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }) as unknown as Transport,
    );
    const asked = await client.callTool({
      name: "opensteer_command",
      arguments: {
        command: {
          type: "plugins.install",
          source: { kind: "openapi", name: "Petstore", url: "https://example.test/openapi.json" },
        },
      },
    });
    expect(asked.isError, JSON.stringify(asked.content)).not.toBe(true);
    expect(asked.structuredContent).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
    });
    expect(install).not.toHaveBeenCalled();
    const requestId = RequestIdSchema.parse(
      (asked.structuredContent as { requestId?: unknown } | undefined)?.requestId,
    );
    const input = {
      type: "request.command.approve",
      idempotencyKey: randomUUID(),
      requestId,
      expectedRevision: (await host.store.requests.revision(requestId))!,
    } as const;
    const approve = () =>
      testRpcData(host.origin, "commands.dispatch", input, { headers: host.ownerHeaders });
    const approval = approve();
    void approval.catch(() => undefined);
    try {
      await Promise.race([building.promise, approval]);
      expect(install).toHaveBeenCalledTimes(1);
      expect.soft(await host.store.requests.get(requestId)).toMatchObject({
        status: "fulfilled",
        command: { outcome: { status: "running" } },
        presentation: { detail: expect.stringContaining("it is being done") },
      });
    } finally {
      finish.resolve();
    }
    const outcome = {
      status: "failed",
      message: `The plugin did not build: ${message}`,
      result: { type: "plugins.install", result: { status: "build-error", message } },
    };
    expect(await approval).toMatchObject({ outcome });
    const attempt = await host.store.database
      .selectFrom("commandAttempts")
      .selectAll()
      .where("callerKey", "=", `request:${requestId}`)
      .executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({ state: "failed", outcome });
    expect(await host.store.requests.get(requestId)).toMatchObject({
      status: "fulfilled",
      command: { outcome },
      presentation: {
        title: expect.stringMatching(/^Did not happen/u),
        detail: expect.stringContaining(
          `You approved this, but the plugin did not build: ${message}`,
        ),
      },
    });
    const receiptPreview = async (id: string) =>
      (
        await host.store.database
          .selectFrom("transcriptItems")
          .select("view")
          .where("id", "=", `request:${id}`)
          .where("visible", "=", true)
          .executeTakeFirstOrThrow()
      ).view.preview;
    expect
      .soft(await receiptPreview(requestId))
      .toContain(`You approved this, but the plugin did not build: ${message}`);
    // If writing the Request's receipt was interrupted, the same approval reads what the
    // attempt recorded. It never sends another install.
    await host.store.database
      .updateTable("requests")
      .set({ command: sql`jsonb_set(command, '{outcome}', '{"status":"running"}')` })
      .where("id", "=", requestId)
      .execute();
    expect(await approve()).toMatchObject({ outcome });
    expect(install).toHaveBeenCalledTimes(1);
    const seen = await client.callTool({
      name: "opensteer_state",
      arguments: { area: "requests" },
    });
    expect(seen.isError, JSON.stringify(seen.content)).not.toBe(true);
    expect(seen.structuredContent).toMatchObject({
      view: {
        requests: expect.arrayContaining([
          {
            request: expect.objectContaining({
              id: requestId,
              status: "approved-failed",
              message: outcome.message,
            }),
          },
        ]),
      },
    });
    expect(await host.store.database.selectFrom("plugins").select("id").execute()).toEqual([]);
    const askAgain = async (name: string) => {
      const result = await client.callTool({
        name: "opensteer_command",
        arguments: {
          command: {
            type: "plugins.install",
            source: { kind: "openapi", name, url: `https://example.test/${name}.json` },
          },
        },
      });
      expect(result.structuredContent).toMatchObject({ status: "pending" });
      return RequestIdSchema.parse(
        (result.structuredContent as { requestId?: unknown } | undefined)?.requestId,
      );
    };
    const declinedId = await askAgain("Declined");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.respond",
        idempotencyKey: randomUUID(),
        requestId: declinedId,
        expectedRevision: (await host.store.requests.revision(declinedId))!,
        response: { kind: "form", answers: { decision: ["decline"] } },
      },
      { headers: host.ownerHeaders },
    );
    expect(install).toHaveBeenCalledTimes(1);
    expect
      .soft(await receiptPreview(declinedId))
      .toBe("You declined this. Opensteer did not run it.");
    const warnings = ["GET /orders — This operation cannot be exposed as a tool."];
    install.mockResolvedValueOnce({
      status: "installed",
      plugin: { id: "petstore" },
      version: { id: "v1" },
      warnings,
    } as never);
    const installedId = await askAgain("Installed");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        ...input,
        idempotencyKey: randomUUID(),
        requestId: installedId,
        expectedRevision: (await host.store.requests.revision(installedId))!,
      },
      { headers: host.ownerHeaders },
    );
    const settled = await client.callTool({
      name: "opensteer_state",
      arguments: { area: "requests" },
    });
    expect(settled.structuredContent).toMatchObject({
      view: {
        requests: expect.arrayContaining([
          {
            request: expect.objectContaining({
              id: declinedId,
              status: "declined",
              next: "The person declined. Do not ask again unless something changes.",
            }),
          },
          {
            request: expect.objectContaining({
              id: installedId,
              status: "approved-done",
              warnings,
            }),
          },
        ]),
      },
    });
  } finally {
    finish.resolve();
    install.mockRestore();
    await client.close();
    await host.close();
    await database.drop();
  }
});

it("keeps the plugin engine idle when a connected agent discovers an empty inventory", async () => {
  const database = await cloneTestDatabase("host");
  const clients: Client[] = [];
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>> | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    await vi.waitFor(() => expect(host!.runtime.plugins.state().status).toBe("idle"));
    const idle = host.runtime.plugins.state();
    const url = new URL(mcpResourcePath, host.origin);
    const connections = new AgentConnectionStore(host.store.database);
    const grants: AgentGrant[] = [
      { scope: "everything" },
      {
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "plugin",
            target: { kind: "installed", pluginId: "absent-plugin" },
            access: "read",
          },
        ],
      },
      {
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "plugin",
            target: { kind: "local-server", serverId: `isv_${randomUUID()}` },
            access: "read",
          },
        ],
      },
      { scope: "selected", tasks: true, resources: [] },
    ];
    for (const grant of grants) {
      const record = await connections.create({
        userId: host.ownerId,
        label: "Discovery agent",
        clientName: "Discovery agent",
        accessMode: "full-access",
        resource: url.href,
        expiresAt: new Date(Date.now() + 60_000),
        grant,
      });
      const token = `${connectionCredentialPrefix}${randomBytes(32).toString("base64url")}`;
      expect(await connections.activate(record.id, credentialHash(token))).toBe(true);
      const client = new Client({ name: "empty-plugin-discovery", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }) as unknown as Transport,
      );
      const found = await client.callTool({ name: "discover", arguments: {} });
      expect(found.isError, JSON.stringify(found.content)).not.toBe(true);
      expect(host.runtime.plugins.state()).toEqual(idle);
    }
    expect(
      await testRpcData(host.origin, "plugins.installed.list", {}, { headers: host.ownerHeaders }),
    ).toMatchObject({ plugins: [], engine: { status: "idle" } });
    expect(
      await testRpcData(host.origin, "plugins.accounts.list", {}, { headers: host.ownerHeaders }),
    ).toMatchObject({ accounts: [] });
    expect(host.runtime.plugins.state()).toEqual(idle);

    // Kill only the child this disposable Host launched. SIGKILL alone does
    // not identify the sender, and must not start another child.
    const context = { caller: "personal", mode: "automatic" } as const;
    const engine = await host.runtime.plugins.health({}, context);
    process.kill(engine.pid, "SIGKILL");
    await vi.waitFor(() =>
      expect(host!.runtime.plugins.state()).toMatchObject({
        status: "unavailable",
        generation: idle.generation + 1,
        reason: "The plugin engine was killed.",
      }),
    );
    await host.runtime.plugins.waitForCleanup();
    await expect(host.runtime.plugins.health({}, context)).rejects.toThrow(
      "The plugin engine was killed.",
    );
    for (const [index, client] of clients.entries()) {
      const partial = await client.callTool({ name: "discover", arguments: {} });
      expect(partial.isError, JSON.stringify(partial.content)).not.toBe(true);
      expect(partial.structuredContent).toMatchObject({ items: expect.any(Array) });
      if (index < 2)
        expect(partial.structuredContent).toHaveProperty(
          "next",
          "Installed plugins are currently unavailable.",
        );
      // A selected grant that lists no installed plugins has nothing here: it is told so.
      else
        expect(partial.structuredContent).toHaveProperty(
          "next",
          "Nothing shared with you is here yet. What else you can use is the person's to decide.",
        );
    }
    expect(host.runtime.plugins.state().generation).toBe(idle.generation + 1);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await host?.close();
    await database.drop();
  }
});
