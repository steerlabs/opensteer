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
 * fresh random password; call at every team Host start and keep the
 * password only in memory. The server receives a SCRAM verifier, so the
 * password itself never reaches its statement log.
 */
export async function prepareKnowledgeExecutor(
  database: Kysely<DatabaseSchema>,
): Promise<KnowledgeExecutorCredentials> {
  const password = randomBytes(32).toString("base64url");
  const role = await withDatabaseTransaction(database, (transaction) =>
    ensureKnowledge(transaction, scramVerifier(password)),
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
 * Where and how a knowledge connection connects. The server and database are
 * resolved exactly as pg resolves the Host's own connection, environment
 * included; who connects, and every startup parameter, are fixed here.
 */
export function knowledgeExecutorClientConfig(
  hostConnectionString: string,
  credentials: KnowledgeExecutorCredentials,
): pg.ClientConfig & { readonly Client: typeof pg.Client } {
  const host = new pg.Client({ connectionString: hostConnectionString });
  if (host.ssl)
    throw new Error(
      "Team knowledge does not support an encrypted database connection; reach PostgreSQL over the team recipe's private network",
    );
  return {
    Client: KnowledgeClient,
    host: host.host,
    port: host.port,
    database: host.database,
    user: credentials.role,
    password: credentials.password,
    ssl: false,
    stream: () => new FramedSocket(),
    client_encoding: "UTF8",
    connectionTimeoutMillis: 5_000,
  };
}

/** Sends only the login, database and its own name at startup: no options, replication or timeouts. */
class KnowledgeClient extends pg.Client {
  getStartupConf(): Record<string, string> {
    return {
      user: this.user ?? "",
      database: this.database ?? "",
      application_name: "opensteer-knowledge",
    };
  }
}

/** The two connections agent SQL runs on, logged in as the restricted role and nothing else. */
export function createKnowledgeExecutorPool(
  hostConnectionString: string,
  credentials: KnowledgeExecutorCredentials,
): pg.Pool {
  // pg-pool awaits onConnect and drops the connection when it rejects; its types say void.
  const options: pg.PoolConfig & { onConnect(client: pg.PoolClient): Promise<void> } = {
    ...knowledgeExecutorClientConfig(hostConnectionString, credentials),
    idleTimeoutMillis: 30_000,
    max: 2,
    async onConnect(client) {
      const { rows } = await client.query<{ restricted: boolean }>(
        `select session_user = $1 and current_user = $1 and not r.rolsuper as restricted
         from pg_catalog.pg_roles r where r.rolname = session_user`,
        [credentials.role],
      );
      if (rows[0]?.restricted !== true)
        throw new Error("The knowledge pool is not logged in as its restricted login");
    },
  };
  const pool = new pg.Pool(options);
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
