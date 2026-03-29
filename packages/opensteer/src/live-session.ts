import { rm } from "node:fs/promises";
import path from "node:path";

import type { OpensteerSessionCapabilities } from "@opensteer/protocol";

import {
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "./internal/filesystem.js";

export const OPENSTEER_LIVE_SESSION_LAYOUT = "opensteer-session";
export const OPENSTEER_LIVE_SESSION_VERSION = 1;

const LEGACY_CLOUD_SESSION_LAYOUT = "opensteer-cloud-session";
const LEGACY_CLOUD_SESSION_VERSION = 1;

interface PersistedSessionRecordBase {
  readonly layout: typeof OPENSTEER_LIVE_SESSION_LAYOUT;
  readonly version: typeof OPENSTEER_LIVE_SESSION_VERSION;
  readonly workspace?: string;
  readonly updatedAt: number;
  readonly activePageRef?: string;
  readonly reconnectable?: boolean;
  readonly capabilities?: OpensteerSessionCapabilities;
}

export interface PersistedLocalBrowserSessionRecord
  extends PersistedSessionRecordBase {
  readonly provider: "local";
  readonly mode: "browser";
  readonly engine: "playwright" | "abp";
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly remoteDebuggingUrl?: string;
  readonly sessionDir?: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly executablePath?: string;
  readonly userDataDir: string;
}

export interface PersistedCloudSessionRecord extends PersistedSessionRecordBase {
  readonly provider: "cloud";
  readonly mode: "cloud";
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly startedAt: number;
}

export type PersistedSessionRecord =
  | PersistedLocalBrowserSessionRecord
  | PersistedCloudSessionRecord;

interface LegacyCloudSessionRecord {
  readonly layout: typeof LEGACY_CLOUD_SESSION_LAYOUT;
  readonly version: typeof LEGACY_CLOUD_SESSION_VERSION;
  readonly mode: "cloud";
  readonly workspace?: string;
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly startedAt: number;
  readonly updatedAt: number;
}

interface LegacyLocalBrowserSessionRecord {
  readonly mode: "persistent";
  readonly engine?: "playwright" | "abp";
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly remoteDebuggingUrl?: string;
  readonly sessionDir?: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly executablePath?: string;
  readonly userDataDir: string;
}

export function resolveLiveSessionRecordPath(rootPath: string): string {
  return path.join(rootPath, "live", "session.json");
}

export function resolveLegacyLiveBrowserRecordPath(rootPath: string): string {
  return path.join(rootPath, "live", "browser.json");
}

export function resolveLegacyCloudSessionRecordPath(rootPath: string): string {
  return path.join(rootPath, "live", "cloud-session.json");
}

export async function readPersistedSessionRecord(
  rootPath: string,
): Promise<PersistedSessionRecord | undefined> {
  const sessionPath = resolveLiveSessionRecordPath(rootPath);
  if (await pathExists(sessionPath)) {
    const parsed = await readJsonFile<Partial<PersistedSessionRecord>>(sessionPath);
    if (isPersistedLocalBrowserSessionRecord(parsed)) {
      return parsed;
    }
    if (isPersistedCloudSessionRecord(parsed)) {
      return parsed;
    }
  }

  const legacyCloudPath = resolveLegacyCloudSessionRecordPath(rootPath);
  if (await pathExists(legacyCloudPath)) {
    const parsed = await readJsonFile<Partial<LegacyCloudSessionRecord>>(legacyCloudPath);
    if (isLegacyCloudSessionRecord(parsed)) {
      return {
        layout: OPENSTEER_LIVE_SESSION_LAYOUT,
        version: OPENSTEER_LIVE_SESSION_VERSION,
        provider: "cloud",
        mode: "cloud",
        ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
        sessionId: parsed.sessionId,
        baseUrl: parsed.baseUrl,
        startedAt: parsed.startedAt,
        updatedAt: parsed.updatedAt,
      };
    }
  }

  const legacyBrowserPath = resolveLegacyLiveBrowserRecordPath(rootPath);
  if (await pathExists(legacyBrowserPath)) {
    const parsed = await readJsonFile<Partial<LegacyLocalBrowserSessionRecord>>(legacyBrowserPath);
    if (isLegacyLocalBrowserSessionRecord(parsed)) {
      return {
        layout: OPENSTEER_LIVE_SESSION_LAYOUT,
        version: OPENSTEER_LIVE_SESSION_VERSION,
        provider: "local",
        mode: "browser",
        engine: parsed.engine ?? "playwright",
        ...(parsed.endpoint === undefined ? {} : { endpoint: parsed.endpoint }),
        ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
        ...(parsed.remoteDebuggingUrl === undefined
          ? {}
          : { remoteDebuggingUrl: parsed.remoteDebuggingUrl }),
        ...(parsed.sessionDir === undefined ? {} : { sessionDir: parsed.sessionDir }),
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        updatedAt: parsed.startedAt,
        ...(parsed.executablePath === undefined
          ? {}
          : { executablePath: parsed.executablePath }),
        userDataDir: parsed.userDataDir,
      };
    }
  }

  return undefined;
}

export async function readPersistedCloudSessionRecord(
  rootPath: string,
): Promise<PersistedCloudSessionRecord | undefined> {
  const record = await readPersistedSessionRecord(rootPath);
  return record?.provider === "cloud" ? record : undefined;
}

export async function readPersistedLocalBrowserSessionRecord(
  rootPath: string,
): Promise<PersistedLocalBrowserSessionRecord | undefined> {
  const record = await readPersistedSessionRecord(rootPath);
  return record?.provider === "local" ? record : undefined;
}

export async function hasPersistedCloudSession(rootPath: string): Promise<boolean> {
  return (await readPersistedCloudSessionRecord(rootPath)) !== undefined;
}

export async function writePersistedSessionRecord(
  rootPath: string,
  record: PersistedSessionRecord,
): Promise<void> {
  await writeJsonFileAtomic(resolveLiveSessionRecordPath(rootPath), record);
  await clearLegacySessionRecordPaths(rootPath);
}

export async function clearPersistedSessionRecord(rootPath: string): Promise<void> {
  await Promise.all([
    removeIfPresent(resolveLiveSessionRecordPath(rootPath)),
    clearLegacySessionRecordPaths(rootPath),
  ]);
}

function isPersistedCloudSessionRecord(
  value: Partial<PersistedCloudSessionRecord> | Partial<PersistedSessionRecord>,
): value is PersistedCloudSessionRecord {
  return (
    value.layout === OPENSTEER_LIVE_SESSION_LAYOUT &&
    value.version === OPENSTEER_LIVE_SESSION_VERSION &&
    value.provider === "cloud" &&
    value.mode === "cloud" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.baseUrl === "string" &&
    value.baseUrl.length > 0 &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}

function isPersistedLocalBrowserSessionRecord(
  value: Partial<PersistedLocalBrowserSessionRecord> | Partial<PersistedSessionRecord>,
): value is PersistedLocalBrowserSessionRecord {
  return (
    value.layout === OPENSTEER_LIVE_SESSION_LAYOUT &&
    value.version === OPENSTEER_LIVE_SESSION_VERSION &&
    value.provider === "local" &&
    value.mode === "browser" &&
    (value.engine === "playwright" || value.engine === "abp") &&
    typeof value.pid === "number" &&
    Number.isFinite(value.pid) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    typeof value.userDataDir === "string" &&
    value.userDataDir.length > 0
  );
}

function isLegacyCloudSessionRecord(
  value: Partial<LegacyCloudSessionRecord>,
): value is LegacyCloudSessionRecord {
  return (
    value.layout === LEGACY_CLOUD_SESSION_LAYOUT &&
    value.version === LEGACY_CLOUD_SESSION_VERSION &&
    value.mode === "cloud" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.baseUrl === "string" &&
    value.baseUrl.length > 0 &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}

function isLegacyLocalBrowserSessionRecord(
  value: Partial<LegacyLocalBrowserSessionRecord>,
): value is LegacyLocalBrowserSessionRecord {
  return (
    value.mode === "persistent" &&
    typeof value.pid === "number" &&
    Number.isFinite(value.pid) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.userDataDir === "string" &&
    value.userDataDir.length > 0
  );
}

async function clearLegacySessionRecordPaths(rootPath: string): Promise<void> {
  await Promise.all([
    removeIfPresent(resolveLegacyLiveBrowserRecordPath(rootPath)),
    removeIfPresent(resolveLegacyCloudSessionRecordPath(rootPath)),
  ]);
}

async function removeIfPresent(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}
