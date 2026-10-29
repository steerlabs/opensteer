import { randomBytes } from "node:crypto";
import { createDatabase } from "@opensteer/database";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPristineUnmigratedDatabase } from "./managed-destruction.js";

const configuredDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = configuredDatabaseUrl ? describe : describe.skip;
const databaseName = `opensteer_pristine_${randomBytes(8).toString("hex")}`;
const adminUrl = configuredDatabaseUrl
  ? databaseUrlWithName(configuredDatabaseUrl, "postgres")
  : "postgres://unconfigured";
const isolatedUrl = configuredDatabaseUrl
  ? databaseUrlWithName(configuredDatabaseUrl, databaseName)
  : "postgres://unconfigured";

integration("pristine managed database detection", () => {
  const administrator = createDatabase({ connectionString: adminUrl, maxConnections: 1 });
  const database = createDatabase({
    applicationName: "opensteer-pristine-detection-integration-test",
    connectionString: isolatedUrl,
    maxConnections: 1,
  });

  beforeAll(async () => {
    await sql.raw(`create database ${databaseName}`).execute(administrator);
  });

  afterAll(async () => {
    await database.destroy();
    await sql.raw(`drop database if exists ${databaseName}`).execute(administrator);
    await administrator.destroy();
  });

  it("accepts an empty database", async () => {
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(true);
  });

  it("refuses an unrelated table in a non-system schema", async () => {
    await sql`create table unrelated_data (id integer primary key)`.execute(database);
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(false);
    await sql`drop table unrelated_data`.execute(database);
  });

  it("refuses an unknown non-system schema even when it is empty", async () => {
    await sql`create schema unknown_application`.execute(database);
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(false);
    await sql`drop schema unknown_application`.execute(database);
  });

  it("accepts empty Kysely bookkeeping but refuses a recorded migration", async () => {
    await sql`create table kysely_migration (name varchar(255) primary key, timestamp varchar(255) not null)`.execute(
      database,
    );
    await sql`create table kysely_migration_lock (id varchar(255) primary key, is_locked integer default 0 not null)`.execute(
      database,
    );
    await sql`insert into kysely_migration_lock (id, is_locked) values ('migration_lock', 0)`.execute(
      database,
    );
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(true);
    await sql`insert into kysely_migration (name, timestamp) values ('partial', 'now')`.execute(
      database,
    );
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(false);
  });

  it("refuses a partial Opensteer schema", async () => {
    await sql`delete from kysely_migration`.execute(database);
    await sql`create table deployments (id text primary key)`.execute(database);
    await expect(isPristineUnmigratedDatabase(database)).resolves.toBe(false);
  });
});

function databaseUrlWithName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}
