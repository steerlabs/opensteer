import { DeviceIdSchema } from "@opensteer/core";
import Fastify from "fastify";
import { createChannelId, slackChannelProviderManifest } from "@opensteer/channel-core";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { Readable } from "node:stream";
import { IdentityService } from "@opensteer/identity";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { appOriginKey } from "@opensteer/shared/appFrame";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { AppGateway } from "./app-gateway.js";
import { testHostApiContext } from "../server/test-host-api-context.js";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import {
  appMaxBytes,
  createId,
  OpensteerError,
  type AgentEvent,
  type AppId,
  type ComputerFolder,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  AppStore,
  TabStore,
  ChannelStore,
  withPersonalTransaction,
  type DatabaseSchema,
} from "@opensteer/database";
import {
  RunnerConnectionFenceSchema,
  type AppRuntimeSpec,
  type RunnerAppResult,
  type RunnerConnectionId,
} from "@opensteer/protocol";
import { expect, vi } from "vitest";
import { describeStore } from "@opensteer/database/test-support/store";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { AppService } from "./app-service.js";
import { AppTunnelHub, type AppRunners } from "./app-tunnel-hub.js";

const html = "<title>First</title><body><h1>First</h1>";

type Fixture = {
  readonly userId: UserId;
  readonly environmentId: import("@opensteer/core").EnvironmentId;
  readonly thread: { readonly id: ThreadId };
  readonly run: { readonly id: RunId };
  readonly runnerId: RunnerId;
  readonly runnerBootId: string;
  readonly bindingGeneration: number;
};
function runScope(f: Fixture) {
  return {
    threadId: f.thread.id,
    runId: f.run.id,
    userId: f.userId,
    environmentId: f.environmentId,
  };
}
function toolScope(f: Fixture): RunToolScope {
  return {
    runId: f.run.id,
    threadId: f.thread.id,
    environmentId: f.environmentId,
    requestedBy: f.userId,
    runnerId: f.runnerId,
    runnerBootId: f.runnerBootId,
    bindingGeneration: f.bindingGeneration,
    aud: "opensteer-run-tools",
    iss: "opensteer-host",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: crypto.randomUUID(),
  };
}

function htmlFiles(read: () => Buffer) {
  return {
    list: vi.fn(async () => ({
      parentKey: "",
      cursor: null,
      revision: "revision",
      entries: [
        {
          name: "index.html",
          key: "opaque_html_key",
          kind: "file" as const,
          executable: false,
          hidden: false,
          mode: 0o600,
          sizeBytes: read().length,
          modifiedAt: null,
        },
      ],
    })),
    download: vi.fn(async () => new Response(new Uint8Array(read()))),
  };
}

const offline: AppRunners = {
  appConnection: () => undefined,
  requestApp: async () => {
    throw new Error("No Runner is connected");
  },
  syncApps: async () => {
    throw new Error("No Runner is connected");
  },
};

// The facade still types its database on the pre-0026 schema; the tables are the same rows.
function appDatabase(database: unknown): Kysely<DatabaseSchema> {
  return database as Kysely<DatabaseSchema>;
}

function serviceFor(
  database: unknown,
  agentHome: ComputerFolder,
  overrides: Partial<ConstructorParameters<typeof AppService>[0]> = {},
) {
  const store = new AppStore(appDatabase(database));
  const events: AgentEvent[] = [];
  const changes: AppId[][] = [];
  const removedTabs: AppId[] = [];
  const service = new AppService({
    dataDirectory: tmpdir(),
    apps: store,
    files: htmlFiles(() => Buffer.from(html)),
    agentHome: async () => agentHome,
    tokens: { reauthorize: async (scope) => scope },
    tunnels: new AppTunnelHub(offline),
    tabs: {
      removeTabs: async (_tx, appId) => {
        removedTabs.push(appId);
        return [];
      },
    },
    changed: (_ownerId, appIds) => changes.push(appIds),
    publishEvent: (event) => events.push(event),
    ...overrides,
  });
  return { service, store, events, changes, removedTabs };
}

