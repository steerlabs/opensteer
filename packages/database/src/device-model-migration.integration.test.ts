import { createId, type RunnerId, DeviceIdSchema } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";
import { deviceDriversMigrationName, migrateToLatest, migrationProvider } from "./migrations.js";
import { seedPrivatePublisher } from "./private-publisher.test-support.js";
let clone: TestDatabase;
let db: ReturnType<typeof createDatabase>;
beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  db = createDatabase({ connectionString: clone.url });
  await sql`drop schema public cascade; create schema public`.execute(db);
});
afterEach(async () => {
  try {
    await db?.destroy();
  } finally {
    await clone?.drop();
  }
});
async function previous() {
  const all = await migrationProvider().getMigrations();
  await migrateToLatest(db, {
    getMigrations: async () =>
      Object.fromEntries(Object.entries(all).filter(([name]) => name < deviceDriversMigrationName)),
  });
}
async function catalog() {
  return (
    await sql`select c.relname,c.relkind,case when c.relkind='i' then pg_get_indexdef(c.oid) end from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`.execute(
      db,
    )
  ).rows;
}
it("backfills visible active and revoked identities exactly, splits targets and agrees with fresh schema", async () => {
  await previous();
  const fixture = await seedPrivatePublisher(db);
  const cases = [
    {
      kind: "local",
      owner: "user",
      modules: ["browser", "integrations"],
      device: { platform: "android", form: "phone" },
      expected: "agent-phone",
      revoked: false,
    },
    {
      kind: "local",
      owner: "user",
      modules: ["browser"],
      device: { platform: "android", form: "phone", app: "opensteer" },
      expected: "computer",
      revoked: false,
    },
    {
      kind: "local",
      owner: "user",
      modules: ["browser", "integrations"],
      device: { platform: "ios", form: "phone", app: "opensteer" },
      expected: "phone",
      revoked: true,
    },
    {
      kind: "managed",
      owner: "user",
      modules: ["browser"],
      device: { platform: "linux", form: "server" },
      expected: "server",
      revoked: false,
    },
    {
      kind: "local",
      owner: "user",
      modules: ["integrations"],
      device: null,
      expected: "unknown",
      revoked: false,
    },
    {
      kind: "managed",
      owner: "deployment",
      modules: ["messaging", "integrations"],
      device: null,
      expected: null,
      revoked: false,
    },
    {
      kind: "managed",
      owner: "deployment",
      modules: ["browser"],
      device: null,
      expected: null,
      revoked: true,
    },
  ];
  const ids: RunnerId[] = [];
  for (const entry of cases) {
    const id = createId("runner");
    ids.push(id);
    await sql`insert into runners(id,owner_kind,owner_user_id,name,kind,public_key_pem,public_key_fingerprint,enrollment_token_hash,capabilities,allowed_modules,module_descriptors,access_policy,access_policy_revision,connection_generation,max_concurrent_runs,device,revoked_at) values(${id},${entry.owner},${entry.owner === "user" ? fixture.userId : null},'Preserved',${entry.kind},${id},${id},${id},'[]',${JSON.stringify(entry.modules)}::jsonb,'{}','{"reach":"nobody","commands":false,"forwarding":false,"shares":[],"browser":false,"apps":false}',7,0,null,${entry.device ? JSON.stringify(entry.device) : null}::jsonb,${entry.revoked ? new Date() : null})`.execute(
      db,
    );
  }
  await sql`insert into computer_use_policies(deployment_id,runner_id,owner_user_id,app_approval,revision) values(${fixture.deploymentId},${ids[0]},${fixture.userId},'automatic',5)`.execute(
    db,
  );
  await sql`insert into computer_use_stops(run_id,runner_id) values(${fixture.runId},${ids[0]})`.execute(
    db,
  );
  await sql`insert into auth_sessions(id,user_id,token,expires_at,absolute_expires_at,device_label,last_seen_at,device_id) values(${createId("authSession")},${fixture.userId},'session',now()+interval '1 hour',now()+interval '2 hours','Test',now(),${ids[0]})`.execute(
    db,
  );
  const computerConnection = createIntegrationId("connection");
  const channelConnection = createIntegrationId("connection");
  for (const [id, kind, runnerId] of [
    [computerConnection, "computer", ids[0]],
    [channelConnection, "channel", fixture.runnerId],
  ] as const)
    await sql`insert into integration_connections(id,owner_user_id,connection_kind,provider,connection_method,status,display_name,capabilities,granted_scopes,integration_definition_id,runner_id)
      values(${id},${fixture.userId},${kind},'test','computer','connected','Preserved','[]','[]','android-phone',${runnerId})`.execute(
      db,
    );
  const setupRequestId = crypto.randomUUID();
  await sql`insert into computer_app_setup_requests(id,kind,deployment_id,owner_user_id,runner_id,definition_id,definition_digest,access)
    values(${setupRequestId},'app',${fixture.deploymentId},${fixture.userId},${ids[0]},'android-phone','unchanged-digest','read')`.execute(
    db,
  );
  const tabId = createId("tab");
  await sql`insert into personal_tabs(id,owner_id,kind,computer_id,title,opened_by) values(${tabId},${fixture.userId},'phone',${ids[2]},'Retained tombstone','"person"')`.execute(
    db,
  );
  await migrateToLatest(db);
  const devices = await db.selectFrom("devices").selectAll().execute();
  expect(devices.find((d) => d.id === DeviceIdSchema.parse(fixture.runnerId))?.kind).toBe("home");
  for (const [index, entry] of cases.entries()) {
    const device = devices.find((d) => d.id === DeviceIdSchema.parse(ids[index]));
    if (!entry.expected) {
      expect(device).toBeUndefined();
      continue;
    }
    expect(device).toMatchObject({
      kind: entry.expected,
      accessPolicyRevision: 7,
      accessPolicy: { browser: false, apps: false },
    });
    expect(Boolean(device?.removedAt)).toBe(entry.revoked);
    const driver = await db
      .selectFrom("deviceDrivers")
      .selectAll()
      .where("deviceId", "=", device!.id)
      .executeTakeFirstOrThrow();
    expect(driver.runnerId).toBe(ids[index]);
    expect(driver.generation).toBe("1");
    expect(Boolean(driver.detachedAt)).toBe(entry.revoked);
  }
  expect((await db.selectFrom("computerUsePolicies").selectAll().execute())[0]).toMatchObject({
    deviceId: ids[0],
    revision: 5,
  });
  expect((await db.selectFrom("computerUseStops").selectAll().execute())[0]?.deviceId).toBe(ids[0]);
  const connections = await db
    .selectFrom("integrationConnections")
    .select(["id", "deviceId", "runnerId"])
    .where("id", "in", [computerConnection, channelConnection])
    .execute();
  expect(connections).toEqual(
    expect.arrayContaining([
      { id: computerConnection, deviceId: ids[0], runnerId: null },
      { id: channelConnection, deviceId: null, runnerId: fixture.runnerId },
    ]),
  );
  expect(
    await db
      .selectFrom("computerAppSetupRequests")
      .select(["deviceId", "definitionDigest"])
      .where("id", "=", setupRequestId)
      .executeTakeFirstOrThrow(),
  ).toEqual({ deviceId: ids[0], definitionDigest: "unchanged-digest" });
  expect(
    (
      await db
        .selectFrom("personalTabs")
        .select("computerId")
        .where("id", "=", tabId)
        .executeTakeFirstOrThrow()
    ).computerId,
  ).toBe(ids[2]);
  expect(
    (
      await db
        .selectFrom("authSessions")
        .select("deviceId")
        .where("token", "=", "session")
        .executeTakeFirstOrThrow()
    ).deviceId,
  ).toBe(ids[0]);
  const upgraded = await catalog();
  await sql`drop schema public cascade; create schema public`.execute(db);
  await migrateToLatest(db);
  expect(await catalog()).toEqual(upgraded);
});
it("creates no Devices on a team deployment, including historical visible Runners", async () => {
  await previous();
  const deployment = createId("deployment");
  await sql`insert into deployments(id,singleton_key,active_host_instance_id,canonical_origin,lifecycle,deployment_shape) values(${deployment},'primary',${createId("hostInstance")},'https://team.invalid','active','{"kind":"team"}')`.execute(
    db,
  );
  await sql`insert into runners(id,owner_kind,owner_user_id,name,kind,public_key_pem,public_key_fingerprint,enrollment_token_hash,capabilities,allowed_modules,module_descriptors,access_policy,access_policy_revision,connection_generation,max_concurrent_runs) values(${createId("runner")},'deployment',null,'Team','main','key','fp','token','[]','["agents"]','{}','{"reach":"nobody","commands":false,"forwarding":false,"shares":[]}',1,0,null)`.execute(
    db,
  );
  await migrateToLatest(db);
  expect(await db.selectFrom("devices").selectAll().execute()).toEqual([]);
});
