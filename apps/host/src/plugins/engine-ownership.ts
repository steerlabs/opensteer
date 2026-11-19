/**
 * One plugin engine owns a runtime directory for the life of its process.
 *
 * Two engines on one runtime directory open the same workerd storage, whose SQLite databases do
 * not survive two writers (`SQLITE_BUSY_RECOVERY`). A Host restarted abruptly can start a new
 * engine while its old detached one still shuts down, so ownership is a lock the operating system
 * holds for the process, never a file a crash leaves behind.
 *
 * A database has one engine because it has one Host: the Host's data directory holds its instance
 * identity (`host-instance.json`), the database's deployment row names that one instance
 * (`ensureDeployment` refuses any other), and the runtime directory is inside that same data
 * directory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

/** How often an engine that waits for a directory asks for it again. */
const pollMs = 100;

/** The lock this process holds; kept referenced so it is never closed. */
let held: DatabaseSync | undefined;

/**
 * An exclusive lock on `engine.lock` in the directory, or nothing while another process holds it.
 * SQLite's exclusive locking mode keeps the file lock its first write transaction takes until the
 * connection closes: a POSIX record lock on Darwin and Linux, a LockFileEx lock on Windows. Each
 * belongs to this process, a child it starts does not inherit it, and the system releases it when
 * the process ends, however it ends.
 */
const take = (file: string) => {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    database.exec("COMMIT");
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error && /database is locked|SQLITE_BUSY/u.test(error.message))
      return undefined;
    throw error;
  }
};

/**
 * Take the runtime directory for this process, waiting while another process holds it, as the
 * engine of a Host that is still shutting down does. Nothing releases it before the process ends.
 */
export async function holdEngineDirectory(directory: string, waiting: () => void) {
  if (held !== undefined) return;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "engine.lock");
  for (let first = true; ; first = false) {
    held = take(file);
    if (held !== undefined) return;
    if (first) waiting();
    await delay(pollMs);
  }
}
