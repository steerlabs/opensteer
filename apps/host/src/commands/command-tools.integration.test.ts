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
    const connect = async (grant: AgentGrant) => {
      const record = await connections.create({
        userId: owner,
        label: "Commands agent",
        clientName: "Commands agent",
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
  } finally {
    for (const step of close) await step().catch(() => undefined);
    await database.drop?.();
  }
}, 180_000);
