import type { ListingPrivateFilesystem } from "@opensteer/client/connections";
import {
  checkpointFence,
  checkpointKeyDeployment,
  noCheckpointFences,
  personalCheckpointMaxBytes,
  raiseCheckpointFence,
  type CheckpointFences,
  type CheckpointStorage,
} from "@opensteer/client/host";
import { DeploymentIdSchema, utf8ByteLength } from "@opensteer/core";
import type { PersonalSessionStore } from "./personal-session-store.js";

type Entry = { readonly savedAt: number; readonly bytes: number };
const fencesName = "fences.json";
const fencesMaxBytes = 64 * 1024;
const checkpointName = /^[0-9a-f]{16}\.json$/u;
const journal = /\.(new|old)$/u;

/**
 * Which session this phone holds for a Deployment now, as an opaque label that changes with each
 * sign-in, or null when it holds none. The app's own session store answers.
 */
export type CurrentCheckpointSession = (deploymentId: string) => Promise<string | null>;

/**
 * The current session label from the phone's personal session store: present only while the
 * stored session is unexpired, and different for every sign-in (its login and absolute expiry;
 * never the token).
 */
export function personalSessionLabel(
  sessions: Pick<PersonalSessionStore, "authorization" | "load">,
  now: () => Date,
): CurrentCheckpointSession {
  return async (deploymentId) => {
    const id = DeploymentIdSchema.safeParse(deploymentId);
    if (!id.success || (await sessions.authorization(id.data, now())) === null) return null;
    const session = await sessions.load(id.data);
    return session ? `${session.viewLoginId ?? ""}|${session.absoluteExpiresAt}` : null;
  };
}

/**
 * Saved personal checkpoints as one private file per scope.
 *
 * The invariant: a checkpoint file exists, and is read, only for a Deployment this phone holds a
 * current session for, and only under that same session. Each file names its key, when it was
 * saved and the session it was saved under. Nothing depends on one write landing:
 * - a read or write checks the session store first;
 * - every start and every clear lists the directory and deletes whatever is not a checkpoint of
 *   the current session that the fences still allow — orphans, journals, records from before a
 *   clear, files of a Deployment signed out of;
 * - a clear tries the fence write and each deletion on its own, sweeps, and then reports any step
 *   that failed.
 * One process owns the directory.
 */
export function fileCheckpointStorage(
  privateFiles: ListingPrivateFilesystem,
  directory: string,
  currentSession: CurrentCheckpointSession,
): CheckpointStorage {
  const pathOf = (key: string) => `${directory}/${fileName(key)}.json`;
  let fences: CheckpointFences = noCheckpointFences;
  let entries = new Map<string, Entry>();
  const sessionOf = (key: string) => {
    const deploymentId = checkpointKeyDeployment(key);
    return deploymentId ? currentSession(deploymentId).catch(() => null) : Promise.resolve(null);
  };
  const sweep = async () => {
    entries = await sweepDirectory(privateFiles, directory, fences, sessionOf);
  };
  let ready: Promise<void> | undefined;
  // The first use sweeps, by when the session store can answer.
  const started = () =>
    (ready ??= (async () => {
      fences = await readFences(privateFiles, `${directory}/${fencesName}`);
      await sweep();
    })()).catch(() => undefined);
  return {
    list: async () => {
      await started();
      return [...entries].map(([key, entry]) => ({ key, ...entry }));
    },
    read: async (key) => {
      await started();
      if (!entries.has(key)) return null;
      const held = await readCheckpoint(privateFiles, pathOf(key));
      // The file names its key, and is read only under the session it was saved under.
      if (held?.key !== key) return null;
      const session = await sessionOf(key);
      return session !== null && held.session === session ? held.value : null;
    },
    fences: async () => {
      await started();
      return fences;
    },
    write: async (key, value, guard) => {
      await started();
      if (checkpointFence(fences, guard) !== guard.fence) return false;
      const session = await sessionOf(key);
      if (session === null || session.includes("\n")) return false;
      const savedAt = Date.now();
      await privateFiles.writeFileAtomic(pathOf(key), `${key}\n${savedAt}\n${session}\n${value}`);
      entries.set(key, { savedAt, bytes: utf8ByteLength(value) });
      return true;
    },
    remove: async (keys) => {
      await started();
      for (const key of keys) {
        entries.delete(key);
        await privateFiles.removeFile(pathOf(key));
      }
    },
    clear: async (matches, scope) => {
      await started();
      const failures: unknown[] = [];
      const attempt = async (step: () => Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      };
      fences = raiseCheckpointFence(fences, scope);
      await attempt(() =>
        privateFiles.writeFileAtomic(`${directory}/${fencesName}`, JSON.stringify(fences)),
      );
      for (const key of [...entries.keys()].filter(matches)) {
        entries.delete(key);
        await attempt(() => privateFiles.removeFile(pathOf(key)));
      }
      await attempt(sweep);
      if (failures.length)
        throw new AggregateError(failures, "Saved private state could not all be cleared.");
    },
  };
}

