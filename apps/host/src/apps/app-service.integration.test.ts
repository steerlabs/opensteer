import Fastify from "fastify";
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
import type { Kysely } from "kysely";
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
import { AppStore, type DatabaseSchema } from "@opensteer/database";
import {
  RunnerConnectionFenceSchema,
  type AppRuntimeSpec,
  type RunnerAppResult,
  type RunnerConnectionId,
} from "@opensteer/protocol";
import { expect, vi } from "vitest";
import { describeStore } from "@opensteer/database/test-support/store";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import { AppService } from "./app-service.js";
import { AppTunnelHub, type AppRunners } from "./app-tunnel-hub.js";

const html = "<title>First</title><body><h1>First</h1>";

type Fixture = {
  readonly userId: UserId;
  readonly environmentId: import("@opensteer/core").EnvironmentId;
  readonly thread: { readonly id: ThreadId };
  readonly run: { readonly id: RunId };
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
  } as unknown as RunToolScope;
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
      await database
        .updateTable("runs")
        .set({ status: "running" })
        .where("id", "=", otherTurn.run.id)
        .execute();
      files.list.mockImplementation(htmlFiles(() => bytes).list);
      expect(
        await service.publish(
          { ...scope, threadId: other.id, runId: otherTurn.run.id } as RunToolScope,
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
    ).rejects.toMatchObject({ code: "not_found" });
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
