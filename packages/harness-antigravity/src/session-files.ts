import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { antigravityManagedPath, antigravityProfileRoot, protoFields } from "./profile-paths.js";

const SessionMetadataSchema = z.object({ cwd: z.string() });
const nativeSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Field numbers from Antigravity's TrajectoryMetadata proto in trajectory_metadata_blob.
const trajectoryWorkspacesField = 1;
const workspaceUriField = 1;
const trajectorySessionIdField = 6;
const trajectoryWorkspaceUrisField = 7;
const maxMetadataBlobBytes = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isNativeAntigravitySessionId(value: string): boolean {
  return nativeSessionId.test(value);
}

function decodeTrajectoryOwnership(blob: Uint8Array):
  | {
      readonly sessionId: string | undefined;
      readonly workspaceUris: readonly string[];
    }
  | undefined {
  try {
    let sessionId: string | undefined;
    const workspaceUris: string[] = [];
    for (const [field, value] of protoFields(blob)) {
      if (field === trajectorySessionIdField && sessionId === undefined) {
        const decoded = utf8Decoder.decode(value).trim();
        if (decoded.length > 0) sessionId = decoded;
      } else if (field === trajectoryWorkspacesField) {
        for (const [nestedField, nestedValue] of protoFields(value)) {
          if (nestedField !== workspaceUriField) continue;
          const uri = utf8Decoder.decode(nestedValue).trim();
          if (uri.length > 0) workspaceUris.push(uri);
        }
      } else if (field === trajectoryWorkspaceUrisField) {
        const uri = utf8Decoder.decode(value).trim();
        if (uri.length > 0) workspaceUris.push(uri);
      }
    }
    return { sessionId, workspaceUris };
  } catch {
    return undefined;
  }
}

function readDatabaseWorkspacePaths(
  databasePath: string,
  sessionId: string,
): readonly string[] | undefined {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const rows = database
      .prepare("SELECT data FROM trajectory_metadata_blob WHERE length(data) <= ? LIMIT 2")
      .all(maxMetadataBlobBytes) as readonly { readonly data?: unknown }[];
    if (rows.length !== 1) return undefined;
    const data = rows[0]?.data;
    if (!(data instanceof Uint8Array)) return undefined;
    const metadata = decodeTrajectoryOwnership(data);
    if (
      !metadata ||
      metadata.workspaceUris.length === 0 ||
      (metadata.sessionId !== undefined && metadata.sessionId !== sessionId)
    ) {
      return undefined;
    }
    return metadata.workspaceUris.map((uri) => fileURLToPath(uri));
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

async function pathKey(target: string): Promise<string> {
  const canonical = await realpath(target).catch(() => resolve(target));
  return sep === "\\" ? canonical.toLowerCase() : canonical;
}

/** Removes only the temporary conversation whose metadata proves our scratch cwd owns it. */
export async function removeTemporaryAntigravitySession(input: {
  readonly cwd: string;
  readonly profileDirectory: string;
  readonly sessionId: string | undefined;
}): Promise<void> {
  if (!input.sessionId || !isNativeAntigravitySessionId(input.sessionId)) return;
  const root = await antigravityProfileRoot(input.profileDirectory);
  if (!root) return;
  const conversationsDir = await antigravityManagedPath(
    root,
    ["antigravity-acp", "conversations"],
    "directory",
  );
  if (!conversationsDir) return;

  const metaEntry = await antigravityManagedPath(
    root,
    ["antigravity-acp", "conversations", `${input.sessionId}.meta`],
    "file",
  );
  if (metaEntry) {
    const metadata = SessionMetadataSchema.parse(
      JSON.parse(await readFile(metaEntry.path, "utf8")),
    );
    if (metadata.cwd !== input.cwd) {
      throw new Error(
        "Antigravity temporary session ownership did not match its scratch directory",
      );
    }
  } else {
    // Reject if a non-regular or symlinked `.meta` file occupies that path.
    const rawMeta = await lstat(join(conversationsDir.path, `${input.sessionId}.meta`)).catch(
      () => undefined,
    );
    if (rawMeta) return;
    // Antigravity 1.5+ writes no `.meta` sidecar; workspace URIs live in the session SQLite DB.
    const databaseFile = await antigravityManagedPath(
      root,
      ["antigravity-acp", "conversations", `${input.sessionId}.db`],
      "file",
    );
    if (!databaseFile) return;
    const workspacePaths = readDatabaseWorkspacePaths(databaseFile.path, input.sessionId);
    if (!workspacePaths || workspacePaths.length === 0) return;
    const expectedCwd = await pathKey(input.cwd);
    for (const workspacePath of workspacePaths) {
      if ((await pathKey(workspacePath)) !== expectedCwd) {
        throw new Error(
          "Antigravity temporary session ownership did not match its scratch directory",
        );
      }
    }
  }

  const base = join(conversationsDir.path, input.sessionId);
  await Promise.all(
    [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"].map((suffix) =>
      rm(`${base}${suffix}`, { force: true }),
    ),
  );

  // Verify `brain` and `annotations` parents (and brain session dir) are unlinked before deleting.
  const brainEntry = await antigravityManagedPath(
    root,
    ["antigravity-acp", "brain", input.sessionId],
    "directory",
  );
  if (brainEntry) {
    await rm(brainEntry.path, { force: true, recursive: true });
  }
  const annotationEntry = await antigravityManagedPath(
    root,
    ["antigravity-acp", "annotations", `${input.sessionId}.pbtxt`],
    "file",
  );
  if (annotationEntry) {
    await rm(annotationEntry.path, { force: true });
  }
}
