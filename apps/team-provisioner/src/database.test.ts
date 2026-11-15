import pg from "pg";
import { expect, it } from "vitest";
import { PostgresTeamDatabase, teamDatabaseName, teamDatabaseUrl } from "./database.js";

it.skipIf(!process.env.PROVISIONER_TEST_DATABASE_URL)(
  "creates and force-drops a team as a non-superuser provisioner, including partial retries",
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.PROVISIONER_TEST_DATABASE_URL });
    await admin.query("create role team_provisioner login createdb createrole");
    const provisionerUrl = new URL(process.env.PROVISIONER_TEST_DATABASE_URL!);
    provisionerUrl.username = "team_provisioner";
    const pool = new pg.Pool({ connectionString: provisionerUrl.toString() });
    const database = new PostgresTeamDatabase(pool);
    const id = "integration";
    const name = teamDatabaseName(id);
    let team: pg.Client | undefined;
    try {
      const url = teamDatabaseUrl(id, "db.example.com");
      await database.ensure(id, url);
      await database.ensure(id, url);
      const role = await admin.query(
        "select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname=$1",
        [name],
      );
      expect(role.rows).toEqual([
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolconnlimit: 16,
        },
      ]);
      const privileges = await admin.query(
        "select has_database_privilege('public', $1, 'CONNECT') as allowed",
        [name],
      );
      expect(privileges.rows[0].allowed).toBe(false);
      const connection = new URL(provisionerUrl);
      connection.username = name;
      connection.password = new URL(url).password;
      connection.pathname = `/${name}`;
      team = new pg.Client({ connectionString: connection.toString() });
      team.on("error", () => {});
      await team.connect();
      await database.delete(id);
      await database.delete(id);
      expect((await admin.query("select 1 from pg_roles where rolname=$1", [name])).rowCount).toBe(
        0,
      );
      expect(
        (await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount,
      ).toBe(0);
    } finally {
      await team?.end();
      await database.delete(id);
      await pool.end();
      await admin.query("drop role team_provisioner");
      await admin.end();
    }
  },
  15_000,
);
