import { OpensteerError } from "@opensteer/core";
import {
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  PostgresDialect,
  type ControlConnectionProvider,
  type IsolationLevel,
  type Transaction,
} from "kysely";
import { addAbortListener } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type PoolClient } from "pg";
import {
  databaseOperation,
  databaseOperationOptions,
  inDatabaseOperationTransaction,
} from "./operation-budget.js";
import type { DatabaseSchema } from "./schema.js";
import { applyDatabaseOperationBudget } from "./operation-budget-executor.js";

interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly minConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly applicationName?: string;
}

const databaseHolders = new WeakMap<object, () => string>();
const databasePools = new WeakMap<object, Pool>();

class DrainingPostgresDialect extends PostgresDialect {
  override createDriver() {
    const driver = super.createDriver();
    const acquire = driver.acquireConnection.bind(driver);
    const destroy = driver.destroy.bind(driver);
    const acquiring = new Set<ReturnType<typeof acquire>>();
    let closing = false;
    driver.acquireConnection = (options) => {
      if (closing) return Promise.reject(new Error("Database is shutting down"));
      const pending = acquire(options);
      acquiring.add(pending);
      return pending.finally(() => acquiring.delete(pending));
    };
    driver.destroy = async (options) => {
      closing = true;
      // Kysely clears its pool reference before ending the pool. A new client
      // still entering acquireConnection needs that reference to finish checkout
      // and become releasable. pg drains the resulting checked-out clients.
      await Promise.allSettled(acquiring);
      await destroy(options);
    };
    return driver;
  }
}

/**
 * A raw session from the database's own pool, for a caller that must hold
 * session state and see the session end: Kysely hides its client's events.
 */
export async function checkoutSession<Schema>(database: Kysely<Schema>): Promise<PoolClient> {
  const pool = databasePools.get(database);
  if (!pool) throw new Error("This database was not created by createDatabase");
  return pool.connect();
}

/** Checkout sites only: SQL and connection credentials must never enter shutdown diagnostics. */
export function databaseShutdownDetails<Schema>(database: Kysely<Schema>): string {
  return databaseHolders.get(database)?.() ?? "";
}

