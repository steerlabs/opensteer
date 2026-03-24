import { createHash, randomUUID } from "node:crypto";

import type { PageRef } from "@opensteer/browser-core";

import type { JsonValue } from "../json.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../json.js";
import type { DescriptorRecord, DescriptorRegistryStore } from "../registry.js";
import type { FilesystemOpensteerRoot } from "../root.js";
import {
  sanitizeElementPath,
  type DomArrayFieldSelector,
  type DomArraySelector,
  type DomRuntime,
  type ElementPath,
} from "../runtimes/dom/index.js";
import {
  buildPersistedOpensteerExtractionPayload,
  type PersistableOpensteerExtractionField,
} from "./extraction-consolidation.js";
import {
  appendDataPathIndex,
  inflateDataPathObject,
  joinDataPath,
} from "./extraction-data-path.js";
import type { CompiledOpensteerSnapshotCounterRecord } from "./snapshot/compiler.js";

interface OpensteerSchemaFieldByElement {
  readonly element: number;
  readonly attribute?: string;
}

interface OpensteerSchemaFieldBySelector {
  readonly selector: string;
  readonly attribute?: string;
}

interface OpensteerSchemaFieldBySource {
  readonly source: "current_url";
}

type OpensteerSchemaField =
  | OpensteerSchemaFieldByElement
  | OpensteerSchemaFieldBySelector
  | OpensteerSchemaFieldBySource;

type OpensteerSchemaNode =
  | OpensteerSchemaField
  | readonly OpensteerSchemaNode[]
  | { readonly [key: string]: OpensteerSchemaNode };

export interface PersistedOpensteerExtractionValueNode {
  readonly $path: ElementPath;
  readonly attribute?: string;
}

export interface PersistedOpensteerExtractionSourceNode {
  readonly $source: "current_url";
}

export interface PersistedOpensteerExtractionArrayVariantNode {
  readonly itemParentPath: ElementPath;
  readonly item: PersistedOpensteerExtractionNode;
}

export interface PersistedOpensteerExtractionArrayNode {
  readonly $array: {
    readonly variants: readonly PersistedOpensteerExtractionArrayVariantNode[];
  };
}

export interface PersistedOpensteerExtractionObjectNode {
  readonly [key: string]: PersistedOpensteerExtractionNode;
}

export type PersistedOpensteerExtractionNode =
  | PersistedOpensteerExtractionValueNode
  | PersistedOpensteerExtractionSourceNode
  | PersistedOpensteerExtractionArrayNode
  | PersistedOpensteerExtractionObjectNode;

export type PersistedOpensteerExtractionPayload = PersistedOpensteerExtractionObjectNode;

export interface OpensteerExtractionDescriptorPayload {
  readonly kind: "dom-extraction";
  readonly description: string;
  readonly root: PersistedOpensteerExtractionPayload;
  readonly schemaHash?: string;
  readonly sourceUrl?: string;
}

export interface OpensteerExtractionDescriptorRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly payload: OpensteerExtractionDescriptorPayload;
}

interface OpensteerExtractionDescriptorStore {
  read(input: {
    readonly description: string;
  }): Promise<OpensteerExtractionDescriptorRecord | undefined>;
  write(input: {
    readonly description: string;
    readonly root: PersistedOpensteerExtractionPayload;
    readonly schemaHash?: string;
    readonly sourceUrl?: string;
    readonly createdAt?: number;
    readonly updatedAt?: number;
  }): Promise<OpensteerExtractionDescriptorRecord>;
}

interface ArrayItemPathDescriptor {
  readonly kind: "path";
  readonly path: string;
  readonly selector: {
    readonly elementPath?: ElementPath;
    readonly attribute?: string;
  };
}

interface ArrayItemSourceDescriptor {
  readonly kind: "source";
  readonly path: string;
  readonly source: "current_url";
}

type ArrayItemDescriptor = ArrayItemPathDescriptor | ArrayItemSourceDescriptor;

interface MergedVariantRow {
  readonly identity: string;
  readonly order: number;
  readonly coverage: number;
  readonly value: JsonValue;
}

export function assertValidOpensteerExtractionSchemaRoot(schema: unknown): asserts schema is {
  readonly [key: string]: OpensteerSchemaNode;
} {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Invalid extraction schema: expected a JSON object at the top level.");
  }
}

export function isPersistedOpensteerExtractionValueNode(
  value: unknown,
): value is PersistedOpensteerExtractionValueNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return "$path" in value;
}

