import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import pg from "pg";
import { withDatabaseTransaction } from "./connection.js";
import { ensureKnowledgeExecutor } from "./knowledge-schema.js";
import type { DatabaseSchema } from "./schema.js";

export interface KnowledgeExecutorCredentials {
  readonly role: string;
  readonly password: string;
}

/**
 * Gives the restricted role a fresh random password and returns it; call at
 * every start and keep it only in memory. The server receives a SCRAM
 * verifier, so the password itself never reaches its statement log.
 */
export async function prepareKnowledgeExecutor(
  database: Kysely<DatabaseSchema>,
): Promise<KnowledgeExecutorCredentials> {
  const password = randomBytes(32).toString("base64url");
  const role = await withDatabaseTransaction(database, (transaction) =>
    ensureKnowledgeExecutor(transaction, scramVerifier(password)),
  );
  return { role, password };
}

function scramVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const storedKey = createHash("sha256")
    .update(createHmac("sha256", salted).update("Client Key").digest())
    .digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * The two connections agent SQL runs on. Only the server's address comes from
 * the Host's connection string: nothing in its query (a user, a password,
 * startup options) can change who these connections log in as.
 */
export function createKnowledgeExecutorPool(
  hostConnectionString: string,
  credentials: KnowledgeExecutorCredentials,
): pg.Pool {
  const url = new URL(hostConnectionString);
  const pool = new pg.Pool({
    host: decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/u, "$1"),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: credentials.role,
    password: credentials.password,
    ssl: false,
    application_name: "opensteer-knowledge",
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 2,
    onConnect: async (client) => {
      const { rows } = await client.query<{ restricted: boolean }>(
        `select session_user = $1 and current_user = $1 and not r.rolsuper as restricted
         from pg_catalog.pg_roles r where r.rolname = session_user`,
        [credentials.role],
      );
      if (rows[0]?.restricted !== true)
        throw new Error("The knowledge pool is not logged in as its restricted login");
    },
  });
  // An idle connection that dies is dropped from the pool; nothing else needs to hear about it.
  pool.on("error", () => undefined);
  return pool;
}
