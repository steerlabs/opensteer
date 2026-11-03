import { createIntegrationId } from "@opensteer/integration-core";
import { sql } from "kysely";
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
    const run = await fixture.startRunFixture("specialist-" + randomUUID());
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
        models: [{ engine: "claude", model: "haiku" }],
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
      .execute();
    expect((await platform.specialists.list(workspace.id, owner.userId))[0]).toMatchObject({
      status: "pending",
      access: [{ state: "needs-access" }],
    });
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
        models: [{ engine: "claude", model: "haiku" }],
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
    await expect(
      platform.specialists.add({ workspaceId: workspace.id, pluginId, actorUserId: other.userId }),
    ).rejects.toThrow("consent owner");
  });
});
