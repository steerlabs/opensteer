import { PluginSettingsStore } from "./plugin-settings-store.js";
import { createId } from "@opensteer/core";
import { RunnerSkillMetadataReportSchema } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { describeStore, enrollTestRunner } from "./store.integration.test-support.js";
import { createTestWorkspace } from "./workspace-fixture.test-support.js";

describeStore("Workspace skill inventory", (it) => {
  it("fences replacement, retains failed scans and authorizes cached reads", async ({
    storeFixture: { store, database },
  }) => {
    const viewer = await store.createUser("Owner");
    const stranger = await store.createUser("Stranger");
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: viewer,
      environmentId,
      runnerId,
      name: "Skills",
      tokenSuffix: randomUUID(),
    });
    const workspace = await createTestWorkspace(store, {
      createdBy: viewer,
      name: "Skills",
      kind: "project",
      status: "ready",
      idempotencyKey: randomUUID(),
      backing: {
        kind: "local-directory",
        bindingId: createId("workspaceBinding"),
        generation: 1,
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
    });
    const runner = await database
      .selectFrom("runners")
      .select("connectionGeneration")
      .where("id", "=", runnerId)
      .executeTakeFirstOrThrow();
    const report = RunnerSkillMetadataReportSchema.parse({
      type: "runner.skills.report",
      runnerId,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: Number(runner.connectionGeneration),
      environmentId,
      storageAuthorityId: workspace.backing.storageAuthorityId,
      binding: {
        bindingId: workspace.backing.bindingId,
        generation: 1,
        ownerEnvironmentId: environmentId,
        storageAuthorityId: workspace.backing.storageAuthorityId,
        workspaceId: workspace.id,
      },
      scanSequence: 1,
      scannedAt: new Date().toISOString(),
      result: {
        status: "complete",
        warnings: [],
        skills: [{ fullName: "release", description: "Release", digest: "a".repeat(64) }],
      },
    });
    const fence = {
      environmentId,
      storageAuthorityId: report.storageAuthorityId,
      runnerId,
      bootId: report.bootId,
      connectionId: report.connectionId,
      connectionLeaseId: report.connectionLeaseId,
      connectionGeneration: report.connectionGeneration,
    };
    expect(await store.reportWorkspaceSkills(fence, report)).toBe(true);
    expect(await store.reportWorkspaceSkills(fence, report)).toBe(false);
    const settings = new PluginSettingsStore(database);
    expect(await settings.affectedViewers({ workspaceId: workspace.id })).toEqual([viewer]);
    expect(await settings.affectedViewers({ runnerId })).toEqual([viewer]);
    expect(await settings.workspaceSkillPolicy(workspace.id, viewer)).toBeUndefined();
    const target = { kind: "skill" as const, workspaceId: workspace.id, fullName: "release" };
    expect((await settings.overview(stranger)).rows).toEqual([]);
    expect((await settings.overview(viewer, new Set())).rows).toMatchObject([
      { target, issues: ["waiting-device"] },
    ]);
    await settings.setEnabled(viewer, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: 0,
      enabled: false,
      idempotencyKey: "skill-off",
    });
    expect(await settings.workspaceSkillPolicy(workspace.id, viewer)).toEqual({
      revision: 1,
      disabledFullNames: ["release"],
    });
    expect(await settings.workspaceSkillPolicy(workspace.id, stranger)).toBeUndefined();
    expect((await settings.detail(viewer, target)).row.placement.enabled).toBe(false);
    await settings.setEnabled(viewer, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: 1,
      enabled: true,
      idempotencyKey: "skill-on",
    });
    expect(await settings.workspaceSkillPolicy(workspace.id, viewer)).toEqual({
      revision: 2,
      disabledFullNames: [],
    });

    expect(await store.listWorkspaceSkillInventory(stranger, [workspace.id])).toEqual([]);
    expect((await store.listWorkspaceSkillInventory(viewer, [workspace.id]))[0]?.skills).toEqual(
      report.result.status === "complete" ? report.result.skills : [],
    );
    expect(
      await store.reportWorkspaceSkills(
        {
          ...fence,
          bootId: RunnerSkillMetadataReportSchema.parse({
            ...report,
            bootId: `rbt_${randomUUID()}`,
          }).bootId,
        },
        { ...report, scanSequence: 2 },
      ),
    ).toBe(false);
    expect(
      await store.reportWorkspaceSkills(fence, {
        ...report,
        scanSequence: 2,
        result: { status: "failed", reason: "unreadable" },
      }),
    ).toBe(true);
    expect((await store.listWorkspaceSkillInventory(viewer, [workspace.id]))[0]).toMatchObject({
      scanStatus: "failed",
      stale: true,
      skills: [{ fullName: "release" }],
    });
    expect(
      await store.reportWorkspaceSkills(fence, {
        ...report,
        scanSequence: 3,
        result: { status: "complete", warnings: [], skills: [] },
      }),
    ).toBe(true);
    expect((await store.listWorkspaceSkillInventory(viewer, [workspace.id]))[0]?.skills).toEqual(
      [],
    );
    await database
      .updateTable("workspaces")
      .set({ backing: { ...workspace.backing, generation: 2 } })
      .where("id", "=", workspace.id)
      .execute();
    expect(await store.reportWorkspaceSkills(fence, { ...report, scanSequence: 4 })).toBe(false);
    expect(
      await store.reportWorkspaceSkills(fence, {
        ...report,
        binding: { ...report.binding, generation: 2 },
        scanSequence: 4,
      }),
    ).toBe(true);
    expect(await store.reportWorkspaceSkills(fence, { ...report, scanSequence: 99 })).toBe(false);
    await database
      .updateTable("runners")
      .set({ connectionGeneration: Number(runner.connectionGeneration) + 1 })
      .where("id", "=", runnerId)
      .execute();
    expect(await store.reportWorkspaceSkills(fence, { ...report, scanSequence: 4 })).toBe(false);
    const replacementEnvironmentId = createId("environment");
    const replacementRunnerId = createId("runner");
    await enrollTestRunner(store, {
      createdBy: viewer,
      environmentId: replacementEnvironmentId,
      runnerId: replacementRunnerId,
      runnerKind: "local",
      name: "Replacement",
      tokenSuffix: randomUUID(),
    });
    const replacementRunner = await database
      .selectFrom("runners")
      .select("connectionGeneration")
      .where("id", "=", replacementRunnerId)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("workspaces")
      .set({
        backing: {
          ...workspace.backing,
          generation: 3,
          ownerEnvironmentId: replacementEnvironmentId,
        },
      })
      .where("id", "=", workspace.id)
      .execute();
    const replacement = RunnerSkillMetadataReportSchema.parse({
      ...report,
      runnerId: replacementRunnerId,
      environmentId: replacementEnvironmentId,
      bootId: `rbt_${randomUUID()}`,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      connectionGeneration: Number(replacementRunner.connectionGeneration),
      binding: { ...report.binding, generation: 3, ownerEnvironmentId: replacementEnvironmentId },
    });
    const replacementFence = {
      ...fence,
      runnerId: replacementRunnerId,
      environmentId: replacementEnvironmentId,
      bootId: replacement.bootId,
      connectionId: replacement.connectionId,
      connectionLeaseId: replacement.connectionLeaseId,
      connectionGeneration: replacement.connectionGeneration,
    };
    expect(
      await store.reportWorkspaceSkills(replacementFence, {
        ...replacement,
        result: { status: "failed", reason: "unavailable" },
      }),
    ).toBe(true);
    expect((await store.listWorkspaceSkillInventory(viewer, [workspace.id]))[0]).toMatchObject({
      ownerRunnerId: runnerId,
      stale: true,
    });
    expect(
      await store.reportWorkspaceSkills(replacementFence, { ...replacement, scanSequence: 2 }),
    ).toBe(true);
    expect(await store.reportWorkspaceSkills(fence, { ...report, scanSequence: 100 })).toBe(false);
    expect(
      await store.reportWorkspaceSkills(
        { ...fence, connectionGeneration: Number(runner.connectionGeneration) + 1 },
        {
          ...report,
          connectionGeneration: Number(runner.connectionGeneration) + 1,
          scanSequence: 101,
        },
      ),
    ).toBe(false);
    expect(
      (await store.listWorkspaceSkillInventory(viewer, [workspace.id]))[0]?.ownerRunnerId,
    ).toBe(replacementRunnerId);
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: workspace.id,
        userId: stranger,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: viewer,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    expect(await store.listWorkspaceSkillInventory(stranger, [workspace.id])).toHaveLength(1);
    await database
      .updateTable("workspaceMemberships")
      .set({ state: "revoked", revokedAt: new Date(), revokedBy: viewer })
      .where("workspaceId", "=", workspace.id)
      .where("userId", "=", stranger)
      .execute();
    expect(await store.listWorkspaceSkillInventory(stranger, [workspace.id])).toEqual([]);
    await database
      .updateTable("workspaces")
      .set({
        status: "deleting",
        deletionRequestedAt: new Date(),
        deletionRequestedBy: viewer,
        purgeAfter: new Date(),
      })
      .where("id", "=", workspace.id)
      .execute();
    expect(
      await store.reportWorkspaceSkills(replacementFence, { ...replacement, scanSequence: 3 }),
    ).toBe(false);
    expect(await store.listWorkspaceSkillInventory(viewer, [workspace.id])).toEqual([]);
  });
});
