import { ExactModelWantSchema } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { createId, SpecialistManifestSchema } from "@opensteer/core";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { assertLineageCompatibleReuse, resolveResourceAccess } from "./resource-access.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("specialist registration", (test) => {
  test("repins every owner's bindings and refuses a version that drops the specialist", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("repin-owners");
    const other = await fixture.store.createUser("Other specialist owner");
    const workspace = await fixture.createProjectWorkspace(owner.userId, "repin");
    await fixture.database
      .insertInto("workspaceMemberships")
      .values({
        workspaceId: workspace.id,
        userId: other,
        id: createId("workspaceMembership"),
        role: "collaborator",
        generation: 1,
        invitedBy: owner.userId,
        revokedAt: null,
        revokedBy: null,
        state: "active",
        joinedAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const platform = new IntegrationPlatformStore(fixture.database),
      pluginId = randomUUID();
    const manifest = SpecialistManifestSchema.parse({
      version: 1,
      models: [{ engine: "codex", model: "fast" }],
      access: [],
    });
    await platform.plugins.install({
      id: pluginId,
      name: "repin",
      actorUserId: owner.userId,
      source: {},
      digest: "old",
      manifest: { name: "repin" },
      specialistManifest: manifest,
    });
    for (const actorUserId of [owner.userId, other])
      await platform.specialists.add({ workspaceId: workspace.id, pluginId, actorUserId });
    await platform.plugins.setActivation({
      pluginId,
      workspaceId: workspace.id,
      actorUserId: owner.userId,
      active: false,
    });
    await platform.specialists.add({
      pluginId,
      workspaceId: workspace.id,
      actorUserId: owner.userId,
      activate: false,
    });
    expect((await platform.plugins.list()).find((p) => p.id === pluginId)?.activations).toEqual([]);
    const bindings = [{ requirement: 0, resourceId: "chosen", level: "read" as const }];
    await fixture.database
      .updateTable("specialists")
      .set({ bindings: sql`${JSON.stringify(bindings)}::jsonb` })
      .where("pluginId", "=", pluginId)
      .execute();
    // As an install does: the new version, then its registrations moved to it.
    const update = (digest: string, specialistManifest: typeof manifest | null) =>
      fixture.database.transaction().execute(async (tx) => {
        await platform.plugins.update(
          { pluginId, digest, manifest: { name: "repin" }, specialistManifest },
          tx,
        );
        await platform.plugins.repinSpecialists(tx, pluginId);
      });
    await update("same-access", {
      ...manifest,
      models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
    });
    const rows = () =>
      fixture.database
        .selectFrom("specialists")
        .selectAll()
        .where("pluginId", "=", pluginId)
        .execute();
    for (const row of await rows()) expect(row.bindings).toEqual(bindings);
    expect(new Set((await rows()).map((r) => r.pluginVersionId)).size).toBe(1);
    await update("changed-access", {
      ...manifest,
      access: [{ type: "browser-profile", level: "read", reason: "Research" }],
    });
    expect(
      (await rows()).every((r) => r.status === "pending" && r.bindings.length === 0 && !r.autoBind),
    ).toBe(true);
    const pinned = (await rows()).map((r) => r.pluginVersionId);
    await expect(update("not-specialist", null)).rejects.toThrow(
      "Remove this plugin's specialist registrations before installing it without one",
    );
    expect((await rows()).map((r) => r.pluginVersionId)).toEqual(pinned);
  });

  test("pins versions, binds consent, narrows access and removes registration", async ({
    storeFixture: fixture,
  }) => {
    const run = await fixture.startRunFixture("specialist-" + randomUUID());
    const workspace = await fixture.createProjectWorkspace(run.userId, "specialist");
    const platform = new IntegrationPlatformStore(fixture.database);
    const pluginId = randomUUID();
    const manifest = SpecialistManifestSchema.parse({
      version: 1,
      models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
      access: [{ type: "browser-profile", level: "read", reason: "Research invoices" }],
    });
    await platform.plugins.install({
      id: pluginId,
      name: "researcher",
      actorUserId: run.userId,
      source: {},
      digest: "a".repeat(64),
      manifest: { name: "researcher" },
      specialistManifest: manifest,
    });
    const version = (await platform.plugins.list())[0]!.versions[0]!;
    expect(version.specialistManifest).toEqual(manifest);
    const add = () =>
      platform.specialists.add({ workspaceId: workspace.id, pluginId, actorUserId: run.userId });
    const pending = await add();
    expect(pending).toMatchObject({
      status: "pending",
      pluginVersionId: version.id,
      ownerUserId: run.userId,
    });
    const request = await fixture.store.requests.create({
      callId: `specialist:${pending.id}:0`,
      kind: "browser.access",
      mode: "durable",
      originatingRunId: run.run.id,
      originatingThreadId: run.thread.id,
      originatingWorkspaceId: run.workspace.id,
      targetWorkspaceId: workspace.id,
      requestedBy: run.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Research invoices",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Browser profile access",
        subject: { id: workspace.id, kind: "workspace" },
      },
    });
    expect(request.request).toMatchObject({ kind: "browser.access", originatingRunId: run.run.id });
    const profile = await fixture.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Invoices",
      idempotencyKey: "specialist-profile",
    });
    const resource = { type: "browser-profile" as const, id: profile.id };
    const check = (resourceId: string) =>
      resolveResourceAccess(fixture.database, {
        workspaceId: workspace.id,
        ownerUserId: run.userId,
        explicitAccess: "read-write",
        specialistId: pending.id,
        resource: { ...resource, id: resourceId },
      });
    expect((await check(profile.id)).access).toBeNull();
    await fixture.store.requests.resolveBrowserRequest({
      requestId: request.request.id,
      resolvedBy: run.userId,
      response: { kind: "external", value: { decision: "fulfilled", profileId: profile.id } },
    });
    const ready = (await platform.specialists.list(workspace.id, run.userId))[0]!;
    expect(ready.status).toBe("ready");
    const connections = new AgentConnectionStore(fixture.database);
    const connection = await connections.create({
      userId: run.userId,
      label: "Specialist agent",
      clientName: "test",
      accessMode: "full-access",
      reach: { kind: "workspace", workspaceId: workspace.id },
      resource: "http://localhost/internal/v1/mcp",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await connections.activate(connection.id, "a".repeat(64));
    const scopedMain = await connections.create({
      userId: run.userId,
      label: "Main scoped",
      clientName: "test",
      accessMode: "full-access",
      reach: { kind: "workspace", workspaceId: run.workspace.id },
      resource: "http://localhost/internal/v1/mcp",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await connections.activate(scopedMain.id, "b".repeat(64));
    expect(
      await resolveResourceAccess(fixture.database, {
        ownerUserId: run.userId,
        workspaceId: run.workspace.id,
        connectionId: scopedMain.id,
      }),
    ).toMatchObject({ inheritsMain: false, mainAccess: "withheld", access: null });
    await connections.revoke(run.userId, scopedMain.id);
    await expect(
      resolveResourceAccess(fixture.database, {
        ownerUserId: run.userId,
        workspaceId: run.workspace.id,
        connectionId: scopedMain.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const independent = await fixture.store.createThread({
      authority: {
        kind: "connection",
        connectionId: connection.id,
        userId: run.userId,
        accessMode: "full-access",
        reach: { kind: "workspace", workspaceId: workspace.id },
      },
      createdBy: run.userId,
      environmentId: run.environmentId,
      harnessInstanceId: run.harnessInstance.id,
      modelSelection: run.thread.modelSelection,
      workspaceId: workspace.id,
      idempotencyKey: "independent-specialist",
      title: "Independent specialist",
      specialistId: ready.id,
    });
    expect(independent.thread).toMatchObject({
      parentThreadId: null,
      lineageRootThreadId: independent.thread.id,
      inheritsMain: false,
      specialistId: ready.id,
    });
    const rootChild = await fixture.store.createThread({
      createdBy: run.userId,
      environmentId: run.environmentId,
      harnessInstanceId: run.harnessInstance.id,
      modelSelection: run.thread.modelSelection,
      workspaceId: workspace.id,
      parentThreadId: independent.thread.id,
      idempotencyKey: "independent-specialist-child",
      title: "Child",
    });
    expect(rootChild.thread).toMatchObject({
      specialistId: ready.id,
      inheritsMain: false,
      lineageRootThreadId: independent.thread.id,
    });
    await expect(
      fixture.database
        .updateTable("threads")
        .set({ specialistId: null })
        .where("id", "=", rootChild.thread.id)
        .execute(),
    ).rejects.toThrow(/specialist.*immutable/u);
    const beforeOff = await fixture.database
      .selectFrom("specialists")
      .selectAll()
      .where("id", "=", ready.id)
      .executeTakeFirstOrThrow();
    const target = { kind: "specialist" as const, pluginId, ownerUserId: run.userId };
    await platform.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: false,
      idempotencyKey: "off-specialist",
    });
    await expect(
      platform.specialists.assertRunnable(ready.id, workspace.id, run.userId),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      (
        await fixture.database
          .selectFrom("specialists")
          .selectAll()
          .where("id", "=", ready.id)
          .executeTakeFirstOrThrow()
      ).bindings,
    ).toEqual(beforeOff.bindings);
    expect((await check(profile.id)).access).toBe("read");
    await platform.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: true,
      idempotencyKey: "on-specialist",
    });
    expect((await platform.specialists.assertRunnable(ready.id, workspace.id, run.userId)).id).toBe(
      ready.id,
    );

    const delegate = (threadId?: import("@opensteer/core").ThreadId) =>
      fixture.store.delegateThread({
        accessMode: run.thread.accessMode,
        createdBy: run.userId,
        environmentId: run.environmentId,
        harnessInstanceId: run.harnessInstance.id,
        idempotencyKey: randomUUID(),
        modelSelection: run.thread.modelSelection,
        specialistId: ready.id,
        origin: { kind: "run", parentRunId: run.run.id, parentThreadId: run.thread.id },
        task: [{ type: "text", text: "Read invoices" }],
        title: "Invoices",
        workspaceId: workspace.id,
        ...(threadId ? { threadId } : {}),
      });
    const child = await delegate();
    expect(child.thread).toMatchObject({
      specialistId: ready.id,
      inheritsMain: true,
      lineageRootThreadId: run.thread.lineageRootThreadId,
    });
    await expect(
      assertLineageCompatibleReuse(fixture.database, child.thread.id, run.thread.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    const descendant = await fixture.store.createThread({
      createdBy: run.userId,
      environmentId: run.environmentId,
      harnessInstanceId: run.harnessInstance.id,
      modelSelection: run.thread.modelSelection,
      workspaceId: workspace.id,
      parentThreadId: child.thread.id,
      idempotencyKey: "specialist-descendant",
      title: "Invoice subtask",
    });
    expect(descendant.thread).toMatchObject({ specialistId: ready.id, inheritsMain: true });
    expect(
      (
        await resolveResourceAccess(fixture.database, {
          workspaceId: workspace.id,
          ownerUserId: run.userId,
          threadId: descendant.thread.id,
          explicitAccess: "read-write",
          resource,
        })
      ).access,
    ).toBe("read");
    const boundChild = await fixture.database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", child.thread.id)
      .executeTakeFirstOrThrow();
    await expect(
      fixture.database
        .insertInto("threads")
        .values({
          ...boundChild,
          id: createId("thread"),
          parentThreadId: child.thread.id,
          specialistId: null,
        })
        .execute(),
    ).rejects.toThrow(/cannot escape its specialist binding/u);
    const sourceRunId = child.run.id;
    await fixture.database
      .updateTable("runs")
      .set({ status: "starting" })
      .where("id", "=", sourceRunId)
      .execute();
    const send = (policy: "queue" | "steer" | "report") =>
      fixture.store.enqueueThreadInput({
        content: [{ type: "text", text: "Result" }],
        idempotencyKey: randomUUID(),
        policy,
        requestedBy: run.userId,
        source: { kind: "agent", runId: sourceRunId },
        threadId: run.thread.id,
      });
    await expect(send("report")).resolves.toBeDefined();
    await expect(send("queue")).rejects.toMatchObject({ code: "forbidden" });
    await expect(send("steer")).rejects.toMatchObject({ code: "forbidden" });
    const guarded = await resolveResourceAccess(fixture.database, {
      workspaceId: workspace.id,
      ownerUserId: run.userId,
      threadId: child.thread.id,
      explicitAccess: "read-write",
      resource,
    });
    expect(guarded.access).toBe("read");
    await fixture.store.cancelAssignment({
      assignmentId: child.assignment.id,
      requestedBy: run.userId,
      idempotencyKey: randomUUID(),
    });
    const again = await delegate(child.thread.id);
    expect(again.thread.specialistId).toBe(ready.id);
    const mainRegistration = await platform.specialists.add({
      workspaceId: run.workspace.id,
      pluginId,
      actorUserId: run.userId,
    });
    const channelId = createId("thread");
    const root = await fixture.database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", run.thread.id)
      .executeTakeFirstOrThrow();
    await fixture.database
      .insertInto("threads")
      .values({
        ...root,
        id: channelId,
        lineageRootThreadId: channelId,
        inheritsMain: false,
      })
      .execute();
    const specialistThreadId = createId("thread");
    const bound = await fixture.database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", child.thread.id)
      .executeTakeFirstOrThrow();
    await fixture.database
      .insertInto("threads")
      .values({
        ...bound,
        id: specialistThreadId,
        workspaceId: run.workspace.id,
        lineageRootThreadId: channelId,
        parentThreadId: channelId,
        inheritsMain: false,
        specialistId: mainRegistration.id,
      })
      .execute();
    expect(
      (
        await resolveResourceAccess(fixture.database, {
          workspaceId: run.workspace.id,
          ownerUserId: run.userId,
          threadId: specialistThreadId,
          resource,
        })
      ).access,
    ).toBeNull();

    expect(ready.access[0]?.binding).toMatchObject({ resourceId: profile.id, level: "read" });
    expect((await check(profile.id)).access).toBe("read");
    expect((await check("unbound")).access).toBeNull();
    expect(
      (
        await resolveResourceAccess(fixture.database, {
          workspaceId: workspace.id,
          ownerUserId: run.userId,
          specialistId: pending.id,
          resource,
          explicitAccess: null,
        })
      ).access,
    ).toBeNull();
    await platform.plugins.update({
      pluginId,
      digest: "b".repeat(64),
      manifest: { name: "researcher" },
      specialistManifest: {
        ...manifest,
        models: [ExactModelWantSchema.parse({ engine: "codex", model: "fast" })],
      },
    });
    expect((await platform.specialists.list(workspace.id, run.userId))[0]?.pluginVersionId).toBe(
      version.id,
    );
    const updated = await add();
    expect(updated.id).toBe(pending.id);
    expect(updated.pluginVersionId).not.toBe(version.id);
    expect(
      updated.models[0] && "engine" in updated.models[0] ? updated.models[0].engine : undefined,
    ).toBe("codex");
    await fixture.database
      .updateTable("browserProfileGrants")
      .set({ revokedAt: new Date() })
      .where("profileId", "=", profile.id)
      .where("workspaceId", "=", workspace.id)
      .execute();
    // A stale ready row cannot preserve withdrawn Workspace consent.
    expect((await check(profile.id)).access).toBeNull();
    expect((await platform.specialists.refresh(pending.id)).status).toBe("pending");
    platform.specialists.setRemovalHandler(async () => {
      throw new Error("Runner offline");
    });
    await expect(
      platform.specialists.remove({
        workspaceId: workspace.id,
        specialistId: pending.id,
        actorUserId: run.userId,
      }),
    ).rejects.toThrow("Runner offline");
    expect((await platform.specialists.list(workspace.id, run.userId))[0]).toMatchObject({
      status: "removal-failed",
    });
    await expect(platform.plugins.remove(pluginId)).rejects.toThrow("specialist");
    expect((await check(profile.id)).access).toBeNull();
    platform.specialists.setRemovalHandler(async () => undefined);
    if (workspace.backing.kind !== "local-directory") throw new Error("Expected local storage");
    await platform.specialists.resumeRemovals([workspace.backing.ownerEnvironmentId]);
    expect(await platform.specialists.list(workspace.id, run.userId)).toEqual([]);
    expect((await add()).id).not.toBe(pending.id);
    await platform.specialists.retirePlugin(pluginId);
    await platform.plugins.remove(pluginId);
    expect(await platform.specialists.list(workspace.id, run.userId)).toEqual([]);
    await expect(
      platform.specialists.assertRunnable(pending.id, workspace.id, run.userId),
    ).rejects.toThrow("removed");
    expect((await check(profile.id)).access).toBeNull();
  });

  test("plugin retirement keeps other Projects ready when one cleanup fails and can be retried", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("retire-plugin");
    const workspace = await fixture.createProjectWorkspace(owner.userId, "retire");
    const platform = new IntegrationPlatformStore(fixture.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "retire",
      actorUserId: owner.userId,
      source: {},
      digest: "d".repeat(64),
      manifest: { name: "retire" },
      specialistManifest: SpecialistManifestSchema.parse({
        version: 1,
        models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
      }),
    });
    const registration = await platform.specialists.add({
      workspaceId: workspace.id,
      pluginId,
      actorUserId: owner.userId,
    });
    const unaffected = await platform.specialists.add({
      workspaceId: owner.workspace.id,
      pluginId,
      actorUserId: owner.userId,
    });
    platform.specialists.setRemovalHandler(async () => {
      throw new Error("Owner computer offline");
    });
    await expect(platform.specialists.retirePlugin(pluginId)).rejects.toThrow("offline");
    const rows = await fixture.database
      .selectFrom("specialists")
      .selectAll()
      .where("pluginId", "=", pluginId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === registration.id)).toMatchObject({
      status: "removal-failed",
      removedAt: expect.any(Date),
    });
    expect(rows.find((row) => row.id === unaffected.id)).toMatchObject({
      status: "ready",
      removedAt: null,
    });
    await expect(platform.plugins.remove(pluginId)).rejects.toThrow("specialist");
    await expect(
      platform.specialists.assertRunnable(registration.id, workspace.id, owner.userId),
    ).rejects.toThrow(/remov/);
    await expect(
      platform.specialists.add({ workspaceId: workspace.id, pluginId, actorUserId: owner.userId }),
    ).rejects.toThrow("cleanup is pending");
    platform.specialists.setRemovalHandler(async () => undefined);
    await platform.specialists.retirePlugin(pluginId);
    await platform.specialists.remove({
      workspaceId: workspace.id,
      specialistId: registration.id,
      actorUserId: owner.userId,
    });
    await platform.plugins.remove(pluginId);
    expect((await platform.plugins.list()).some((plugin) => plugin.id === pluginId)).toBe(false);
  });

  test("purging a Project finalizes its specialists and plugin uninstall cleans the other Project", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("purge-specialist");
    const a = await fixture.createProjectWorkspace(owner.userId, "purged");
    const b = await fixture.createProjectWorkspace(owner.userId, "remaining");
    const platform = new IntegrationPlatformStore(fixture.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "purge",
      actorUserId: owner.userId,
      source: {},
      digest: "e".repeat(64),
      manifest: { name: "purge" },
      specialistManifest: SpecialistManifestSchema.parse({
        version: 1,
        models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
      }),
    });
    for (const workspace of [a, b]) {
      await platform.specialists.add({
        workspaceId: workspace.id,
        pluginId,
        actorUserId: owner.userId,
      });
    }
    const legacy = await fixture.database
      .selectFrom("specialists")
      .selectAll()
      .where("workspaceId", "=", a.id)
      .executeTakeFirstOrThrow();
    await fixture.store.requestWorkspaceDeletion({
      workspaceId: a.id,
      requestedBy: owner.userId,
      purgeAfter: new Date(),
    });
    // This commit follows the storage authority's durable destruction receipt.
    await fixture.store.markWorkspaceDeleted({ workspaceId: a.id });
    expect(await platform.specialists.list(a.id, owner.userId)).toEqual([]);
    const cleanup = vi.fn(async ({ workspaceId }: { workspaceId: string }): Promise<void> => {
      if (workspaceId === a.id) throw new Error("Binding destroyed");
      throw new Error("B offline");
    });
    platform.specialists.setRemovalHandler(cleanup);
    await expect(platform.specialists.retirePlugin(pluginId)).rejects.toThrow("B offline");
    expect(await platform.specialists.list(a.id, owner.userId)).toEqual([]);
    await expect(platform.plugins.remove(pluginId)).rejects.toThrow("specialist");
    // An older Host may have committed destruction without removing its registration.
    await fixture.database
      .insertInto("specialists")
      .values({
        ...legacy,
        bindings: sql`'[]'::jsonb`,
      })
      .execute();
    cleanup.mockImplementation(async ({ workspaceId }) => {
      if (workspaceId === a.id) throw new Error("Binding destroyed");
    });
    await platform.specialists.retirePlugin(pluginId);
    await platform.plugins.remove(pluginId);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: b.id }));
    expect(await platform.specialists.list(b.id, owner.userId)).toEqual([]);
  });

  test("an agent-registered specialist waits for its owner to choose even a sole candidate", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("specialist-agent-registered");
    const workspace = await fixture.createProjectWorkspace(owner.userId, "agent-registered");
    const platform = new IntegrationPlatformStore(fixture.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "agent-installed",
      actorUserId: owner.userId,
      source: {},
      digest: "e".repeat(64),
      manifest: { name: "agent-installed" },
      specialistManifest: SpecialistManifestSchema.parse({
        version: 1,
        models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
        access: [{ type: "browser-profile", level: "read", reason: "Browse" }],
      }),
    });
    const profile = await fixture.store.createBrowserProfile({
      ownerId: owner.userId,
      name: "Only",
      idempotencyKey: "only",
    });
    await fixture.store.createBrowserProfileGrant({
      workspaceId: workspace.id,
      createdBy: owner.userId,
      profileId: profile.id,
      access: "read",
    });
    const registered = await platform.specialists.add({
      workspaceId: workspace.id,
      pluginId,
      actorUserId: owner.userId,
      autoBind: false,
    });
    expect(registered).toMatchObject({
      status: "pending",
      access: [{ state: "choose", binding: null }],
    });
    // Later reads, including the check before running it, never bind for the owner.
    expect((await platform.specialists.list(workspace.id, owner.userId))[0]).toMatchObject({
      status: "pending",
      access: [{ state: "choose", binding: null }],
    });
    await expect(
      platform.specialists.assertRunnable(registered.id, workspace.id, owner.userId),
    ).rejects.toThrow();
    const ready = await platform.specialists.bind({
      workspaceId: workspace.id,
      specialistId: registered.id,
      actorUserId: owner.userId,
      requirement: 0,
      resourceId: profile.id,
    });
    expect(ready).toMatchObject({ status: "ready", access: [{ state: "bound" }] });
  });

  test("ambiguous consent requires an owner choice and list revalidates revocations", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("specialist-choice");
    const workspace = await fixture.createProjectWorkspace(owner.userId, "choice");
    const platform = new IntegrationPlatformStore(fixture.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "chooser",
      actorUserId: owner.userId,
      source: {},
      digest: "c".repeat(64),
      manifest: { name: "chooser" },
      specialistManifest: SpecialistManifestSchema.parse({
        version: 1,
        models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
        access: [{ type: "browser-profile", level: "read-write", reason: "Browse" }],
      }),
    });
    const pending = await platform.specialists.add({
      workspaceId: workspace.id,
      pluginId,
      actorUserId: owner.userId,
    });
    expect(pending.access[0]).toMatchObject({ state: "needs-access", candidates: [] });
    const profiles = [];
    for (const name of ["First", "Second"]) {
      const p = await fixture.store.createBrowserProfile({
        ownerId: owner.userId,
        name,
        idempotencyKey: name,
      });
      await fixture.store.createBrowserProfileGrant({
        workspaceId: workspace.id,
        createdBy: owner.userId,
        profileId: p.id,
        access: "read-write",
      });
      profiles.push(p);
    }
    const [choice] = await platform.specialists.list(workspace.id, owner.userId);
    expect(choice?.access[0]).toMatchObject({ state: "choose", binding: null });
    expect(choice?.access[0]?.candidates).toHaveLength(2);
    await expect(
      platform.specialists.bind({
        workspaceId: workspace.id,
        specialistId: pending.id,
        actorUserId: owner.userId,
        requirement: 0,
        resourceId: "unavailable",
      }),
    ).rejects.toThrow("candidate");
    const ready = await platform.specialists.bind({
      workspaceId: workspace.id,
      specialistId: pending.id,
      actorUserId: owner.userId,
      requirement: 0,
      resourceId: profiles[1]!.id,
    });
    expect(ready).toMatchObject({
      status: "ready",
      access: [{ state: "bound", binding: { resourceId: profiles[1]!.id } }],
    });
    expect(
      (await platform.specialists.list(workspace.id, owner.userId))[0]?.access[0]?.binding
        ?.resourceId,
    ).toBe(profiles[1]!.id);
    await fixture.database
      .updateTable("browserProfileGrants")
      .set({ revokedAt: new Date() })
      .where("workspaceId", "=", workspace.id)
      .where("profileId", "=", profiles[1]!.id)
      .execute();
    expect((await platform.specialists.list(workspace.id, owner.userId))[0]).toMatchObject({
      status: "pending",
      access: [
        {
          state: "rebind",
          binding: null,
          candidates: [{ resourceId: profiles[0]!.id, name: "First" }],
        },
      ],
    });
    expect((await platform.specialists.list(workspace.id, owner.userId))[0]?.status).toBe(
      "pending",
    );
    await expect(
      platform.specialists.assertRunnable(pending.id, workspace.id, owner.userId),
    ).rejects.toThrow("pending");
    expect(
      (
        await platform.specialists.bind({
          workspaceId: workspace.id,
          specialistId: pending.id,
          actorUserId: owner.userId,
          requirement: 0,
          resourceId: profiles[0]!.id,
        })
      ).status,
    ).toBe("ready");
  });

  test("a shared Project never binds another member's browser consent", async ({
    storeFixture: fixture,
  }) => {
    const owner = await fixture.createRunFixture("specialist-owner");
    const other = { userId: await fixture.store.createUser("Other member") };
    const workspace = await fixture.createProjectWorkspace(owner.userId, "shared-specialist");
    const platform = new IntegrationPlatformStore(fixture.database);
    const profile = await fixture.store.createBrowserProfile({
      ownerId: other.userId,
      name: "Other person's profile",
      idempotencyKey: "other-profile",
    });
    await fixture.database
      .insertInto("workspaceMemberships")
      .values({
        workspaceId: workspace.id,
        userId: other.userId,
        id: createId("workspaceMembership"),
        role: "collaborator",
        generation: 1,
        invitedBy: owner.userId,
        revokedAt: null,
        revokedBy: null,
        state: "active",
        joinedAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await fixture.store.createBrowserProfileGrant({
      workspaceId: workspace.id,
      createdBy: other.userId,
      profileId: profile.id,
      access: "read-write",
    });
    const installationId = createIntegrationId("installation");
    const connectionId = createIntegrationId("connection");
    await fixture.database
      .insertInto("integrationInstallations")
      .values({
        id: installationId,
        name: "mail",
        title: "Mail",
        description: "Mail",
        version: null,
        sourceKind: "built-in",
        trust: "built-in",
        manifest: sql`'{}'::jsonb`,
        provenance: sql`'{}'::jsonb`,
        status: "active",
        revision: 1,
        createdBy: other.userId,
        updatedBy: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await fixture.database
      .insertInto("integrationConnections")
      .values({
        id: connectionId,
        ownerUserId: other.userId,
        provider: "gmail",
        integrationDefinitionId: "gmail",
        connectionKind: "provider-account",
        connectionMethod: "api-key",
        applicationSource: sql`'{"kind":"api-key"}'::jsonb`,
        authMethodId: "api-key",
        authorizationDigest: "a".repeat(43),
        accountIdentifier: "other@example.com",
        status: "connected",
        displayName: "Other's Gmail",
        capabilities: sql`'[]'::jsonb`,
        grantedScopes: sql`'[]'::jsonb`,
        updatedAt: new Date(),
      })
      .execute();
    await fixture.database
      .insertInto("integrationGrants")
      .values({
        id: createIntegrationId("grant"),
        workspaceId: workspace.id,
        ownerUserId: other.userId,
        installationId,
        connectionId,
        access: "read-write",
        alias: "mail",
        isDefault: true,
        createdBy: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: "active",
      })
      .execute();
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "owner-only",
      actorUserId: owner.userId,
      source: {},
      digest: "a".repeat(64),
      manifest: { name: "owner-only" },
      specialistManifest: SpecialistManifestSchema.parse({
        version: 1,
        models: [ExactModelWantSchema.parse({ engine: "claude", model: "haiku" })],
        access: [
          { type: "browser-profile", level: "read", reason: "Read" },
          { type: "integration", service: "gmail", level: "read", reason: "Read mail" },
        ],
      }),
    });
    expect(
      await platform.specialists.add({
        workspaceId: workspace.id,
        pluginId,
        actorUserId: owner.userId,
      }),
    ).toMatchObject({
      status: "pending",
      ownerUserId: owner.userId,
      access: [
        { binding: null, state: "needs-access", candidates: [] },
        { binding: null, state: "needs-access", candidates: [] },
      ],
    });
    const [registration] = await platform.specialists.list(workspace.id, owner.userId);
    await expect(
      platform.specialists.bind({
        workspaceId: workspace.id,
        specialistId: registration!.id,
        actorUserId: other.userId,
        requirement: 0,
        resourceId: profile.id,
      }),
    ).rejects.toThrow("consent owner");
    const own = await platform.specialists.add({
      workspaceId: workspace.id,
      pluginId,
      actorUserId: other.userId,
    });
    expect(own).toMatchObject({ status: "ready", ownerUserId: other.userId });
    const listed = await platform.specialists.list(workspace.id, other.userId);
    expect(listed).toHaveLength(2);
    expect(listed.find((r) => r.id === registration!.id)).toMatchObject({ canUse: false });
    await expect(
      platform.specialists.assertRunnable(registration!.id, workspace.id, other.userId),
    ).rejects.toThrow("add it for yourself");
  });
});
