import path from "node:path";

import type { OpensteerLocalViewSessionSummary } from "@opensteer/protocol";

import { pathExists } from "../internal/filesystem.js";
import {
  readPersistedLocalBrowserSessionRecord,
  type PersistedLocalBrowserSessionRecord,
} from "../live-session.js";
import { isProcessRunning } from "../local-browser/process-owner.js";
import {
  deleteLocalViewSessionManifest,
  listLocalViewSessionManifests,
  readLocalViewSessionManifest,
  type PersistedLocalViewSessionManifest,
} from "./session-manifest.js";
import { resolveBrowserWebSocketUrl } from "./resolve-browser-websocket.js";

export interface ResolvedLocalViewSession {
  readonly manifest: PersistedLocalViewSessionManifest;
  readonly record: PersistedLocalBrowserSessionRecord;
  readonly browserWebSocketUrl: string;
}

export async function listResolvedLocalViewSessions(): Promise<
  readonly OpensteerLocalViewSessionSummary[]
> {
  const manifests = await listLocalViewSessionManifests();
  const resolved = await Promise.all(manifests.map((manifest) => resolveSessionSummary(manifest)));
  return resolved
    .filter((session): session is OpensteerLocalViewSessionSummary => session !== undefined)
    .sort(
      (left, right) => right.startedAt - left.startedAt || left.label.localeCompare(right.label),
    );
}

export async function resolveLocalViewSession(
  sessionId: string,
): Promise<ResolvedLocalViewSession | undefined> {
  const manifest = await readLocalViewSessionManifest(sessionId);
  if (!manifest) {
    return undefined;
  }

  return readResolvedLocalViewSession(manifest);
}

async function resolveSessionSummary(
  manifest: PersistedLocalViewSessionManifest,
): Promise<OpensteerLocalViewSessionSummary | undefined> {
  const record = await readLiveRecord(manifest);
  if (!record) {
    await deleteLocalViewSessionManifest(manifest.sessionId);
    return undefined;
  }

  const browserName = record.executablePath
    ? path.basename(record.executablePath).replace(/\.[A-Za-z0-9]+$/u, "")
    : undefined;

  return {
    sessionId: manifest.sessionId,
    label: manifest.workspace ?? (path.basename(manifest.rootPath) || manifest.sessionId),
    status: isProcessRunning(record.pid) ? "live" : "stale",
    ...(manifest.workspace === undefined ? {} : { workspace: manifest.workspace }),
    rootPath: manifest.rootPath,
    engine: record.engine,
    ownership: manifest.ownership,
    pid: record.pid,
    startedAt: record.startedAt,
    ...(browserName === undefined ? {} : { browserName }),
  };
}

async function readResolvedLocalViewSession(
  manifest: PersistedLocalViewSessionManifest,
): Promise<ResolvedLocalViewSession | undefined> {
  const record = await readLiveRecord(manifest);
  if (!record) {
    await deleteLocalViewSessionManifest(manifest.sessionId);
    return undefined;
  }

  const browserWebSocketUrl = await resolveBrowserWebSocketUrl(record).catch(() => undefined);
  if (!browserWebSocketUrl) {
    return undefined;
  }

  return {
    manifest,
    record,
    browserWebSocketUrl,
  };
}

async function readLiveRecord(
  manifest: PersistedLocalViewSessionManifest,
): Promise<PersistedLocalBrowserSessionRecord | undefined> {
  if (!(await pathExists(manifest.rootPath))) {
    return undefined;
  }

  const record = await readPersistedLocalBrowserSessionRecord(manifest.rootPath);
  if (!record) {
    return undefined;
  }

  if (
    record.pid !== manifest.pid ||
    record.startedAt !== manifest.startedAt ||
    !isProcessRunning(record.pid)
  ) {
    return undefined;
  }

  return record;
}
