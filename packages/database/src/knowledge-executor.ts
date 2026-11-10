import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { Socket } from "node:net";
import pg from "pg";
import { withDatabaseTransaction } from "./connection.js";
import { ensureKnowledge } from "./knowledge-schema.js";
import type { DatabaseSchema } from "./schema.js";

export interface KnowledgeExecutorCredentials {
  readonly role: string;
  readonly password: string;
}

/**
 * Creates or upgrades the knowledge schema and gives the restricted role a
 * fresh random password; call at every start with the trial on and keep the
 * password only in memory. The server receives a SCRAM verifier, so the
 * password itself never reaches its statement log.
 */
export async function prepareKnowledgeExecutor(
  database: Kysely<DatabaseSchema>,
): Promise<KnowledgeExecutorCredentials> {
  const password = randomBytes(32).toString("base64url");
  const role = await withDatabaseTransaction(database, (transaction) =>
    ensureKnowledge(transaction, scramVerifier(password)),
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "42501")
      throw new Error(
        "The knowledge trial needs a PostgreSQL user that may create roles and schemas; turn OPENSTEER_KNOWLEDGE off or run the Host as such a user",
        { cause: error },
      );
    throw error;
  });
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
    stream: () => new FramedSocket(),
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

/** The largest message a knowledge connection accepts; rows are at most 512 KB. */
export const knowledgeMessageBytes = 1_048_576;

export class KnowledgeMessageTooLarge extends Error {
  constructor() {
    super("PostgreSQL sent a knowledge connection a message over 1 MB");
  }
}

/**
 * Reads each backend message's header (type byte, then a length that counts
 * itself) as bytes arrive, and destroys the socket on one over the bound,
 * before the driver buffers it or turns it into a string where no catch reaches.
 */
class FramedSocket extends Socket {
  #header = Buffer.alloc(5);
  #headerBytes = 0;
  #bodyBytes = 0;

  override push(chunk: unknown, encoding?: BufferEncoding): boolean {
    if (!Buffer.isBuffer(chunk) || this.#accepts(chunk)) return super.push(chunk, encoding);
    this.destroy(new KnowledgeMessageTooLarge());
    return false;
  }

  #accepts(chunk: Buffer): boolean {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#bodyBytes > 0) {
        const taken = Math.min(this.#bodyBytes, chunk.length - offset);
        this.#bodyBytes -= taken;
        offset += taken;
        continue;
      }
      const taken = Math.min(5 - this.#headerBytes, chunk.length - offset);
      chunk.copy(this.#header, this.#headerBytes, offset, offset + taken);
      this.#headerBytes += taken;
      offset += taken;
      if (this.#headerBytes < 5) break;
      const length = this.#header.readUInt32BE(1);
      if (length < 4 || length - 4 > knowledgeMessageBytes) return false;
      this.#headerBytes = 0;
      this.#bodyBytes = length - 4;
    }
    return true;
  }
}
