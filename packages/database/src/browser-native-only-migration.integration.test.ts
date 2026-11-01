import { sql } from "kysely";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  BrowserRuntime,
  LocalProfileStore,
  type BrowserLauncher,
} from "@opensteer/browser-runtime-core";
import {
  FakeIsolatingLauncher,
  FakeSink,
  FakeTicketVerifier,
  validClaims,
} from "@opensteer/browser-runtime-core/test-support";
import { SessionCookieMirror } from "../../../apps/desktop/src/browser/session-cookie-mirror.js";
import { BrowserSessionIdSchema, LocalProfileBindingSchema } from "@opensteer/protocol";
import { createDatabase } from "./connection.js";
import { browserNativeOnlyMigration, nativeBrowserProfilesMigration } from "./migrations.js";

it("preserves both established local bindings and native sign-ins byte for byte while removing Vault data", async () => {
  const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
  const root = await mkdtemp(path.join(tmpdir(), "native-cutover-"));
  await writeFile(
    path.join(root, "storage.v1.json"),
    JSON.stringify({ version: 1, storageInstanceId: "20000000-0000-4000-8000-000000000001" }),
    { mode: 0o600 },
  );
  const store = await LocalProfileStore.acquire(root, "electron");
  const bindings = [1, 2].map((index) =>
    LocalProfileBindingSchema.parse({
      version: 1,
      deploymentId: "dep_00000000-0000-4000-8000-000000000001",
      runnerId: "rnr_00000000-0000-4000-8000-000000000001",
      storageInstanceId: store.storageInstanceId,
      profileId: `bpr_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      bindingId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      engine: "electron",
    }),
  );
  const artifacts = new Map<string, Buffer>();
  const mirrors = JSON.parse(
    await readFile(
      new URL("../../../tests/fixtures/native-browser-mirrors.json", import.meta.url),
      "utf8",
    ),
  ) as {
    profiles: Array<{ binding: unknown; keyFile: string; mirrorFile: string }>;
  };
  try {
    for (const [index, binding] of bindings.entries()) {
      const mirror = mirrors.profiles[index]!;
      expect(mirror.binding).toEqual(binding);
      const native = store.directory(binding);
      await mkdir(native, { recursive: true });
      for (const [name, bytes] of Object.entries({
        "opensteer.v1.json": Buffer.from(JSON.stringify({ version: 1, binding })),
        Cookies: Buffer.from("existing Chromium encrypted cookie database"),
        Preferences: Buffer.from('{"profile":{"name":"Existing"}}'),
        "../session-cookies.v1.json": Buffer.from(mirror.mirrorFile),
        "../session-cookie-key.v1.json": Buffer.from(mirror.keyFile),
      })) {
        const file = path.join(native, name);
        await writeFile(file, bytes, { mode: 0o600 });
        artifacts.set(file, bytes);
      }
    }
    await database.transaction().execute(async (tx) => {
      await sql`create schema native_only_upgrade`.execute(tx);
      await sql`set local search_path = native_only_upgrade, public`.execute(tx);
      await sql`create table deployments(id text primary key)`.execute(tx);
      await sql`create table runners(id text primary key)`.execute(tx);
      await sql`create table browser_profiles(id text primary key, owner_id text not null, name text not null, revision integer not null default 0, archived_at timestamptz)`.execute(
        tx,
      );
      await sql`create table browser_profile_revisions(profile_id text references browser_profiles(id), revision integer, ciphertext bytea)`.execute(
        tx,
      );
      await sql`create table requests(id text primary key,kind text,status text,cancellation_reason text,resolved_at timestamptz)`.execute(
        tx,
      );
      await sql`create table request_continuations(request_id text primary key)`.execute(tx);
      await sql`create table browser_sessions(id text primary key,profile_id text references browser_profiles(id),lease_token_hash text,lease_generation integer,profile_lease_expires_at timestamptz,
          constraint browser_sessions_profile_lease_check check(true),constraint browser_sessions_lease_generation_check check(true))`.execute(
        tx,
      );
      await sql`create table browser_tabs(id text primary key,session_id text references browser_sessions(id) on delete cascade,title text)`.execute(
        tx,
      );
      await sql`create table browser_profile_grants(id text primary key,profile_id text references browser_profiles(id),workspace_id text)`.execute(
        tx,
      );
      await sql`create table browser_history_entries(id text primary key,profile_id text references browser_profiles(id),url text)`.execute(
        tx,
      );
      await sql`create table browser_history_icons(id text primary key,profile_id text references browser_profiles(id))`.execute(
        tx,
      );
      await sql`create table browser_tab_opens(binding jsonb)`.execute(tx);
      await nativeBrowserProfilesMigration.up(tx);
      await sql`insert into deployments values (${bindings[0]!.deploymentId})`.execute(tx);
      await sql`insert into runners values (${bindings[0]!.runnerId})`.execute(tx);
      for (const [index, binding] of bindings.entries()) {
        await sql`insert into browser_profiles(id,owner_id,name,revision,storage_state,storage_binding_version,storage_deployment_id,storage_runner_id,storage_instance_id,storage_binding_id,storage_engine,frozen_seed_revision,frozen_seed_digest)
          values (${binding.profileId},'owner',${`Profile ${index + 1}`},3,'local',1,${binding.deploymentId},${binding.runnerId},${binding.storageInstanceId}::uuid,${binding.bindingId}::uuid,'electron',3,repeat('a',64))`.execute(
          tx,
        );
        await sql`insert into browser_sessions(id,profile_id) values (${`session-${index}`},${binding.profileId})`.execute(
          tx,
        );
        await sql`insert into browser_tabs values (${`tab-${index}`},${`session-${index}`},'Signed in')`.execute(
          tx,
        );
        await sql`insert into browser_profile_grants values (${`grant-${index}`},${binding.profileId},'workspace')`.execute(
          tx,
        );
        await sql`insert into browser_history_entries values (${`history-${index}`},${binding.profileId},'https://example.test/account')`.execute(
          tx,
        );
      }
      await sql`insert into browser_profiles(id,owner_id,name) values ('vault','owner','Vault'),('initializing','owner','Discard'),('erasure','owner','Deleted')`.execute(
        tx,
      );
      for (const [index, id] of ["initializing", "erasure"].entries()) {
        await sql`update browser_profiles set storage_state='initializing', storage_binding_version=1,
          storage_deployment_id=${bindings[0]!.deploymentId}, storage_runner_id=${bindings[0]!.runnerId},
          storage_instance_id=${bindings[0]!.storageInstanceId}::uuid,
          storage_binding_id=${`90000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`}::uuid,
          storage_engine='electron', frozen_seed_revision=1, frozen_seed_digest=repeat('a',64),
          initialization_token_hash=repeat('b',64), initialization_token_expires_at=now()+interval '1 minute'
          where id=${id}`.execute(tx);
      }
      await sql`insert into browser_profile_revisions values ('vault',1,decode('010203','hex'))`.execute(
        tx,
      );
      await sql`insert into browser_sessions(id,profile_id) values ('old-session','vault')`.execute(
        tx,
      );
      await sql`insert into browser_tabs values ('old-tab','old-session','Old')`.execute(tx);
      await sql`insert into browser_profile_grants values ('old-grant','vault','workspace')`.execute(
        tx,
      );
      await sql`insert into browser_history_entries values ('old-history','vault','https://old.test')`.execute(
        tx,
      );
      await sql`insert into browser_tab_opens values ('{"chosenSessionId":"old-session"}'::jsonb)`.execute(
        tx,
      );
      await sql`insert into requests values ('retired-save','browser.profile.save','pending',null,null)`.execute(
        tx,
      );
      await sql`insert into browser_profile_deletions(deletion_id,profile_id,binding_version,deployment_id,runner_id,storage_instance_id,binding_id,engine,state)
          values ('90000000-0000-4000-8000-000000000001','erasure',1,${bindings[0]!.deploymentId},${bindings[0]!.runnerId},${bindings[0]!.storageInstanceId}::uuid,'90000000-0000-4000-8000-000000000002','electron','pending-restart')`.execute(
        tx,
      );
      await sql`insert into request_continuations values ('retired-save')`.execute(tx);
      const tables = [
        "browser_sessions",
        "browser_tabs",
        "browser_profile_grants",
        "browser_history_entries",
      ];
      const before = await Promise.all(
        tables.map((table) =>
          sql
            .raw(
              `select * from ${table} where ${table === "browser_tabs" ? "id like 'tab-%'" : table === "browser_sessions" ? "id like 'session-%'" : "id not like 'old-%'"} order by id`,
            )
            .execute(tx)
            .then((result) => result.rows),
        ),
      );
      await browserNativeOnlyMigration.up(tx);
      const profiles = (await sql`select * from browser_profiles order by id`.execute(tx))
        .rows as Array<Record<string, unknown>>;
      expect(profiles).toHaveLength(3);
      for (const [index, binding] of bindings.entries())
        expect(profiles.find((row) => row.id === binding.profileId)).toMatchObject({
          name: `Profile ${index + 1}`,
          ownerId: "owner",
          storageState: "local",
          initialized: true,
          storageBindingVersion: binding.version,
          storageDeploymentId: binding.deploymentId,
          storageRunnerId: binding.runnerId,
          storageBindingId: binding.bindingId,
          storageEngine: binding.engine,
          storageInstanceId: binding.storageInstanceId,
          archivedAt: null,
        });
      expect(profiles.find((row) => row.id === "erasure")).toMatchObject({
        initialized: true,
        storageState: "local",
        storageBindingId: "90000000-0000-4000-8000-000000000002",
        archivedAt: expect.any(Date),
      });
      const after = await Promise.all(
        tables.map((table) =>
          sql
            .raw(`select * from ${table} order by id`)
            .execute(tx)
            .then((result) => result.rows),
        ),
      );
      expect(after).toEqual(
        before.map((rows, index) =>
          index === 0
            ? rows.map((row) => {
                const {
                  leaseTokenHash: _token,
                  leaseGeneration: _generation,
                  profileLeaseExpiresAt: _expiry,
                  ...retained
                } = row as Record<string, unknown>;
                return retained;
              })
            : rows,
        ),
      );
      expect((await sql`select * from browser_tab_opens`.execute(tx)).rows).toEqual([]);
      expect((await sql`select * from request_continuations`.execute(tx)).rows).toEqual([]);
      expect((await sql`select state from browser_profile_deletions`.execute(tx)).rows).toEqual([
        { state: "pending-restart" },
      ]);
      expect((await sql`select status,cancellation_reason from requests`.execute(tx)).rows).toEqual(
        [{ status: "cancelled", cancellationReason: "resource-deleted" }],
      );
      expect(
        (
          await sql`select column_name from information_schema.columns where table_schema='native_only_upgrade' and column_name in ('revision','frozen_seed_revision','frozen_seed_digest','initialization_token_hash','initialization_token_expires_at','lease_token_hash','lease_generation','profile_lease_expires_at')`.execute(
            tx,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await sql`select to_regclass('native_only_upgrade.browser_profile_revisions') as revisions`.execute(
            tx,
          )
        ).rows,
      ).toEqual([{ revisions: null }]);
      await sql`drop schema native_only_upgrade cascade`.execute(tx);
    });
    for (const binding of bindings)
      expect(await store.requireReady(binding)).toBe(store.directory(binding));
    await store.close();
    const files = vi.fn(async () => {
      throw new Error("Established profiles must not be recreated");
    });
    const acknowledge = vi.fn(async () => {
      throw new Error("Established profiles need no initialization acknowledgement");
    });
    const engine = new FakeIsolatingLauncher();
    const restored: Array<readonly Record<string, unknown>[]> = [];
    const activeMirrors: SessionCookieMirror[] = [];
    const launcher: BrowserLauncher = {
      localProfiles: {
        engine: "electron",
        createFiles: files,
        release: async () => "retained-until-exit",
      },
      launch: async (request, signal) => {
        expect(request.storage.kind).toBe("local");
        if (request.storage.kind !== "local") throw new Error("Native binding required");
        expect(request.storage.directory).toBe(
          path.join(store.root, "profiles", request.storage.binding.profileId, "native"),
        );
        let jar: unknown[] = [];
        const mirror = new SessionCookieMirror({
          directory: path.dirname(request.storage.directory),
          binding: request.storage.binding,
          cryptography: {
            isAsyncEncryptionAvailable: async () => true,
            getSelectedStorageBackend: () => "gnome_libsecret",
            decryptStringAsync: async (value) => ({
              result: value.toString(),
              shouldReEncrypt: false,
            }),
            encryptStringAsync: async () => {
              throw new Error("Established keys must not be rewritten");
            },
          },
          capture: async () => jar,
          restore: async (cookies) => {
            restored.push(cookies);
            jar = cookies.map((cookie) => ({
              ...cookie,
              domain: cookie.domain ?? new URL(String(cookie.url)).hostname,
              session: true,
              expires: -1,
            }));
          },
          subscribe: () => () => {},
          onFailure: (error) => {
            throw error;
          },
          publish: async () => {
            throw new Error("Established mirrors must not be rewritten");
          },
        });
        activeMirrors.push(mirror);
        const browser = await engine.launch(request, signal);
        return Object.assign(browser, {
          profile: {
            ready: async () => {
              expect(await mirror.recover()).toBe(true);
            },
            admit: async () => {},
          },
        });
      },
    };
    const verifier = new FakeTicketVerifier();
    const runtime = new BrowserRuntime({
      launcher,
      ticketVerifier: verifier,
      localProfiles: { root },
      runtimeId: "runtime_test",
      sessionFilesRoot: path.join(root, ".opensteer-runtime", "session-files"),
      acknowledgeProfileReady: acknowledge,
    });
    try {
      for (const [index, binding] of bindings.entries()) {
        const ticket = String(index);
        verifier.setClaims(
          ticket,
          validClaims({
            sessionId: BrowserSessionIdSchema.parse(
              `bsn_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            ),
            identity: {
              kind: "profile-local",
              binding,
              initialized: true,
              readyUrl: "https://host.test/ready",
            },
          }),
        );
        const opened = await runtime.attach(ticket, new FakeSink());
        expect(restored[index]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "sid", value: `existing-sign-in-${index + 1}` }),
            expect.objectContaining({
              name: "partitioned",
              value: `existing-partition-${index + 1}`,
              partitionKey: { topLevelSite: "https://shop.test", hasCrossSiteAncestor: true },
            }),
          ]),
        );
        await opened.close();
      }
      expect(engine.launchCount).toBe(2);
      expect(files).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
      for (const [file, bytes] of artifacts) expect(await readFile(file)).toEqual(bytes);
    } finally {
      await runtime.shutdown();
      await Promise.all(activeMirrors.map((mirror) => mirror.stop()));
    }
  } finally {
    await store.close();
    await database.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
