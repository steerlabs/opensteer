/**
 * One plugin engine owns a runtime directory and a database for the life of its process.
 *
 * Two engines on one runtime directory open the same workerd storage, whose SQLite databases do
 * not survive two writers (`SQLITE_BUSY_RECOVERY`), and two on one database share its schedules
 * and workflow runs under one runner. A Host restarted abruptly can start a new engine while its
 * old detached one still shuts down, so ownership is the kernel's and the database's, never a
 * file a crash leaves behind.
 */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryKernelLock } from "@opensteer/shared/kernelLock";
import { Effect, Redacted } from "effect";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import { PluginServiceError } from "./engine-protocol.js";

/** How often an engine that waits for a directory asks for it again. */
const pollMs = 100;

/** Listen on a name only one live process can hold, or report that another holds it. */
const listen = (name: string) =>
  new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    // Held until the process exits; it never keeps the process alive.
    server.listen(name, () => resolve(true));
    server.unref();
  });

/**
 * Take the runtime directory for this process, waiting while another process holds it, as the
 * engine of a Host that is still shutting down does. The kernel releases it when this process
 * exits, crash included; nothing releases it before. Darwin locks a file in the directory
 * (O_EXLOCK); Linux and Windows hold a name derived from the directory's real path, an abstract
 * socket and a named pipe, which exist only while their process lives.
 */
export async function holdEngineDirectory(directory: string, waiting: () => void) {
  mkdirSync(directory, { recursive: true });
  const name = createHash("sha256").update(realpathSync(directory)).digest("hex").slice(0, 32);
  const take =
    process.platform === "darwin"
      ? async () => tryKernelLock(join(directory, "engine.lock")) !== undefined
      : process.platform === "win32"
        ? () => listen(`\\\\.\\pipe\\opensteer-plugin-engine-${name}`)
        : () => listen(`\0opensteer-plugin-engine-${name}`);
  for (let first = true; !(await take()); first = false) {
    if (first) waiting();
    await delay(pollMs);
  }
}

/** The database's engine lock: a session advisory lock of the engine's own connection. */
const lifetimeLock = "SELECT pg_advisory_lock(hashtextextended('plugin-engine', 0))";

/**
 * Hold the database's engine lock for the engine's scope, on a connection of its own. One whose
 * previous holder is still disconnecting gets it within the wait; a second Host running plugins
 * from the same database does not, and its engine fails to start with a clear error.
 */
export const holdEngineDatabase = (databaseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* PgClient.make({
      url: Redacted.make(databaseUrl),
      maxConnections: 1,
    }).pipe(Effect.provide(Reactivity.layer));
    const connection = yield* client.reserve;
    yield* connection.execute("SET lock_timeout = '10s'", [], undefined);
    yield* connection.execute(lifetimeLock, [], undefined).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "LockTimeoutError",
        () =>
          Effect.fail(
            new PluginServiceError(
              "unavailable",
              "Another Opensteer Host runs plugins from this database. Stop it, or give this Host a database of its own.",
              "PluginEngineDatabaseHeld",
            ),
          ),
      ),
    );
  });
