import { rm } from "node:fs/promises";
import path from "node:path";

import {
  ensureDirectory,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "../internal/filesystem.js";
import {
  DEFAULT_OPENSTEER_ENGINE,
  normalizeOpensteerEngineName,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { type OpensteerExecutionMode } from "../mode/config.js";

const OPENSTEER_SERVICE_METADATA_VERSION = 3 as const;
const OPENSTEER_LEGACY_SERVICE_METADATA_VERSION = 2 as const;

export interface OpensteerLocalServiceMetadata {
  readonly version: typeof OPENSTEER_SERVICE_METADATA_VERSION;
  readonly mode: "local";
  readonly name: string;
  readonly rootPath: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly startedAt: number;
  readonly baseUrl: string;
  readonly engine: OpensteerEngineName;
}

export interface OpensteerCloudServiceMetadata {
  readonly version: typeof OPENSTEER_SERVICE_METADATA_VERSION;
  readonly mode: "cloud";
  readonly name: string;
  readonly rootPath: string;
  readonly startedAt: number;
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly authSource: "env";
}

export type OpensteerServiceMetadata =
  | OpensteerLocalServiceMetadata
  | OpensteerCloudServiceMetadata;
export type OpensteerServiceMetadataWriteInput =
  | Omit<OpensteerLocalServiceMetadata, "version">
  | Omit<OpensteerCloudServiceMetadata, "version">;

export interface ParsedOpensteerServiceMetadata {
  readonly metadata: OpensteerServiceMetadata;
  readonly needsRewrite: boolean;
}

function getOpensteerServiceDirectory(rootPath: string, name: string): string {
  return path.join(rootPath, "runtime", "sessions", encodeURIComponent(normalizeName(name)));
}

export function getOpensteerServiceMetadataPath(rootPath: string, name: string): string {
  return path.join(getOpensteerServiceDirectory(rootPath, name), "service.json");
}

export async function readOpensteerServiceMetadata(
  rootPath: string,
  name: string,
): Promise<unknown | undefined> {
  const metadataPath = getOpensteerServiceMetadataPath(rootPath, name);
  if (!(await pathExists(metadataPath))) {
    return undefined;
  }

  return readJsonFile<unknown>(metadataPath);
}

export async function writeOpensteerServiceMetadata(
  rootPath: string,
  metadata: OpensteerServiceMetadataWriteInput,
): Promise<void> {
  const directory = getOpensteerServiceDirectory(rootPath, metadata.name);
  await ensureDirectory(directory);
  await writeJsonFileAtomic(getOpensteerServiceMetadataPath(rootPath, metadata.name), {
    version: OPENSTEER_SERVICE_METADATA_VERSION,
    ...metadata,
  } as OpensteerServiceMetadata);
}

export async function removeOpensteerServiceMetadata(
  rootPath: string,
  name: string,
): Promise<void> {
  await rm(getOpensteerServiceMetadataPath(rootPath, name), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLocalOpensteerServiceMetadata(
  metadata: OpensteerServiceMetadata,
): metadata is OpensteerLocalServiceMetadata {
  return metadata.mode === "local";
}

export function isCloudOpensteerServiceMetadata(
  metadata: OpensteerServiceMetadata,
): metadata is OpensteerCloudServiceMetadata {
  return metadata.mode === "cloud";
}

export function parseOpensteerServiceMetadata(
  value: unknown,
  metadataPath: string,
): ParsedOpensteerServiceMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Opensteer service metadata at ${metadataPath} is invalid. Remove the stale session metadata and open the session again.`,
    );
  }

  const record = value as Record<string, unknown>;
  const version = readMetadataVersion(record, metadataPath);
  const legacyMetadata =
    version === undefined || version === OPENSTEER_LEGACY_SERVICE_METADATA_VERSION;
  if (legacyMetadata) {
    return {
      metadata: {
        version: OPENSTEER_SERVICE_METADATA_VERSION,
        mode: "local",
        name: readRequiredString(record, "name", metadataPath),
        rootPath: readRequiredString(record, "rootPath", metadataPath),
        pid: readRequiredInteger(record, "pid", metadataPath),
        port: readRequiredInteger(record, "port", metadataPath),
        token: readRequiredString(record, "token", metadataPath),
        startedAt: readRequiredInteger(record, "startedAt", metadataPath),
        baseUrl: readRequiredString(record, "baseUrl", metadataPath),
        engine: DEFAULT_OPENSTEER_ENGINE,
      },
      needsRewrite: true,
    };
  }

  const mode = readRequiredMode(record, metadataPath);
  if (mode === "cloud") {
    return {
      metadata: {
        version: OPENSTEER_SERVICE_METADATA_VERSION,
        mode,
        name: readRequiredString(record, "name", metadataPath),
        rootPath: readRequiredString(record, "rootPath", metadataPath),
        startedAt: readRequiredInteger(record, "startedAt", metadataPath),
        baseUrl: readRequiredString(record, "baseUrl", metadataPath),
        sessionId: readRequiredString(record, "sessionId", metadataPath),
        authSource: readRequiredAuthSource(record, metadataPath),
      },
      needsRewrite: false,
    };
  }

  return {
    metadata: {
      version: OPENSTEER_SERVICE_METADATA_VERSION,
      mode: "local",
      name: readRequiredString(record, "name", metadataPath),
      rootPath: readRequiredString(record, "rootPath", metadataPath),
      pid: readRequiredInteger(record, "pid", metadataPath),
      port: readRequiredInteger(record, "port", metadataPath),
      token: readRequiredString(record, "token", metadataPath),
      startedAt: readRequiredInteger(record, "startedAt", metadataPath),
      baseUrl: readRequiredString(record, "baseUrl", metadataPath),
      engine: readRequiredEngineName(record, metadataPath),
    },
    needsRewrite: false,
  };
}

export function normalizeOpensteerSessionName(name: string | undefined): string {
  return normalizeName(name);
}

export function resolveOpensteerSessionRootPath(rootDir: string | undefined): string {
  return path.resolve(rootDir ?? process.cwd(), ".opensteer");
}

function normalizeName(value: string | undefined): string {
  const normalized = String(value ?? "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}

function readRequiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  metadataPath: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Opensteer service metadata at ${metadataPath} is missing a valid "${key}" field. Remove the stale session metadata and open the session again.`,
    );
  }
  return value;
}

function readRequiredInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  metadataPath: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Opensteer service metadata at ${metadataPath} is missing a valid "${key}" field. Remove the stale session metadata and open the session again.`,
    );
  }
  return value;
}

function readRequiredEngineName(
  record: Readonly<Record<string, unknown>>,
  metadataPath: string,
): OpensteerEngineName {
  const value = record.engine;
  if (typeof value !== "string") {
    throw new Error(
      `Opensteer service metadata at ${metadataPath} is missing a valid "engine" field. Remove the stale session metadata and open the session again.`,
    );
  }

  try {
    return normalizeOpensteerEngineName(value, `engine in ${metadataPath}`);
  } catch {
    throw new Error(
      `Opensteer service metadata at ${metadataPath} has an unsupported "engine" value. Remove the stale session metadata and open the session again.`,
    );
  }
}

function readRequiredMode(
  record: Readonly<Record<string, unknown>>,
  metadataPath: string,
): OpensteerExecutionMode {
  const value = record.mode;
  if (value === "local" || value === "cloud") {
    return value;
  }
  if (value === "connect") {
    return "local";
  }
  throw new Error(
    `Opensteer service metadata at ${metadataPath} is missing a valid "mode" field. Remove the stale session metadata and open the session again.`,
  );
}

function readRequiredAuthSource(
  record: Readonly<Record<string, unknown>>,
  metadataPath: string,
): "env" {
  const value = record.authSource;
  if (value === "env") {
    return value;
  }
  throw new Error(
    `Opensteer service metadata at ${metadataPath} is missing a valid "authSource" field. Remove the stale session metadata and open the session again.`,
  );
}

function readMetadataVersion(
  record: Readonly<Record<string, unknown>>,
  metadataPath: string,
):
  | typeof OPENSTEER_SERVICE_METADATA_VERSION
  | typeof OPENSTEER_LEGACY_SERVICE_METADATA_VERSION
  | undefined {
  const value = record.version;
  if (value === undefined) {
    return undefined;
  }
  if (
    value === OPENSTEER_SERVICE_METADATA_VERSION ||
    value === OPENSTEER_LEGACY_SERVICE_METADATA_VERSION
  ) {
    return value;
  }
  throw new Error(
    `Opensteer service metadata at ${metadataPath} has unsupported version "${String(value)}". Remove the stale session metadata and open the session again.`,
  );
}
