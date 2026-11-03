import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { createId, SpecialistManifestSchema } from "@opensteer/core";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { resolveResourceAccess } from "./resource-access.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("specialist registration", (test) => {
  test("pins versions, binds consent, narrows access and removes registration", async ({
    storeFixture: fixture,
  }) => {
    const run = await fixture.createRunFixture("specialist-" + randomUUID());
    const workspace = await fixture.createProjectWorkspace(run.userId, "specialist");
    const platform = new IntegrationPlatformStore(fixture.database);
    const pluginId = randomUUID();
    const manifest = SpecialistManifestSchema.parse({
      version: 1,
      models: [{ engine: "claude", model: "haiku" }],
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
    await fixture.store.createBrowserProfileGrant({
      workspaceId: workspace.id,
      createdBy: run.userId,
      profileId: profile.id,
      access: "read-write",
    });
    const ready = await platform.specialists.refresh(pending.id);
    expect(ready.status).toBe("ready");
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
      specialistManifest: { ...manifest, models: [{ engine: "codex", model: "fast" }] },
    });
    expect((await platform.specialists.list(workspace.id, run.userId))[0]?.pluginVersionId).toBe(
      version.id,
    );
    const updated = await add();
    expect(updated.id).toBe(pending.id);
    expect(updated.pluginVersionId).not.toBe(version.id);
    expect(updated.models[0]?.engine).toBe("codex");
    await fixture.database
      .updateTable("browserProfileGrants")
      .set({ revokedAt: new Date() })
      .where("profileId", "=", profile.id)
      .where("workspaceId", "=", workspace.id)
      .execute();
    // A stale ready row cannot preserve withdrawn Workspace consent.
    expect((await check(profile.id)).access).toBeNull();
    expect((await platform.specialists.refresh(pending.id)).status).toBe("pending");
    await platform.specialists.remove({
      workspaceId: workspace.id,
      specialistId: pending.id,
      actorUserId: run.userId,
    });
    expect(await platform.specialists.list(workspace.id, run.userId)).toEqual([]);
    expect((await check(profile.id)).access).toBeNull();
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
        models: [{ engine: "claude", model: "haiku" }],
        access: [{ type: "browser-profile", level: "read", reason: "Read" }],
      }),
    });
    expect(
      await platform.specialists.add({
        workspaceId: workspace.id,
        pluginId,
        actorUserId: owner.userId,
      }),
    ).toMatchObject({ status: "pending", ownerUserId: owner.userId, access: [{ binding: null }] });
    await expect(
      platform.specialists.add({ workspaceId: workspace.id, pluginId, actorUserId: other.userId }),
    ).rejects.toThrow("consent owner");
  });
});