export function isPersistedOpensteerExtractionSourceNode(
  value: unknown,
): value is PersistedOpensteerExtractionSourceNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (value as { readonly $source?: unknown }).$source === "current_url";
}

export function isPersistedOpensteerExtractionArrayNode(
  value: unknown,
): value is PersistedOpensteerExtractionArrayNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return "$array" in value;
}

export async function compileOpensteerExtractionPayload(options: {
  readonly pageRef: PageRef;
  readonly schema: Record<string, unknown>;
  readonly dom: DomRuntime;
  readonly latestSnapshotCounters?: ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>;
}): Promise<PersistedOpensteerExtractionPayload> {
  assertValidOpensteerExtractionSchemaRoot(options.schema);
  const fields: PersistableOpensteerExtractionField[] = [];
  await collectPersistableFieldsFromSchemaObject({
    dom: options.dom,
    pageRef: options.pageRef,
    latestSnapshotCounters: options.latestSnapshotCounters,
    value: options.schema,
    path: "",
    fields,
    insideArray: false,
  });
  return buildPersistedOpensteerExtractionPayload(fields);
}

export async function replayOpensteerExtractionPayload(options: {
  readonly pageRef: PageRef;
  readonly dom: DomRuntime;
  readonly payload: PersistedOpensteerExtractionPayload;
}): Promise<JsonValue> {
  return extractPersistedObjectNode(options.pageRef, options.dom, options.payload);
}

export function createOpensteerExtractionDescriptorStore(options: {
  readonly root?: FilesystemOpensteerRoot;
  readonly namespace?: string;
}): OpensteerExtractionDescriptorStore {
  const namespace = normalizeNamespace(options.namespace);
  if (options.root) {
    return new FilesystemOpensteerExtractionDescriptorStore(
      options.root.registry.descriptors,
      namespace,
    );
  }

  return new MemoryOpensteerExtractionDescriptorStore(namespace);
}

async function collectPersistableFieldsFromSchemaObject(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters:
    | ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>
    | undefined;
  readonly value: Record<string, unknown>;
  readonly path: string;
  readonly fields: PersistableOpensteerExtractionField[];
  readonly insideArray: boolean;
}): Promise<void> {
  for (const [key, childValue] of Object.entries(options.value)) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      continue;
    }

    await collectPersistableFieldsFromSchemaValue({
      dom: options.dom,
      pageRef: options.pageRef,
      latestSnapshotCounters: options.latestSnapshotCounters,
      value: childValue,
      path: joinDataPath(options.path, normalizedKey),
      fields: options.fields,
      insideArray: options.insideArray,
    });
  }
}

async function collectPersistableFieldsFromSchemaValue(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters:
    | ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>
    | undefined;
  readonly value: unknown;
  readonly path: string;
  readonly fields: PersistableOpensteerExtractionField[];
  readonly insideArray: boolean;
}): Promise<void> {
  const normalizedField = normalizeSchemaField(options.value);
  if (normalizedField !== null) {
    options.fields.push(
      await compilePersistableSchemaField({
        dom: options.dom,
        pageRef: options.pageRef,
        latestSnapshotCounters: options.latestSnapshotCounters,
        field: normalizedField,
        path: options.path,
      }),
    );
    return;
  }

  if (Array.isArray(options.value)) {
    if (options.insideArray) {
      throw new Error(
        `Nested arrays are not supported in extraction schema at "${labelForPath(options.path)}".`,
      );
    }
    if (options.value.length === 0) {
      throw new Error(
        `Extraction array "${labelForPath(options.path)}" must include at least one representative item.`,
      );
    }

    for (let index = 0; index < options.value.length; index += 1) {
      const itemValue = options.value[index];
      if (!itemValue || typeof itemValue !== "object" || Array.isArray(itemValue)) {
        throw new Error(
          `Extraction array "${labelForPath(options.path)}" item ${String(index)} must be an object.`,
        );
      }

      const fieldCountBeforeItem = options.fields.length;
      await collectPersistableFieldsFromSchemaObject({
        dom: options.dom,
        pageRef: options.pageRef,
        latestSnapshotCounters: options.latestSnapshotCounters,
        value: itemValue as Record<string, unknown>,
        path: appendDataPathIndex(options.path, index),
        fields: options.fields,
        insideArray: true,
      });

      const itemFields = options.fields.slice(fieldCountBeforeItem);
      if (!itemFields.some((field) => "path" in field)) {
        throw new Error(
          `Extraction array "${labelForPath(options.path)}" item ${String(index)} must include at least one element- or selector-backed field.`,
        );
      }
    }
    return;
  }

  if (!options.value || typeof options.value !== "object") {
    throw new Error(
      `Invalid extraction schema value at "${labelForPath(options.path)}": expected an object, array, or field descriptor.`,
    );
  }

  await collectPersistableFieldsFromSchemaObject({
    dom: options.dom,
    pageRef: options.pageRef,
    latestSnapshotCounters: options.latestSnapshotCounters,
    value: options.value as Record<string, unknown>,
    path: options.path,
    fields: options.fields,
    insideArray: options.insideArray,
  });
}

