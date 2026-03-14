import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  type OpensteerRequestPlanFreshness,
  type OpensteerRequestPlanLifecycle,
  type OpensteerRequestPlanPayload,
} from "@opensteer/protocol";

import {
  encodePathSegment,
  ensureDirectory,
  isAlreadyExistsError,
  listJsonFiles,
  normalizeNonEmptyString,
  normalizeTimestamp,
  pathExists,
  readJsonFile,
  sha256Hex,
  withFilesystemLock,
  writeJsonFileAtomic,
  writeJsonFileExclusive,
} from "./internal/filesystem.js";
import { canonicalJsonString, type JsonValue } from "./json.js";

export interface RegistryProvenance {
  readonly source: string;
  readonly sourceId?: string;
  readonly capturedAt?: number;
  readonly notes?: string;
}

export interface RegistryRecord<TPayload = JsonValue> {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: RegistryProvenance;
  readonly payload: TPayload;
}

export type DescriptorRecord = RegistryRecord;

export type RequestPlanLifecycle = OpensteerRequestPlanLifecycle;

export type RequestPlanFreshness = OpensteerRequestPlanFreshness;

export interface RequestPlanRecord extends RegistryRecord<OpensteerRequestPlanPayload> {
  readonly lifecycle: RequestPlanLifecycle;
  readonly freshness?: RequestPlanFreshness;
}

export interface ResolveRegistryRecordInput {
  readonly key: string;
  readonly version?: string;
}

export interface WriteDescriptorInput<TPayload = JsonValue> {
  readonly id?: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly tags?: readonly string[];
  readonly provenance?: RegistryProvenance;
  readonly payload: TPayload;
}

export interface WriteRequestPlanInput extends WriteDescriptorInput<OpensteerRequestPlanPayload> {
  readonly lifecycle?: RequestPlanLifecycle;
  readonly freshness?: RequestPlanFreshness;
}

export interface ListRegistryRecordsInput {
  readonly key?: string;
}

export interface UpdateRequestPlanMetadataInput {
  readonly id: string;
  readonly updatedAt?: number;
  readonly lifecycle?: RequestPlanLifecycle;
  readonly freshness?: RequestPlanFreshness;
}

export interface DescriptorRegistryStore {
  readonly recordsDirectory: string;
  readonly indexesDirectory: string;

  write(input: WriteDescriptorInput): Promise<DescriptorRecord>;
  getById(id: string): Promise<DescriptorRecord | undefined>;
  resolve(input: ResolveRegistryRecordInput): Promise<DescriptorRecord | undefined>;
}

export interface RequestPlanRegistryStore {
  readonly recordsDirectory: string;
  readonly indexesDirectory: string;

  write(input: WriteRequestPlanInput): Promise<RequestPlanRecord>;
  getById(id: string): Promise<RequestPlanRecord | undefined>;
  list(input?: ListRegistryRecordsInput): Promise<readonly RequestPlanRecord[]>;
  resolve(input: ResolveRegistryRecordInput): Promise<RequestPlanRecord | undefined>;
  updateMetadata(input: UpdateRequestPlanMetadataInput): Promise<RequestPlanRecord>;
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) {
    return [];
  }

  return Array.from(new Set(tags.map((tag) => normalizeNonEmptyString("tag", tag)))).sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeProvenance(
  provenance: RegistryProvenance | undefined,
): RegistryProvenance | undefined {
  if (provenance === undefined) {
    return undefined;
  }

  return {
    source: normalizeNonEmptyString("provenance.source", provenance.source),
    ...(provenance.sourceId === undefined
      ? {}
      : { sourceId: normalizeNonEmptyString("provenance.sourceId", provenance.sourceId) }),
    ...(provenance.capturedAt === undefined
      ? {}
      : { capturedAt: normalizeTimestamp("provenance.capturedAt", provenance.capturedAt) }),
    ...(provenance.notes === undefined
      ? {}
      : { notes: normalizeNonEmptyString("provenance.notes", provenance.notes) }),
  };
}

function normalizeFreshness(
  freshness: RequestPlanFreshness | undefined,
): RequestPlanFreshness | undefined {
  if (freshness === undefined) {
    return undefined;
  }

  return {
    ...(freshness.lastValidatedAt === undefined
      ? {}
      : {
          lastValidatedAt: normalizeTimestamp(
            "freshness.lastValidatedAt",
            freshness.lastValidatedAt,
          ),
        }),
    ...(freshness.staleAt === undefined
      ? {}
      : { staleAt: normalizeTimestamp("freshness.staleAt", freshness.staleAt) }),
    ...(freshness.expiresAt === undefined
      ? {}
      : { expiresAt: normalizeTimestamp("freshness.expiresAt", freshness.expiresAt) }),
  };
}

