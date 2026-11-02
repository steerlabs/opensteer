import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, appMaxBytes, OpensteerError, type AgentEvent } from "@opensteer/core";
import { AppStore } from "@opensteer/database";
import { expect, vi } from "vitest";
import { describeStore } from "@opensteer/database/test-support/store";
import type { AgentControlRunScope } from "../agents/agent-control-service.js";
import { AppService } from "./app-service.js";

const html = "<!doctype html><html><head></head><body><h1>First</h1></body></html>";
describeStore("published app HTML", (it) => {
  it("publishes, versions atomically, replays tool calls, serves latest through reusable expiring capabilities, and cleans origin-owned bytes", async ({
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
      const token = new URL(view.path, "https://host.test").searchParams.get("token")!;
      expect(await service.content(first.appId, token, "dark")).toContain("First");
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
      expect(
        await service.publish("run-token", "publish-3", {
          path: "index.html",
          title: "Budget",
          appId: first.appId,
        }),
      ).toMatchObject(updates[1]);
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
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
      try {
        await expect(service.content(first.appId, token, "dark")).rejects.toMatchObject({
          code: "not_found",
        });
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
      bytes = Buffer.from('{"not":"HTML"}');
      await expect(publish()).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("HTML"),
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
});