/**
 * Deletes every file in the directory that is not a checkpoint saved under its Deployment's
 * current session and still allowed by `fences`, and returns the ones that are. A step that fails
 * does not stop the rest; the first failure is rethrown at the end.
 */
async function sweepDirectory(
  privateFiles: ListingPrivateFilesystem,
  directory: string,
  fences: CheckpointFences,
  sessionOf: (key: string) => Promise<string | null>,
): Promise<Map<string, Entry>> {
  const kept = new Map<string, Entry>();
  let failure: unknown;
  const remove = async (path: string) => {
    await privateFiles.removeFile(path).catch((error: unknown) => {
      failure ??= error;
    });
  };
  // A journal file stands for the file it was writing: reading that settles the journal.
  const names = new Set(
    (await privateFiles.listFiles(directory)).map((name) => name.replace(journal, "")),
  );
  for (const name of names) {
    if (name === fencesName) continue;
    const path = `${directory}/${name}`;
    const held = checkpointName.test(name) ? await readCheckpoint(privateFiles, path) : null;
    const valid =
      held !== null &&
      `${fileName(held.key)}.json` === name &&
      validUnder(fences, held.value) &&
      held.session === (await sessionOf(held.key));
    if (valid) kept.set(held.key, { savedAt: held.savedAt, bytes: utf8ByteLength(held.value) });
    else await remove(path);
  }
  // Whatever journal is still left belongs to no valid file.
  for (const name of await privateFiles.listFiles(directory))
    if (journal.test(name)) await remove(`${directory}/${name}`);
  if (failure !== undefined) throw failure;
  return kept;
}

/** A saved record names its viewer and the fence it was written under. */
function validUnder(fences: CheckpointFences, value: string) {
  try {
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== "object") return false;
    const fence = Reflect.get(record, "fence");
    const scope = Reflect.get(record, "scope");
    if (typeof fence !== "number" || !scope || typeof scope !== "object") return false;
    const deploymentId = Reflect.get(scope, "deploymentId");
    const viewerId = Reflect.get(scope, "viewerId");
    return (
      typeof deploymentId === "string" &&
      typeof viewerId === "string" &&
      fence >= checkpointFence(fences, { deploymentId, viewerId })
    );
  } catch {
    return false;
  }
}

async function readCheckpoint(
  privateFiles: ListingPrivateFilesystem,
  path: string,
): Promise<{ key: string; savedAt: number; session: string; value: string } | null> {
  const bytes = await privateFiles
    .readFile(path, personalCheckpointMaxBytes + 4096)
    .catch(() => null);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  const lines: number[] = [];
  for (let at = text.indexOf("\n"); at >= 0 && lines.length < 3; at = text.indexOf("\n", at + 1))
    lines.push(at);
  if (lines.length < 3) return null;
  const [first, second, third] = lines as [number, number, number];
  const savedAt = Number(text.slice(first + 1, second));
  return Number.isFinite(savedAt)
    ? {
        key: text.slice(0, first),
        savedAt,
        session: text.slice(second + 1, third),
        value: text.slice(third + 1),
      }
    : null;
}

async function readFences(
  privateFiles: ListingPrivateFilesystem,
  path: string,
): Promise<CheckpointFences> {
  const bytes = await privateFiles.readFile(path, fencesMaxBytes).catch(() => null);
  if (!bytes) return noCheckpointFences;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object") return noCheckpointFences;
    const all = Reflect.get(value, "all");
    const deployments = Reflect.get(value, "deployments");
    const viewers = Reflect.get(value, "viewers");
    return {
      all: typeof all === "number" ? all : 0,
      deployments: deployments && typeof deployments === "object" ? deployments : {},
      viewers: viewers && typeof viewers === "object" ? viewers : {},
    };
  } catch {
    // Unreadable fences are never trusted lower than they were: everything saved goes.
    return { all: Number.MAX_SAFE_INTEGER, deployments: {}, viewers: {} };
  }
}

/**
 * Removes the saved state of every earlier format under `root` (`personal-stream-v<format>`); none
 * is migrated. Every file in those directories goes, journals included.
 */
export async function dropEarlierCheckpointFormats(
  privateFiles: ListingPrivateFilesystem,
  root: string,
  format: number,
): Promise<void> {
  for (let earlier = 64; earlier < format; earlier++) {
    const directory = `${root}/personal-stream-v${earlier}`;
    for (const name of await privateFiles.listFiles(directory).catch(() => []))
      await privateFiles.removeFile(`${directory}/${name}`).catch(() => false);
  }
}

/** A short, stable file name for a key (two 32-bit FNV-1a hashes). */
function fileName(key: string) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
