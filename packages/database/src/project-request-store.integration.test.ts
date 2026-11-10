import {
  createId,
  ProjectEngineRequestEventSchema,
  type ProjectEngineRequestEvent,
} from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { projectRequestStorageSql } from "./project-authority-migration.js";
import { ProjectNotificationStore } from "./notification-store.js";
import { describeStore } from "./store.integration.test-support.js";
import { ProjectRequestStore, eligibleProjectRequestManagers } from "./project-request-store.js";
import { projectRequestFixture, recordingProjectControls } from "./project-request.test-support.js";

function proposal(binding: ProjectEngineRequestEvent["binding"]): ProjectEngineRequestEvent {
  return ProjectEngineRequestEventSchema.parse({
    type: "request.proposed.project",
    binding,
    data: {
      request: {
        id: createId("request"),
        callId: "provider-call",
        createdAt: new Date(0).toISOString(),
        mode: "live",
        kind: "harness.approval",
        requestClass: "harness-approval",
        payload: { kind: "harness.approval" },
        presentation: {
          kind: "choice",
          title: "Run command?",
          options: [{ id: "yes", hint: "allow-once", label: "Allow" }],
        },
      },
    },
  });
}

describeStore("Project Requests", (it) => {
  it("derives the human audience, persists once, resolves to the original grant, and rechecks continuation", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-human");
    const { database } = storeFixture;
    const controls = recordingProjectControls();
    const store = new ProjectRequestStore(database, controls.port);
    const event = proposal(fixture.binding);
    const opened = await controls.transact(database, (tx) => store.propose(tx, event));
    expect(opened.state).toBe("ready");
    if (opened.state !== "ready") throw new Error("Request was refused");
    expect(opened.request).toMatchObject({
      requestedBy: fixture.userId,
      requiredActor: "requester",
      originatingGrantId: fixture.grant.id,
    });
    expect(opened.request.createdAt).not.toBe(event.data.request.createdAt);
    expect(await controls.transact(database, (tx) => store.propose(tx, event))).toMatchObject({
      replayed: true,
    });
    await controls.transact(database, async (tx) => {
      expect(await store.count(tx, fixture.userId)).toBe(1);
      expect((await store.list(tx, fixture.userId)).map((row) => row.id)).toEqual([
        event.data.request.id,
      ]);
      expect(await store.recipients(tx, event.data.request.id)).toEqual([fixture.userId]);
      expect(
        (await store.detail(tx, { requestId: event.data.request.id, userId: fixture.userId })).id,
      ).toBe(event.data.request.id);
    });
    const notifications = new ProjectNotificationStore(database);
    expect((await notifications.decide(opened.events[0]!)).map((entry) => entry.userId)).toEqual([
      fixture.userId,
    ]);
    const managerId = await storeFixture.store.createUser("Other manager");
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", managerId)
      .execute();
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: fixture.workspace.id,
        userId: managerId,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    await controls.transact(database, async (tx) => {
      expect(await store.list(tx, managerId)).toEqual([]);
      expect(await store.count(tx, managerId)).toBe(0);
    });
    await expect(
      controls.transact(database, (tx) =>
        store.detail(tx, { requestId: event.data.request.id, userId: managerId }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const answer = {
      requestId: event.data.request.id,
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      response: { kind: "choice" as const, optionId: "yes" },
    };
    await database
      .updateTable("authSessions")
      .set({ memberGeneration: "2" })
      .where("id", "=", fixture.sessionId)
      .execute();
    await expect(
      controls.transact(database, (tx) => store.answer(tx, answer)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(controls.records.size).toBe(0);
    expect(
      await database
        .selectFrom("requests")
        .select("status")
        .where("id", "=", answer.requestId)
        .executeTakeFirst(),
    ).toEqual({ status: "pending" });
    await database
      .updateTable("authSessions")
      .set({ memberGeneration: "1" })
      .where("id", "=", fixture.sessionId)
      .execute();
    await expect(
      controls.transact(database, (tx) => store.answer(tx, { ...answer, userId: managerId })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await controls.transact(database, (tx) => store.answer(tx, answer))).toMatchObject({
      replayed: false,
    });
    expect(await controls.transact(database, (tx) => store.answer(tx, answer))).toMatchObject({
      replayed: true,
    });
    expect([...controls.records.values()]).toEqual([
      { kind: "request.resolve", requestId: answer.requestId, response: answer.response },
    ]);
    expect(await controls.transact(database, (tx) => store.canContinue(tx, answer.requestId))).toBe(
      true,
    );
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await controls.transact(database, (tx) => store.canContinue(tx, answer.requestId))).toBe(
      false,
    );
  });

  it("refuses injected roots and unsupported proposals without a card; a lost-root refusal is idempotent", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-refusal");
    const { database } = storeFixture;
    const controls = recordingProjectControls();
    const store = new ProjectRequestStore(database, controls.port);
    const event = proposal(fixture.binding);
    const wrong = structuredClone(event);
    if (!wrong.binding.authority.origin) throw new Error("Expected root");
    wrong.binding.authority.origin.initiatorGeneration++;
    await expect(
      controls.transact(database, (tx) => store.propose(tx, wrong)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      controls.transact(database, (tx) =>
        store.propose(tx, {
          ...event,
          data: { request: { ...event.data.request, kind: "browser.access" } },
        } as unknown as ProjectEngineRequestEvent),
      ),
    ).rejects.toThrow();
    await database
      .updateTable("users")
      .set({ authorityGeneration: "2" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await controls.transact(database, (tx) => store.propose(tx, event))).toMatchObject({
      state: "refused",
      control: { reason: "authority-revoked" },
    });
    expect(await controls.transact(database, (tx) => store.propose(tx, event))).toMatchObject({
      state: "refused",
    });
    expect(controls.records.size).toBe(1);
    expect(await database.selectFrom("requests").select("id").execute()).toHaveLength(0);
  });

  it("enforces grant scope, audience and immutable origin by direct SQL and retains the grant", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-ddl");
    const { database } = storeFixture;
    const controls = recordingProjectControls();
    const store = new ProjectRequestStore(database, controls.port);
    const event = proposal(fixture.binding);
    await controls.transact(database, (tx) => store.propose(tx, event));
    for (const change of [
      sql`requested_by = null`,
      sql`originating_grant_id = null`,
      sql`required_actor = 'workspace-owner'`,
      sql`call_id = 'changed'`,
    ]) {
      await expect(
        sql`update requests set ${change} where id = ${event.data.request.id}`.execute(database),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      sql`delete from grants where id = ${fixture.grant.id}`.execute(database),
    ).rejects.toMatchObject({ code: "23001" });
    await expect(
      sql`update grants set runner_boot_id = 'replacement' where id = ${fixture.grant.id}`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const constraints = await sql<{ convalidated: boolean }>`select convalidated from pg_constraint
      where conname in ('requests_originating_grant_id_fkey', 'requests_requester_audience')`.execute(
      database,
    );
    expect(constraints.rows).toHaveLength(2);
    expect(constraints.rows.every((row) => !row.convalidated)).toBe(true);
  });

  for (const kind of ["member", "membership", "connection"] as const) {
    it(`cancels only the captured ${kind} root without contacting a Runner`, async ({
      storeFixture,
    }) => {
      const fixture = await projectRequestFixture(storeFixture, `project-request-cancel-${kind}`);
      const { database } = storeFixture;
      const controls = recordingProjectControls();
      const store = new ProjectRequestStore(database, controls.port);
      if (kind === "connection") {
        await database
          .updateTable("runs")
          .set({ originConnectionId: fixture.connectionId })
          .where("id", "=", fixture.run.id)
          .execute();
        if (!fixture.binding.authority.origin) throw new Error("Expected root");
        fixture.binding.authority.origin.originConnectionId = fixture.connectionId;
      }
      const event = proposal(fixture.binding);
      await controls.transact(database, (tx) => store.propose(tx, event));
      await controls.transact(database, async (tx) => {
        await tx
          .selectFrom("runs")
          .select("id")
          .where("id", "=", fixture.run.id)
          .forNoKeyUpdate()
          .execute();
        await tx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", fixture.workspace.id)
          .forNoKeyUpdate()
          .execute();
        const root =
          kind === "member"
            ? { kind, userId: fixture.userId, memberGenerationCutoff: 1 }
            : kind === "membership"
              ? {
                  kind,
                  userId: fixture.userId,
                  workspaceId: fixture.workspace.id,
                  membershipGenerationCutoff: 1,
                }
              : {
                  kind,
                  userId: fixture.userId,
                  workspaceId: fixture.workspace.id,
                  connectionId: fixture.connectionId,
                  memberGenerationCutoff: 1,
                  membershipGenerationCutoff: 1,
                };
        const older =
          root.kind === "member"
            ? { ...root, memberGenerationCutoff: 0 }
            : { ...root, membershipGenerationCutoff: 0 };
        expect((await store.cancel(tx, [older])).runIds).toEqual([]);
        expect((await store.cancel(tx, [root])).runIds).toEqual([fixture.run.id]);
      });
      expect(
        await database
          .selectFrom("requests")
          .select("status")
          .where("id", "=", event.data.request.id)
          .executeTakeFirst(),
      ).toEqual({ status: "cancelled" });
    });
  }

  it("adds the Request columns and NOT VALID constraints without scanning or rewriting existing rows", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-scans");
    const { database } = storeFixture;
    const controls = recordingProjectControls();
    const store = new ProjectRequestStore(database, controls.port);
    await controls.transact(database, (tx) => store.propose(tx, proposal(fixture.binding)));
    await controls.transact(database, async (tx) => {
      await sql`alter table requests drop column originating_grant_id, drop constraint requests_requester_audience`.execute(
        tx,
      );
      const facts = async () =>
        (
          await sql`select relname, relfilenode, pg_stat_get_xact_numscans(oid) as scans
        from pg_class where oid in ('requests'::regclass, 'grants'::regclass) order by relname`.execute(
            tx,
          )
        ).rows;
      const before = await facts();
      await projectRequestStorageSql.execute(tx);
      expect(await facts()).toEqual(before);
      const locks = await sql<{ relname: string; mode: string }>`select distinct c.relname, l.mode
        from pg_locks l join pg_class c on c.oid = l.relation where l.pid = pg_backend_pid()
        and l.granted and c.relname in ('requests', 'grants')`.execute(tx);
      expect(locks.rows).toContainEqual({ relname: "requests", mode: "AccessExclusiveLock" });
      expect(locks.rows).toContainEqual({ relname: "grants", mode: "ShareRowExclusiveLock" });
    });
  });

  it("counts only admitted full managers, never a guest or an administrator without manage", async ({
    storeFixture,
  }) => {
    const fixture = await projectRequestFixture(storeFixture, "project-request-managers");
    const { database } = storeFixture;
    const administrator = await storeFixture.store.createUser(
      "Administrator without Project access",
    );
    await database
      .updateTable("users")
      .set({ admittedAt: new Date(), instanceRole: "administrator" })
      .where("id", "=", administrator)
      .execute();
    expect(await eligibleProjectRequestManagers(database, fixture.workspace.id)).toEqual([
      fixture.userId,
    ]);
    await database
      .updateTable("users")
      .set({ memberKind: "guest" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await eligibleProjectRequestManagers(database, fixture.workspace.id)).toEqual([]);
  });
});
