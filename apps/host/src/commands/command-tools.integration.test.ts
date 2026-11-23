import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import pg from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentGrant, ThreadAccessMode, ThreadId } from "@opensteer/core";
import { AgentConnectionStore, admitCommand } from "@opensteer/database";
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
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";

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
    const mcp = async (url: URL, bearer: string) => {
      const client = new Client({ name: "command-tools", version: "1" });
      close.unshift(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${bearer}` } },
        }) as unknown as Transport,
      );
      return client;
    };
    const runFor = async (mode: ThreadAccessMode, key: string) => {
      const run = await dispatchCallerRun(host, machine, {
        key,
        title: key,
        threadId: await task(key, mode),
      });
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
    const admission: string[] = [];
    const query = pg.Client.prototype.query;
    const counting = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { readonly text?: string } | undefined;
      admission.push(typeof first === "string" ? first : (first?.text ?? "<unknown>"));
      return Reflect.apply(query, this, args) as never;
    });
    try {
      await admitCommand(host.store.database, {
        ownerUserId: owner,
        subject: { kind: "binding", bindingId: `run:${counted.runId}` },
        command: rename("Counted").command as never,
      });
    } finally {
      counting.mockRestore();
    }
    // Its slot is the computer's: the Runs below need it.
    await counted.complete();
    expect(
      admission.filter((statement) => /from "runs" inner join "threads"/u.test(statement)),
      admission.join("\n"),
    ).toHaveLength(1);
    // begin, the Run's row, the owner, the Home's settings, commit: the Run read once, not twice.
    expect(admission, admission.join("\n")).toHaveLength(5);

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
      "policy",
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
    const appHolder = await connect({
      scope: "selected",
      tasks: false,
      resources: [
        {
          kind: "computer-app",
          approvalId: `con_${randomUUID()}`,
          deviceId: everyDevice[0]!,
          app: { kind: "mac-app", bundleId: "com.apple.Notes", teamId: null },
        },
      ],
    } as unknown as AgentGrant);
    expect(await devicesSeen(appHolder.client)).toEqual([everyDevice[0]]);
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
        command: (first.command as { command: Record<string, unknown> }).command,
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
        command: renameAsk.command!.command,
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
    const statements: string[] = [];
    let tracing = false;
    const clientQuery = pg.Client.prototype.query;
    const traced = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { readonly text?: string } | undefined;
      if (tracing)
        statements.push(typeof first === "string" ? first : (first?.text ?? "<unknown>"));
      return Reflect.apply(clientQuery, this, args) as never;
    });
    const writesDuring = async (send: () => Promise<unknown>) => {
      statements.length = 0;
      tracing = true;
      try {
        await send().catch(() => undefined);
      } finally {
        tracing = false;
      }
      return statements.filter((statement) =>
        /^\s*(?:insert|update|delete|merge)\b|\bfor (?:no key )?update\b/iu.test(statement),
      );
    };
    try {
      const signIn = new Set(
        await writesDuring(() =>
          testRpcRequest(host.origin, "channels.get", {} as never, { headers: host.ownerHeaders }),
        ),
      );
      const wrote: string[] = [];
      for (const [name, input] of reads) {
        for (const statement of await writesDuring(() =>
          testRpcRequest(host.origin, name as never, input as never, {
            headers: host.ownerHeaders,
          }),
        ))
          if (!signIn.has(statement)) wrote.push(`${name}: ${statement.slice(0, 160)}`);
        expect(doorRoutes.get(`POST /v1/rpc/${name}`), name).toMatchObject({
          kind: "not a Home command",
          why: expect.stringContaining("writes nothing"),
        });
      }
      // The extension's pair challenge (ruling 3): it signs the extension's nonce with this Home's
      // key and returns it. No row is written, with or without a pairing the person started, so
      // nothing it leaves can outlive the pairing.
      for (const statement of await writesDuring(() =>
        fetch(new URL(hostInternalRoutePaths.browserSourcePairChallenge, host.origin), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: `chrome-extension://${"a".repeat(32)}`,
          },
          body: JSON.stringify({
            origin: new URL(host.origin).origin,
            routeGeneration: null,
            nonce: randomUUID(),
          }),
        }),
      ))
        if (!signIn.has(statement)) wrote.push(`pair/challenge: ${statement.slice(0, 160)}`);
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
    "POST /hooks/v1/:routeKey",
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
    "POST /v1/runner/enrollment/preview",
    { kind: "not a Home command", why: "a read: what an enrollment would be" },
  ],
  [
    "PUT /v1/runner/file-transfers/:id",
    { kind: "not a Home command", why: "the bytes of a file a Run moves between computers" },
  ],
]);
