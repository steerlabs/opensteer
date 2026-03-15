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

const OPENSTEER_SERVICE_METADATA_VERSION = 2 as const;

export interface OpensteerServiceMetadata {
  readonly version: typeof OPENSTEER_SERVICE_METADATA_VERSION;
  readonly name: string;
  readonly rootPath: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly startedAt: number;
  readonly baseUrl: string;
  readonly engine: OpensteerEngineName;
}

interface ParsedOpensteerServiceMetadata {
  readonly metadata: OpensteerServiceMetadata;
  readonly needsRewrite: boolean;
}

export function getOpensteerServiceDirectory(rootPath: string, name: string): string {
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
  metadata: Omit<OpensteerServiceMetadata, "version">,
): Promise<void> {
  const directory = getOpensteerServiceDirectory(rootPath, metadata.name);
  await ensureDirectory(directory);
  await writeJsonFileAtomic(getOpensteerServiceMetadataPath(rootPath, metadata.name), {
    version: OPENSTEER_SERVICE_METADATA_VERSION,
    ...metadata,
  } satisfies OpensteerServiceMetadata);
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
  const legacyMetadata = version === undefined;

  return {
    metadata: {
      version: OPENSTEER_SERVICE_METADATA_VERSION,
      name: readRequiredString(record, "name", metadataPath),
      rootPath: readRequiredString(record, "rootPath", metadataPath),
      pid: readRequiredInteger(record, "pid", metadataPath),
      port: readRequiredInteger(record, "port", metadataPath),
      token: readRequiredString(record, "token", metadataPath),
      startedAt: readRequiredInteger(record, "startedAt", metadataPath),
      baseUrl: readRequiredString(record, "baseUrl", metadataPath),
      engine: legacyMetadata
        ? DEFAULT_OPENSTEER_ENGINE
        : readRequiredEngineName(record, metadataPath),
    },
    needsRewrite: legacyMetadata,
  };
}

function normalizeName(value: string): string {
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

function readMetadataVersion(
  record: Readonly<Record<string, unknown>>,
  metadataPath: string,
): typeof OPENSTEER_SERVICE_METADATA_VERSION | undefined {
  const value = record.version;
  if (value === undefined) {
    return undefined;
  }

  if (value !== OPENSTEER_SERVICE_METADATA_VERSION) {
    throw new Error(
      `Opensteer service metadata at ${metadataPath} has unsupported version "${String(value)}". Remove the stale session metadata and open the session again.`,
    );
  }

  return OPENSTEER_SERVICE_METADATA_VERSION;
}