async function compilePersistableSchemaField(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters:
    | ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>
    | undefined;
  readonly field: OpensteerSchemaField;
  readonly path: string;
}): Promise<PersistableOpensteerExtractionField> {
  if ("source" in options.field) {
    return {
      key: options.path,
      source: "current_url",
    };
  }

  const compiledPath = await resolveFieldPath({
    dom: options.dom,
    pageRef: options.pageRef,
    latestSnapshotCounters: options.latestSnapshotCounters,
    field: options.field,
    path: options.path,
  });

  return {
    key: options.path,
    path: compiledPath,
    ...(options.field.attribute === undefined ? {} : { attribute: options.field.attribute }),
  };
}

async function resolveFieldPath(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters:
    | ReadonlyMap<number, CompiledOpensteerSnapshotCounterRecord>
    | undefined;
  readonly field: OpensteerSchemaFieldByElement | OpensteerSchemaFieldBySelector;
  readonly path: string;
}): Promise<ElementPath> {
  if ("selector" in options.field) {
    const resolved = await options.dom.resolveTarget({
      pageRef: options.pageRef,
      method: "extract",
      target: {
        kind: "selector",
        selector: options.field.selector,
      },
    });
    return (
      resolved.replayPath ??
      (await options.dom.buildPath({
        locator: resolved.locator,
      }))
    );
  }

  const counters = options.latestSnapshotCounters;
  if (counters === undefined) {
    throw new Error(
      `Extraction schema field "${labelForPath(options.path)}" uses element ${String(options.field.element)} but no snapshot is available.`,
    );
  }

  const counter = counters.get(options.field.element);
  if (!counter) {
    throw new Error(
      `Extraction schema field "${labelForPath(options.path)}" references missing counter ${String(options.field.element)}.`,
    );
  }

  const resolved = await options.dom.resolveTarget({
    pageRef: options.pageRef,
    method: "extract",
    target: {
      kind: "live",
      locator: counter.locator,
      anchor: counter.anchor,
    },
  });

  return (
    resolved.replayPath ??
    (await options.dom.buildPath({
      locator: resolved.locator,
    }))
  );
}

function isPersistedObjectNode(value: unknown): value is PersistedOpensteerExtractionObjectNode {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isPersistedOpensteerExtractionValueNode(value) &&
    !isPersistedOpensteerExtractionSourceNode(value) &&
    !isPersistedOpensteerExtractionArrayNode(value)
  );
}

async function extractPersistedObjectNode(
  pageRef: PageRef,
  dom: DomRuntime,
  node: PersistedOpensteerExtractionObjectNode,
): Promise<JsonValue> {
  const out: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(node)) {
    out[key] = await extractPersistedNode(pageRef, dom, child);
  }

  return out;
}

async function extractPersistedNode(
  pageRef: PageRef,
  dom: DomRuntime,
  node: PersistedOpensteerExtractionNode,
): Promise<JsonValue> {
  if (isPersistedOpensteerExtractionValueNode(node)) {
    const resolved = await dom.resolveTarget({
      pageRef,
      method: "extract",
      target: {
        kind: "path",
        path: node.$path,
      },
    });
    const values = await dom.extractFields({
      pageRef,
      fields: [
        {
          key: "value",
          target: {
            kind: "live",
            locator: resolved.locator,
            anchor: resolved.anchor,
          },
          ...(node.attribute === undefined ? {} : { attribute: node.attribute }),
        },
      ],
    });
    return values.value ?? null;
  }

  if (isPersistedOpensteerExtractionSourceNode(node)) {
    const values = await dom.extractFields({
      pageRef,
      fields: [
        {
          key: "value",
          source: "current_url",
        },
      ],
    });
    return values.value ?? null;
  }

  if (isPersistedOpensteerExtractionArrayNode(node)) {
    return extractPersistedArrayNode(pageRef, dom, node);
  }

  return extractPersistedObjectNode(pageRef, dom, node);
}

