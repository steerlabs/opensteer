import { rm } from "node:fs/promises";
import path from "node:path";

import {
  ensureDirectory,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "../internal/filesystem.js";

export interface OpensteerServiceMetadata {
  readonly name: string;
  readonly rootPath: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly startedAt: number;
  readonly baseUrl: string;
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
): Promise<OpensteerServiceMetadata | undefined> {
  const metadataPath = getOpensteerServiceMetadataPath(rootPath, name);
  if (!(await pathExists(metadataPath))) {
    return undefined;
  }

  return readJsonFile<OpensteerServiceMetadata>(metadataPath);
}

export async function writeOpensteerServiceMetadata(
  rootPath: string,
  metadata: OpensteerServiceMetadata,
): Promise<void> {
  const directory = getOpensteerServiceDirectory(rootPath, metadata.name);
  await ensureDirectory(directory);
  await writeJsonFileAtomic(getOpensteerServiceMetadataPath(rootPath, metadata.name), metadata);
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

function normalizeName(value: string): string {
  const normalized = String(value ?? "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}
