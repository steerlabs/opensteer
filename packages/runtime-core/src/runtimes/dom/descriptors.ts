import { createHash, randomUUID } from "node:crypto";

import type { DescriptorRecord, DescriptorRegistryStore } from "../../registry.js";
import type { FilesystemOpensteerWorkspace } from "../../root.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../../json.js";
import { sanitizeReplayElementPath } from "./path.js";
import type {
  DomDescriptorPayload,
  DomDescriptorRecord,
  DomReadDescriptorInput,
  DomWriteDescriptorInput,
} from "./types.js";

export interface DomDescriptorStore {
  read(input: DomReadDescriptorInput): Promise<DomDescriptorRecord | undefined>;
  write(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord>;
}

export function createDomDescriptorStore(options: {
  readonly root?: FilesystemOpensteerWorkspace;
  readonly namespace?: string;
}): DomDescriptorStore {
  const namespace = normalizeDomDescriptorNamespace(options.namespace);
  if (options.root) {
    return new FilesystemDomDescriptorStore(options.root.registry.descriptors, namespace);
  }
  return new MemoryDomDescriptorStore(namespace);
}

export function hashDomDescriptorName(name: string): string {
  return sha256Hex(name.trim());
}

const DOM_DESCRIPTOR_METHOD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  click: "dom.click",
  hover: "dom.hover",
  input: "dom.input",
  scroll: "dom.scroll",
});

function normalizeDomDescriptorMethod(method: string): string {
  const normalized = method.trim();
  return DOM_DESCRIPTOR_METHOD_ALIASES[normalized] ?? normalized;
}

function buildDomDescriptorKeys(options: {
  readonly namespace?: string;
  readonly method: string;
  readonly name: string;
}): readonly string[] {
  const namespace = normalizeDomDescriptorNamespace(options.namespace);
  const nameHash = hashDomDescriptorName(options.name);
  const rawMethod = options.method.trim();
  const canonicalMethod = normalizeDomDescriptorMethod(rawMethod);
  const methods = new Set([canonicalMethod]);
  if (rawMethod.length > 0) {
    methods.add(rawMethod);
  }
  return [...methods].map((method) => `dom:${namespace}:${method}:${nameHash}`);
}

export function buildDomDescriptorKey(options: {
  readonly namespace?: string;
  readonly method: string;
  readonly name: string;
}): string {
  return buildDomDescriptorKeys(options)[0]!;
}

export function normalizeDomDescriptorNamespace(namespace: string | undefined): string {
  const normalized = String(namespace || "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildDomDescriptorPayload(input: DomWriteDescriptorInput): DomDescriptorPayload {
  return {
    kind: "dom-target",
    method: normalizeDomDescriptorMethod(input.method),
    name: input.name,
    path: sanitizeReplayElementPath(input.path),
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
  };
}

export function buildDomDescriptorVersion(payload: DomDescriptorPayload): string {
  return sha256Hex(canonicalJsonString(payload));
}

export function parseDomDescriptorRecord(
  record: DescriptorRecord,
): DomDescriptorRecord | undefined {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const raw = payload as Record<string, unknown>;
  if (raw.kind !== "dom-target") {
    return undefined;
  }
  const name =
    typeof raw.name === "string"
      ? raw.name
      : typeof raw.description === "string"
        ? raw.description
        : undefined;
  if (typeof raw.method !== "string" || name === undefined) {
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
    method: normalizeDomDescriptorMethod(raw.method),
    name,
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
    for (const key of buildDomDescriptorKeys({
      namespace: this.namespace,
      method: input.method,
      name: input.name,
    })) {
      const record = await this.registry.resolve({ key });
      if (!record) {
        continue;
      }
      return parseDomDescriptorRecord(record);
    }
    return undefined;
  }

  async write(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord> {
    const payload = buildDomDescriptorPayload(input);
    const key = buildDomDescriptorKey({
      namespace: this.namespace,
      method: input.method,
      name: input.name,
    });
    const version = buildDomDescriptorVersion(payload);
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
      tags: ["dom-runtime", payload.method],
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
    for (const key of buildDomDescriptorKeys({
      namespace: this.namespace,
      method: input.method,
      name: input.name,
    })) {
      const record = this.latestByKey.get(key);
      if (record) {
        return record;
      }
    }
    return undefined;
  }

  async write(input: DomWriteDescriptorInput): Promise<DomDescriptorRecord> {
    const payload = buildDomDescriptorPayload(input);
    const key = buildDomDescriptorKey({
      namespace: this.namespace,
      method: input.method,
      name: input.name,
    });
    const version = buildDomDescriptorVersion(payload);
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
