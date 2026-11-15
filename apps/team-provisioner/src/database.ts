import pg from "pg";
import { createHash, randomBytes } from "node:crypto";

export function teamDatabaseName(id: string): string {
  return `team_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

export function teamDatabaseUrl(id: string, host: string): string {
  const name = teamDatabaseName(id);
  const url = new URL(
    `postgresql://${name}:${randomBytes(32).toString("hex")}@${host}:5432/${name}`,
  );
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", "/run/secrets/host/database-ca.pem");
  return url.toString();
}

export interface TeamDatabase {
  exists(id: string): Promise<boolean>;
  ensure(id: string, databaseUrl: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export class PostgresTeamDatabase implements TeamDatabase {
  private readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "select 1 from pg_roles where rolname=$1 union all select 1 from pg_database where datname=$1",
      [teamDatabaseName(id)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async ensure(id: string, databaseUrl: string): Promise<void> {
    const name = teamDatabaseName(id);
    const identifier = pg.escapeIdentifier(name);
    const client = await this.pool.connect();
    try {
      // Session locking spans CREATE DATABASE, which cannot run in a transaction.
      await client.query("select pg_advisory_lock(hashtext($1))", [name]);
      const role = await client.query("select 1 from pg_roles where rolname=$1", [name]);
      if (!role.rowCount) {
        const password = decodeURIComponent(new URL(databaseUrl).password);
        await client.query(
          `CREATE ROLE ${identifier} LOGIN PASSWORD ${pg.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16`,
        );
      }
      await client.query(`GRANT ${identifier} TO CURRENT_USER WITH SET TRUE`);
      const database = await client.query("select 1 from pg_database where datname=$1", [name]);
      if (!database.rowCount)
        await client.query(`CREATE DATABASE ${identifier} OWNER ${identifier}`);
      await client.query(`REVOKE ALL ON DATABASE ${identifier} FROM PUBLIC`);
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [name]);
      } finally {
        client.release();
      }
    }
  }

  async delete(id: string): Promise<void> {
    const name = teamDatabaseName(id);
    const identifier = pg.escapeIdentifier(name);
    const client = await this.pool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [name]);
      const role = await client.query("select 1 from pg_roles where rolname=$1", [name]);
      if (role.rowCount) await client.query(`ALTER ROLE ${identifier} NOLOGIN`);
      await client.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
      await client.query(`DROP ROLE IF EXISTS ${identifier}`);
      const remains = await client.query(
        "select 1 from pg_database where datname=$1 union all select 1 from pg_roles where rolname=$1",
        [name],
      );
      if (remains.rowCount) throw new Error("Team database deletion is incomplete");
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [name]);
      } finally {
        client.release();
      }
    }
  }
}
