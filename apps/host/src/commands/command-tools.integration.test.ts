import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentGrant, ThreadAccessMode, ThreadId } from "@opensteer/core";
import { AgentConnectionStore } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { expect, it } from "vitest";
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
import { testRpcData } from "../server/test-host-api-request.js";

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
    // An engine account carries the work location its engine commands name.
    const engines = await call(full, "opensteer_state", { area: "engines" });
    expect((engines.structuredContent!.view as { accounts: unknown[] }).accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aiAccountId: machine.harnessInstanceId,
          environmentId: machine.environmentId,
        }),
      ]),
    );
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
 * Every route a Home answers that can change something, and why it is not a Home command the
 * door must see. The door's own routes and the routes that send a table command to it come first.
 */
const doorRoutes = new Map<string, string>([]);
