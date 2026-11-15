import pg from "pg";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * Room for every team Host pod a rollout runs at once: a Host pools up to 10 connections
 * (its bus listener among them), times two steady replicas plus a surge pod.
 */
const teamConnectionLimit = 32;

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

/** PostgreSQL's stored form of a SCRAM-SHA-256 password (RFC 7677). */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export interface TeamDatabase {
  exists(id: string): Promise<boolean>;
  ensure(id: string, databaseUrl: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Every team login can reach a database PUBLIC may connect to, and read other teams' names there. */
export const sharedDatabaseNames = ["postgres", "template1"] as const;

export class PostgresTeamDatabase implements TeamDatabase {
  private readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** The databases outside any team that still admit every role. */
  async openSharedDatabases(names: readonly string[] = sharedDatabaseNames): Promise<string[]> {
    const result = await this.pool.query<{ datname: string }>(
      "select datname from pg_database where datname = any($1) and has_database_privilege('public', oid, 'CONNECT') order by datname",
      [names],
    );
    return result.rows.map((row) => row.datname);
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
        // Only the SCRAM verifier reaches the server, so the password can't surface in its logs.
        await client.query(
          `CREATE ROLE ${identifier} LOGIN PASSWORD ${pg.escapeLiteral(scramSha256Verifier(password))} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${teamConnectionLimit}`,
        );
      }
      await client.query(`ALTER ROLE ${identifier} CONNECTION LIMIT ${teamConnectionLimit}`);
      await client.query(`GRANT ${identifier} TO CURRENT_USER WITH SET TRUE`);
      const database = await client.query("select 1 from pg_database where datname=$1", [name]);
      // PUBLIC may connect to a new database, and a session outlives a later REVOKE, so the
      // database admits no one until PUBLIC is gone, including after a crash in between.
      if (!database.rowCount)
        await client.query(
          `CREATE DATABASE ${identifier} OWNER ${identifier} ALLOW_CONNECTIONS false`,
        );
      await client.query(`REVOKE ALL ON DATABASE ${identifier} FROM PUBLIC`);
      await client.query(`ALTER DATABASE ${identifier} ALLOW_CONNECTIONS true`);
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
