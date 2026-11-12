import Fastify from "fastify";
import { once } from "node:events";
import { request } from "node:http";
import { Readable } from "node:stream";
import { IdentityService } from "@opensteer/identity";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { appOriginKey } from "@opensteer/shared/appFrame";
import { AppGateway } from "./app-gateway.js";
import { testHostApiContext } from "../server/test-host-api-context.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  appMaxBytes,
  OpensteerError,
  type AgentEvent,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { AppStore } from "@opensteer/database";
import { expect, vi } from "vitest";
import { describeStore } from "@opensteer/database/test-support/store";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import {
  startPrivateMachineHost,
  connectCallerMachine,
  dispatchCallerRun,
  openRealtime,
} from "../integrations/personal-machine.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { AppService } from "./app-service.js";

const html = "<title>First</title><body><h1>First</h1>";
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
    const apps = new AppStore(database);
    const published = await apps.publish({
      threadId: f.thread.id,
      runId: f.run.id,
      environmentId: f.environmentId,
      userId: f.userId,
      title: "Session app",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      publishKey: "session-app",
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
        get: (id, user) => apps.get(id, user),
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

  it("joins personal app tabs, bootstrap and realtime across owner devices", async ({
    storeFixture,
  }) => {
    const host = await startPrivateMachineHost(storeFixture.databaseUrl);
    const sockets: Awaited<ReturnType<typeof openRealtime>>[] = [];
    let caller: Awaited<ReturnType<typeof connectCallerMachine>> | undefined;
    try {
      caller = await connectCallerMachine(host, {
        name: "App publisher",
        token: host.hostingRunnerEnrollmentToken,
      });
      const run = await dispatchCallerRun(host, caller, { key: "tab-wire", title: "App tabs" });
      const apps = new AppStore(storeFixture.database);
      const published = await apps.publish({
        threadId: run.threadId,
        runId: run.runId,
        environmentId: caller.environmentId,
        userId: host.ownerId,
        title: "Wire app",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        publishKey: "wire",
      });
      const active = await openRealtime(host, { ...host.ownerHeaders });
      sockets.push(active);
      const second = await openRealtime(host, { ...host.ownerHeaders });
      sockets.push(second);
      const dispatch = (type: "app.tab.open" | "app.tab.close") =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          { type, appId: published.appId, idempotencyKey: crypto.randomUUID() },
          { headers: host.ownerHeaders },
        );
      expect(await dispatch("app.tab.open")).toMatchObject({
        type: "app.tab.open",
        appTabs: [{ appId: published.appId, latestVersion: 1 }],
      });
      await vi.waitFor(() => {
        expect(active.messages.filter((m) => m.type === "host.app-tabs-changed")).toHaveLength(1);
        expect(second.messages.filter((m) => m.type === "host.app-tabs-changed")).toHaveLength(1);
      });
      expect(
        (await testRpcData(host.origin, "bootstrap.get", {}, { headers: host.ownerHeaders }))
          .appTabs,
      ).toMatchObject([{ appId: published.appId, title: "Wire app", latestVersion: 1 }]);
      expect(await dispatch("app.tab.close")).toMatchObject({ type: "app.tab.close", appTabs: [] });
      await vi.waitFor(() =>
        expect(active.messages.filter((m) => m.type === "host.app-tabs-changed")).toHaveLength(2),
      );
      expect(
        (await testRpcData(host.origin, "bootstrap.get", {}, { headers: host.ownerHeaders }))
          .appTabs,
      ).toEqual([]);
    } finally {
      for (const socket of sockets) await socket.close();
      await caller?.close();
      await host.close();
    }
  });

  it("keeps personal app tabs idempotent, bounded and owner-authorized", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("app tabs");
    const apps = new AppStore(database);
    const ids = Array.from({ length: 51 }, () => `app_${crypto.randomUUID()}`);
    await database
      .insertInto("apps")
      .values(
        ids.map((id) => ({
          id,

          threadId: f.thread.id,
          runId: f.run.id,
          title: "App",
          latestVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      )
      .execute();
    await apps.setTabOpen(ids[0]!, f.userId, true);
    const first = await apps.listTabs(f.userId);
    await apps.setTabOpen(ids[0]!, f.userId, true);
    expect(await apps.listTabs(f.userId)).toEqual(first);
    await apps.setTabOpen(ids[0]!, f.userId, false);
    await apps.setTabOpen(ids[0]!, f.userId, false);
    expect(await apps.listTabs(f.userId)).toEqual([]);
    for (const id of ids.slice(0, 50)) await apps.setTabOpen(id, f.userId, true);
    await expect(apps.setTabOpen(ids[50]!, f.userId, true)).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("50"),
    });
    expect(await apps.listTabs(f.userId)).toHaveLength(50);
    await apps.setTabOpen(ids[0]!, f.userId, false);
    expect(await apps.listTabs(f.userId)).toHaveLength(49);
    expect(
      (
        await database
          .selectFrom("apps")
          .select("tabOpenedAt")
          .where("id", "=", ids[0]!)
          .executeTakeFirstOrThrow()
      ).tabOpenedAt,
    ).toBeNull();
    const foreign = createId("user");
    await expect(apps.listTabs(foreign)).rejects.toMatchObject({ code: "forbidden" });
    for (const open of [true, false])
      await expect(apps.setTabOpen(ids[1]!, foreign, open)).rejects.toMatchObject({
        code: "forbidden",
      });
  });

  it("publishes, versions atomically, replays tool calls, serves latest through reusable capabilities, and cleans origin-owned bytes", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("apps");
    const scope = {
      runId: f.run.id,
      threadId: f.thread.id,

      environmentId: f.environmentId,
      requestedBy: f.userId,
    } as unknown as RunToolScope;
    const directory = await mkdtemp(join(tmpdir(), "opensteer-apps-test-"));
    const events: AgentEvent[] = [];
    let bytes = Buffer.from(html);
    const files = {
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
            sizeBytes: bytes.length,
            modifiedAt: null,
          },
        ],
      })),
      download: vi.fn(async () => new Response(bytes)),
    };
    const apps = new AppStore(database);
    const service = new AppService({
      dataDirectory: directory,

      apps,
      files,
      agentHome: async () => f.agentHome,
      tokens: { authenticate: async () => scope, reauthorize: async () => scope },
      publishEvent: (event) => events.push(event),
    });
    try {
      await database
        .updateTable("runs")
        .set({ status: "waiting" })
        .where("id", "=", f.run.id)
        .execute();
      const first = await service.publish(scope, "publish-1", {
        path: "index.html",
        title: "Budget",
      });
      expect(first).toMatchObject({
        version: 1,
        message: expect.stringContaining("shown inline in this Thread"),
      });
      expect(files.download).toHaveBeenCalledWith("opaque_html_key", expect.any(AbortSignal));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "app.published",
        runId: f.run.id,
        threadId: f.thread.id,
        data: { appId: first.appId, version: 1, title: "Budget" },
      });
      expect(
        (await store.threadEventPageForOwner({ ownerId: f.userId, threadId: f.thread.id }))?.events,
      ).toContainEqual(events[0]);
      const view = await service.view(first.appId, f.userId, "dark");
      const token = view.path.split("/").at(-2)!;
      const content = await service.content(first.appId, token, "dark");
      expect(content).toContain("First");
      expect(content.startsWith("<!doctype html>")).toBe(true);
      bytes = Buffer.from(html.replace("First", "Latest"));
      const updates = await Promise.all([
        service.publish(scope, "publish-2", {
          path: "index.html",
          title: "Budget",
          appId: first.appId,
        }),
        service.publish(scope, "publish-3", {
          path: "index.html",
          title: "Budget",
          appId: first.appId,
        }),
      ]);
      expect(updates.map((update) => update.version).sort()).toEqual([2, 3]);
      files.list.mockRejectedValue(new Error("Source file is gone"));
      files.download.mockRejectedValue(new Error("Source file is gone"));
      const listedBeforeReplay = files.list.mock.calls.length;
      const readBeforeReplay = files.download.mock.calls.length;
      expect(
        await service.publish(scope, "publish-3", {
          path: "index.html",
          title: "Budget",
          appId: first.appId,
        }),
      ).toMatchObject(updates[1]);
      expect(files.list).toHaveBeenCalledTimes(listedBeforeReplay);
      expect(files.download).toHaveBeenCalledTimes(readBeforeReplay);
      expect(events).toHaveLength(3);
      expect((await service.get(first.appId, f.userId)).latestVersion).toBe(3);
      expect(await service.content(first.appId, token, "light")).toContain("Latest");
      expect(
        await database
          .selectFrom("appVersions")
          .selectAll()
          .where("appId", "=", first.appId)
          .execute(),
      ).toHaveLength(3);
      await expect(service.get(first.appId, createId("user"))).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(service.content(first.appId, "x".repeat(43), "light")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        service.content(`app_${crypto.randomUUID()}`, token, "light"),
      ).rejects.toMatchObject({ code: "not_found" });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 12 * 60 * 60_000);
      try {
        expect(await service.content(first.appId, token, "dark")).toContain("Latest");
      } finally {
        clock.mockRestore();
      }
      // Keep the shared causal chain's root outside the Thread being erased.
      const { thread: retained } = await store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: "retained-app-history",
        modelSelection: f.thread.modelSelection,
        title: "Retained",
      });
      const retainedTurn = await storeFixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Retained" }],
        idempotencyKey: "retained-app-input",
        requestedBy: f.userId,
        threadId: retained.id,
      });
      await database
        .updateTable("causalChains")
        .set({ rootMessageId: retainedTurn.run.seedInputId })
        .where("id", "=", f.run.causalChainId)
        .execute();
      await database.deleteFrom("threads").where("id", "=", f.thread.id).execute();
      expect(await database.selectFrom("apps").selectAll().execute()).toEqual([]);
      expect(await database.selectFrom("appVersions").selectAll().execute()).toEqual([]);
      await service.collectGarbage();
      expect(await readdir(join(directory, "apps"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets the personal owner update an app from another task", async ({ storeFixture }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("app-reach");
    const apps = new AppStore(database);
    const publication = (threadId: ThreadId, runId: RunId, publishKey: string, appId?: string) =>
      apps.publish({
        ...(appId ? { appId } : {}),

        threadId,
        runId,
        environmentId: f.environmentId,
        userId: f.userId,
        title: "Budget",
        sha256: "b".repeat(64),
        sizeBytes: 1,
        publishKey,
      });
    const original = await publication(f.thread.id, f.run.id, "original");
    const thread = (idempotencyKey: string, parentThreadId?: ThreadId) =>
      store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey,
        modelSelection: f.thread.modelSelection,
        ...(parentThreadId ? { parentThreadId } : {}),
        title: idempotencyKey,
      });
    const running = async (threadId: ThreadId, idempotencyKey: string) => {
      const turn = await storeFixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Update" }],
        idempotencyKey,
        requestedBy: f.userId,
        threadId,
      });
      await database
        .updateTable("runs")
        .set({ status: "running" })
        .where("id", "=", turn.run.id)
        .execute();
      return turn.run.id;
    };
    // Reach follows consent, not lineage: a task delegated from another
    // conversation in this Workspace reaches the origin as much as its own child.
    const { thread: unrelatedRoot } = await thread("unrelated-root");
    const { thread: delegated } = await thread("unrelated-task", unrelatedRoot.id);
    const { thread: child } = await thread("origin-task", f.thread.id);

    const delegatedRun = await running(delegated.id, "unrelated-task-run");
    const childRun = await running(child.id, "origin-task-run");

    await expect(
      publication(delegated.id, delegatedRun, "outside-lineage", original.appId),
    ).resolves.toMatchObject({ appId: original.appId, version: 2 });
    await expect(
      publication(child.id, childRun, "origin-lineage", original.appId),
    ).resolves.toMatchObject({ appId: original.appId, version: 3 });
  });

  it("refuses foreign and missing IDs, missing/non-HTML/oversized files, and offline Runner reads without a publication", async ({
    storeFixture,
  }) => {
    const { database, startRunFixture } = storeFixture;
    const f = await startRunFixture("app-refusals");
    const scope = {
      runId: f.run.id,
      threadId: f.thread.id,

      environmentId: f.environmentId,
      requestedBy: f.userId,
    } as unknown as RunToolScope;
    const directory = await mkdtemp(join(tmpdir(), "opensteer-app-refusals-"));
    let bytes = Buffer.from(html);
    const entries = [
      {
        name: "index.html",
        key: "opaque",
        kind: "file" as const,
        executable: false,
        hidden: false,
        mode: 0o600,
        sizeBytes: bytes.length,
        modifiedAt: null,
      },
    ];
    const files = {
      list: vi.fn(async () => ({ parentKey: "", cursor: null, revision: "revision", entries })),
      download: vi.fn(async () => new Response(bytes)),
    };
    const published = vi.fn();
    const apps = new AppStore(database);
    const service = new AppService({
      dataDirectory: directory,
      apps,

      files,
      agentHome: async () => f.agentHome,
      tokens: { authenticate: async () => scope, reauthorize: async () => scope },
      publishEvent: published,
    });
    const publish = (input = {}) =>
      service.publish(scope, crypto.randomUUID(), {
        path: "index.html",
        title: "Test",
        ...input,
      });
    try {
      await expect(publish({ appId: `app_${crypto.randomUUID()}` })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        service.publish({ ...scope, requestedBy: createId("user") }, "foreign-owner", {
          path: "index.html",
          title: "Foreign",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(publish({ appId: "wrong" })).rejects.toThrow();
      await expect(publish({ path: "../index.html" })).rejects.toMatchObject({
        code: "bad_request",
      });
      files.list.mockResolvedValueOnce({
        parentKey: "",
        cursor: null,
        revision: "revision",
        entries: [],
      });
      await expect(publish()).rejects.toMatchObject({ code: "not_found" });
      await expect(publish({ path: "index.txt" })).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("HTML"),
      });
      bytes = Buffer.from([0xff]);
      await expect(publish()).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("UTF-8"),
      });
      bytes = Buffer.alloc(appMaxBytes + 1, 65);
      await expect(publish()).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("5 MiB"),
      });
      files.list.mockRejectedValueOnce(
        new OpensteerError({ code: "folder_unavailable", message: "Runner offline" }),
      );
      await expect(publish()).rejects.toMatchObject({ code: "folder_unavailable" });
      expect(published).not.toHaveBeenCalled();
      expect(
        await database.selectFrom("apps").selectAll().where("threadId", "=", f.thread.id).execute(),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("authorizes full-access app servers and recovers stored versions after restart", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-servers");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-app-server-host-"));
    let scope = {
      runId: f.run.id,
      threadId: f.thread.id,

      environmentId: f.environmentId,
      requestedBy: f.userId,
    } as unknown as RunToolScope;
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const connect =
      vi.fn<NonNullable<ConstructorParameters<typeof AppService>[0]["tunnels"]>["connect"]>();
    const apps = new AppStore(database);
    const files = {
      list: vi.fn(async () => ({
        parentKey: "",
        cursor: null,
        revision: "r",
        entries: [
          {
            name: "index.html",
            key: "html",
            kind: "file" as const,
            executable: false,
            hidden: false,
            mode: 0o600,
            sizeBytes: html.length,
            modifiedAt: null,
          },
        ],
      })),
      download: vi.fn(async () => new Response(html)),
    };
    const options = {
      dataDirectory: directory,
      apps,
      files,
      agentHome: async () => f.agentHome,
      tokens: { authenticate: async () => scope, reauthorize: async () => scope },
      publishEvent: () => undefined,
      tunnels: { start, stop, connect, accept: () => undefined },
    };
    const service = new AppService(options);
    const publish = (extra = {}) =>
      service.publish(scope, crypto.randomUUID(), {
        path: "app",
        title: "Server",
        start: "node server.js",
        ...extra,
      });
    try {
      await database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.run.id)
        .execute();
      await expect(publish()).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("full-access"),
      });
      expect(start).not.toHaveBeenCalled();
      await database
        .updateTable("runs")
        .set({ accessMode: "full-access" })
        .where("id", "=", f.run.id)
        .execute();
      for (const path of ["../bad", "/absolute", "a/../b"])
        await expect(publish({ path })).rejects.toMatchObject({ code: "bad_request" });
      expect(start).not.toHaveBeenCalled();
      start.mockRejectedValueOnce(
        new (await import("./app-tunnel-hub.js")).AppTunnelError(
          "Server exited",
          "failure log tail",
        ),
      );
      await expect(publish()).rejects.toMatchObject({
        message: expect.stringContaining("failure log tail"),
      });
      expect(await database.selectFrom("appVersions").selectAll().execute()).toHaveLength(0);
      stop.mockClear();
      const commit = vi
        .spyOn(apps, "publish")
        .mockRejectedValueOnce(new Error("Injected commit failure"));
      await expect(publish()).rejects.toThrow("Injected commit failure");
      expect(stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ version: 1 }));
      expect(await database.selectFrom("appVersions").selectAll().execute()).toHaveLength(0);
      commit.mockRestore();
      const first = await publish();
      expect((await apps.latest(first.appId, f.userId)).version).toMatchObject({
        sha256: null,
        sizeBytes: null,
        server: {
          folder: { computerId: f.runnerId, path: join(f.agentHome.path, "app") },
          command: "node server.js",
        },
      });
      const v = await service.view(first.appId, f.userId, "dark");
      const token = v.path.split("/").at(-2)!;
      expect((await service.view(first.appId, f.userId, "light")).path.split("/").at(-2)).toBe(
        token,
      );
      expect(await service.list(scope)).toMatchObject({
        apps: [
          expect.objectContaining({
            id: first.appId,
            kind: "server",
            folder: join(f.agentHome.path, "app"),
            start: "node server.js",
          }),
        ],
      });
      const { createServer } = await import("node:http");
      const { once } = await import("node:events");
      const { connect: dial } = await import("node:net");
      const upstream = createServer((req, res) => {
        res.writeHead(req.url === "/error" ? 409 : 200, { "content-type": "text/plain" });
        if (req.url === "/large") res.end("x".repeat(300_000));
        else res.end("app response");
      });
      try {
        const listening = once(upstream, "listening", { signal: AbortSignal.timeout(3_000) });
        upstream.listen(0, "127.0.0.1");
        await listening;
        const address = upstream.address();
        if (!address || typeof address === "string") throw new Error("Missing upstream address");
        connect.mockImplementation(async (_spec, signal) => ({
          stream: dial({ host: "127.0.0.1", port: address.port, signal }),
          port: address.port,
        }));
        expect(
          await service.fetch(scope, { appId: first.appId, method: "GET", path: "/error" }),
        ).toMatchObject({ status: 409, body: "app response" });
        const large = await service.fetch(scope, {
          appId: first.appId,
          method: "GET",
          path: "/large",
        });
        expect(large.truncated).toBe(true);
        expect(large.body).toContain("Response truncated");
        expect(large.body.length).toBeLessThan(263_000);
      } finally {
        await (await import("@opensteer/shared/httpServer")).closeHttpServerNow(upstream);
      }
      await database
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", f.userId)
        .execute();
      await expect(service.authorizeView(first.appId, token)).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        service.fetch(scope, { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await database
        .updateTable("users")
        .set({ disabledAt: null })
        .where("id", "=", f.userId)
        .execute();
      await database
        .updateTable("runs")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.run.id)
        .execute();
      await expect(
        service.fetch(scope, { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.list(scope)).rejects.toMatchObject({ code: "forbidden" });
      await database
        .updateTable("runs")
        .set({ accessMode: "full-access" })
        .where("id", "=", f.run.id)
        .execute();

      const stopsBefore = stop.mock.calls.length;
      await service.publish(scope, "html-republish", {
        appId: first.appId,
        path: "index.html",
        title: "HTML",
      });
      expect(stop).toHaveBeenCalledTimes(stopsBefore + 1);
      await expect(
        service.fetch(scope, { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      const next = await publish({ appId: first.appId });
      expect(next.version).toBe(3);
      // A new Host has no memory of the server that the database owns.
      const restarted = new AppService(options);
      const restartedView = await restarted.view(first.appId, f.userId, "dark");
      const viewerRequest = {
        appId: first.appId,
        token: restartedView.path.split("/").at(-2)!,
        theme: "dark" as const,
        method: "GET",
        path: "/",
        prefix: restartedView.path.slice(0, -1),
        headers: {},
        signal: AbortSignal.timeout(5_000),
      };
      // Lazy start can succeed on the Runner while tunnel establishment fails on the Host.
      connect.mockRejectedValue(new Error("Tunnel failed after lazy start"));
      (await restarted.response(viewerRequest)).body.destroy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