describeStore("published app HTML", (it) => {
  it("fences app cookies and live responses on session expiry, owner state and personal route rotation", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-origin-session");
    const viewer = f.userId;
    const session = testHostApiContext(viewer).session!;
    const now = new Date();
    const insertSession = () =>
      database
        .insertInto("authSessions")
        .values({
          id: session.id,
          userId: viewer,
          token: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 120_000),
          deviceLabel: "Test",
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
          ipAddress: null,
          userAgent: null,
        })
        .execute();
    await insertSession();
    const { service, store: apps } = serviceFor(database, f.agentHome);
    const published = await apps.commit({
      scope: runScope(f),
      name: "Session app",
      publishKey: "session-app",
      html: { sha256: "a".repeat(64), sizeBytes: 1 },
    });
    const identity = new IdentityService(database, {
      deployment: { kind: "personal", name: null },
      localPasswordEnabled: true,
      signupPolicy: "closed",
      oidcProviders: [],
      publicOrigin: new URL("http://127.0.0.1:1234"),
      secret: "app-session-test-secret".padEnd(40, "x"),
      exposure: "networked",
    });
    expect(await identity.isSessionCurrent(session.id, createId("user"))).toBe(false);
    expect(await identity.isSessionCurrent(session.id, viewer)).toBe(true);
    for (const expired of [
      { createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1) },
      {
        createdAt: new Date(Date.now() - 120_000),
        expiresAt: new Date(Date.now() - 2),
        absoluteExpiresAt: new Date(Date.now() - 1),
      },
    ]) {
      await database
        .updateTable("authSessions")
        .set(expired)
        .where("id", "=", session.id)
        .execute();
      expect(await identity.isSessionCurrent(session.id, viewer)).toBe(false);
      const renewed = new Date();
      await database
        .updateTable("authSessions")
        .set({
          createdAt: renewed,
          expiresAt: new Date(renewed.getTime() + 60_000),
          absoluteExpiresAt: new Date(renewed.getTime() + 120_000),
        })
        .where("id", "=", session.id)
        .execute();
    }
    await database
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", viewer)
      .execute();
    await database
      .updateTable("personalRemoteAccess")
      .set({ mode: "connect", generation: 1, routeOrigin: "https://connect.example.test" })
      .where("singletonKey", "=", "personal")
      .execute();
    await database
      .insertInto("personalRemoteSessions")
      .values({
        authSessionId: session.id,
        delivery: "header",
        routeGeneration: 1,
        routeKind: "connect",
        routeOrigin: "https://connect.example.test",
        createdAt: now,
      })
      .execute();
    expect(await identity.isSessionCurrent(session.id, viewer)).toBe(true);
    for (const change of [
      { generation: 2 },
      { mode: "off" as const, routeOrigin: null },
      { mode: "private" as const },
      { routeOrigin: "https://rotated.example.test" },
    ]) {
      await database
        .updateTable("personalRemoteAccess")
        .set(change)
        .where("singletonKey", "=", "personal")
        .execute();
      expect(await identity.isSessionCurrent(session.id, viewer)).toBe(false);
      await database
        .updateTable("personalRemoteAccess")
        .set({ mode: "connect", generation: 1, routeOrigin: "https://connect.example.test" })
        .where("singletonKey", "=", "personal")
        .execute();
    }
    const app = Fastify();
    const gateway = new AppGateway({
      realOrigins: true,
      identity,
      signingKey: Buffer.alloc(32, 5),
      canonicalOrigin: "http://127.0.0.1:1234",
      apps: {
        get: (user, id) => service.get(user, id),
        onRevoked: () => () => undefined,
        connect: async () => {
          throw new Error("Not a server app");
        },
        response: async (input) => ({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body:
            input.path === "/events"
              ? new Readable({
                  read() {
                    this.push("data: ready\n\n");
                    this._read = () => undefined;
                  },
                })
              : Readable.from(["ok"]),
        }),
      },
    });
    gateway.installHttp(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("No gateway listener");
    const authority = `${appOriginKey(published.appId)}.localhost:1234`;
    const entry = new URL(
      gateway.entryUrl(published.appId, session, "dark", { host: "127.0.0.1:1234" })!,
    );
    const first = await app.inject({
      url: entry.pathname + entry.search,
      headers: { host: authority },
    });
    expect(first.statusCode).toBe(200);
    const cookie = String(first.headers["set-cookie"]).split(";")[0]!;
    try {
      for (const reason of ["session", "owner"] as const) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const req = request({
          host: "127.0.0.1",
          port: address.port,
          path: "/events",
          headers: { host: authority, cookie },
          signal: AbortSignal.timeout(3_000),
        });
        req.on("error", () => undefined);
        const response = once(req, "response", { signal: AbortSignal.timeout(2_000) });
        req.end();
        const [stream] = await response;
        stream.on("error", () => undefined);
        await once(stream, "data", { signal: AbortSignal.timeout(2_000) });
        const closed = new Promise<void>((resolve) => stream.once("close", resolve));
        if (reason === "session")
          await database.deleteFrom("authSessions").where("id", "=", session.id).execute();
        else
          await database
            .updateTable("users")
            .set({ disabledAt: new Date() })
            .where("id", "=", viewer)
            .execute();
        await vi.advanceTimersByTimeAsync(30_000);
        vi.useRealTimers();
        await withTimeout(closed, 2_000, {
          timeoutError: () => new Error(`${reason} revocation did not close the app stream`),
        });
        expect(
          (await app.inject({ url: "/", headers: { host: authority, cookie } })).statusCode,
        ).toBe(403);
        if (reason === "session") await insertSession();
      }
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("publishes HTML versions, replays tool calls, serves latest through reusable capabilities and outlives its origin chat", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("apps");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-apps-test-"));
    let bytes = Buffer.from(html);
    const files = htmlFiles(() => bytes);
    const { service, events, changes } = serviceFor(database, f.agentHome, {
      dataDirectory: directory,
      files,
    });
    const scope = toolScope(f);
    try {
      const first = await service.publish(scope, "publish-1", {
        path: "index.html",
        name: "Budget",
      });
      expect(first).toEqual({ appId: expect.stringMatching(/^app_/u), version: 1 });
      expect(files.download).toHaveBeenCalledWith("opaque_html_key", expect.any(AbortSignal));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "app.published",
        runId: f.run.id,
        threadId: f.thread.id,
        data: { appId: first.appId, version: 1, title: "Budget" },
      });
      expect(changes).toContainEqual([first.appId]);
      expect(
        (await store.threadEventPageForOwner({ ownerId: f.userId, threadId: f.thread.id }))?.events,
      ).toContainEqual(events[0]);
      const view = await service.view(f.userId, first.appId, "dark");
      expect(view.app).toMatchObject({ kind: "html", state: "running", server: null });
      expect(view.app).not.toHaveProperty("localUrl");
      const token = view.path.split("/").at(-2)!;
      expect(await service.content(first.appId, token, "dark")).toContain("First");
      bytes = Buffer.from(html.replace("First", "Latest"));
      const updates = await Promise.all(
        ["publish-2", "publish-3"].map((key) =>
          service.publish(scope, key, { path: "index.html", name: "Budget", appId: first.appId }),
        ),
      );
      expect(updates.map((update) => update.version).sort()).toEqual([2, 3]);
      files.list.mockRejectedValue(new Error("Source file is gone"));
      expect(
        await service.publish(scope, "publish-3", {
          path: "index.html",
          name: "Budget",
          appId: first.appId,
        }),
      ).toEqual(updates[1]);
      expect(events).toHaveLength(3);
      expect(await service.get(f.userId, first.appId)).toMatchObject({ version: 3 });
      expect(await service.content(first.appId, token, "light")).toContain("Latest");
      await expect(service.get(createId("user"), first.appId)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(service.content(first.appId, "x".repeat(43), "light")).rejects.toMatchObject({
        code: "not_found",
      });

      // Another task of the same person may update it.
      const { thread: other } = await store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: "other-task",
        modelSelection: f.thread.modelSelection,
        title: "Other",
      });
      const otherTurn = await storeFixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Update" }],
        idempotencyKey: "other-task-input",
        requestedBy: f.userId,
        threadId: other.id,
      });
      const otherRun = await startPersonalQueuedRunFixture(store, otherTurn.run.id);
      files.list.mockImplementation(htmlFiles(() => bytes).list);
      expect(
        await service.publish(
          {
            ...scope,
            threadId: other.id,
            runId: otherTurn.run.id,
            bindingGeneration: otherRun.bindingGeneration,
            runnerBootId: otherRun.runnerBootId,
          },
          "from-other-task",
          { path: "index.html", name: "Budget", appId: first.appId },
        ),
      ).toEqual({ appId: first.appId, version: 4 });

      // Deleting the origin chat only clears its provenance; the app, versions and bytes stay.
      await database
        .updateTable("causalChains")
        .set({ rootMessageId: otherTurn.run.seedInputId })
        .where("id", "=", f.run.causalChainId)
        .execute();
      await database.deleteFrom("threads").where("id", "=", f.thread.id).execute();
      expect(await service.get(f.userId, first.appId)).toMatchObject({ taskId: null, version: 4 });
      await service.collectGarbage();
      expect(await readdir(join(directory, "apps"))).toHaveLength(2);
      expect(await service.content(first.appId, token, "dark")).toContain("Latest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses foreign and missing IDs, bad paths and files, and offline reads without a publication", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("app-refusals");
    let bytes = Buffer.from(html);
    const files = htmlFiles(() => bytes);
    const { service, events } = serviceFor(database, f.agentHome, { files });
    const scope = toolScope(f);
    const publish = (input = {}) =>
      service.publish(scope, crypto.randomUUID(), { path: "index.html", name: "Test", ...input });
    await expect(publish({ appId: `app_${crypto.randomUUID()}` })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.publish({ ...scope, requestedBy: createId("user") }, "foreign-owner", {
        path: "index.html",
        name: "Foreign",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(publish({ appId: "wrong" })).rejects.toThrow();
    await expect(publish({ path: "../index.html" })).rejects.toMatchObject({ code: "bad_request" });
    files.list.mockResolvedValueOnce({ parentKey: "", cursor: null, revision: "r", entries: [] });
    await expect(publish()).rejects.toMatchObject({ code: "not_found" });
    await expect(publish({ path: "index.txt" })).rejects.toMatchObject({ code: "bad_request" });
    bytes = Buffer.from([0xff]);
    await expect(publish()).rejects.toMatchObject({ message: expect.stringContaining("UTF-8") });
    bytes = Buffer.alloc(appMaxBytes + 1, 65);
    await expect(publish()).rejects.toMatchObject({ message: expect.stringContaining("5 MiB") });
    files.list.mockRejectedValueOnce(
      new OpensteerError({ code: "folder_unavailable", message: "Runner offline" }),
    );
    await expect(publish()).rejects.toMatchObject({ code: "folder_unavailable" });
    await database
      .updateTable("runs")
      .set({ accessMode: "approval-required" })
      .where("id", "=", f.run.id)
      .execute();
    await expect(publish({ path: "server", start: "node server.js" })).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("full-access"),
    });
    expect(events).toEqual([]);
    expect(await database.selectFrom("apps").selectAll().execute()).toEqual([]);
  });

  it("fences app reads, publication, stop and delete by current Run authority inside the personal transaction", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("app-actor-authority");
    const { service, store } = serviceFor(f.database, run.agentHome);
    const scope = toolScope(run),
      actor = { kind: "run", claims: scope } as const;
    const reservation = await store.reserve({
      scope: runScope(run),
      creationKey: "authority",
      name: "App",
      computerId: run.runnerId,
    });
    await store.commit({
      scope: runScope(run),
      appId: reservation.appId,
      name: "App",
      publishKey: "authority",
      server: {
        folder: { ...run.agentHome, path: `${run.agentHome.path}/app` },
        command: "node app.js",
      },
      serverGeneration: reservation.generation,
    });
    for (const accessMode of ["approval-required", "auto-accept-edits"] as const) {
      await f.database
        .updateTable("runs")
        .set({ accessMode })
        .where("id", "=", run.runId)
        .execute();
      for (const call of [
        () => service.stop(actor, reservation.appId),
        () => service.delete(actor, reservation.appId),
        () => service.publish(scope, `html-${accessMode}`, { path: "index.html", name: "Denied" }),
      ])
        await expect(call()).rejects.toMatchObject({ code: "forbidden" });
      expect((await service.list(actor)).map((app) => app.appId)).toEqual([reservation.appId]);
    }
    await f.database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", run.runId)
      .execute();
    await f.database
      .updateTable("runners")
      .set({
        allowedModules: sql`'["agents", "messaging"]'::jsonb`,
        moduleDescriptors: {
          messaging: {
            capabilities: [
              {
                manifest: slackChannelProviderManifest,
                provider: "slack",
                transportKinds: ["socket"],
              },
            ],
          },
        },
      })
      .where("id", "=", run.runnerId)
      .execute();
    const configured = await new ChannelStore(f.database).createConnection({
      createdBy: run.userId,
      accessPolicy: {
        directMessages: { mode: "anyone", allowedExternalUserIds: [] },
        channels: {
          conversationIds: [],
          scope: "all",
          sender: { mode: "anyone", allowedExternalUserIds: [] },
        },
      },
      account: {
        displayName: "Restricted",
        externalAccountId: "restricted-app-context",
        routingMode: "dedicated",
      },
      connection: {
        connectionMethod: "bring-your-own",
        displayName: "Restricted",
        externalIdentityId: "bot",
        externalTenantId: "tenant",
        provider: "slack",
        runnerId: run.runnerId,
        transportKind: "socket",
      },
      credential: {
        encryptedPayload: Buffer.from("fixture"),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: "Restricted",
        ownerId: run.userId,
        provider: "channel:slack",
      },
      executionPolicy: { harness: "specific", harnessInstanceId: run.harnessInstance.id },
      selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
    });
    const conversationId = createChannelId("conversation");
    await f.database
      .insertInto("channelConversations")
      .values({
        id: conversationId,
        accountId: configured.account.id,
        provider: "slack",
        externalAccountId: "restricted-app-context",
        bindingId: configured.binding.id,
        bindingRevision: 1,
        externalScopeId: null,
        externalConversationId: "group",
        externalThreadId: null,
        conversationType: "group",
        displayName: "Group",
        activeThreadId: run.threadId,
        providerState: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    for (const call of [
      () => service.list(actor),
      () => service.stop(actor, reservation.appId),
      () => service.delete(actor, reservation.appId),
      () => service.publish(scope, "restricted-html", { path: "index.html", name: "Denied" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: "not_found" });
    await f.database.deleteFrom("channelConversations").where("id", "=", conversationId).execute();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      service.stop(actor, reservation.appId, { signal: aborted.signal }),
    ).rejects.toThrow();
    await expect(
      service.delete(actor, reservation.appId, {
        checkLive: async () => {
          throw new Error("Call ended");
        },
      }),
    ).rejects.toThrow("Call ended");
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const fence = withPersonalTransaction(f.database, async (tx) => {
      entered.resolve();
      await withTimeout(release.promise, 2000, {
        timeoutError: () => new Error("Personal fence was not released"),
      });
      await tx
        .updateTable("grants")
        .set({ status: "revoked" })
        .where("runId", "=", run.runId)
        .execute();
    });
    await withTimeout(entered.promise, 2000, {
      timeoutError: () => new Error("Personal fence was not acquired"),
    });
    const stopping = service.stop(actor, reservation.appId);
    release.resolve();
    await fence;
    await expect(stopping).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.list(actor)).rejects.toMatchObject({ code: "forbidden" });
    expect(await store.get(run.userId, reservation.appId)).toMatchObject({
      deleting: false,
      server: { desiredState: "running", generation: reservation.generation },
    });
  });
  it("runs a person-owned server on one fixed port through stop, offline intent, reconnect, Host restart, origin deletion and deletion, keeping its folder", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-lifecycle");
    await database
      .updateTable("runs")
      .set({ status: "running", accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const folder = join(f.agentHome.path, "notes");
    await mkdir(folder);
    await writeFile(join(folder, "README.md"), "GET / returns the app ID");
    let service!: AppService;
    const runner = fakeRunner(f.runnerId, () => service);
    const build = () =>
      serviceFor(database, f.agentHome, { tunnels: new AppTunnelHub(runner.runners) });
    let built = build();
    service = built.service;
    const person = { kind: "person", ownerId: f.userId } as const;
    try {
      await runner.connect();
      // A failed first start commits no version or card and leaves no reservation.
      runner.failNextStart("App server exited", "listen EADDRNOTAVAIL\nfailure tail");
      await expect(
        service.publish(toolScope(f), "broken", {
          path: "notes",
          name: "Notes",
          start: "node s.js",
        }),
      ).rejects.toMatchObject({
        reason: "app_start_failed",
        message: expect.stringContaining("failure tail"),
      });
      expect(await database.selectFrom("apps").selectAll().execute()).toEqual([]);
      expect(built.events).toEqual([]);

      const published = await service.publish(toolScope(f), "notes", {
        path: "notes",
        name: "Notes",
        start: "node s.js",
      });
      expect(published).toEqual({ appId: expect.stringMatching(/^app_/u), version: 1 });
      expect(built.events).toHaveLength(1);
      const { appId } = published;
      const running = await service.get(f.userId, appId);
      const port = running.server!.port;
      expect(running).toMatchObject({
        kind: "server",
        state: "running",
        localUrl: `http://127.0.0.1:${port}`,
        folder,
        start: "node s.js",
        computerId: f.runnerId,
        taskId: f.thread.id,
        server: { desiredState: "running", lastError: null },
      });
      expect(await (await fetch(running.localUrl!)).text()).toBe(appId);
      const { path } = await service.view(f.userId, appId, "dark");
      const token = path.split("/").at(-2)!;

      // Offline Stop records intent; reconnecting keeps the server stopped.
      await runner.disconnect();
      expect(await service.get(f.userId, appId)).toMatchObject({ state: "offline" });
      expect(await service.stop(person, appId)).toMatchObject({
        state: "offline",
        server: { desiredState: "stopped" },
      });
      await runner.connect();
      expect(await service.get(f.userId, appId)).toMatchObject({ state: "stopped" });
      expect(runner.serving(appId)).toBe(false);
      // Viewing a stopped server explains itself and never starts it.
      const starts = runner.starts.length;
      const viewed = await service.response({
        appId,
        token,
        theme: "dark",
        method: "GET",
        path: "/",
        prefix: path.slice(0, -1),
        headers: { accept: "text/html" },
        signal: AbortSignal.timeout(2_000),
      });
      expect(viewed.status).toBe(503);
      expect(await text(viewed.body)).toContain("stopped");
      expect(runner.starts).toHaveLength(starts);

      // Start keeps the port, and a Host restart restarts running intent without the Run.
      expect(await service.start(person, appId)).toMatchObject({ state: "running" });
      expect(runner.starts.at(-1)).toMatchObject({ appId, port });
      await runner.disconnect();
      built = build();
      service = built.service;
      await runner.connect();
      expect(await service.get(f.userId, appId)).toMatchObject({
        state: "running",
        server: { port },
      });
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(appId);

      // Deleting the origin chat clears provenance and leaves the server running.
      const { thread: retained } = await store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: "retained-chain-root",
        modelSelection: f.thread.modelSelection,
        title: "Retained",
      });
      const retainedTurn = await storeFixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Retained" }],
        idempotencyKey: "retained-chain-input",
        requestedBy: f.userId,
        threadId: retained.id,
      });
      await database
        .updateTable("causalChains")
        .set({ rootMessageId: retainedTurn.run.seedInputId })
        .where("id", "=", f.run.causalChainId)
        .execute();
      await database.deleteFrom("threads").where("id", "=", f.thread.id).execute();
      expect(await service.get(f.userId, appId)).toMatchObject({ taskId: null, state: "running" });

      // Delete stops the server, removes tabs and records, revokes viewing, keeps the folder.
      const view = await service.view(f.userId, appId, "light");
      const viewToken = view.path.split("/").at(-2)!;
      await service.delete(person, appId);
      expect(runner.serving(appId)).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
      expect(built.removedTabs).toEqual([appId]);
      await expect(service.get(f.userId, appId)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.authorizeView(appId, viewToken)).rejects.toMatchObject({
        code: "not_found",
      });
      expect(
        await appDatabase(database)
          .selectFrom("appServers")
          .selectAll()
          .where("appId", "=", appId)
          .execute(),
      ).toEqual([]);
      expect((await stat(join(folder, "README.md"))).isFile()).toBe(true);
      // The deleted app is absent from the complete set, so a reconnect cannot restart it.
      await runner.disconnect();
      await runner.connect();
      expect(runner.serving(appId)).toBe(false);
    } finally {
      await runner.disconnect();
    }
  });
});

