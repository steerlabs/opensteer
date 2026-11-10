import { hostApiVersion } from "@opensteer/deployment-authority";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { mutateAccess, TeamAccessReadStore } from "@opensteer/database";
import { describeStore, type StoreFixture } from "@opensteer/database/test-support/store";
import { IdentityService } from "@opensteer/identity";
import {
  TeamSummarySchema,
  MemberDetailSchema,
  AccessExplanationSchema,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import { createHostServer } from "../server.js";
import { HostAuthenticator } from "../identity/auth.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { hostServerTestDependencies } from "../server/host-server-test-harness.js";
import { injectRpcRequest } from "../server/test-host-api-request.js";
import { testHostApiContext } from "../server/test-host-api-context.js";
import { TeamAdministrationService } from "./team-administration-service.js";

const origin = "http://127.0.0.1:4310";
async function setup(fixture: StoreFixture) {
  const run = await fixture.createRunFixture("team-host", null, "project");
  const database = fixture.database;
  const identity = new IdentityService(database, {
    deployment: { kind: "self-hosted", name: null },
    localPasswordEnabled: true,
    oidcProviders: [],
    publicOrigin: new URL(origin),
    secret: "team-test-secret-at-least-thirty-two-bytes",
    exposure: "networked",
    signupPolicy: "open",
  });
  const signup = async (name: string) => {
    const result = await identity.signUpPassword(
      { displayName: name, email: `${name}@team.test`, password: "a correct test password" },
      new Headers({ origin }),
    );
    const cookie = result.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0]!)
      .join("; ");
    return { session: result.data.session, cookie };
  };
  const admin = await signup("administrator");
  const manager = await signup("manager");
  const pending = await signup("pending");
  await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
  await database
    .updateTable("users")
    .set({ admittedAt: new Date(), instanceRole: "administrator" })
    .where("id", "=", run.userId)
    .execute();
  await database
    .updateTable("users")
    .set({ admittedAt: new Date(), instanceRole: "administrator" })
    .where("id", "=", admin.session.user.id)
    .execute();
  await database
    .updateTable("users")
    .set({ admittedAt: new Date() })
    .where("id", "=", manager.session.user.id)
    .execute();
  await database
    .updateTable("users")
    .set({ emailVerified: true })
    .where("id", "=", pending.session.user.id)
    .execute();
  await database
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
  await mutateAccess(database, {
    actor: { userId: run.userId },
    expectedRevision: 1,
    commandIdentity: createId("command"),
    changes: [
      {
        kind: "grant",
        id: randomUUID(),
        subject: { kind: "person", userId: manager.session.user.id },
        target: { kind: "project", workspaceId: run.workspace.id },
        level: "manage",
      },
    ],
  });
  const service = new TeamAdministrationService({
    database,
    identity,
    teamName: "Test team",
    runnerIsConnected: () => false,
    invalidate: () => undefined,
  });
  const app = await createHostServer(
    hostServerTestDependencies({
      teamAdministration: service,
      authenticator: new HostAuthenticator({ identity, publicUrl: new URL(origin) }),
      discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
        canonicalOrigin: origin,
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
      }),
    }),
  );
  const context = (person: typeof admin) => ({
    ...testHostApiContext(person.session.user.id),
    session: person.session,
    headers: { cookie: person.cookie, origin },
  });
  return { ...run, database, app, service, identity, admin, manager, pending, context };
}

