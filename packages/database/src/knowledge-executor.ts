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

/** The two connections agent SQL runs on, logged in as the restricted role and nothing else. */
export function createKnowledgeExecutorPool(
  hostConnectionString: string,
  credentials: KnowledgeExecutorCredentials,
): pg.Pool {
  const url = new URL(hostConnectionString);
  url.username = encodeURIComponent(credentials.role);
  url.password = encodeURIComponent(credentials.password);
  const pool = new pg.Pool({
    application_name: "opensteer-knowledge",
    connectionString: url.toString(),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 2,
  });
  // An idle connection that dies is dropped from the pool; nothing else needs to hear about it.
  pool.on("error", () => undefined);
  return pool;
}
