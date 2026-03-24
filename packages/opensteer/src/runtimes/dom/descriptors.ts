import { createHash, randomUUID } from "node:crypto";

import type { DescriptorRecord, DescriptorRegistryStore } from "../../registry.js";
import type { FilesystemOpensteerRoot } from "../../root.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../../json.js";
import { sanitizeReplayElementPath } from "./path.js";
import type {
  DomDescriptorPayload,
  DomDescriptorRecord,
  DomReadDescriptorInput,
  DomWriteDescriptorInput,
} from "./types.js";

interface DomDescriptorStore {
  read(input: DomReadDescriptorInput): Promise<DomDescriptorRecord | undefined>;
  write(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord>;
}

export function createDomDescriptorStore(options: {
  readonly root?: FilesystemOpensteerRoot;
  readonly namespace?: string;
}): DomDescriptorStore {
  const namespace = normalizeNamespace(options.namespace);
  if (options.root) {
    return new FilesystemDomDescriptorStore(options.root.registry.descriptors, namespace);
  }
  return new MemoryDomDescriptorStore(namespace);
}

function descriptionKey(namespace: string, description: string): string {
  return `dom:${namespace}:${sha256Hex(description.trim())}`;
}

function normalizeNamespace(namespace: string | undefined): string {
  const normalized = String(namespace || "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildPayload(input: DomWriteDescriptorInput): DomDescriptorPayload {
  return {
    kind: "dom-target",
    method: input.method,
    description: input.description,
    path: sanitizeReplayElementPath(input.path),
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
  };
}

function parseDomDescriptorRecord(record: DescriptorRecord): DomDescriptorRecord | undefined {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const raw = payload as Record<string, unknown>;
  if (raw.kind !== "dom-target") {
    return undefined;
  }
  if (typeof raw.method !== "string" || typeof raw.description !== "string") {
    return undefined;
  }
  if (!raw.path || typeof raw.path !== "object" || Array.isArray(raw.path)) {
    return undefined;
  }
  if ((raw.path as { readonly resolution?: unknown }).resolution !== "deterministic") {
    return undefined;
  }

  const normalizedPayload: DomDescriptorPayload = {
    kind: "dom-target",
    method: raw.method,
    description: raw.description,
    path: sanitizeReplayElementPath(raw.path as DomDescriptorPayload["path"]),
    ...(typeof raw.sourceUrl === "string" ? { sourceUrl: raw.sourceUrl } : {}),
  };

  return {
    id: record.id,
    key: record.key,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    payload: normalizedPayload,
  };
}

class FilesystemDomDescriptorStore implements DomDescriptorStore {
  constructor(
    private readonly registry: DescriptorRegistryStore,
    private readonly namespace: string,
  ) {}

  async read(input: DomReadDescriptorInput): Promise<DomDescriptorRecord | undefined> {
    const record = await this.registry.resolve({
      key: descriptionKey(this.namespace, input.description),
    });
    if (!record) {
      return undefined;
    }
    return parseDomDescriptorRecord(record);
  }

  async write(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord> {
    const payload = buildPayload(input);
    const key = descriptionKey(this.namespace, input.description);
    const version = sha256Hex(canonicalJsonString(payload));
    const existing = await this.registry.resolve({ key, version });
    if (existing) {
      const parsed = parseDomDescriptorRecord(existing);
      if (!parsed) {
        throw new Error(`descriptor ${existing.id} has an invalid DOM payload`);
      }
      return parsed;
    }

    const now = Date.now();
    const record = await this.registry.write({
      id: `descriptor:${randomUUID()}`,
      key,
      version,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
      tags: ["dom-runtime", input.method],
      provenance: {
        source: "opensteer.dom",
        sourceId: key,
        ...(payload.sourceUrl === undefined ? {} : { notes: payload.sourceUrl }),
      },
      payload: toCanonicalJsonValue(payload),
    });
    const parsed = parseDomDescriptorRecord(record);
    if (!parsed) {
      throw new Error(`descriptor ${record.id} could not be parsed after write`);
    }
    return parsed;
  }
}

class MemoryDomDescriptorStore implements DomDescriptorStore {
  private readonly latestByKey = new Map<string, DomDescriptorRecord>();
  private readonly recordsByKey = new Map<string, Map<string, DomDescriptorRecord>>();

  constructor(private readonly namespace: string) {}

  async read(input: DomReadDescriptorInput): Promise<DomDescriptorRecord | undefined> {
    return this.latestByKey.get(descriptionKey(this.namespace, input.description));
  }

  async write(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord> {
    const payload = buildPayload(input);
    const key = descriptionKey(this.namespace, input.description);
    const version = sha256Hex(canonicalJsonString(payload));
    const existing = this.recordsByKey.get(key)?.get(version);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const record: DomDescriptorRecord = {
      id: `descriptor:${randomUUID()}`,
      key,
      version,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
      payload,
    };

    const versions = this.recordsByKey.get(key) ?? new Map<string, DomDescriptorRecord>();
    versions.set(version, record);
    this.recordsByKey.set(key, versions);
    this.latestByKey.set(key, record);
    return record;
  }
}