describeStore("team administration Host boundary", (it) => {
  it("isolates anonymous caller exhaustion and retains a shared invitation cap", async ({
    storeFixture,
  }) => {
    const { app } = await setup(storeFixture);
    const request = (address: string) =>
      app.inject({
        method: "GET",
        url: `/v1/rpc/team.invitation.preview?input=${encodeURIComponent(JSON.stringify({ selector: "missing-selector-123456789" }))}`,
        remoteAddress: address,
        headers: { "x-opensteer-api-version": String(hostApiVersion) },
      });
    try {
      for (let index = 0; index < 60; index++)
        expect((await request("192.0.2.1")).statusCode).toBe(200);
      expect((await request("192.0.2.1")).statusCode).toBe(429);
      expect((await request("192.0.2.2")).statusCode).toBe(200);
      for (let index = 0; index < 539; index++)
        expect((await request(`198.51.100.${1 + Math.floor(index / 60)}`)).statusCode).toBe(200);
      expect((await request("192.0.2.3")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("refuses the real service on both model-1 kinds before a target lookup or read transaction", async ({
    storeFixture,
  }) => {
    const run = await storeFixture.createRunFixture("team-dormancy", null, "project");
    const database = storeFixture.database;
    const service = new TeamAdministrationService({
      database,
      identity: {} as IdentityService,
      teamName: "Dormant",
      runnerIsConnected: () => false,
      invalidate: () => undefined,
    });
    const transactions = vi.spyOn(database, "transaction");
    const context = testHostApiContext(run.userId);
    for (const kind of ["server", "personal"] as const) {
      await database
        .updateTable("deployments")
        .set({ deploymentShape: { kind, defaultWorkspaceBacking: "local-directory" } })
        .execute();
      await expect(
        service.read("team.member.get", { userId: createId("user") }, context),
      ).rejects.toMatchObject({ reason: "team-unavailable" });
      await expect(
        service.command(
          {
            type: "team.member.change",
            userId: createId("user"),
            change: { kind: "set-state", value: "active" },
            expectedRevision: 1,
            idempotencyKey: "dormant",
          },
          context,
        ),
      ).rejects.toMatchObject({ reason: "team-unavailable" });
      expect(transactions).not.toHaveBeenCalled();
    }
  });

  it("separates metadata and content, scopes paging and summary revisions, and refuses agent credentials at both boundaries", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    const { app, service, admin, manager, context, database } = prepared;
    try {
      const metadata = await injectRpcRequest(
        app,
        "team.project.access.get",
        { workspaceId: prepared.workspace.id },
        { origin, cookie: admin.cookie },
      );
      expect(metadata.statusCode, metadata.body).toBe(200);
      expect(metadata.json().data).toMatchObject({
        iAmAdminNotMember: true,
        can: { use: { allowed: false }, editInstructions: { allowed: false } },
      });
      const settings = await injectRpcRequest(
        app,
        "team.project.settings.get",
        { workspaceId: prepared.workspace.id },
        { origin, cookie: admin.cookie },
      );
      expect(settings.statusCode).toBe(403);
      const summary = TeamSummarySchema.parse(
        await service.read("team.summary.get", {}, context(admin)),
      );
      expect(summary.projects).toEqual([]);
      expect(JSON.stringify(summary)).not.toMatch(
        /email|instructions|presentation|password|tokenHash/,
      );
      const managerSummary = TeamSummarySchema.parse(
        await service.read(
          "team.summary.get",
          { knownRevision: summary.revision },
          context(manager),
        ),
      );
      expect(managerSummary.projects.map((project) => project.id)).toEqual([prepared.workspace.id]);
      expect(managerSummary.revision).not.toBe(summary.revision);
      expect(
        await service.read(
          "team.summary.get",
          { knownRevision: managerSummary.revision },
          context(manager),
        ),
      ).toEqual({ notModified: true, revision: managerSummary.revision });
      const directory = await service.read(
        "team.directory.search",
        { workspaceId: prepared.workspace.id, query: "", limit: 2 },
        context(manager),
      );
      expect(JSON.stringify(directory)).not.toMatch(/email|instructions|token/);
      const people = await injectRpcRequest(
        app,
        "team.people.list",
        {},
        { origin, cookie: manager.cookie },
      );
      expect(people.statusCode).toBe(403);
      const reads = new TeamAccessReadStore(database);
      const first = await reads.people({ userId: admin.session.user.id }, { limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await reads.people(
        { userId: admin.session.user.id },
        { limit: 1, cursor: first.nextCursor! },
      );
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
      await expect(
        reads.people({ userId: prepared.userId }, { cursor: first.nextCursor! }),
      ).rejects.toMatchObject({ reason: "invalid-selection" });
      const member = MemberDetailSchema.parse(
        await service.read("team.member.get", { userId: manager.session.user.id }, context(admin)),
      );
      expect(member.effectiveProjects).toEqual([
        { id: prepared.workspace.id, name: prepared.workspace.name, level: "manage" },
      ]);
      const explanation = AccessExplanationSchema.parse(
        await service.read(
          "team.access.explain",
          {
            workspaceId: prepared.workspace.id,
            subject: { kind: "person", userId: manager.session.user.id },
          },
          context(manager),
        ),
      );
      expect(explanation.effectiveLevel).toBe("manage");
      expect(explanation.entries).toHaveLength(1);
      const command = {
        type: "team.member.change" as const,
        userId: manager.session.user.id,
        expectedRevision: 2,
        idempotencyKey: "forbidden-agent",
        change: { kind: "set-state" as const, value: "suspended" as const },
      };
      await expect(
        service.command(command, { ...context(admin), session: null }),
      ).rejects.toMatchObject({ reason: "human-session-required" });
      for (const token of [
        "ost_mcp_connected-agent",
        "run-token",
        "program-token",
        "runner-token",
      ]) {
        const response = await injectRpcRequest(app, "commands.dispatch", command, {
          origin,
          cookie: admin.cookie,
          authorization: `Bearer ${token}`,
        });
        expect(response.statusCode, response.body).toBe(401);
      }
      await expect(
        service.read(
          "team.member.preview",
          { userId: manager.session.user.id, change: { kind: "set-state", value: "suspended" } },
          context(admin),
        ),
      ).resolves.toMatchObject({ allowed: true });
      const transactions = vi.spyOn(database, "transaction");
      await expect(
        service.command(
          {
            type: "team.member.change",
            userId: prepared.pending.session.user.id,
            change: { kind: "set-state", value: "active" },
            expectedRevision: 2,
            idempotencyKey: "no-admin",
          },
          context(manager),
        ),
      ).rejects.toMatchObject({ reason: "team-admin-required" });
      expect(transactions).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("reuses identity admission proof and atomically admits once across failure, concurrency and lost-response replay", async ({
    storeFixture,
  }) => {
    const prepared = await setup(storeFixture);
    const { app, service, database, admin, pending, identity, context } = prepared;
    try {
      const everyone = randomUUID();
      await database
        .insertInto("accessGroups")
        .values({
          id: everyone,
          name: "Everyone",
          builtin: "everyone",
          createdBy: prepared.userId,
          deletedAt: null,
        })
        .execute();
      await mutateAccess(database, {
        actor: { userId: prepared.userId },
        expectedRevision: 2,
        commandIdentity: createId("command"),
        changes: [
          {
            kind: "grant",
            id: randomUUID(),
            subject: { kind: "group", groupId: everyone },
            target: { kind: "project", workspaceId: prepared.workspace.id },
            level: "use",
          },
        ],
      });
      const selector = randomBytes(24).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const invitationId = randomUUID();
      const creation = {
        type: "team.invitation.create" as const,
        id: invitationId,
        selector,
        tokenHash: createHash("sha256").update(verifier).digest("hex"),
        intendedEmail: pending.session.user.email.toUpperCase(),
        memberKind: "full" as const,
        validFor: "1d" as const,
        expectedRevision: 3,
        idempotencyKey: "invite-person",
      };
      const created = await service.command(creation, context(admin));
      expect(await service.command(creation, context(admin))).toEqual(created);
      const listed = await service.read("team.invitations.list", { limit: 1 }, context(admin));
      expect(listed).toMatchObject({
        items: [{ id: invitationId, state: "open", can: { revoke: { allowed: true } } }],
      });
      expect(JSON.stringify(listed)).not.toMatch(/tokenHash|token_hash|selector/);
      expect(JSON.stringify(listed)).not.toContain(pending.session.user.email);
      await expect(
        service.read("team.invitations.list", {}, context(prepared.manager)),
      ).rejects.toMatchObject({ reason: "team-admin-required" });
      const preview = await service.read(
        "team.invitation.preview",
        { selector },
        { ...context(admin), session: null },
      );
      expect(JSON.stringify(preview)).not.toContain(pending.session.user.email);
      await expect(
        identity.exchangeTeamInvitation(selector, "v".repeat(43), new Headers({ origin })),
      ).rejects.toMatchObject({ reason: "invite-unavailable" });
      const exchange = await identity.exchangeTeamInvitation(
        selector,
        verifier,
        new Headers({ origin }),
      );
      const admissionCookie = exchange.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";", 1)[0]!)
        .join("; ");
      const acceptedContext = {
        ...context(pending),
        headers: { origin, cookie: `${pending.cookie}; ${admissionCookie}` },
      };
      const proof = await identity.teamInvitationAdmission(
        new Headers(acceptedContext.headers),
        pending.session,
      );
      await database
        .updateTable("users")
        .set({ emailVerified: false })
        .where("id", "=", pending.session.user.id)
        .execute();
      await expect(
        service.read("team.invitation.accept", {}, acceptedContext),
      ).rejects.toMatchObject({ reason: "invite-unavailable" });
      await database
        .updateTable("users")
        .set({ emailVerified: true })
        .where("id", "=", pending.session.user.id)
        .execute();
      await expect(
        service.read(
          "team.invitation.accept",
          {},
          { ...context(prepared.manager), headers: acceptedContext.headers },
        ),
      ).rejects.toMatchObject({ reason: "invite-unavailable" });
      await sql`create function team_test_fail_projection() returns trigger language plpgsql as $$ begin raise exception 'injected projection failure'; end $$;
        create trigger team_test_fail_projection before insert on workspace_memberships for each row execute function team_test_fail_projection();`.execute(
        database,
      );
      await expect(service.read("team.invitation.accept", {}, acceptedContext)).rejects.toThrow(
        "injected projection failure",
      );
      expect(
        await database
          .selectFrom("teamInvitations")
          .select("acceptedAt")
          .where("id", "=", invitationId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ acceptedAt: null });
      expect(
        await database
          .selectFrom("authAdmissions")
          .select("consumedAt")
          .where("id", "=", proof.admissionId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ consumedAt: null });
      expect(
        await database
          .selectFrom("users")
          .select("admittedAt")
          .where("id", "=", pending.session.user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ admittedAt: null });
      await sql`drop trigger team_test_fail_projection on workspace_memberships; drop function team_test_fail_projection()`.execute(
        database,
      );
      const [first, concurrent] = await Promise.all([
        service.read("team.invitation.accept", {}, acceptedContext),
        service.read("team.invitation.accept", {}, acceptedContext),
      ]);
      expect(concurrent).toEqual(first);
      expect(await service.read("team.invitation.accept", {}, acceptedContext)).toEqual(first);
      expect(await service.read("team.invitations.list", {}, context(admin))).toMatchObject({
        items: [{ id: invitationId, state: "used", can: { revoke: { allowed: false } } }],
      });
      expect(
        await database
          .selectFrom("workspaceMemberships")
          .select("state")
          .where("userId", "=", pending.session.user.id)
          .where("workspaceId", "=", prepared.workspace.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "active" });
      const audit = await database.selectFrom("securityAudit").select("metadata").execute();
      expect(JSON.stringify(audit)).not.toContain(verifier);
      expect(JSON.stringify(audit)).not.toContain(creation.tokenHash);
      await database
        .updateTable("authAdmissions")
        .set({ expiresAt: new Date(0) })
        .where("id", "=", proof.admissionId)
        .execute();
      await expect(
        service.read("team.invitation.accept", {}, acceptedContext),
      ).rejects.toMatchObject({ reason: "invite-unavailable" });
      const promotion = await service.command(
        {
          type: "team.member.change",
          userId: pending.session.user.id,
          change: { kind: "set-administrator", value: true },
          idempotencyKey: "promote-before-removal",
          expectedRevision: 4,
        },
        context(admin),
      );
      const removed = await service.command(
        {
          type: "team.member.change",
          userId: pending.session.user.id,
          change: { kind: "set-state", value: "removed" },
          idempotencyKey: "remove-before-reinvite",
          expectedRevision: promotion.accessRevision,
        },
        context(admin),
      );
      const tombstone = await database
        .selectFrom("workspaceMemberships")
        .select(["id", "generation", "state"])
        .where("userId", "=", pending.session.user.id)
        .where("workspaceId", "=", prepared.workspace.id)
        .executeTakeFirstOrThrow();
      const replacement = {
        ...creation,
        id: randomUUID(),
        selector: randomBytes(24).toString("base64url"),
        expectedRevision: removed.accessRevision,
        memberKind: "guest" as const,
        idempotencyKey: "reinvite-person",
      };
      await service.command(replacement, context(admin));
      const replacementProof = await identity.exchangeTeamInvitation(
        replacement.selector,
        verifier,
        new Headers({ origin }),
      );
      const rejoined = await service.read(
        "team.invitation.accept",
        {},
        {
          ...context(pending),
          headers: {
            origin,
            cookie: `${pending.cookie}; ${replacementProof.headers
              .getSetCookie()
              .map((value) => value.split(";", 1)[0]!)
              .join("; ")}`,
          },
        },
      );
      expect(rejoined).toMatchObject({
        member: { id: pending.session.user.id, kind: "guest", administrator: false },
      });
      expect(
        await database
          .selectFrom("workspaceMemberships")
          .select(["id", "generation", "state"])
          .where("userId", "=", pending.session.user.id)
          .where("workspaceId", "=", prepared.workspace.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(tombstone);
      expect(tombstone.state).toBe("revoked");
      expect(
        await database
          .selectFrom("users")
          .select("authorityGeneration")
          .where("id", "=", pending.session.user.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ authorityGeneration: "4" });
    } finally {
      await app.close();
    }
  });
});
