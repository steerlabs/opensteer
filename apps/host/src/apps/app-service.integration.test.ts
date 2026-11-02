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
import type { AgentControlRunScope } from "../agents/agent-control-service.js";
import { AppService } from "./app-service.js";

const html = "<title>First</title><body><h1>First</h1>";
describeStore("published app HTML", (it) => {
  it("publishes, versions atomically, replays tool calls, serves latest through reusable capabilities, and cleans origin-owned bytes", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("apps");
    const scope = {
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
      environmentId: f.environmentId,
      requestedBy: f.userId,
    } as AgentControlRunScope;
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
      store,
      apps,
      files,
      tokens: { authenticate: async () => scope, reauthorize: async () => scope },
      publishEvent: (event) => events.push(event),
    });
    try {
      await database
        .updateTable("runs")
        .set({ status: "waiting" })
        .where("id", "=", f.run.id)
        .execute();
      const first = await service.publish("run-token", "publish-1", {
        path: "index.html",
        title: "Budget",
      });
      expect(first).toMatchObject({
        version: 1,
        message: expect.stringContaining("already shown"),
      });
      expect(files.download).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: expect.objectContaining({ id: f.workspace.id }) }),
        "opaque_html_key",
        expect.any(AbortSignal),
      );
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
        service.publish("run-token", "publish-2", {
          path: "index.html",
          title: "Budget",
          appId: first.appId,
        }),
        service.publish("run-token", "publish-3", {
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
        await service.publish("run-token", "publish-3", {
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
        workspaceId: f.workspace.id,
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

  it("lets only a publisher that reaches the origin Thread update its app", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("app-reach");
    const apps = new AppStore(database);
    const publication = (threadId: ThreadId, runId: RunId, publishKey: string, appId?: string) =>
      apps.publish({
        ...(appId ? { appId } : {}),
        workspaceId: f.workspace.id,
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
        workspaceId: f.workspace.id,
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
    // A task delegated from another conversation sits in a different lineage.
    const { thread: unrelatedRoot } = await thread("unrelated-root");
    const { thread: delegated } = await thread("unrelated-task", unrelatedRoot.id);
    const { thread: child } = await thread("origin-task", f.thread.id);
    expect([delegated.capabilityProfileId, child.capabilityProfileId]).toEqual([
      "delegated",
      "delegated",
    ]);
    const delegatedRun = await running(delegated.id, "unrelated-task-run");
    const childRun = await running(child.id, "origin-task-run");

    await expect(
      publication(delegated.id, delegatedRun, "outside-lineage", original.appId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      publication(child.id, childRun, "origin-lineage", original.appId),
    ).resolves.toMatchObject({ appId: original.appId, version: 2 });
  });

  it("refuses foreign and missing IDs, missing/non-HTML/oversized files, and offline Runner reads without a publication", async ({
    storeFixture,
  }) => {
    const { store, database, startRunFixture } = storeFixture;
    const f = await startRunFixture("app-refusals");
    const otherWorkspace = await storeFixture.createSpecializedWorkspace(
      f.userId,
      "app-other-workspace",
    );
    const { thread: otherThread } = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harnessInstance.id,
      idempotencyKey: "other-app-thread",
      modelSelection: f.thread.modelSelection,
      title: "Other app",
      workspaceId: otherWorkspace.id,
    });
    const otherTurn = await storeFixture.enqueueHumanTrigger({
      content: [{ type: "text", text: "Publish" }],
      idempotencyKey: "other-app-run",
      requestedBy: f.userId,
      threadId: otherThread.id,
    });
    await database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", otherTurn.run.id)
      .execute();
    const other = {
      workspace: otherWorkspace,
      thread: otherThread,
      run: otherTurn.run,
      userId: f.userId,
      environmentId: f.environmentId,
    };
    const apps = new AppStore(database);
    const foreign = await apps.publish({
      workspaceId: other.workspace.id,
      threadId: other.thread.id,
      runId: other.run.id,
      environmentId: other.environmentId,
      userId: other.userId,
      title: "Other",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      publishKey: "foreign",
    });
    const scope = {
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
      environmentId: f.environmentId,
      requestedBy: f.userId,
    } as AgentControlRunScope;
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
    const service = new AppService({
      dataDirectory: directory,
      apps,
      store,
      files,
      tokens: { authenticate: async () => scope, reauthorize: async () => scope },
      publishEvent: published,
    });
    const publish = (input = {}) =>
      service.publish("token", crypto.randomUUID(), {
        path: "index.html",
        title: "Test",
        ...input,
      });
    try {
      await expect(publish({ appId: `app_${crypto.randomUUID()}` })).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(publish({ appId: foreign.appId })).rejects.toMatchObject({ code: "not_found" });
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
        new OpensteerError({ code: "workspace_unavailable", message: "Runner offline" }),
      );
      await expect(publish()).rejects.toMatchObject({ code: "workspace_unavailable" });
      expect(published).not.toHaveBeenCalled();
      expect(
        await database
          .selectFrom("apps")
          .selectAll()
          .where("workspaceId", "=", f.workspace.id)
          .execute(),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("authorizes server publication before start, stops failed commits, preserves tokens and enforces agent reach", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const f = await storeFixture.startRunFixture("app-servers");
    const directory = await mkdtemp(join(tmpdir(), "opensteer-app-server-host-"));
    let scope = {
      runId: f.run.id,
      threadId: f.thread.id,
      workspaceId: f.workspace.id,
      environmentId: f.environmentId,
      requestedBy: f.userId,
    } as AgentControlRunScope;
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
    const service = new AppService({
      dataDirectory: directory,
      store,
      apps,
      files,
      tokens: { authenticate: async () => scope, reauthorize: async () => scope },
      publishEvent: () => undefined,
      tunnels: { start, stop, connect, accept: () => undefined },
    });
    const publish = (extra = {}) =>
      service.publish("run-token", crypto.randomUUID(), {
        path: "app",
        title: "Server",
        start: "node server.js",
        ...extra,
      });
    try {
      await database
        .updateTable("threads")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.thread.id)
        .execute();
      await expect(publish()).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("full-access"),
      });
      expect(start).not.toHaveBeenCalled();
      await database
        .updateTable("threads")
        .set({ accessMode: "full-access" })
        .where("id", "=", f.thread.id)
        .execute();
      await expect(publish()).rejects.toMatchObject({
        message: "App servers need a local Workspace",
      });
      expect(start).not.toHaveBeenCalled();
      await database
        .updateTable("workspaces")
        .set({
          backing: {
            kind: "local-directory",
            bindingId: createId("workspaceBinding"),
            generation: 1,
            storageAuthorityId: createId("storageAuthority"),
            ownerEnvironmentId: f.environmentId,
          },
          capacityPolicy: { kind: "host-filesystem" },
        })
        .where("id", "=", f.workspace.id)
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
        server: { folder: "app", command: "node server.js", environmentId: f.environmentId },
      });
      const v = await service.view(first.appId, f.userId, "dark");
      const token = v.path.split("/").at(-2)!;
      expect((await service.view(first.appId, f.userId, "light")).path.split("/").at(-2)).toBe(
        token,
      );
      expect(await service.list("token")).toMatchObject({
        apps: [
          expect.objectContaining({
            id: first.appId,
            kind: "server",
            folder: "app",
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
          await service.fetch("token", { appId: first.appId, method: "GET", path: "/error" }),
        ).toMatchObject({ status: 409, body: "app response" });
        const large = await service.fetch("token", {
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
      const startsBefore = start.mock.calls.length;
      const { thread: unrelated } = await store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: "unrelated-app-root",
        modelSelection: f.thread.modelSelection,
        title: "Other",
        workspaceId: f.workspace.id,
      });
      const { thread: child } = await store.createThread({
        createdBy: f.userId,
        environmentId: f.environmentId,
        harnessInstanceId: f.harnessInstance.id,
        idempotencyKey: "unrelated-app-child",
        modelSelection: f.thread.modelSelection,
        title: "Other task",
        workspaceId: f.workspace.id,
        parentThreadId: unrelated.id,
      });
      const turn = await storeFixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Other task" }],
        idempotencyKey: "unrelated-app-turn",
        requestedBy: f.userId,
        threadId: child.id,
      });
      await database
        .updateTable("runs")
        .set({ status: "running" })
        .where("id", "=", turn.run.id)
        .execute();
      await database
        .updateTable("threads")
        .set({ accessMode: "full-access" })
        .where("id", "=", child.id)
        .execute();
      const originScope = scope;
      scope = { ...scope, threadId: child.id, runId: turn.run.id };
      await expect(publish({ appId: first.appId })).rejects.toMatchObject({ code: "not_found" });
      expect(start).toHaveBeenCalledTimes(startsBefore);
      await expect(
        service.fetch("token", { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await service.list("token")).toEqual({ apps: [] });
      scope = originScope;
      const retainedOwner = await store.createUser("Retained app Workspace owner");
      await database
        .insertInto("workspaceMemberships")
        .values({
          generation: 1,
          id: createId("workspaceMembership"),
          invitedBy: f.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          role: "owner",
          state: "active",
          updatedAt: new Date(),
          userId: retainedOwner,
          workspaceId: f.workspace.id,
        })
        .execute();

      await database
        .updateTable("workspaceMemberships")
        .set({ state: "revoked", revokedAt: new Date(), revokedBy: retainedOwner })
        .where("workspaceId", "=", f.workspace.id)
        .where("userId", "=", f.userId)
        .execute();
      await expect(service.authorizeView(first.appId, token)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        service.fetch("token", { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "not_found" });
      await database
        .updateTable("workspaceMemberships")
        .set({ state: "active", revokedAt: null, revokedBy: null })
        .where("workspaceId", "=", f.workspace.id)
        .where("userId", "=", f.userId)
        .execute();
      await database
        .updateTable("threads")
        .set({ accessMode: "approval-required" })
        .where("id", "=", f.thread.id)
        .execute();
      await expect(
        service.fetch("token", { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(service.list("token")).rejects.toMatchObject({ code: "forbidden" });
      await database
        .updateTable("threads")
        .set({ accessMode: "full-access" })
        .where("id", "=", f.thread.id)
        .execute();

      const stopsBefore = stop.mock.calls.length;
      await service.publish("token", "html-republish", {
        appId: first.appId,
        path: "index.html",
        title: "HTML",
      });
      expect(stop).toHaveBeenCalledTimes(stopsBefore + 1);
      await expect(
        service.fetch("token", { appId: first.appId, method: "GET", path: "/" }),
      ).rejects.toMatchObject({ code: "bad_request" });
      const next = await publish({ appId: first.appId });
      expect(next.version).toBe(3);
      // The same causal root constraint used in the HTML lifecycle fixture.
      const retained = await storeFixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Retained" }],
        idempotencyKey: "retained-server-cause",
        requestedBy: f.userId,
        threadId: unrelated.id,
      });
      await database
        .updateTable("causalChains")
        .set({ rootMessageId: retained.run.seedInputId })
        .where("id", "=", f.run.causalChainId)
        .execute();
      await database.deleteFrom("threads").where("id", "=", f.thread.id).execute();
      const deletedStops = stop.mock.calls.length;
      await service.reconcile();
      expect(stop).toHaveBeenCalledTimes(deletedStops + 1);
      await expect(service.authorizeView(first.appId, token)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