async function extractPersistedArrayNode(
  pageRef: PageRef,
  dom: DomRuntime,
  node: PersistedOpensteerExtractionArrayNode,
): Promise<JsonValue> {
  const rowsByIdentity = new Map<string, MergedVariantRow>();

  for (const variant of node.$array.variants) {
    const descriptors = collectArrayItemDescriptors(variant.item);
    const pathFields = descriptors
      .filter((descriptor): descriptor is ArrayItemPathDescriptor => descriptor.kind === "path")
      .map((descriptor) => ({
        key: descriptor.path,
        ...(descriptor.selector.elementPath === undefined
          ? {}
          : { path: descriptor.selector.elementPath }),
        ...(descriptor.selector.attribute === undefined
          ? {}
          : { attribute: descriptor.selector.attribute }),
      })) satisfies readonly DomArrayFieldSelector[];
    const sourceFields = descriptors
      .filter((descriptor): descriptor is ArrayItemSourceDescriptor => descriptor.kind === "source")
      .map((descriptor) => ({
        key: descriptor.path,
        source: "current_url",
      })) satisfies readonly DomArrayFieldSelector[];

    const extracted = await dom.extractArrayRows({
      pageRef,
      array: {
        itemParentPath: variant.itemParentPath,
        fields: [...pathFields, ...sourceFields] satisfies DomArraySelector["fields"],
      },
    });
    const primitiveArray = descriptors.every((descriptor) => descriptor.path.length === 0);

    for (const row of extracted) {
      const value = primitiveArray
        ? toCanonicalJsonValue(row.values[""] ?? row.values.value ?? null)
        : toCanonicalJsonValue(inflateDataPathObject(row.values));
      const coverage = computeArrayRowCoverage(row.values, value);
      const existing = rowsByIdentity.get(row.meta.key);
      if (!existing || coverage > existing.coverage) {
        rowsByIdentity.set(row.meta.key, {
          identity: row.meta.key,
          order: row.meta.order,
          coverage,
          value,
        });
      }
    }
  }

  return [...rowsByIdentity.values()]
    .sort((left, right) => {
      if (left.order !== right.order) {
        return left.order - right.order;
      }
      return left.identity.localeCompare(right.identity);
    })
    .map((row) => row.value);
}

function collectArrayItemDescriptors(
  node: PersistedOpensteerExtractionNode,
  prefix = "",
): ArrayItemDescriptor[] {
  if (isPersistedOpensteerExtractionValueNode(node)) {
    return [
      {
        kind: "path",
        path: prefix,
        selector:
          node.$path.nodes.length === 0 && node.$path.context.length === 0
            ? {
                ...(node.attribute === undefined ? {} : { attribute: node.attribute }),
              }
            : {
                elementPath: node.$path,
                ...(node.attribute === undefined ? {} : { attribute: node.attribute }),
              },
      },
    ];
  }

  if (isPersistedOpensteerExtractionSourceNode(node)) {
    return [
      {
        kind: "source",
        path: prefix,
        source: "current_url",
      },
    ];
  }

  if (isPersistedOpensteerExtractionArrayNode(node)) {
    throw new Error("Nested persisted extraction arrays are not supported.");
  }

  const out: ArrayItemDescriptor[] = [];
  for (const [key, child] of Object.entries(node)) {
    out.push(...collectArrayItemDescriptors(child, joinDataPath(prefix, key)));
  }
  return out;
}

function computeArrayRowCoverage(
  flat: Readonly<Record<string, string | null>>,
  value: JsonValue,
): number {
  const flatCoverage = Object.values(flat).reduce<number>(
    (count, current) => (current == null ? count : count + 1),
    0,
  );
  if (flatCoverage > 0) {
    return flatCoverage;
  }

  return countNonNullLeaves(value);
}

function countNonNullLeaves(value: JsonValue): number {
  if (value === null) {
    return 0;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countNonNullLeaves(item), 0);
  }
  return Object.values(value).reduce<number>((sum, item) => sum + countNonNullLeaves(item), 0);
}

