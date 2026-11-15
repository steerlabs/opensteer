import pg from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresTeamDatabase, teamDatabaseName, teamDatabaseUrl } from "./database.js";

// Skipped outside the PostgreSQL launcher, which provides the database URL.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

integration("team databases", () => {
  it("creates and force-drops a team as a non-superuser provisioner, including partial retries", async () => {
    const adminUrl = new URL(process.env.OPENSTEER_TEST_DATABASE_URL!);
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    // Roles are cluster-wide, so every name here is unique to this run.
    const provisionerRole = `team_provisioner_${randomUUID().replaceAll("-", "")}`;
    const provisionerPassword = randomUUID();
    await admin.query(
      `create role ${provisionerRole} login createdb createrole password ${pg.escapeLiteral(provisionerPassword)}`,
    );
    const provisionerUrl = new URL(adminUrl);
    provisionerUrl.username = provisionerRole;
    provisionerUrl.password = provisionerPassword;
    const pool = new pg.Pool({ connectionString: provisionerUrl.toString() });
    const database = new PostgresTeamDatabase(pool);
    const id = randomUUID();
    const name = teamDatabaseName(id);
    let team: pg.Client | undefined;
    try {
      const url = teamDatabaseUrl(id, "db.example.com");
      await database.ensure(id, url);
      await database.ensure(id, url);
      const role = await admin.query(
        "select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolpassword like 'SCRAM-SHA-256$%' as scram from pg_authid where rolname=$1",
        [name],
      );
      expect(role.rows).toEqual([
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolconnlimit: 32,
          scram: true,
        },
      ]);
      const privileges = await admin.query(
        "select has_database_privilege('public', $1, 'CONNECT') as allowed",
        [name],
      );
      expect(privileges.rows[0].allowed).toBe(false);
      // A database outside the teams counts as open until PUBLIC loses CONNECT on it.
      expect(await database.openSharedDatabases([name])).toEqual([]);
      await admin.query(`grant connect on database ${pg.escapeIdentifier(name)} to public`);
      expect(await database.openSharedDatabases([name])).toEqual([name]);
      await admin.query(`revoke connect on database ${pg.escapeIdentifier(name)} from public`);
      // The team logs in with the password whose verifier alone reached the server.
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
      await admin.query(`drop role ${provisionerRole}`);
      await admin.end();
    }
  });
});
