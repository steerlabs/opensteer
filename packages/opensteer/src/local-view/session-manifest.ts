import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { OpensteerSessionOwnership } from "@opensteer/protocol";

import {
  ensureDirectory,
  listJsonFiles,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "../internal/filesystem.js";
import {
  getPersistedLocalBrowserSessionOwnership,
  type PersistedLocalBrowserSessionRecord,
} from "../live-session.js";
import { resolveLocalViewSessionsDir } from "./runtime-dir.js";

export const OPENSTEER_LOCAL_VIEW_SESSION_LAYOUT = "opensteer-local-view-session";
export const OPENSTEER_LOCAL_VIEW_SESSION_VERSION = 1;

export interface PersistedLocalViewSessionManifest {
  readonly layout: typeof OPENSTEER_LOCAL_VIEW_SESSION_LAYOUT;
  readonly version: typeof OPENSTEER_LOCAL_VIEW_SESSION_VERSION;
  readonly sessionId: string;
  readonly rootPath: string;
  readonly workspace?: string;
  readonly engine: PersistedLocalBrowserSessionRecord["engine"];
  readonly ownership: OpensteerSessionOwnership;
  readonly pid: number;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export function buildLocalViewSessionId(input: {
  readonly rootPath: string;
  readonly startedAt: number;
  readonly pid?: number;
  readonly ownership?: OpensteerSessionOwnership;
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly remoteDebuggingUrl?: string;
}): string {
  const ownership = input.ownership ?? "owned";
  const identity =
    ownership === "attached"
      ? (input.endpoint ?? input.remoteDebuggingUrl ?? input.baseUrl ?? "attached")
      : `pid:${String(input.pid ?? 0)}`;
  const hash = createHash("sha256")
    .update(`${input.rootPath}\n${ownership}\n${identity}\n${String(input.startedAt)}`)
    .digest("hex");
  return `local_${hash.slice(0, 24)}`;
}

export function buildLocalViewSessionIdForRecord(input: {
  readonly rootPath: string;
  readonly live: PersistedLocalBrowserSessionRecord;
}): string {
  const ownership = getPersistedLocalBrowserSessionOwnership(input.live);
  if (ownership === "attached") {
    return buildLocalViewSessionId({
      rootPath: input.rootPath,
      ownership,
      startedAt: input.live.startedAt,
      ...(input.live.endpoint === undefined ? {} : { endpoint: input.live.endpoint }),
      ...(input.live.baseUrl === undefined ? {} : { baseUrl: input.live.baseUrl }),
      ...(input.live.remoteDebuggingUrl === undefined
        ? {}
        : { remoteDebuggingUrl: input.live.remoteDebuggingUrl }),
    });
  }
  return buildLocalViewSessionId({
    rootPath: input.rootPath,
    ownership,
    startedAt: input.live.startedAt,
    pid: input.live.pid,
  });
}

export function createLocalViewSessionManifest(input: {
  readonly rootPath: string;
  readonly workspace?: string;
  readonly live: PersistedLocalBrowserSessionRecord;
  readonly ownership: OpensteerSessionOwnership;
}): PersistedLocalViewSessionManifest {
  return {
    layout: OPENSTEER_LOCAL_VIEW_SESSION_LAYOUT,
    version: OPENSTEER_LOCAL_VIEW_SESSION_VERSION,
    sessionId: buildLocalViewSessionIdForRecord({
      rootPath: input.rootPath,
      live: input.live,
    }),
    rootPath: input.rootPath,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    engine: input.live.engine,
    ownership: input.ownership,
    pid: input.live.pid,
    startedAt: input.live.startedAt,
    updatedAt: Date.now(),
  };
}

export async function writeLocalViewSessionManifest(
  manifest: PersistedLocalViewSessionManifest,
): Promise<void> {
  await ensureDirectory(resolveLocalViewSessionsDir());
  await writeJsonFileAtomic(resolveLocalViewSessionManifestPath(manifest.sessionId), manifest);
}

export async function deleteLocalViewSessionManifest(sessionId: string): Promise<void> {
  await rm(resolveLocalViewSessionManifestPath(sessionId), { force: true }).catch(() => undefined);
}

export async function readLocalViewSessionManifest(
  sessionId: string,
): Promise<PersistedLocalViewSessionManifest | undefined> {
  const manifestPath = resolveLocalViewSessionManifestPath(sessionId);
  if (!(await pathExists(manifestPath))) {
    return undefined;
  }

  const parsed = await readJsonFile<Partial<PersistedLocalViewSessionManifest>>(manifestPath);
  return isPersistedLocalViewSessionManifest(parsed) ? parsed : undefined;
}

export async function listLocalViewSessionManifests(): Promise<
  readonly PersistedLocalViewSessionManifest[]
> {
  const directoryPath = resolveLocalViewSessionsDir();
  const fileNames = await listJsonFiles(directoryPath);
  const manifests = await Promise.all(
    fileNames.map(async (fileName) => {
      const parsed = await readJsonFile<Partial<PersistedLocalViewSessionManifest>>(
        path.join(directoryPath, fileName),
      ).catch(() => undefined);
      return isPersistedLocalViewSessionManifest(parsed) ? parsed : undefined;
    }),
  );
  return manifests
    .filter((manifest): manifest is PersistedLocalViewSessionManifest => manifest !== undefined)
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.sessionId.localeCompare(right.sessionId),
    );
}

export function resolveLocalViewSessionManifestPath(sessionId: string): string {
  return path.join(resolveLocalViewSessionsDir(), `${sessionId}.json`);
}

function isPersistedLocalViewSessionManifest(
  value: Partial<PersistedLocalViewSessionManifest> | null | undefined,
): value is PersistedLocalViewSessionManifest {
  return (
    value?.layout === OPENSTEER_LOCAL_VIEW_SESSION_LAYOUT &&
    value.version === OPENSTEER_LOCAL_VIEW_SESSION_VERSION &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.rootPath === "string" &&
    value.rootPath.length > 0 &&
    (value.engine === "playwright" || value.engine === "abp") &&
    (value.ownership === "owned" ||
      value.ownership === "attached" ||
      value.ownership === "managed") &&
    typeof value.pid === "number" &&
    Number.isFinite(value.pid) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}
