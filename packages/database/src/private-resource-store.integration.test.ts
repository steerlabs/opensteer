import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";
import { PrivateResourceStore } from "./private-resource-store.js";
import { listEligibleBrowserRunners } from "./browser-home-store.js";

async function fixture() {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/tmp/private-agent-home");
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", personal.runnerId)
      .execute();
    const passwords = {
      get: vi.fn(async () => ({ loginId: "chosen-login", revision: 3 })),
      revoke: vi.fn(async () => {}),
    };
    const store = new PrivateResourceStore(database, passwords, () => ({}));
    const actor = {
      ownerId: personal.userId,
      deploymentId: personal.deploymentId,
      threadId: null,
      runId: null,
    };
    return {
      database,
      personal,
      passwords,
      store,
      actor,
      close: async () => {
        await database.destroy();
        await clone.drop();
      },
    };
  } catch (error) {
    await database.destroy();
    await clone.drop();
    throw error;
  }
}
it("fences private grants to the personal owner and deployment, with explicit installation consent", async () => {
  const f = await fixture();
  try {
    const installationId = createIntegrationId("installation"),
      serverId = createIntegrationId("server");
    await f.database
      .insertInto("integrationInstallations")
      .values({
        id: installationId,
        name: "local-tool",
        title: "Local tool",
        description: "",
        sourceKind: "built-in",
        trust: "built-in",
        manifest: sql`'{}'::jsonb`,
        provenance: sql`'{}'::jsonb`,
        status: "active",
        revision: 1,
      })
      .execute();
    await f.database
      .insertInto("integrationServers")
      .values({
        id: serverId,
        installationId,
        name: "local",
        transport: sql`'{"type":"in-process"}'::jsonb`,
        connectionRequirement: sql`'{"kind":"none"}'::jsonb`,
        status: "active",
        toolGeneration: 1,
      })
      .execute();
    expect(await f.store.integrationGrants(f.actor)).toEqual([]);
    const grant = {
      installationId,
      connectionId: null,
      access: "read-write" as const,
      alias: "My tool",
      isDefault: true,
    };
    await f.store.setIntegrationGrant(f.actor, grant);
    expect(await f.store.integrationGrants(f.actor)).toEqual([grant]);
    await f.store.setIntegrationGrant(f.actor, { ...grant, access: "read" });
    expect(await f.store.integrationGrants(f.actor)).toEqual([{ ...grant, access: "read" }]);
    await f.store.revokeIntegrationGrant(f.actor, { installationId, connectionId: null });
    expect(await f.store.integrationGrants(f.actor)).toEqual([]);
    await expect(
      f.store.integrationGrants({ ...f.actor, ownerId: createId("user") }),
    ).rejects.toThrow();
    await expect(
      f.store.passwordsGrant(
        { ...f.actor, deploymentId: createId("deployment") },
        "https://example.com",
      ),
    ).rejects.toThrow();
    expect(f.passwords.get).not.toHaveBeenCalled();
    expect(await f.store.passwordsGrant(f.actor, "https://example.com")).toEqual({
      loginId: "chosen-login",
      revision: 3,
    });
    await f.store.revokePasswordsGrant(f.actor, "https://example.com");
    expect(f.passwords.revoke).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
it("keeps profile authority on its exact owner-enrolled computer and cuts it on revocation", async () => {
  const f = await fixture();
  try {
    const profileId = createId("browserProfile"),
      otherComputer = createId("runner");
    await f.database
      .insertInto("browserProfiles")
      .values({
        id: profileId,
        ownerId: f.personal.userId,
        name: "Personal",
        homeRunnerId: f.personal.runnerId,
      })
      .execute();
    expect(
      await f.store.assertBrowserProfile(f.actor, profileId, f.personal.runnerId),
    ).toMatchObject({ homeComputerId: f.personal.runnerId, storageBindingVersion: null });
    await expect(f.store.assertBrowserProfile(f.actor, profileId, otherComputer)).rejects.toThrow();
    await f.database
      .updateTable("browserProfiles")
      .set({
        storageState: "local",
        storageBindingVersion: 1,
        storageDeploymentId: f.personal.deploymentId,
        storageRunnerId: f.personal.runnerId,
        storageInstanceId: "storage-instance",
        storageBindingId: "binding",
        storageEngine: "chromium",
      })
      .where("id", "=", profileId)
      .execute();
    expect(
      (await f.store.assertBrowserProfile(f.actor, profileId, f.personal.runnerId))
        .storageBindingVersion,
    ).toBe(1);

    await f.database
      .updateTable("browserProfiles")
      .set({ storageState: "local", storageRunnerId: otherComputer })
      .where("id", "=", profileId)
      .execute();
    await expect(
      f.store.assertBrowserProfile(f.actor, profileId, f.personal.runnerId),
    ).rejects.toThrow();
    await f.database
      .updateTable("browserProfiles")
      .set({ storageState: "unbound", storageRunnerId: null })
      .where("id", "=", profileId)
      .execute();
    await f.database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", f.personal.runnerId)
      .execute();
    await expect(
      f.store.assertBrowserProfile(f.actor, profileId, f.personal.runnerId),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
it("does not offer another person's computer or an unowned helper as a browser home", async () => {
  const f = await fixture();
  try {
    const outsider = createId("user");
    await f.database
      .insertInto("users")
      .values({
        id: outsider,
        displayName: "Other",
        email: "other@example.invalid",
        emailVerified: true,
      })
      .execute();
    for (const ownerKind of ["user", "deployment"] as const) {
      const id = createId("runner");
      await f.database
        .insertInto("runners")
        .values({
          id,
          ownerKind,
          ownerUserId: ownerKind === "user" ? outsider : null,
          name: "Other computer",
          kind: "managed",
          publicKeyPem: "test",
          publicKeyFingerprint: id,
          enrollmentTokenHash: id,
          capabilities: sql`'[]'::jsonb`,
          allowedModules: sql`'["browser"]'::jsonb`,
          moduleDescriptors: sql`'{}'::jsonb`,
          accessPolicy: sql`'{}'::jsonb`,
          accessPolicyRevision: 1,
          connectionGeneration: 1,
          maxConcurrentRuns: 1,
        })
        .execute();
    }
    expect(
      (await listEligibleBrowserRunners(f.database, f.personal.userId)).map((row) => row.id),
    ).toEqual([f.personal.runnerId]);
  } finally {
    await f.close();
  }
});
