import { freePort } from "@opensteer/shared/test-support/loopbackPort";
/**
 * Personal pre-update database snapshot journey, on a disposable deployment.
 *
 * Release A is every shipped migration but the last; release B is all of them,
 * so the update has a real pending migration. The journey writes A's data,
 * stops PostgreSQL, takes the snapshot the supervisor takes on B's first start,
 * commits B and migrates. It then follows docs/releases.md#personal-database-snapshots
 * by hand to bring A's data back, and checks that pruning keeps the newest
 * three. Evidence: `journey.json` under OPENSTEER_PERSONAL_SNAPSHOT_EVIDENCE_DIR.
 *
 *   OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE=<reviewed PostgreSQL 17 directory> \
 *     pnpm --filter @opensteer/desktop exec tsx scripts/personal-database-snapshot-journey.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import { createDatabase } from "../../../packages/database/src/connection.js";
import { migrateToLatest, migrationProvider } from "../../../packages/database/src/migrations.js";
import {
  NativePersonalDeploymentFilesystem,
  PersonalDeploymentManifestSchema,
  type PersonalRuntimeIdentity,
} from "../src/secrets/personal-deployment-store.js";
import { retainedDatabaseSnapshots } from "../src/supervisor/personal-database-snapshot.js";

const postgresSource = process.env.OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE;
if (!postgresSource) throw new Error("OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE is required.");
const evidenceDirectory =
  process.env.OPENSTEER_PERSONAL_SNAPSHOT_EVIDENCE_DIR ??
  path.join(tmpdir(), "opensteer-personal-snapshot");
await mkdir(evidenceDirectory, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "opensteer-personal-snapshot-"));
const binary = (name: string) => path.join(postgresSource, "bin", name);
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: [] };
const step = (name: string, fields: Record<string, unknown> = {}) => {
  (evidence.steps as unknown[]).push({ step: name, at: new Date().toISOString(), ...fields });
  process.stdout.write(`${name} ${JSON.stringify(fields)}\n`);
};

const releaseA: PersonalRuntimeIdentity = {
  architecture: process.arch === "x64" ? "amd64" : "arm64",
  hostVersion: "0.1.200",
  manifestSha256: "a".repeat(64),
  operatingSystem: "darwin",
  postgresMajor: 17,
  postgresVersion: "17.11.0",
  runnerVersion: "0.1.200",
};
const releaseB: PersonalRuntimeIdentity = {
  ...releaseA,
  hostVersion: "0.1.201",
  manifestSha256: "b".repeat(64),
  runnerVersion: "0.1.201",
};
const allMigrations = await migrationProvider().getMigrations();
const names = Object.keys(allMigrations).sort();
const migrationsA = Object.fromEntries(
  names.slice(0, -1).map((name) => [name, allMigrations[name]!]),
);
const pendingInB = names.at(-1)!;

let postgres: ChildProcess | undefined;
try {
  const files = new NativePersonalDeploymentFilesystem({ dataDirectory: root });
  const now = new Date().toISOString();
  const postgresPort = await freePort();
  let manifest = await files.create({
    createdAt: now,
    databaseInitialized: true,
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: null,
    hostPort: await freePort(),
    name: "Snapshot journey",
    ownerInitialized: false,
    postgresPort,
    release: releaseA,
    runnerId: createId("runner"),
    schemaVersion: 3,
    setupIntentId: globalThis.crypto.randomUUID(),
    updatedAt: now,
    workspaceRoot: path.join(root, "Workspaces"),
  });
  const paths = await files.prepare(manifest);
  run(binary("initdb"), [
    "--pgdata",
    paths.postgresDataDirectory,
    "--username",
    "opensteer",
    "--auth",
    "trust",
    "--encoding",
    "UTF8",
  ]);
  const url = `postgresql://opensteer@127.0.0.1:${postgresPort}/postgres`;

  // Release A: its schema, and data only A wrote.
  postgres = await startPostgres(paths.postgresDataDirectory, postgresPort);
  let database = createDatabase({ connectionString: url, maxConnections: 1 });
  await migrateToLatest(database, { getMigrations: async () => migrationsA });
  const sentinel = database.withTables<{ journey_sentinel: { id: string; note: string } }>();
  await sentinel.schema
    .createTable("journey_sentinel")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("note", "text")
    .execute();
  await sentinel
    .insertInto("journey_sentinel")
    .values([
      { id: "a1", note: "written by A" },
      { id: "a2", note: "also A" },
    ])
    .execute();
  const appliedA = await applied(database);
  assert.equal(appliedA.length, names.length - 1);
  await database.destroy();
  await stopPostgres(postgres);
  postgres = undefined;
  step("release-a-quit", { applied: appliedA.length, sentinel: ["a1", "a2"] });

  // B's first start: the supervisor's snapshot, then the cutover, then B's Host migrates.
  const started = performance.now();
  const snapshotA = await files.snapshotDatabase(manifest, releaseB, new Date());
  const snapshotMs = Math.round(performance.now() - started);
  manifest = await files.commitCompatibleRelease(manifest, releaseB, new Date().toISOString());
  const snapshotDirectory = path.join(paths.rootDirectory, "snapshots", snapshotA);
  const metadata = JSON.parse(
    await readFile(path.join(snapshotDirectory, "snapshot.json"), "utf8"),
  );
  assert.deepEqual(metadata.fromRelease, releaseA);
  assert.deepEqual(metadata.toRelease, releaseB);
  assert.ok(snapshotMs < 2_000, `snapshot took ${snapshotMs} ms`);
  step("release-b-snapshot", { snapshot: snapshotA, snapshotMs });

  postgres = await startPostgres(paths.postgresDataDirectory, postgresPort);
  database = createDatabase({ connectionString: url, maxConnections: 1 });
  await migrateToLatest(database);
  const appliedB = await applied(database);
  assert.equal(appliedB.at(-1), pendingInB);
  // Work done under B, which the restore must set aside.
  const sentinelB = database.withTables<{ journey_sentinel: { id: string; note: string } }>();
  await sentinelB.deleteFrom("journey_sentinel").where("id", "=", "a1").execute();
  await sentinelB
    .insertInto("journey_sentinel")
    .values({ id: "b1", note: "written by B" })
    .execute();
  await database.destroy();
  step("release-b-migrated", { applied: appliedB.length, pendingApplied: pendingInB });

  // The manual restore, exactly as docs/releases.md describes it.
  await stopPostgres(postgres); // 1. Quit Opensteer.
  postgres = undefined;
  await rename(paths.postgresDataDirectory, `${paths.postgresDataDirectory}.before-restore`); // 2.
  run("/bin/cp", ["-cRp", path.join(snapshotDirectory, "postgres"), paths.postgresDataDirectory]); // 3.
  const saved = JSON.parse(await readFile(files.manifestPath, "utf8"));
  await writeFile(
    files.manifestPath,
    `${JSON.stringify({ ...saved, release: metadata.fromRelease }, null, 2)}\n`,
  ); // 4.
  const restoredManifest = await files.load();
  assert.deepEqual(restoredManifest?.release, releaseA);
  PersonalDeploymentManifestSchema.parse(restoredManifest);
  postgres = await startPostgres(paths.postgresDataDirectory, postgresPort); // 5. Release A starts.
  database = createDatabase({ connectionString: url, maxConnections: 1 });
  await migrateToLatest(database, { getMigrations: async () => migrationsA });
  const appliedRestored = await applied(database);
  const rows = await database
    .withTables<{ journey_sentinel: { id: string; note: string } }>()
    .selectFrom("journey_sentinel")
    .select(["id", "note"])
    .orderBy("id")
    .execute();
  await database.destroy();
  assert.deepEqual(appliedRestored, appliedA);
  assert.deepEqual(rows, [
    { id: "a1", note: "written by A" },
    { id: "a2", note: "also A" },
  ]);
  await stopPostgres(postgres);
  postgres = undefined;
  step("manual-restore", { applied: appliedRestored.length, rows });

  // Retention: an unfinished copy is removed, and the newest three survive.
  const snapshots = path.join(paths.rootDirectory, "snapshots");
  await mkdir(path.join(snapshots, "20000101T000000Z-unfinished", "postgres"), { recursive: true });
  const taken: string[] = [];
  for (const [index, from] of ["0.1.202", "0.1.203", "0.1.204", "0.1.205"].entries()) {
    taken.push(
      await files.snapshotDatabase(
        { ...manifest, release: { ...releaseA, hostVersion: from } },
        releaseB,
        new Date(Date.parse("2030-01-01T00:00:00Z") + index * 60_000),
      ),
    );
  }
  const kept = (await readdir(snapshots)).sort();
  assert.deepEqual(kept, taken.slice(-retainedDatabaseSnapshots).sort());
  step("pruned", { taken, kept });

  evidence.result = "passed";
} catch (error) {
  evidence.result = "failed";
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (postgres) await stopPostgres(postgres).catch(() => postgres?.kill("SIGKILL"));
  await rm(root, { force: true, recursive: true });
  evidence.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(evidenceDirectory, "journey.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  process.stdout.write(
    `journey ${String(evidence.result)}: ${path.join(evidenceDirectory, "journey.json")}\n`,
  );
}

function run(executable: string, arguments_: readonly string[]): void {
  const result = spawnSync(executable, arguments_, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${executable} failed: ${result.stderr || result.stdout}`);
}

async function startPostgres(dataDirectory: string, port: number) {
  // TCP only: a socket under the temporary root would exceed the Unix socket path limit.
  const child = spawn(
    binary("postgres"),
    [
      "-D",
      dataDirectory,
      "-p",
      String(port),
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "unix_socket_directories=",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 30_000;
  while (
    spawnSync(binary("pg_isready"), ["-q", "-h", "127.0.0.1", "-p", String(port)]).status !== 0
  ) {
    if (child.exitCode !== null) throw new Error(`PostgreSQL exited during startup: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`PostgreSQL did not become ready: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return child;
}

/** The app's quit: a graceful stop that leaves a clean shutdown checkpoint. */
async function stopPostgres(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function applied(database: ReturnType<typeof createDatabase>): Promise<string[]> {
  const rows = await database
    .withTables<{ kysely_migration: { name: string; timestamp: string } }>()
    .selectFrom("kysely_migration")
    .select("name")
    .orderBy("name")
    .execute();
  return rows.map(({ name }) => name);
}
