import { createProjectIdentityFixture } from "./project-work.test-support.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createId, type AccessMutation, type UserId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { describeStore, type StoreFixture } from "./store.integration.test-support.js";
import {
  acceptTeamInvitation,
  mutateAccess,
  previewAccess,
  previewMemberAccess,
} from "./access-store.js";
import { TeamAccessReadStore } from "./team-access-read-store.js";
import { teamAdministrationMigration } from "./team-administration-migration.js";

async function prepare(fixture: StoreFixture) {
  const run = await createProjectIdentityFixture(fixture, "team-regressions");
  const database = fixture.database;
  await database
    .updateTable("users")
    .set({ admittedAt: new Date(), instanceRole: "administrator" })
    .where("id", "=", run.userId)
    .execute();
  const ownerEntryId = randomUUID();
  await database
    .insertInto("accessEntries")
    .values({
      id: ownerEntryId,
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
  const input = (
    changes: readonly AccessMutation[],
    expectedRevision: number,
    userId = run.userId,
  ) => ({ actor: { userId }, changes, expectedRevision, commandIdentity: createId("command") });
  return { ...run, database, actor, ownerEntryId, input };
}

async function admit(fixture: StoreFixture, name: string) {
  const userId = await fixture.store.createUser(name);
  await fixture.database
    .updateTable("users")
    .set({ admittedAt: new Date() })
    .where("id", "=", userId)
    .execute();
  return userId;
}

describeStore("team administration review regressions", (it) => {
  it("explains computed Everyone membership, including nesting, but excludes guests", async ({
    storeFixture,
  }) => {
    const p = await prepare(storeFixture);
    const full = await admit(storeFixture, "Full member");
    const guest = await admit(storeFixture, "Guest");
    await p.database
      .updateTable("users")
      .set({ memberKind: "guest" })
      .where("id", "=", guest)
      .execute();
    const everyone = { id: randomUUID() };
    await p.database
      .insertInto("accessGroups")
      .values({ id: everyone.id, name: "Everyone", builtin: "everyone", createdBy: p.userId })
      .execute();
    const parent = randomUUID();
    await mutateAccess(
      p.database,
      p.input(
        [
          { kind: "create-group", id: parent, name: "Parent" },
          {
            kind: "add-group-member",
            groupId: parent,
            member: { kind: "group", groupId: everyone.id },
          },
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "group", groupId: everyone.id },
            target: { kind: "project", workspaceId: p.workspace.id },
            level: "use",
          },
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "group", groupId: parent },
            target: { kind: "project", workspaceId: p.workspace.id },
            level: "use",
          },
        ],
        1,
      ),
    );
    const reads = new TeamAccessReadStore(p.database);
    const explanation = await reads.explain(p.actor, {
      workspaceId: p.workspace.id,
      subject: { kind: "person", userId: full },
    });
    expect(explanation.effectiveLevel).toBe("use");
    expect(explanation.entries).toHaveLength(2);
    expect(explanation.edges).toEqual(
      expect.arrayContaining([
        { groupId: everyone.id, member: { kind: "person", userId: full } },
        { groupId: parent, member: { kind: "group", groupId: everyone.id } },
      ]),
    );
    const excluded = await reads.explain(p.actor, {
      workspaceId: p.workspace.id,
      subject: { kind: "person", userId: guest },
    });
    expect(excluded.effectiveLevel).toBeNull();
    expect(excluded.entries).toEqual([]);
    expect(excluded.edges).toEqual([]);
  });

  it("removes explicit sources atomically and never restores them on a guest reinvitation", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    const { database } = prepared;
    const person = await admit(storeFixture, "Returning person");
    await database
      .updateTable("users")
      .set({ email: "returning@teams.test", emailVerified: true })
      .where("id", "=", person)
      .execute();
    const directId = randomUUID();
    const child = randomUUID();
    const parent = randomUUID();
    await mutateAccess(
      database,
      prepared.input(
        [
          { kind: "create-group", id: child, name: "Child" },
          { kind: "create-group", id: parent, name: "Parent" },
          { kind: "add-group-member", groupId: child, member: { kind: "person", userId: person } },
          { kind: "add-group-member", groupId: parent, member: { kind: "group", groupId: child } },
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "group", groupId: parent },
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
    await mutateAccess(
      database,
      prepared.input([{ kind: "member", userId: person, memberState: "suspended" }], 2),
    );
    expect(
      await database
        .selectFrom("accessEntries")
        .select("revokedAt")
        .where("id", "=", directId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revokedAt: null });
    await mutateAccess(
      database,
      prepared.input([{ kind: "member", userId: person, memberState: "active" }], 3),
    );
    const removal = prepared.input([{ kind: "member", userId: person, memberState: "removed" }], 4);
    expect(await previewAccess(database, removal)).toMatchObject({
      allowed: true,
      counts: { peopleLosing: 1 },
      changes: [{ user: { id: person }, before: "manage", after: null }],
      surviving: [],
    });
    await mutateAccess(database, removal);
    const now = new Date();
    const expires = new Date(now.getTime() + 600_000);
    const selector = randomBytes(24).toString("base64url");
    await database
      .insertInto("teamInvitations")
      .values({
        id: randomUUID(),
        selector,
        tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"),
        intendedEmail: "returning@teams.test",
        memberKind: "guest",
        createdBy: prepared.userId,
        createdAt: now,
        expiresAt: expires,
        acceptedAt: null,
        acceptedBy: null,
        revokedAt: null,
        revokedBy: null,
        commandId: "rejoin",
        requestFingerprint: "rejoin",
      })
      .execute();
    const sessionId = createId("authSession");
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId,
        userId: person,
        memberGeneration: (
          await database
            .selectFrom("users")
            .select("authorityGeneration")
            .where("id", "=", person)
            .executeTakeFirstOrThrow()
        ).authorityGeneration,
        token: randomBytes(32).toString("hex"),
        expiresAt: expires,
        absoluteExpiresAt: expires,
        ipAddress: null,
        userAgent: null,
        deviceLabel: "test",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const admissionId = createId("authAdmission");
    const browserNonce = randomBytes(32).toString("base64url");
    await database
      .insertInto("authAdmissions")
      .values({
        id: admissionId,
        purpose: "invitation",
        subjectSelector: selector,
        browserNonceHash: createHash("sha256").update(browserNonce).digest("hex"),
        reservedEmail: "returning@teams.test",
        reservedAt: now,
        expiresAt: expires,
        consumedAt: null,
        consumedBy: null,
        createdAt: now,
      })
      .execute();
    await acceptTeamInvitation(database, { admissionId, browserNonce, sessionId, userId: person });
    expect(
      await database
        .selectFrom("workspaceMemberships")
        .select(["state", "generation"])
        .where("userId", "=", person)
        .where("workspaceId", "=", prepared.workspace.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "revoked", generation: "4" });
    expect(
      await database
        .selectFrom("accessEntries")
        .select(["revokedAt", "revokedBy"])
        .where("id", "=", directId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revokedAt: expect.any(Date), revokedBy: prepared.userId });
    expect(
      await database
        .selectFrom("accessGroupMembers")
        .selectAll()
        .where("memberKind", "=", "user")
        .where("memberId", "=", person)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom("users")
        .select(["memberKind", "authorityGeneration"])
        .where("id", "=", person)
        .executeTakeFirstOrThrow(),
    ).toEqual({ memberKind: "guest", authorityGeneration: "5" });
    const audit = await database
      .selectFrom("securityAudit")
      .select("metadata")
      .where("requestId", "=", removal.commandIdentity)
      .executeTakeFirstOrThrow();
    expect(audit.metadata.changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        before: expect.objectContaining({ id: directId }),
        after: null,
      }),
    );
    expect(audit.metadata.removedGroupMemberships).toEqual([{ groupId: child, userId: person }]);
  });

  it("authorizes before target-dependent planning and keeps preview/apply refusals identical", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    const caller = await admit(storeFixture, "Plain member");
    const removed = await admit(storeFixture, "Removed member");
    await prepared.database
      .updateTable("users")
      .set({ memberState: "removed" })
      .where("id", "=", removed)
      .execute();
    for (const target of [removed, prepared.userId, createId("user")]) {
      const change = prepared.input(
        [{ kind: "member", userId: target, memberState: "active" }],
        1,
        caller,
      );
      expect(await previewAccess(prepared.database, change)).toMatchObject({
        allowed: false,
        blockers: [{ reason: "team-admin-required" }],
      });
      await expect(mutateAccess(prepared.database, change)).rejects.toMatchObject({
        code: "forbidden",
        reason: "team-admin-required",
      });
    }
  });

  it("promotes a replacement manager before reductions and permits a managerless Project", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    const replacement = await admit(storeFixture, "Replacement manager");
    const useId = randomUUID();
    await mutateAccess(
      prepared.database,
      prepared.input(
        [
          {
            kind: "grant",
            id: useId,
            subject: { kind: "person", userId: replacement },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "use",
          },
        ],
        1,
      ),
    );
    const handover = prepared.input(
      [
        { kind: "revoke", entryId: prepared.ownerEntryId },
        { kind: "revoke", entryId: useId },
        {
          kind: "grant",
          id: randomUUID(),
          subject: { kind: "person", userId: replacement },
          target: { kind: "project", workspaceId: prepared.workspace.id },
          level: "manage",
        },
      ],
      2,
    );
    expect(await previewAccess(prepared.database, handover)).toMatchObject({ allowed: true });
    await expect(mutateAccess(prepared.database, handover)).resolves.toMatchObject({ revision: 3 });
    const sources = await prepared.database
      .selectFrom("accessEntries")
      .select("id")
      .where("subjectId", "=", replacement)
      .where("revokedAt", "is", null)
      .execute();
    const managerless = prepared.input(
      sources.map(({ id }) => ({ kind: "revoke", entryId: id })),
      3,
    );
    expect(await previewAccess(prepared.database, managerless)).toMatchObject({
      allowed: true,
    });
    await expect(mutateAccess(prepared.database, managerless)).resolves.toMatchObject({
      revision: 4,
    });
  });

  it("audits ordinary administrator self-appointment and Project-filtered group effects", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    const administrator = await admit(storeFixture, "Administrator without access");
    await prepared.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", administrator)
      .execute();
    const appointment = prepared.input(
      [
        {
          kind: "grant",
          id: randomUUID(),
          subject: { kind: "person", userId: administrator },
          target: { kind: "project", workspaceId: prepared.workspace.id },
          level: "manage",
        },
      ],
      1,
      administrator,
    );
    await mutateAccess(prepared.database, appointment);
    const entry = await prepared.database
      .selectFrom("accessEntries")
      .select(["subjectId", "grantedBy"])
      .where("subjectId", "=", administrator)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({ subjectId: administrator, grantedBy: administrator });
    const groupId = randomUUID();
    await mutateAccess(
      prepared.database,
      prepared.input(
        [
          { kind: "create-group", id: groupId, name: "Project group" },
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "group", groupId },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "use",
          },
        ],
        2,
      ),
    );
    await mutateAccess(
      prepared.database,
      prepared.input([{ kind: "rename-group", groupId, name: "Renamed group" }], 3),
    );
    const result = await new TeamAccessReadStore(prepared.database).audit(prepared.actor, {
      target: { workspaceId: prepared.workspace.id },
    });
    expect(result.items).toHaveLength(3);
    expect(result.items.find((row) => row.actor?.id === administrator)).toMatchObject({
      actor: { id: administrator },
      target: { kind: "project", id: prepared.workspace.id, name: prepared.workspace.name },
      changes: [{ kind: "entry", after: { subject: { userId: administrator }, level: "manage" } }],
    });
    expect(result.items.every((row) => row.target !== null)).toBe(true);

    // Removing a suspended person changes no effective access, only sources: still this Project's audit.
    const person = await admit(storeFixture, "Suspended then removed");
    await mutateAccess(
      prepared.database,
      prepared.input(
        [
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "person", userId: person },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "use",
          },
          { kind: "add-group-member", groupId, member: { kind: "person", userId: person } },
        ],
        4,
      ),
    );
    for (const [memberState, revision] of [
      ["suspended", 5],
      ["removed", 6],
    ] as const)
      await mutateAccess(
        prepared.database,
        prepared.input([{ kind: "member", userId: person, memberState }], revision),
      );
    const scoped = await new TeamAccessReadStore(prepared.database).audit(prepared.actor, {
      target: { workspaceId: prepared.workspace.id },
    });
    expect(scoped.items.filter((row) => row.target?.id === person)).toHaveLength(2);
  });

  it("counts distinct people across Projects without losing per-Project preview detail", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    const person = await admit(storeFixture, "Two Projects");
    const secondId = createId("workspace");
    await mutateAccess(
      prepared.database,
      prepared.input(
        [
          {
            kind: "create-project",
            workspaceId: secondId,
            entryId: randomUUID(),
            name: "Second",
            color: "blue",
            backing: {
              kind: "local-directory",
              generation: 1,
              bindingId: createId("workspaceBinding"),
              ownerEnvironmentId: prepared.environmentId,
              storageAuthorityId: null,
            },
          },
        ],
        1,
      ),
    );
    const grants: AccessMutation[] = [prepared.workspace.id, secondId].map((workspaceId) => ({
      kind: "grant",
      id: randomUUID(),
      subject: { kind: "person", userId: person },
      target: { kind: "project", workspaceId },
      level: "use",
    }));
    expect(await previewAccess(prepared.database, prepared.input(grants, 2))).toMatchObject({
      counts: { peopleGaining: 1 },
      changes: [expect.anything(), expect.anything()],
    });
    await mutateAccess(prepared.database, prepared.input(grants, 2));
    expect(
      await previewAccess(
        prepared.database,
        prepared.input([{ kind: "member", userId: person, memberState: "suspended" }], 3),
      ),
    ).toMatchObject({
      counts: { peopleLosing: 1 },
      changes: [expect.anything(), expect.anything()],
    });
    expect(
      await previewMemberAccess(
        prepared.database,
        prepared.input([{ kind: "member", userId: person, memberState: "suspended" }], 3),
      ),
    ).toMatchObject({ allowed: true, projectsLosing: 2, projectsChangingLevel: 0 });
  });

  it("pages Unicode names using the SQL sort key and collation without skipping rows", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    const names = ["İ", "İx", "ẞ", "ß", "Σ", "σ", "ς", "I", "i", "é", "É"];
    const people = await Promise.all(names.map((name) => admit(storeFixture, name)));
    const groups = names.map((name, index) => ({
      id: randomUUID(),
      name: `${name}${index}`,
      createdBy: prepared.userId,
    }));
    await prepared.database.insertInto("accessGroups").values(groups).execute();
    const reads = new TeamAccessReadStore(prepared.database);
    const expected = (
      await sql<{
        id: UserId;
        sort: string;
      }>`select id, lower(display_name collate "C") collate "C" as sort from users where admitted_at is not null order by sort, id collate "C"`.execute(
        prepared.database,
      )
    ).rows;
    const actual: UserId[] = [];
    let cursor: string | undefined;
    for (let page = 0; page <= expected.length; page++) {
      const result = await reads.people(prepared.actor, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(JSON.stringify(result)).not.toContain("sortKey");
      actual.push(...result.items.map((row) => row.id));
      if (!result.nextCursor) break;
      const body = JSON.parse(
        Buffer.from(result.nextCursor.split(".")[0]!, "base64url").toString("utf8"),
      );
      expect(body.sort).toBe(expected.find((row) => row.id === result.items[0]!.id)!.sort);
      cursor = result.nextCursor;
    }
    expect(actual).toEqual(expected.map((row) => row.id));
    const expectedGroups = (
      await sql<{
        id: string;
      }>`select id from access_groups where deleted_at is null order by lower(name collate "C") collate "C", id::text collate "C"`.execute(
        prepared.database,
      )
    ).rows;
    const actualGroups: string[] = [];
    cursor = undefined;
    for (let page = 0; page <= expectedGroups.length; page++) {
      const result = await reads.groups(prepared.actor, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      if (!("items" in result)) throw new Error("Expected groups page");
      actualGroups.push(...result.items.map((row) => row.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(actualGroups).toEqual(expectedGroups.map((row) => row.id));
    expect(people).toHaveLength(names.length);
  });

  it("adds dormant credential checks without scanning existing rows and still checks new writes", async ({
    storeFixture,
  }) => {
    const prepared = await prepare(storeFixture);
    await prepared.database.transaction().execute(async (transaction) => {
      await sql`drop table team_invitations; alter table auth_sessions drop column member_generation; alter table agent_connections drop column member_generation, drop column membership_generation`.execute(
        transaction,
      );
      await sql`insert into auth_sessions (id, user_id, token, expires_at, absolute_expires_at, device_label, created_at, updated_at, last_seen_at) select 'ses_' || item, ${prepared.userId}, 'token_' || item, now() + interval '1 day', now() + interval '1 day', 'test', now(), now(), now() from generate_series(1, 100) item`.execute(
        transaction,
      );
      await sql`insert into agent_connections (id, user_id, label, client_name, access_mode, resource, workspace_id, expires_at, created_at) select 'mcn_' || gen_random_uuid()::text, ${prepared.userId}, 'test', 'test', 'full-access', 'test', ${prepared.workspace.id}, now() + interval '1 day', now() from generate_series(1, 100) item`.execute(
        transaction,
      );
      const scans = async () =>
        (
          await sql<{
            sessions: number;
            connections: number;
          }>`select pg_stat_get_xact_numscans('auth_sessions'::regclass)::int as sessions, pg_stat_get_xact_numscans('agent_connections'::regclass)::int as connections`.execute(
            transaction,
          )
        ).rows[0]!;
      const before = await scans();
      await teamAdministrationMigration.up(transaction);
      expect(await scans()).toEqual(before);
      const checks = (
        await sql<{
          convalidated: boolean;
        }>`select convalidated from pg_constraint where conrelid in ('auth_sessions'::regclass, 'agent_connections'::regclass) and conname in ('auth_sessions_member_generation_bounds', 'agent_connections_member_generation_bounds', 'agent_connections_membership_generation_bounds')`.execute(
          transaction,
        )
      ).rows;
      expect(checks).toEqual([
        { convalidated: false },
        { convalidated: false },
        { convalidated: false },
      ]);
    });
    await prepared.database.updateTable("agentConnections").set({ workspaceId: null }).execute();
    await expect(
      prepared.database.updateTable("authSessions").set({ memberGeneration: "0" }).execute(),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      prepared.database
        .updateTable("agentConnections")
        .set({ membershipGeneration: "1" })
        .execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