function normalizeSchemaField(value: unknown): OpensteerSchemaField | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const hasElement = raw.element !== undefined;
  const hasSelector = raw.selector !== undefined;
  const hasSource = raw.source !== undefined;
  const targetCount = Number(hasElement) + Number(hasSelector) + Number(hasSource);
  if (targetCount === 0) {
    return null;
  }
  if (targetCount !== 1) {
    throw new Error(
      "Extraction field descriptors must specify exactly one of element, selector, or source.",
    );
  }

  const attribute =
    raw.attribute === undefined ? undefined : normalizeNonEmptyString("attribute", raw.attribute);

  if (hasSource) {
    if (raw.source !== "current_url") {
      throw new Error(`Unsupported extraction source "${String(raw.source)}".`);
    }
    return {
      source: "current_url",
    };
  }

  if (hasSelector) {
    return {
      selector: normalizeNonEmptyString("selector", raw.selector),
      ...(attribute === undefined ? {} : { attribute }),
    };
  }

  const element = Number(raw.element);
  if (!Number.isInteger(element) || element < 1) {
    throw new Error(
      `Extraction field element must be a positive integer, received ${String(raw.element)}.`,
    );
  }

  return {
    element,
    ...(attribute === undefined ? {} : { attribute }),
  };
}

function normalizeNamespace(namespace: string | undefined): string {
  const normalized = String(namespace ?? "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}

function descriptionKey(namespace: string, description: string): string {
  return `extract:${namespace}:${sha256Hex(description.trim())}`;
}

function parseExtractionDescriptorRecord(
  record: DescriptorRecord,
): OpensteerExtractionDescriptorRecord | undefined {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const raw = payload as Record<string, unknown>;
  if (raw.kind !== "dom-extraction" || typeof raw.description !== "string") {
    return undefined;
  }

  const root = normalizePersistedExtractionNode(raw.root, "root");
  if (!isPersistedObjectNode(root)) {
    throw new Error(`descriptor ${record.id} root payload is not an object node`);
  }

  return {
    id: record.id,
    key: record.key,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    payload: {
      kind: "dom-extraction",
      description: raw.description,
      root,
      ...(typeof raw.schemaHash === "string" ? { schemaHash: raw.schemaHash } : {}),
      ...(typeof raw.sourceUrl === "string" ? { sourceUrl: raw.sourceUrl } : {}),
    },
  };
}

function normalizePersistedExtractionNode(
  value: unknown,
  label: string,
): PersistedOpensteerExtractionNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid persisted extraction node at "${label}".`);
  }

  const record = value as Record<string, unknown>;
  if ("$path" in record) {
    const rawPath = record.$path;
    if (
      !rawPath ||
      typeof rawPath !== "object" ||
      Array.isArray(rawPath) ||
      (rawPath as { readonly resolution?: unknown }).resolution !== "deterministic"
    ) {
      throw new Error(`Invalid persisted extraction path node at "${label}".`);
    }
    return {
      $path: sanitizeElementPath(rawPath as ElementPath),
      ...(typeof record.attribute === "string" ? { attribute: record.attribute } : {}),
    };
  }

  if (record.$source === "current_url") {
    return {
      $source: "current_url",
    };
  }

  if ("$array" in record) {
    const rawArray = record.$array;
    if (!rawArray || typeof rawArray !== "object" || Array.isArray(rawArray)) {
      throw new Error(`Invalid persisted extraction array node at "${label}".`);
    }

    const variantsRaw = (rawArray as { readonly variants?: unknown }).variants;
    if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
      throw new Error(`Persisted extraction array "${label}" must contain variants.`);
    }

    return {
      $array: {
        variants: variantsRaw.map((variant, index) => {
          if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
            throw new Error(
              `Invalid persisted extraction array variant at "${label}[${String(index)}]".`,
            );
          }

          const rawVariant = variant as Record<string, unknown>;
          const itemParentPath = rawVariant.itemParentPath;
          if (
            !itemParentPath ||
            typeof itemParentPath !== "object" ||
            Array.isArray(itemParentPath) ||
            (itemParentPath as { readonly resolution?: unknown }).resolution !== "deterministic"
          ) {
            throw new Error(
              `Invalid persisted extraction array item parent path at "${label}[${String(index)}]".`,
            );
          }
          return {
            itemParentPath: sanitizeElementPath(itemParentPath as ElementPath),
            item: normalizePersistedExtractionNode(
              rawVariant.item,
              `${label}[${String(index)}].item`,
            ),
          };
        }),
      },
    };
  }

  const out: Record<string, PersistedOpensteerExtractionNode> = {};
  for (const [key, child] of Object.entries(record)) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      continue;
    }
    out[normalizedKey] = normalizePersistedExtractionNode(child, `${label}.${normalizedKey}`);
  }
  return out;
}

class FilesystemOpensteerExtractionDescriptorStore implements OpensteerExtractionDescriptorStore {
  constructor(
    private readonly registry: DescriptorRegistryStore,
    private readonly namespace: string,
  ) {}

  async read(input: {
    readonly description: string;
  }): Promise<OpensteerExtractionDescriptorRecord | undefined> {
    const record = await this.registry.resolve({
      key: descriptionKey(this.namespace, input.description),
    });
    return record === undefined ? undefined : parseExtractionDescriptorRecord(record);
  }

  async write(input: {
    readonly description: string;
    readonly root: PersistedOpensteerExtractionPayload;
    readonly schemaHash?: string;
    readonly sourceUrl?: string;
    readonly createdAt?: number;
    readonly updatedAt?: number;
  }): Promise<OpensteerExtractionDescriptorRecord> {
    const payload: OpensteerExtractionDescriptorPayload = {
      kind: "dom-extraction",
      description: input.description,
      root: input.root,
      ...(input.schemaHash === undefined ? {} : { schemaHash: input.schemaHash }),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    };
    const key = descriptionKey(this.namespace, input.description);
    const version = sha256Hex(canonicalJsonString(payload));
    const existing = await this.registry.resolve({ key, version });
    if (existing) {
      const parsed = parseExtractionDescriptorRecord(existing);
      if (!parsed) {
        throw new Error(`descriptor ${existing.id} has an invalid extraction payload`);
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
      tags: ["dom-runtime", "extract"],
      provenance: {
        source: "opensteer.extract",
        sourceId: key,
        ...(input.sourceUrl === undefined ? {} : { notes: input.sourceUrl }),
      },
      payload: toCanonicalJsonValue(payload),
    });
    const parsed = parseExtractionDescriptorRecord(record);
    if (!parsed) {
      throw new Error(`descriptor ${record.id} could not be parsed after write`);
    }
    return parsed;
  }
}

class MemoryOpensteerExtractionDescriptorStore implements OpensteerExtractionDescriptorStore {
  private readonly latestByKey = new Map<string, OpensteerExtractionDescriptorRecord>();
  private readonly recordsByKey = new Map<
    string,
    Map<string, OpensteerExtractionDescriptorRecord>
  >();

  constructor(private readonly namespace: string) {}

  async read(input: {
    readonly description: string;
  }): Promise<OpensteerExtractionDescriptorRecord | undefined> {
    return this.latestByKey.get(descriptionKey(this.namespace, input.description));
  }

  async write(input: {
    readonly description: string;
    readonly root: PersistedOpensteerExtractionPayload;
    readonly schemaHash?: string;
    readonly sourceUrl?: string;
    readonly createdAt?: number;
    readonly updatedAt?: number;
  }): Promise<OpensteerExtractionDescriptorRecord> {
    const payload: OpensteerExtractionDescriptorPayload = {
      kind: "dom-extraction",
      description: input.description,
      root: input.root,
      ...(input.schemaHash === undefined ? {} : { schemaHash: input.schemaHash }),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    };
    const key = descriptionKey(this.namespace, input.description);
    const version = sha256Hex(canonicalJsonString(payload));
    const existing = this.recordsByKey.get(key)?.get(version);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const record: OpensteerExtractionDescriptorRecord = {
      id: `descriptor:${randomUUID()}`,
      key,
      version,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
      payload,
    };

    const versions =
      this.recordsByKey.get(key) ?? new Map<string, OpensteerExtractionDescriptorRecord>();
    versions.set(version, record);
    this.recordsByKey.set(key, versions);
    this.latestByKey.set(key, record);
    return record;
  }
}

function normalizeNonEmptyString(name: string, value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (normalized.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return normalized;
}

function normalizeKey(value: string): string {
  return String(value ?? "").trim();
}

function labelForPath(path: string): string {
  return path.trim().length === 0 ? "$" : path;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface DataPathPropertyToken {
  readonly kind: "prop";
  readonly key: string;
}

interface DataPathIndexToken {
  readonly kind: "index";
  readonly index: number;
}

type DataPathToken = DataPathPropertyToken | DataPathIndexToken;