function compareByCreatedAtAndId(
  left: Pick<RegistryRecord<unknown>, "createdAt" | "id">,
  right: Pick<RegistryRecord<unknown>, "createdAt" | "id">,
): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt;
  }

  return left.id.localeCompare(right.id);
}

abstract class FilesystemRegistryStore<TRecord extends RegistryRecord<unknown>> {
  readonly recordsDirectory: string;
  readonly indexesDirectory: string;

  protected constructor(
    rootPath: string,
    private readonly registryRelativePath: readonly string[],
  ) {
    const basePath = path.join(rootPath, ...registryRelativePath);
    this.recordsDirectory = path.join(basePath, "records");
    this.indexesDirectory = path.join(basePath, "indexes", "by-key");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.recordsDirectory);
    await ensureDirectory(this.indexesDirectory);
  }

  async getById(id: string): Promise<TRecord | undefined> {
    const recordPath = this.recordPath(id);
    if (!(await pathExists(recordPath))) {
      return undefined;
    }

    return readJsonFile<TRecord>(recordPath);
  }

  async resolve(input: ResolveRegistryRecordInput): Promise<TRecord | undefined> {
    const key = normalizeNonEmptyString("key", input.key);
    if (input.version !== undefined) {
      return this.resolveIndexedRecord(key, normalizeNonEmptyString("version", input.version));
    }

    const matches = (await this.readAllRecords()).filter(
      (record) => this.isActive(record) && record.key === key,
    );
    matches.sort(compareByCreatedAtAndId);
    return matches[0];
  }

  protected async writeRecord(record: TRecord): Promise<TRecord> {
    return withFilesystemLock(this.writeLockPath(), async () => {
      if ((await this.getById(record.id)) !== undefined) {
        throw new Error(`registry record ${record.id} already exists`);
      }

      const indexPath = this.indexPath(record.key, record.version);
      if (await pathExists(indexPath)) {
        const indexedRecord = await readJsonFile<{ readonly id: string }>(indexPath);
        throw new Error(
          `registry record ${record.key}@${record.version} already exists as ${indexedRecord.id}`,
        );
      }

      const exactMatch = await this.findExactRecord(record.key, record.version);
      if (exactMatch !== undefined) {
        throw new Error(
          `registry record ${record.key}@${record.version} already exists as ${exactMatch.id}`,
        );
      }

      try {
        await writeJsonFileExclusive(this.recordPath(record.id), record);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new Error(`registry record ${record.id} already exists`);
        }

        throw error;
      }

      try {
        await writeJsonFileExclusive(indexPath, {
          id: record.id,
        });
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new Error(`registry record ${record.key}@${record.version} already exists`);
        }

        throw error;
      }

      return record;
    });
  }

  protected readAllRecords(): Promise<readonly TRecord[]> {
    return this.readRecordsFromDirectory();
  }

  protected abstract isActive(record: TRecord): boolean;

  protected async readRecordsFromDirectory(): Promise<readonly TRecord[]> {
    const files = await listJsonFiles(this.recordsDirectory);
    const records = await Promise.all(
      files.map((fileName) => readJsonFile<TRecord>(path.join(this.recordsDirectory, fileName))),
    );
    records.sort(compareByCreatedAtAndId);
    return records;
  }

  private async findExactRecord(key: string, version: string): Promise<TRecord | undefined> {
    const records = await this.readAllRecords();
    return records.find((record) => record.key === key && record.version === version);
  }

  private async resolveIndexedRecord(key: string, version: string): Promise<TRecord | undefined> {
    const indexPath = this.indexPath(key, version);
    if (!(await pathExists(indexPath))) {
      const exactMatches = (await this.readAllRecords()).filter(
        (record) => record.key === key && record.version === version,
      );
      if (exactMatches.length <= 1) {
        return exactMatches[0];
      }

      throw new Error(
        `registry contains multiple records for ${key}@${version} without an index entry`,
      );
    }

    const indexedRecord = await readJsonFile<{ readonly id: string }>(indexPath);
    const record = await this.getById(indexedRecord.id);
    if (record === undefined) {
      throw new Error(
        `registry index ${key}@${version} points to missing record ${indexedRecord.id}`,
      );
    }

    return record;
  }

  protected recordPath(id: string): string {
    return path.join(this.recordsDirectory, `${encodePathSegment(id)}.json`);
  }

  protected indexPath(key: string, version: string): string {
    return path.join(
      this.indexesDirectory,
      encodePathSegment(key),
      `${encodePathSegment(version)}.json`,
    );
  }

  protected writeLockPath(): string {
    return path.join(path.dirname(this.recordsDirectory), ".write.lock");
  }
}

