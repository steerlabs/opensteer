import { sql } from "kysely";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { browserProfileHomesMigration } from "./migrations.js";
import { describeStore } from "./store.integration.test-support.js";

const phoneFingerprint = `sha256:${createHash("sha256")
  .update(
    JSON.stringify([
      "opensteer-runner-enrollment-issuance-v2",
      "allowedModules",
      ["integrations"],
      "createdBy",
      "owner",
      "idempotencyKey",
      "android",
      "purpose",
      "phone",
      "runnerKind",
      "local",
      "lifetimeSeconds",
      600,
      "name",
      "Phone",
    ]),
  )
  .digest("base64url")}`;

describeStore("browser home forward migration", (it) => {
  it.for(["server", "personal", "personal-unenrolled"] as const)(
    "backfills %s without changing identity or issuance intent",
    async (shape, { storeFixture: { database } }) => {
      await database.transaction().execute(async (tx) => {
        await sql`
        create schema browser_home_upgrade;
        set local search_path = browser_home_upgrade, public;
        create table deployments (id text primary key, deployment_shape jsonb);
        create table runners (id text primary key,kind text,owner_kind text,owner_user_id text,allowed_modules jsonb,
          device_profile text,revoked_at timestamptz,enrollment_token_hash text,public_key_pem text default 'original-key',
          constraint runners_device_profile_check check (device_profile is null or allowed_modules = '["integrations"]'::jsonb));
        create table runner_enrollments (id text primary key,runner_kind text,owner_kind text,created_by text,
          idempotency_key text,name text,request_fingerprint text,token_hash text,allowed_modules jsonb,device_profile text,
          created_at timestamptz default now(),expires_at timestamptz default now() + interval '600 seconds',
          constraint runner_enrollments_device_profile_check check (device_profile is null or allowed_modules = '["integrations"]'::jsonb));
        create table browser_profiles (id text primary key,owner_id text,name text,storage_state text default 'unbound',
          storage_binding_version integer,storage_deployment_id text,storage_runner_id text,storage_instance_id uuid,
          storage_binding_id uuid, storage_engine text check (storage_engine in ('electron','chromium')),
          archived_at timestamptz,updated_at timestamptz default now());
        create table browser_profile_deletions (deletion_id uuid primary key,profile_id text unique,binding_version integer,
          deployment_id text,runner_id text,storage_instance_id uuid,binding_id uuid,engine text check (engine in ('electron','chromium')),
          state text check (state in ('pending-computer','pending-restart','deleted')),
          created_at timestamptz default now(),updated_at timestamptz default now(),deleted_at timestamptz,
          constraint browser_profile_deletions_completion_check check ((state = 'deleted') = (deleted_at is not null)));
        create index browser_profile_deletions_pending on browser_profile_deletions(runner_id,storage_instance_id) where state <> 'deleted';
        create table browser_sessions (id text primary key,profile_id text,tab_group_id text,state text,closed_at timestamptz,updated_at timestamptz,created_at timestamptz default now());
        create table workspace_tabs (group_id text,closed_at timestamptz);
        create table browser_session_attachments (session_id text);
        create table browser_history_entries (profile_id text);
        create table browser_history_icons (profile_id text);
        create table browser_profile_grants (profile_id text,revoked_at timestamptz);
        insert into deployments values ('deployment',${sql.lit(JSON.stringify({ kind: shape === "server" ? "server" : "personal" }))}::jsonb);
        insert into runner_enrollments(id,runner_kind,owner_kind,created_by,idempotency_key,name,request_fingerprint,token_hash,allowed_modules,device_profile) values
          ('reach','local','user','owner','reach','Laptop','reach-intent','reach-token','["shell","integrations","messaging"]',null),
          ('android','local','user','owner','android','Phone',${sql.lit(phoneFingerprint)},'android-token','["integrations"]',null),
          ('iphone','local','user','owner','iphone','iPhone','iphone-intent','iphone-token','["integrations"]','iphone'),
          ('custom','local','user','owner','custom','Custom','custom-intent','custom-token','["integrations"]',null),
          ('service','managed','deployment',null,'service','Service','service-intent','service-token','["integrations","messaging","shell"]',null);
        insert into runners(id,kind,owner_kind,owner_user_id,allowed_modules,device_profile,enrollment_token_hash)
          select id,runner_kind,owner_kind,case when owner_kind = 'user' then 'owner' end,allowed_modules,device_profile,token_hash from runner_enrollments;
        insert into runners(id,kind,owner_kind,allowed_modules,revoked_at) values
          ('removed','local','user','["browser"]',now());
        insert into browser_profiles(id,owner_id,name) values ('unbound','owner','Unbound');
        insert into browser_profiles(id,owner_id,name,storage_state,storage_binding_version,storage_deployment_id,storage_runner_id,storage_instance_id,storage_binding_id,storage_engine) values
          ('bound','owner','Bound','local',1,'deployment','reach','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','electron'),
          ('removed-profile','owner','Removed','local',1,'deployment','removed','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','chromium');
        insert into browser_sessions(id,profile_id,tab_group_id,state) values ('session','removed-profile','session','ready');
        insert into workspace_tabs values ('session',null);
        insert into browser_session_attachments values ('session');
        insert into browser_history_entries values ('removed-profile');
        insert into browser_history_icons values ('removed-profile');
        insert into browser_profile_grants values ('removed-profile',null);
      `.execute(tx);
        if (shape !== "personal-unenrolled")
          await sql`insert into runners(id,kind,owner_kind,allowed_modules) values ('main','main','deployment','["agents","browser"]')`.execute(
            tx,
          );
        const issuance = (
          await sql`select id,token_hash,request_fingerprint,created_by,created_at,expires_at from runner_enrollments order by id`.execute(
            tx,
          )
        ).rows;
        const identities = (
          await sql`select id,enrollment_token_hash,public_key_pem from runners order by id`.execute(
            tx,
          )
        ).rows;
        const originalGrants = (
          await sql`select id,allowed_modules as issuance_modules from runner_enrollments order by id`.execute(
            tx,
          )
        ).rows;
        await browserProfileHomesMigration.up(tx);
        expect(
          (await sql`select id,issuance_modules from runner_enrollments order by id`.execute(tx))
            .rows,
        ).toEqual(originalGrants);
        expect(
          (
            await sql`select id,token_hash,request_fingerprint,created_by,created_at,expires_at from runner_enrollments order by id`.execute(
              tx,
            )
          ).rows,
        ).toEqual(issuance);
        expect(
          (
            await sql`select id,enrollment_token_hash,public_key_pem from runners order by id`.execute(
              tx,
            )
          ).rows,
        ).toEqual(identities);
        const grants = (
          await sql<{
            id: string;
            allowedModules: string[];
          }>`select id,allowed_modules from runner_enrollments order by id`.execute(tx)
        ).rows;
        expect(grants).toEqual([
          { id: "android", allowedModules: ["browser", "integrations"] },
          {
            id: "custom",
            allowedModules: shape === "server" ? ["integrations"] : ["browser", "integrations"],
          },
          { id: "iphone", allowedModules: ["browser", "integrations"] },
          {
            id: "reach",
            allowedModules:
              shape === "server"
                ? ["shell", "integrations", "messaging"]
                : ["browser", "integrations", "messaging", "shell"],
          },
          { id: "service", allowedModules: ["integrations", "messaging", "shell"] },
        ]);
        for (const grant of grants)
          expect(
            (await sql`select allowed_modules from runners where id = ${grant.id}`.execute(tx))
              .rows,
          ).toEqual([{ allowedModules: grant.allowedModules }]);
        expect(
          (await sql`select id,home_runner_id from browser_profiles order by id`.execute(tx)).rows,
        ).toEqual([
          { id: "bound", homeRunnerId: "reach" },
          { id: "removed-profile", homeRunnerId: "removed" },
          { id: "unbound", homeRunnerId: shape === "personal" ? "main" : null },
        ]);
        expect(
          (
            await sql`select archived_at from browser_profiles where id = 'removed-profile'`.execute(
              tx,
            )
          ).rows,
        ).toEqual([{ archivedAt: expect.any(Date) }]);
        expect(
          (await sql`select state,deleted_at from browser_profile_deletions`.execute(tx)).rows,
        ).toEqual([{ state: "unconfirmed", deletedAt: null }]);
        expect((await sql`select closed_at from workspace_tabs`.execute(tx)).rows).toEqual([
          { closedAt: expect.any(Date) },
        ]);
        expect(
          (
            await sql`select * from browser_history_entries union all select * from browser_history_icons`.execute(
              tx,
            )
          ).rows,
        ).toEqual([]);
        expect((await sql`select revoked_at from browser_profile_grants`.execute(tx)).rows).toEqual(
          [{ revokedAt: expect.any(Date) }],
        );
        await sql`
        update browser_profiles set storage_engine = 'wkwebview' where id = 'bound';
        update browser_profiles set storage_engine = 'android-webview' where id = 'bound';
        update browser_profile_deletions set engine = 'wkwebview';
        update browser_profile_deletions set engine = 'android-webview';
        do $$ begin
          begin update browser_profiles set home_runner_id = 'removed' where id = 'bound';
            raise exception 'accepted storage outside its home'; exception when check_violation then null; end;
          begin update browser_profiles set storage_engine = 'future';
            raise exception 'accepted unknown engine'; exception when check_violation then null; end;
          begin update browser_profile_deletions set engine = 'future';
            raise exception 'accepted unknown erasure engine'; exception when check_violation then null; end;
          begin update browser_profile_deletions set state = 'deleted';
            raise exception 'claimed erasure without acknowledgement'; exception when check_violation then null; end;
        end $$;
        drop schema browser_home_upgrade cascade;
      `.execute(tx);
      });
    },
  );
});
