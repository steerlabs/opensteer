import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { nativeBrowserProfilesMigration } from "./migrations.js";

it.runIf(Boolean(process.env.OPENSTEER_TEST_DATABASE_URL))(
  "adds vault defaults and durable native deletion records without changing revision ciphertext",
  async () => {
    const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
    try {
      await database.transaction().execute(async (tx) => {
        // The isolated schema models the upgrade without touching the worker's current tables.
        await sql`
          create schema native_profile_upgrade;
          set local search_path = native_profile_upgrade, public;
          create table deployments (id text primary key);
          create table runners (id text primary key);
          create table browser_profiles (id text primary key, revision integer not null default 0, archived_at timestamptz);
          create table browser_profile_revisions (profile_id text not null, revision integer not null, ciphertext bytea not null, ciphertext_sha256 text not null);
          insert into deployments values ('deployment');
          insert into runners values ('runner');
          insert into browser_profiles values ('old', 4, null);
          insert into browser_profile_revisions values ('old', 4, decode('010203', 'hex'), 'ciphertext-digest');
        `.execute(tx);
        await nativeBrowserProfilesMigration.up(tx);
        expect(
          (
            await sql`select storage_state, storage_binding_id, frozen_seed_revision, initialization_token_hash from browser_profiles`.execute(
              tx,
            )
          ).rows,
        ).toEqual([
          {
            storageState: "vault",
            storageBindingId: null,
            frozenSeedRevision: null,
            initializationTokenHash: null,
          },
        ]);
        expect((await sql`select * from browser_profile_revisions`.execute(tx)).rows).toEqual([
          {
            profileId: "old",
            revision: 4,
            ciphertext: Buffer.from([1, 2, 3]),
            ciphertextSha256: "ciphertext-digest",
          },
        ]);
        await sql`
          update browser_profiles set storage_state = 'initializing', storage_binding_version = 1,
            storage_deployment_id = 'deployment', storage_runner_id = 'runner',
            storage_instance_id = '11111111-1111-4111-8111-111111111111',
            storage_binding_id = '22222222-2222-4222-8222-222222222222', storage_engine = 'electron',
            frozen_seed_revision = 4, frozen_seed_digest = repeat('a', 64),
            initialization_token_hash = repeat('b', 64), initialization_token_expires_at = now() + interval '1 minute';
          update browser_profiles set storage_state = 'local', initialization_token_hash = null, initialization_token_expires_at = null;
          insert into browser_profile_deletions (deletion_id, profile_id, binding_version, deployment_id, runner_id, storage_instance_id, binding_id, engine, state)
            values ('33333333-3333-4333-8333-333333333333', 'old', 1, 'deployment', 'runner',
              '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'electron', 'pending-computer');
          update browser_profiles set archived_at = now();
          delete from browser_profile_revisions;
          update browser_profile_deletions set state = 'pending-restart';
        `.execute(tx);
        expect(
          (await sql`select state, deleted_at from browser_profile_deletions`.execute(tx)).rows,
        ).toEqual([{ state: "pending-restart", deletedAt: null }]);
        await sql`update browser_profile_deletions set state = 'deleted', deleted_at = now()`.execute(
          tx,
        );
        expect((await sql`select state from browser_profile_deletions`.execute(tx)).rows).toEqual([
          { state: "deleted" },
        ]);
        await sql`
          do $$ begin
            begin
              update browser_profiles set storage_state = 'vault';
              raise exception 'accepted a vault row with a native binding';
            exception when check_violation then null; end;
            begin
              update browser_profiles set frozen_seed_digest = 'invalid';
              raise exception 'accepted an invalid frozen digest';
            exception when check_violation then null; end;
            begin
              update browser_profiles set storage_state = 'missing';
              raise exception 'accepted an observation as storage authority';
            exception when check_violation then null; end;
            begin
              update browser_profile_deletions set state = 'pending-restart';
              raise exception 'accepted pending erasure with a deleted timestamp';
            exception when check_violation then null; end;
          end $$;
          drop schema native_profile_upgrade cascade;
        `.execute(tx);
      });
    } finally {
      await database.destroy();
    }
  },
);
