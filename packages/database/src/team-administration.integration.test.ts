import { randomUUID } from "node:crypto";
import { createId, type AccessMutation } from "@opensteer/core";
import { expect } from "vitest";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import { mutateAccess, previewAccess } from "./access-store.js";

async function setup(fixture: StoreFixture) {
  const run = await fixture.createRunFixture("team-administration", null, "project");
  await fixture.database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
  await fixture.database
    .updateTable("users")
    .set({ admittedAt: new Date(), instanceRole: "administrator" })
    .where("id", "=", run.userId)
    .execute();
  await fixture.database
    .insertInto("accessEntries")
    .values({
      id: randomUUID(),
      subjectKind: "user",
      subjectId: run.userId,
      targetKind: "project",
      targetId: run.workspace.id,
      level: "manage",
      grantedBy: run.userId,
      revokedBy: null,
    })
    .execute();
  const actor = { userId: run.userId };
  const input = (changes: readonly AccessMutation[], revision: number) => ({
    actor,
    expectedRevision: revision,
    commandIdentity: createId("command"),
    changes,
  });
  return { ...run, actor, input };
}

describeStore("dormant team administration", (it) => {
  it("shares preview and apply planning, preserves surviving access, and leaves no preview writes", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    const database = storeFixture.database;
    const person = await storeFixture.store.createUser("Invited person");
    const groupId = randomUUID();
    const parentId = randomUUID();
    const directId = randomUUID();
    const groupEntry = randomUUID();
    await mutateAccess(
      database,
      prepared.input(
        [
          { kind: "member", userId: person, admit: true },
          { kind: "create-group", id: groupId, name: "Nested" },
          { kind: "create-group", id: parentId, name: "Parent" },
          { kind: "add-group-member", groupId, member: { kind: "person", userId: person } },
          { kind: "add-group-member", groupId: parentId, member: { kind: "group", groupId } },
          {
            kind: "grant",
            id: groupEntry,
            subject: { kind: "group", groupId: parentId },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "use",
          },
          {
            kind: "grant",
            id: directId,
            subject: { kind: "person", userId: person },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "manage",
          },
        ],
        1,
      ),
    );
    const change = prepared.input(
      [
        { kind: "revoke", entryId: directId },
        { kind: "rename-group", groupId, name: "Renamed" },
      ],
      2,
    );
    const auditBefore = await database.selectFrom("securityAudit").selectAll().execute();
    const preview = await previewAccess(database, change);
    expect(preview).toMatchObject({
      allowed: true,
      accessRevision: 2,
      counts: { peopleGaining: 0, peopleLosing: 0, levelChanges: 1 },
    });
    expect(preview.changes).toEqual([
      {
        user: { id: person, name: "Invited person" },
        project: { kind: "project", workspaceId: prepared.workspace.id },
        before: "manage",
        after: "use",
      },
    ]);
    expect(await database.selectFrom("securityAudit").selectAll().execute()).toEqual(auditBefore);
    expect((await mutateAccess(database, change)).transitions).toMatchObject([
      { userId: person, state: "active", role: "collaborator" },
    ]);
    expect(await previewAccess(database, change)).toMatchObject({
      allowed: false,
      blockers: [{ reason: "access-revision-changed" }],
    });
    const removeGroup = prepared.input(
      [{ kind: "remove-group-member", groupId, member: { kind: "person", userId: person } }],
      3,
    );
    expect(await previewAccess(database, removeGroup)).toMatchObject({
      allowed: true,
      counts: { peopleLosing: 1 },
    });
    await mutateAccess(database, removeGroup);
    expect(
      await database
        .selectFrom("workspaceMemberships")
        .select("state")
        .where("userId", "=", person)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "revoked" });
  });

  it("protects the final active administrator using the final batch state and never resets generations", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    const database = storeFixture.database;
    const demote = prepared.input(
      [{ kind: "member", userId: prepared.userId, administrator: false }],
      1,
    );
    expect(await previewAccess(database, demote)).toMatchObject({
      allowed: false,
      blockers: [{ reason: "last-active-admin" }],
    });
    await expect(mutateAccess(database, demote)).rejects.toMatchObject({
      code: "conflict",
      reason: "last-active-admin",
    });
    const second = await storeFixture.store.createUser("Second administrator");
    await mutateAccess(
      database,
      prepared.input(
        [
          { kind: "member", userId: second, admit: true, administrator: true },
          { kind: "member", userId: prepared.userId, administrator: false },
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "person", userId: second },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "manage",
          },
        ],
        1,
      ),
    );
    expect(
      await database
        .selectFrom("users")
        .select("authorityGeneration")
        .where("id", "=", prepared.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ authorityGeneration: "2" });
    const secondActor = { userId: second, authorityGeneration: 2 };
    const mutate = (change: AccessMutation, expectedRevision: number) =>
      mutateAccess(database, {
        actor: secondActor,
        expectedRevision,
        commandIdentity: createId("command"),
        changes: [change],
      });
    await mutate({ kind: "member", userId: prepared.userId, memberState: "suspended" }, 2);
    await mutate({ kind: "member", userId: prepared.userId, memberState: "active" }, 3);
    await mutate({ kind: "member", userId: prepared.userId, memberState: "removed" }, 4);
    await expect(
      mutate({ kind: "member", userId: prepared.userId, memberState: "active" }, 5),
    ).rejects.toMatchObject({ reason: "member-removed" });
    expect(
      await database
        .selectFrom("users")
        .select(["memberState", "authorityGeneration"])
        .where("id", "=", prepared.userId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ memberState: "removed", authorityGeneration: "5" });
  });
});