export class FilesystemDescriptorRegistry
  extends FilesystemRegistryStore<DescriptorRecord>
  implements DescriptorRegistryStore
{
  constructor(rootPath: string) {
    super(rootPath, ["registry", "descriptors"]);
  }

  async write(input: WriteDescriptorInput): Promise<DescriptorRecord> {
    const id = normalizeNonEmptyString("id", input.id ?? `descriptor:${randomUUID()}`);
    const key = normalizeNonEmptyString("key", input.key);
    const version = normalizeNonEmptyString("version", input.version);
    const createdAt = normalizeTimestamp("createdAt", input.createdAt ?? Date.now());
    const updatedAt = normalizeTimestamp("updatedAt", input.updatedAt ?? createdAt);

    if (updatedAt < createdAt) {
      throw new RangeError("updatedAt must be greater than or equal to createdAt");
    }

    const payload = input.payload;
    const contentHash = sha256Hex(Buffer.from(canonicalJsonString(payload), "utf8"));
    const provenance = normalizeProvenance(input.provenance);
    const record: DescriptorRecord = {
      id,
      key,
      version,
      createdAt,
      updatedAt,
      contentHash,
      tags: normalizeTags(input.tags),
      ...(provenance === undefined ? {} : { provenance }),
      payload,
    };

    return this.writeRecord(record);
  }

  protected isActive(_record: DescriptorRecord): boolean {
    return true;
  }
}

export class FilesystemRequestPlanRegistry
  extends FilesystemRegistryStore<RequestPlanRecord>
  implements RequestPlanRegistryStore
{
  constructor(rootPath: string) {
    super(rootPath, ["registry", "request-plans"]);
  }

  async write(input: WriteRequestPlanInput): Promise<RequestPlanRecord> {
    const id = normalizeNonEmptyString("id", input.id ?? `request-plan:${randomUUID()}`);
    const key = normalizeNonEmptyString("key", input.key);
    const version = normalizeNonEmptyString("version", input.version);
    const createdAt = normalizeTimestamp("createdAt", input.createdAt ?? Date.now());
    const updatedAt = normalizeTimestamp("updatedAt", input.updatedAt ?? createdAt);

    if (updatedAt < createdAt) {
      throw new RangeError("updatedAt must be greater than or equal to createdAt");
    }

    const payload = input.payload;
    const contentHash = sha256Hex(Buffer.from(canonicalJsonString(payload), "utf8"));
    const provenance = normalizeProvenance(input.provenance);
    const freshness = normalizeFreshness(input.freshness);
    const record: RequestPlanRecord = {
      id,
      key,
      version,
      createdAt,
      updatedAt,
      contentHash,
      tags: normalizeTags(input.tags),
      ...(provenance === undefined ? {} : { provenance }),
      payload,
      lifecycle: input.lifecycle ?? "active",
      ...(freshness === undefined ? {} : { freshness }),
    };

    return this.writeRecord(record);
  }

  async list(input: ListRegistryRecordsInput = {}): Promise<readonly RequestPlanRecord[]> {
    const key = input.key === undefined ? undefined : normalizeNonEmptyString("key", input.key);
    const records = await this.readAllRecords();
    return key === undefined ? records : records.filter((record) => record.key === key);
  }

  async updateMetadata(input: UpdateRequestPlanMetadataInput): Promise<RequestPlanRecord> {
    const id = normalizeNonEmptyString("id", input.id);

    return withFilesystemLock(this.writeLockPath(), async () => {
      const existing = await this.getById(id);
      if (existing === undefined) {
        throw new Error(`registry record ${id} was not found`);
      }

      const nextFreshness = normalizeFreshness(input.freshness ?? existing.freshness);
      const nextUpdatedAt = normalizeTimestamp(
        "updatedAt",
        input.updatedAt ?? Math.max(Date.now(), existing.updatedAt),
      );
      if (nextUpdatedAt < existing.createdAt) {
        throw new RangeError("updatedAt must be greater than or equal to createdAt");
      }

      const nextRecord: RequestPlanRecord = {
        ...existing,
        updatedAt: nextUpdatedAt,
        lifecycle: input.lifecycle ?? existing.lifecycle,
        ...(nextFreshness === undefined ? {} : { freshness: nextFreshness }),
      };

      await writeJsonFileAtomic(this.recordPath(id), nextRecord);
      return nextRecord;
    });
  }

  protected isActive(record: RequestPlanRecord): boolean {
    return record.lifecycle === "active";
  }
}

export function createDescriptorRegistry(rootPath: string): FilesystemDescriptorRegistry {
  return new FilesystemDescriptorRegistry(rootPath);
}

export function createRequestPlanRegistry(rootPath: string): FilesystemRequestPlanRegistry {
  return new FilesystemRequestPlanRegistry(rootPath);
}