describeStore("app lifecycle admission", (it) => {
  async function setup(fixture: Parameters<typeof serviceFor>[0], home: ComputerFolder) {
    const controller = new AbortController();
    const connection = {
      connectionId: `rcn_${crypto.randomUUID()}` as RunnerConnectionId,
      signal: controller.signal,
    };
    const tunnels = {
      connection: () => connection,
      start: vi.fn(async () => 51_000),
      stop: vi.fn(async () => undefined),
      sync: vi.fn(async () => ({ ok: true })),
      close: vi.fn(),
      connect: vi.fn(),
      accept: vi.fn(),
    };
    const built = serviceFor(fixture, home, {
      tunnels: tunnels as unknown as ConstructorParameters<typeof AppService>[0]["tunnels"],
    });
    return { ...built, tunnels, controller, connection };
  }

  for (const operation of ["start", "publish"] as const)
    for (const reason of ["revoked", "cancelled", "failed-sync"] as const)
      it(`refuses a ${reason} ${operation} held behind reconciliation without persisting running intent`, async ({
        storeFixture,
      }) => {
        const { database } = storeFixture;
        const f = await storeFixture.startRunFixture("app-pending-admission");
        await database
          .updateTable("runs")
          .set({ accessMode: "full-access" })
          .where("id", "=", f.run.id)
          .execute();
        const b = await setup(database, f.agentHome);
        const reserved = await b.store.reserve({
          scope: runScope(f),
          creationKey: "old",
          name: "Old",
          computerId: f.runnerId,
        });
        await b.store.commit({
          scope: runScope(f),
          appId: reserved.appId,
          name: "Old",
          publishKey: "old",
          server: { folder: f.agentHome, command: "old" },
          serverGeneration: reserved.generation,
        });
        await b.store.setDesiredState(f.userId, reserved.appId, "stopped");
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<{ ok: boolean }>();
        b.tunnels.sync.mockImplementationOnce(async () => {
          entered.resolve();
          return withTimeout(release.promise, 2_000, {
            timeoutError: () => new Error("Sync was not released"),
          });
        });
        const connecting = b.service.onRunnerConnected(f.runnerId);
        await withTimeout(entered.promise, 2_000, {
          timeoutError: () => new Error("Sync never started"),
        });
        const authorized = Promise.withResolvers<void>();
        const authorizeRun = b.store.authorizeRun.bind(b.store);
        vi.spyOn(b.store, "authorizeRun").mockImplementation(async (...args) => {
          const result = await authorizeRun(...args);
          authorized.resolve();
          return result;
        });
        const lifetime = new AbortController();
        const starting =
          operation === "start"
            ? b.service.start({ kind: "run", claims: toolScope(f) }, reserved.appId, {
                signal: lifetime.signal,
              })
            : b.service.publish(
                toolScope(f),
                "pending",
                { appId: reserved.appId, name: "Pending", path: "pending", start: "pending" },
                { signal: lifetime.signal },
              );
        const refused =
          reason === "failed-sync"
            ? expect(starting).rejects.toMatchObject({
                reason: "outcome_unknown",
                message: expect.stringContaining("reconcile"),
              })
            : expect(starting).rejects.toThrow();
        await withTimeout(authorized.promise, 2_000, {
          timeoutError: () => new Error("The caller never passed initial app admission"),
        });
        if (reason === "revoked")
          await database
            .updateTable("runs")
            .set({ accessMode: "approval-required" })
            .where("id", "=", f.run.id)
            .execute();
        if (reason === "cancelled") lifetime.abort(new Error("Caller cancelled"));
        release.resolve({ ok: reason !== "failed-sync" });
        await connecting;
        await refused;
        expect(b.tunnels.start).not.toHaveBeenCalled();
        expect((await b.store.get(f.userId, reserved.appId)).server?.desiredState).toBe("stopped");
      });

  it("rechecks live caller authority after resolving the launch spec and withdraws a refused start's intent", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-final-admission");
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const b = await setup(database, f.agentHome);
    const reserved = await b.store.reserve({
      scope: runScope(f),
      creationKey: "old",
      name: "Old",
      computerId: f.runnerId,
    });
    await b.store.commit({
      scope: runScope(f),
      appId: reserved.appId,
      name: "Old",
      publishKey: "old",
      server: { folder: f.agentHome, command: "old" },
      serverGeneration: reserved.generation,
    });
    await b.store.setDesiredState(f.userId, reserved.appId, "stopped");
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let admitted = true;
    let holdSpec = false;
    const service = serviceFor(database, f.agentHome, {
      tunnels: b.tunnels as unknown as ConstructorParameters<typeof AppService>[0]["tunnels"],
      agentHome: async () => {
        if (!holdSpec) return f.agentHome;
        held.resolve();
        await withTimeout(release.promise, 2_000, {
          timeoutError: () => new Error("Agent home resolution was not released"),
        });
        return f.agentHome;
      },
    }).service;
    await service.onRunnerConnected(f.runnerId);
    holdSpec = true;
    const starting = service.start({ kind: "run", claims: toolScope(f) }, reserved.appId, {
      checkLive: async () => {
        if (!admitted) throw new Error("Caller no longer admitted");
      },
    });
    const rejected = expect(starting).rejects.toThrow("Caller no longer admitted");
    await withTimeout(held.promise, 2_000, {
      timeoutError: () => new Error("Start never resolved its launch spec"),
    });
    admitted = false;
    release.resolve();
    await rejected;
    expect(b.tunnels.start).not.toHaveBeenCalled();
    expect((await b.store.get(f.userId, reserved.appId)).server?.desiredState).toBe("stopped");
  });

  it("enforces the stored-app limit before allocating a new publication and keeps all existing server records in reconciliation", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-storage-limit");
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const { store: apps } = serviceFor(database, f.agentHome);
    const ids = Array.from({ length: 500 }, () => `app_${crypto.randomUUID()}` as AppId).sort();
    const server = { folder: f.agentHome, command: "node app.js" };
    await database
      .insertInto("apps")
      .values(
        ids.map((id) => ({
          id,
          computerId: f.runnerId,
          ownerId: f.userId,
          name: "Stored",
          creationKey: id,
          latestVersion: 1,
        })),
      )
      .execute();
    await database
      .insertInto("appServers")
      .values(
        ids.map((appId, index) => ({
          appId,
          computerId: f.runnerId,
          port: 49_152 + index,
          desiredState: index === 499 ? ("running" as const) : ("stopped" as const),
        })),
      )
      .execute();
    await database
      .insertInto("appVersions")
      .values(
        ids.map((appId) => ({
          appId,
          version: 1,
          server,
          publishKey: appId,
          createdByRun: f.run.id,
        })),
      )
      .execute();
    expect(await apps.runtimeSet(f.runnerId)).toHaveLength(500);
    expect((await apps.runtimeSet(f.runnerId)).at(-1)).toMatchObject({
      id: ids[499],
      server: { desiredState: "running" },
    });
    await expect(
      apps.reserve({
        scope: runScope(f),
        name: "Overflow server",
        computerId: f.runnerId,
        creationKey: "overflow",
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    await expect(
      apps.commit({
        scope: runScope(f),
        name: "Overflow HTML",
        publishKey: "overflow-html",
        html: { sha256: "a".repeat(64), sizeBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(
      await apps.commit({
        scope: runScope(f),
        appId: ids[0]!,
        name: "Existing",
        publishKey: "update-at-limit",
        html: { sha256: "a".repeat(64), sizeBytes: 1 },
      }),
    ).toMatchObject({ appId: ids[0], version: 2 });
  });

  for (const rejection of ["authority", "cancelled", "newer-stop"] as const)
    it(`stops a replacement rejected by ${rejection} at its exact generation and retains the previous publication stopped`, async ({
      storeFixture,
    }) => {
      const f = await storeFixture.startRunFixture("app-rejected-replacement");
      const { database } = storeFixture;
      await database
        .updateTable("runs")
        .set({ accessMode: "full-access" })
        .where("id", "=", f.run.id)
        .execute();
      const b = await setup(database, f.agentHome);
      await b.service.onRunnerConnected(f.runnerId);
      const published = await b.service.publish(toolScope(f), "old", {
        name: "Old",
        path: "old",
        start: "old",
      });
      const lifetime = new AbortController();
      b.tunnels.start.mockImplementationOnce(async () => {
        if (rejection === "cancelled")
          lifetime.abort(new Error("Caller cancelled after readiness"));
        else if (rejection === "newer-stop")
          await b.service.stop({ kind: "person", ownerId: f.userId }, published.appId);
        else
          await database
            .updateTable("runs")
            .set({ accessMode: "approval-required" })
            .where("id", "=", f.run.id)
            .execute();
        return 51_000;
      });
      await expect(
        b.service.publish(
          toolScope(f),
          "new",
          { appId: published.appId, name: "New", path: "new", start: "new" },
          { signal: lifetime.signal },
        ),
      ).rejects.toThrow();
      expect(b.tunnels.stop).toHaveBeenCalledWith(f.runnerId, b.connection, published.appId, 2);
      expect(await b.store.get(f.userId, published.appId)).toMatchObject({
        name: "Old",
        version: { version: 1, server: { command: "old" } },
        server: { desiredState: "stopped", generation: 3 },
      });
      expect(await b.service.get(f.userId, published.appId)).toMatchObject({ state: "stopped" });
    });

  for (const failure of ["before-delete", "during-stop", "abandoned-publication"] as const)
    it(`retains an unconfirmed ${failure} tombstone and port until complete-set sync acknowledges termination`, async ({
      storeFixture,
    }) => {
      const { database } = storeFixture;
      const f = await storeFixture.startRunFixture("app-unknown-deletion");
      await database
        .updateTable("runs")
        .set({ accessMode: "full-access" })
        .where("id", "=", f.run.id)
        .execute();
      const b = await setup(database, f.agentHome);
      const tabs = new TabStore(database);
      const appTabs = {
        removeTabs: (tx: Parameters<TabStore["removeTabs"]>[0], id: AppId) =>
          tabs.removeTabs(tx, id),
      };
      const service = serviceFor(database, f.agentHome, {
        tunnels: b.tunnels as unknown as ConstructorParameters<typeof AppService>[0]["tunnels"],
        tabs: appTabs,
      }).service;
      await service.onRunnerConnected(f.runnerId);
      let appId: AppId;
      if (failure === "abandoned-publication") {
        b.tunnels.start.mockImplementationOnce(async () => {
          b.controller.abort();
          throw new Error("Disconnected");
        });
        await expect(
          service.publish(toolScope(f), "abandoned", {
            name: "Pending",
            path: "pending",
            start: "pending",
          }),
        ).rejects.toThrow();
        appId = (await database.selectFrom("apps").select("id").executeTakeFirstOrThrow()).id;
      } else {
        appId = (
          await service.publish(toolScope(f), "published", {
            name: "App",
            path: "app",
            start: "app",
          })
        ).appId;
        await tabs.open(
          {
            id: createId("tab"),
            ownerId: f.userId,
            kind: "app",
            computerId: DeviceIdSchema.parse(f.runnerId),
            appId,
            title: "App",
            openedBy: "person",
          },
          "app-tab",
        );
        await tabs.open(
          {
            id: createId("tab"),
            ownerId: f.userId,
            kind: "phone",
            computerId: DeviceIdSchema.parse(f.runnerId),
            title: "Phone",
            openedBy: "person",
          },
          "phone-tab",
        );
        if (failure === "before-delete")
          await service.onRunnerDisconnected(f.runnerId, b.connection.connectionId);
        else
          b.tunnels.stop.mockImplementationOnce(async () => {
            b.controller.abort();
            throw new Error("Disconnected");
          });
        await expect(
          service.delete({ kind: "person", ownerId: f.userId }, appId),
        ).rejects.toMatchObject({ reason: "outcome_unknown" });
        expect((await tabs.snapshot(f.userId)).rows.map((tab) => tab.kind)).toEqual(["phone"]);
      }
      expect(await b.store.record(appId)).toMatchObject({
        deleting: true,
        server: { port: expect.any(Number), desiredState: "stopped" },
      });
      expect(
        await database.selectFrom("personalTabs").selectAll().where("appId", "=", appId).execute(),
      ).toEqual([]);
      const fresh = await setup(database, f.agentHome);
      fresh.tunnels.sync.mockResolvedValueOnce({ ok: false });
      await fresh.service.onRunnerConnected(f.runnerId);
      expect(await b.store.record(appId)).toMatchObject({ deleting: true });
      await fresh.service.onRunnerConnected(f.runnerId);
      expect(fresh.tunnels.sync).toHaveBeenCalledWith(f.runnerId, fresh.connection, []);
      expect(await b.store.record(appId)).toBeUndefined();
    });
  it("keeps an abandoned reservation's fixed port through garbage collection until reconciliation proves termination", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-abandoned-reservation");
    await database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.id)
      .execute();
    const b = await setup(database, f.agentHome);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-abandoned-app-"));
    const service = serviceFor(database, f.agentHome, {
      dataDirectory: directory,
      tunnels: b.tunnels as unknown as ConstructorParameters<typeof AppService>[0]["tunnels"],
    }).service;
    try {
      const reservation = await b.store.reserve({
        scope: runScope(f),
        creationKey: "abandoned",
        name: "Abandoned",
        computerId: f.runnerId,
      });
      await database
        .updateTable("runs")
        .set({ status: "completed", completedAt: new Date() })
        .where("id", "=", f.run.id)
        .execute();
      await service.collectGarbage();
      await service.collectGarbage();
      expect(await b.store.record(reservation.appId)).toMatchObject({
        deleting: true,
        version: null,
        server: { port: reservation.port, desiredState: "stopped" },
      });
      await service.onRunnerConnected(f.runnerId);
      expect(b.tunnels.sync).toHaveBeenCalledWith(f.runnerId, b.connection, []);
      expect(await b.store.record(reservation.appId)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function text(body: Readable): Promise<string> {
  let result = "";
  for await (const chunk of body) result += String(chunk);
  return result;
}

/**
 * A controlled Runner: each started app is an in-process HTTP server on its fixed port.
 * Process-tree containment is proven by the Runner's own manager tests.
 */
function fakeRunner(computerId: RunnerId, service: () => AppService) {
  const base = RunnerConnectionFenceSchema.parse({
    runnerId: computerId,
    bootId: `rbt_${crypto.randomUUID()}`,
    connectionGeneration: 1,
    connectionId: `rcn_${crypto.randomUUID()}`,
    connectionLeaseId: `rls_${crypto.randomUUID()}`,
  });
  const fence = { ...base, environmentId: createId("environment"), bindingGeneration: 1 };
  let current: { connectionId: RunnerConnectionId; controller: AbortController } | undefined;
  const servers = new Map<string, { server: Server; generation: number }>();
  const stopped = new Map<string, number>();
  const starts: AppRuntimeSpec[] = [];
  let failure: { error: string; logTail: string } | undefined;
  const result = (
    appId: string,
    generation: number,
    outcome: Pick<RunnerAppResult, "ok" | "port" | "error" | "logTail">,
  ): RunnerAppResult => ({
    type: "runner.app.result",
    requestId: crypto.randomUUID(),
    fence,
    appId,
    generation,
    ...outcome,
  });
  const report = async (
    appId: string,
    generation: number,
    state: "running" | "stopped" | "failed",
  ) => {
    if (current)
      await service().onAppState(computerId, current.connectionId, { appId, generation, state });
  };
  const close = async (appId: string, generation: number) => {
    stopped.set(appId, Math.max(stopped.get(appId) ?? 0, generation));
    const entry = servers.get(appId);
    if (!entry) return;
    servers.delete(appId);
    await closeHttpServerNow(entry.server);
    await report(appId, generation, "stopped");
  };
  const start = async (spec: AppRuntimeSpec): Promise<RunnerAppResult> => {
    if (spec.generation <= (stopped.get(spec.appId) ?? 0))
      return result(spec.appId, spec.generation, { ok: false, error: "Stale start" });
    if (failure) {
      const { error, logTail } = failure;
      failure = undefined;
      await report(spec.appId, spec.generation, "failed");
      return result(spec.appId, spec.generation, { ok: false, error, logTail });
    }
    const running = servers.get(spec.appId);
    if (running) running.generation = spec.generation;
    else {
      starts.push(spec);
      const server = createServer((_request, response) => response.end(spec.appId));
      server.listen(spec.port, "127.0.0.1");
      await once(server, "listening", { signal: AbortSignal.timeout(2_000) });
      servers.set(spec.appId, { server, generation: spec.generation });
    }
    await report(spec.appId, spec.generation, "running");
    return result(spec.appId, spec.generation, { ok: true, port: spec.port });
  };
  const runners: AppRunners = {
    appConnection: (id) =>
      id === computerId && current
        ? { connectionId: current.connectionId, signal: current.controller.signal }
        : undefined,
    requestApp: async (_computer, connectionId, request) => {
      if (current?.connectionId !== connectionId) throw new Error("App connection was replaced");
      if (request.type === "host.app.start") return start(request.spec);
      if (request.type === "host.app.stop") {
        await close(request.appId, request.generation);
        return result(request.appId, request.generation, { ok: true });
      }
      throw new Error(`Unexpected ${request.type}`);
    },
    syncApps: async (_computer, connectionId, request) => {
      if (current?.connectionId !== connectionId) throw new Error("App connection was replaced");
      const wanted = new Map(request.apps.map((app) => [app.spec.appId, app]));
      for (const [appId, entry] of servers)
        if (wanted.get(appId)?.desiredState !== "running") await close(appId, entry.generation);
      for (const app of request.apps) if (app.desiredState === "running") await start(app.spec);
      return { type: "runner.apps.sync.result", requestId: request.requestId, fence, ok: true };
    },
  };
  return {
    runners,
    starts,
    serving: (appId: string) => servers.has(appId),
    failNextStart: (error: string, logTail: string) => {
      failure = { error, logTail };
    },
    async connect() {
      current = {
        connectionId: `rcn_${crypto.randomUUID()}` as RunnerConnectionId,
        controller: new AbortController(),
      };
      await service().onRunnerConnected(computerId);
    },
    async disconnect() {
      const ended = current;
      if (!ended) return;
      current = undefined;
      ended.controller.abort();
      // The Runner's own connection-loss cleanup stops everything and forgets its fences.
      stopped.clear();
      for (const [appId, entry] of servers) {
        servers.delete(appId);
        await closeHttpServerNow(entry.server);
      }
      await service().onRunnerDisconnected(computerId, ended.connectionId);
    },
  };
}
