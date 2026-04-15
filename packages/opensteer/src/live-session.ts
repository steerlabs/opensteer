import { rm } from "node:fs/promises";
import path from "node:path";

import type { OpensteerSessionCapabilities, OpensteerSessionOwnership } from "@opensteer/protocol";

import { pathExists, readJsonFile, writeJsonFileAtomic } from "./internal/filesystem.js";
import { inspectCdpEndpoint } from "./local-browser/cdp-discovery.js";

export const OPENSTEER_LIVE_SESSION_LAYOUT = "opensteer-session";
export const OPENSTEER_LIVE_SESSION_VERSION = 1;

export type OpensteerLiveSessionProvider = "local" | "cloud";

interface PersistedSessionRecordBase {
  readonly layout: typeof OPENSTEER_LIVE_SESSION_LAYOUT;
  readonly version: typeof OPENSTEER_LIVE_SESSION_VERSION;
  readonly provider: OpensteerLiveSessionProvider;
  readonly workspace?: string;
  readonly updatedAt: number;
  readonly activePageRef?: string;
  readonly reconnectable?: boolean;
  readonly capabilities?: OpensteerSessionCapabilities;
}

export interface PersistedLocalBrowserSessionRecord extends PersistedSessionRecordBase {
  readonly provider: "local";
  readonly engine: "playwright" | "abp";
  readonly ownership?: Exclude<OpensteerSessionOwnership, "managed">;
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
  readonly sessionId: string;
  readonly startedAt: number;
}

export type PersistedSessionRecord =
  | PersistedLocalBrowserSessionRecord
  | PersistedCloudSessionRecord;

export function resolveLiveSessionRecordPath(
  rootPath: string,
  provider: OpensteerLiveSessionProvider,
): string {
  return path.join(rootPath, "live", provider === "local" ? "local.json" : "cloud.json");
}

export function resolveLocalSessionRecordPath(rootPath: string): string {
  return resolveLiveSessionRecordPath(rootPath, "local");
}

export function resolveCloudSessionRecordPath(rootPath: string): string {
  return resolveLiveSessionRecordPath(rootPath, "cloud");
}

export async function readPersistedSessionRecord(
  rootPath: string,
  provider: OpensteerLiveSessionProvider,
): Promise<PersistedSessionRecord | undefined> {
  const sessionPath = resolveLiveSessionRecordPath(rootPath, provider);
  if (!(await pathExists(sessionPath))) {
    return undefined;
  }

  const parsed = await readJsonFile<Partial<PersistedSessionRecord>>(sessionPath);
  if (provider === "local" && isPersistedLocalBrowserSessionRecord(parsed)) {
    return parsed;
  }
  if (provider === "cloud" && isPersistedCloudSessionRecord(parsed)) {
    return parsed;
  }
  return undefined;
}

export async function readPersistedCloudSessionRecord(
  rootPath: string,
): Promise<PersistedCloudSessionRecord | undefined> {
  const record = await readPersistedSessionRecord(rootPath, "cloud");
  return record?.provider === "cloud" ? record : undefined;
}

export async function readPersistedLocalBrowserSessionRecord(
  rootPath: string,
): Promise<PersistedLocalBrowserSessionRecord | undefined> {
  const record = await readPersistedSessionRecord(rootPath, "local");
  return record?.provider === "local" ? record : undefined;
}

export async function writePersistedSessionRecord(
  rootPath: string,
  record: PersistedSessionRecord,
): Promise<void> {
  await writeJsonFileAtomic(resolveLiveSessionRecordPath(rootPath, record.provider), record);
}

export async function clearPersistedSessionRecord(
  rootPath: string,
  provider: OpensteerLiveSessionProvider,
): Promise<void> {
  await rm(resolveLiveSessionRecordPath(rootPath, provider), { force: true });
}

export function getPersistedLocalBrowserSessionOwnership(
  record: PersistedLocalBrowserSessionRecord,
): Exclude<OpensteerSessionOwnership, "managed"> {
  return record.ownership === "attached" ? "attached" : "owned";
}

export async function isAttachedLocalBrowserSessionReachable(
  record: PersistedLocalBrowserSessionRecord,
): Promise<boolean> {
  if (getPersistedLocalBrowserSessionOwnership(record) !== "attached") {
    return false;
  }
  if (record.engine !== "playwright" || record.endpoint === undefined) {
    return false;
  }
  try {
    await inspectCdpEndpoint({
      endpoint: record.endpoint,
      timeoutMs: 1_500,
    });
    return true;
  } catch {
    return false;
  }
}

function isPersistedCloudSessionRecord(
  value: Partial<PersistedCloudSessionRecord> | Partial<PersistedSessionRecord>,
): value is PersistedCloudSessionRecord {
  return (
    value.layout === OPENSTEER_LIVE_SESSION_LAYOUT &&
    value.version === OPENSTEER_LIVE_SESSION_VERSION &&
    value.provider === "cloud" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
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
    (value.engine === "playwright" || value.engine === "abp") &&
    (value.ownership === undefined ||
      value.ownership === "owned" ||
      value.ownership === "attached") &&
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