export function createDatabase<Schema = DatabaseSchema>(
  options: DatabaseConnectionOptions,
  providedPool?: Pool,
): Kysely<Schema>;
export function createDatabase(
  options: DatabaseConnectionOptions,
  providedPool?: Pool,
): Kysely<DatabaseSchema>;
export function createDatabase<Schema = DatabaseSchema>(
  options: DatabaseConnectionOptions,
  providedPool?: Pool,
): Kysely<Schema> {
  const pool =
    providedPool ??
    new Pool({
      application_name: options.applicationName ?? "opensteer-host",
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      ...(options.minConnections === undefined ? {} : { min: options.minConnections }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMillis: options.idleTimeoutMs }),
    });

  const holders = new Map<object, { origin: Error; started: number; state: string }>();
  const clients = new Map<PoolClient, object>();
  const forget = (client: PoolClient) => {
    const token = clients.get(client);
    if (token) holders.delete(token);
    clients.delete(client);
  };
  pool.on("release", (_error, client) => forget(client));
  pool.on("remove", forget);
  // pg's idle listener is removed at checkout. A server can end a checked-out
  // client between queries, when there is no query promise to receive the error.
  // Keep an error listener through that interval so the driver can finish closing
  // the socket. The client will reject further queries and be discarded on release.
  pool.on("connect", (client) => client.on("error", () => {}));
  // An idle client the server ends (restart, failover) is dropped by the pool; without a
  // listener the error would crash the process.
  pool.on("error", () => {});
  const provideControlConnection: ControlConnectionProvider = async (consume) => {
    const control = new Client(pool.options);
    try {
      await control.connect();
      await consume({
        async executeQuery(query) {
          await control.query(query.sql, [...query.parameters]);
          return { rows: [] };
        },
        streamQuery() {
          throw new Error("A PostgreSQL control connection cannot stream rows");
        },
      });
    } finally {
      await control.end();
    }
  };
  const database = new Kysely<Schema>({
    dialect: new DrainingPostgresDialect({
      onCreateConnection: async (connection) => {
        // Kysely's provider path rechecks the query ID even when the query has already ended.
        const cancel = connection.cancelQuery?.bind(connection);
        const kill = connection.killSession?.bind(connection);
        if (cancel) connection.cancelQuery = () => cancel(provideControlConnection);
        if (kill) connection.killSession = () => kill(provideControlConnection);
        const execute = connection.executeQuery.bind(connection);
        connection.executeQuery = async <R>(query: CompiledQuery) => {
          const operation = databaseOperation();
          if (!operation?.transaction) return execute<R>(query);
          operation.signal.throwIfAborted();
          const remaining = Math.max(1, Math.ceil(operation.expiresAt - Date.now()));
          await execute(CompiledQuery.raw(`set local statement_timeout = ${remaining}`));
          await connection.collectSessionInfo?.();
          operation.signal.throwIfAborted();
          const pending = execute<R>(query);
          let cancellation: Promise<void> | undefined;
          const abort = addAbortListener(operation.signal, () => {
            cancellation = connection
              .cancelQuery?.(async () => {
                throw new Error("PostgreSQL control connection is unavailable");
              })
              .catch(() => undefined);
          });
          try {
            return await pending;
          } finally {
            abort[Symbol.dispose]();
            // Join the cancellation before the transaction rolls back or releases this session.
            await cancellation;
          }
        };
      },
      pool: {
        options: pool.options,
        async connect() {
          const token = {};
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = 40;
          const origin = new Error("Database checkout");
          Error.stackTraceLimit = limit;
          const holder = {
            origin,
            started: performance.now(),
            state: "acquiring",
          };
          holders.set(token, holder);
          try {
            const client = await pool.connect();
            holder.state = "checked out";
            clients.set(client, token);
            return client;
          } catch (error) {
            holders.delete(token);
            throw error;
          }
        },
        end: () => pool.end(),
      },
    }),
    // Column names are converted; what a JSON column holds is not. Opensteer's
    // own documents are camelCase already, and a document from elsewhere — an
    // MCP tool's schema, a program's environment — must read back exactly as
    // it was written: `PLUGIN_ROOT` is not `PLUGINROOT`.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
  applyDatabaseOperationBudget(database.getExecutor());
  databasePools.set(database, pool);
  databaseHolders.set(database, () =>
    [...holders.values()]
      .map(
        (holder) =>
          `${holder.state} for ${Math.round(performance.now() - holder.started)}ms at ${holder.origin.stack}`,
      )
      .join("; "),
  );
  return database;
}

/**
 * Whether an error is a transaction that lost to a concurrent one: a deadlock
 * or a serialization failure. PostgreSQL rolled it back whole, so running it
 * again is safe and usually succeeds.
 */
export function isTransactionConflict(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "40P01" || code === "40001";
}

/**
 * Whether an error is a value the schema refused: a unique, foreign-key, check
 * or not-null constraint. The same value fails the same way every time.
 */
export function isConstraintViolation(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && code.startsWith("23");
}

/**
 * A transaction found more rows to lock than it discovered before locking, and
 * rolled back to lock the larger set from the start.
 */
export class TransactionScopeChanged extends Error {}

/** Four total attempts. Callbacks must be database-only; publish their returned result after commit. */
export async function retryDatabaseTransaction<Result>(
  attempt: () => Promise<Result>,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      const retry = retryAdditional?.(error) || isTransactionConflict(error);
      if (!retry) throw error;
      if (index === 3) {
        // Retrying happens here and nowhere above: what reaches the caller is a
        // conflict it may try again, not a database error it cannot read.
        if (error instanceof TransactionScopeChanged) {
          throw new OpensteerError({
            cause: error,
            code: "conflict",
            message: "Concurrent changes kept moving this operation's scope; try again",
            retryable: true,
          });
        }
        if (isTransactionConflict(error)) {
          throw new OpensteerError({
            cause: error,
            code: "conflict",
            message: "Concurrent changes kept conflicting with this operation; try again",
            retryable: true,
          });
        }
        throw error;
      }
      await delay(5 + Math.floor(Math.random() * 15) * (index + 1));
    }
  }
}

export function withDatabaseTransaction<Schema, Result>(
  database: Kysely<Schema>,
  action: (transaction: Transaction<Schema>) => Promise<Result>,
  isolationLevel?: IsolationLevel,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  return retryDatabaseTransaction(
    () => runDatabaseTransactionOnce(database, action, isolationLevel),
    retryAdditional,
  );
}

/**
 * One attempt of a transaction under the operation's budget (each statement's timeout and its
 * cancel on the signal), never retried: what `withDatabaseTransaction` runs for each attempt.
 */
export async function runDatabaseTransactionOnce<Schema, Result>(
  database: Kysely<Schema>,
  action: (transaction: Transaction<Schema>) => Promise<Result>,
  isolationLevel?: IsolationLevel,
): Promise<Result> {
  const operation = databaseOperation();
  const options = databaseOperationOptions();
  const run = (connection: Kysely<Schema>) => {
    const builder = connection.transaction();
    return (isolationLevel ? builder.setIsolationLevel(isolationLevel) : builder).execute(
      (transaction) =>
        inDatabaseOperationTransaction(async () => {
          operation?.signal.throwIfAborted();
          const result = await action(transaction);
          operation?.signal.throwIfAborted();
          return result;
        }),
    );
  };
  try {
    return await (operation ? database.connection().execute(run, options) : run(database));
  } catch (error) {
    if (operation?.signal.aborted) throw operation.signal.reason;
    throw error;
  }
}
