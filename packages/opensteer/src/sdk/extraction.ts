import { createHash, randomUUID } from "node:crypto";

import type { PageRef } from "@opensteer/browser-core";

import type { JsonValue } from "../json.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../json.js";
import type { DescriptorRecord, DescriptorRegistryStore } from "../registry.js";
import type { FilesystemOpensteerRoot } from "../root.js";
import {
  STABLE_PRIMARY_ATTR_KEYS,
  VOLATILE_CLASS_TOKENS,
  VOLATILE_LAZY_CLASS_TOKENS,
} from "../runtimes/dom/match-policy.js";
import {
  sanitizeElementPath,
  type DomArrayFieldSelector,
  type DomArraySelector,
  type DomRuntime,
  type ElementPath,
  type MatchClause,
  type PathNode,
} from "../runtimes/dom/index.js";
import type { CompiledOpensteerSnapshotCounterRecord } from "./snapshot/compiler.js";

const ALLOWED_ARRAY_ATTR_KEYS = new Set<string>(["class", ...STABLE_PRIMARY_ATTR_KEYS]);

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

interface CompiledLeafField {
  readonly key: string;
  readonly kind: "path";
  readonly path: ElementPath;
  readonly attribute?: string;
}

interface CompiledSourceField {
  readonly key: string;
  readonly kind: "source";
  readonly source: "current_url";
}

type CompiledField = CompiledLeafField | CompiledSourceField;

interface RelativeArrayPathField {
  readonly key: string;
  readonly kind: "path";
  readonly path?: ElementPath;
  readonly attribute?: string;
}

interface RelativeArraySourceField {
  readonly key: string;
  readonly kind: "source";
  readonly source: "current_url";
}

type RelativeArrayField = RelativeArrayPathField | RelativeArraySourceField;

interface ArrayVariantExample {
  readonly itemPath: ElementPath;
  readonly fields: readonly RelativeArrayField[];
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
    throw new Error(
      "Invalid extraction schema: expected a JSON object at the top level.",
    );
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

  const compiled = await compileSchemaObject({
    dom: options.dom,
    pageRef: options.pageRef,
    latestSnapshotCounters: options.latestSnapshotCounters,
    value: options.schema,
    path: "",
    insideArray: false,
  });

  if (
    compiled === undefined ||
    isPersistedOpensteerExtractionValueNode(compiled) ||
    isPersistedOpensteerExtractionSourceNode(compiled) ||
    isPersistedOpensteerExtractionArrayNode(compiled)
  ) {
    throw new Error("Extraction schema must compile to an object payload.");
  }

  return compiled;
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
    return new FilesystemOpensteerExtractionDescriptorStore(options.root.registry.descriptors, namespace);
  }

  return new MemoryOpensteerExtractionDescriptorStore(namespace);
}

async function compileSchemaObject(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters: ReadonlyMap<
    number,
    CompiledOpensteerSnapshotCounterRecord
  > | undefined;
  readonly value: Record<string, unknown>;
  readonly path: string;
  readonly insideArray: boolean;
}): Promise<PersistedOpensteerExtractionObjectNode | undefined> {
  const out: Record<string, PersistedOpensteerExtractionNode> = {};

  for (const [key, childValue] of Object.entries(options.value)) {
    const normalizedKey = normalizeKey(key);
    if (!normalizedKey) {
      continue;
    }

    const child = await compileSchemaNode({
      dom: options.dom,
      pageRef: options.pageRef,
      latestSnapshotCounters: options.latestSnapshotCounters,
      value: childValue,
      path: joinDataPath(options.path, normalizedKey),
      insideArray: options.insideArray,
    });
    if (child !== undefined) {
      out[normalizedKey] = child;
    }
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

async function compileSchemaNode(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters: ReadonlyMap<
    number,
    CompiledOpensteerSnapshotCounterRecord
  > | undefined;
  readonly value: unknown;
  readonly path: string;
  readonly insideArray: boolean;
}): Promise<PersistedOpensteerExtractionNode | undefined> {
  const normalizedField = normalizeSchemaField(options.value);
  if (normalizedField !== null) {
    return compileSchemaField({
      dom: options.dom,
      pageRef: options.pageRef,
      latestSnapshotCounters: options.latestSnapshotCounters,
      field: normalizedField,
      path: options.path,
    });
  }

  if (Array.isArray(options.value)) {
    if (options.insideArray) {
      throw new Error(
        `Nested arrays are not supported in extraction schema at "${labelForPath(options.path)}".`,
      );
    }

    return compileArraySchemaNode({
      dom: options.dom,
      pageRef: options.pageRef,
      latestSnapshotCounters: options.latestSnapshotCounters,
      value: options.value,
      path: options.path,
    });
  }

  if (!options.value || typeof options.value !== "object") {
    throw new Error(
      `Invalid extraction schema value at "${labelForPath(options.path)}": expected an object, array, or field descriptor.`,
    );
  }

  return compileSchemaObject({
    dom: options.dom,
    pageRef: options.pageRef,
    latestSnapshotCounters: options.latestSnapshotCounters,
    value: options.value as Record<string, unknown>,
    path: options.path,
    insideArray: options.insideArray,
  });
}

async function compileSchemaField(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters: ReadonlyMap<
    number,
    CompiledOpensteerSnapshotCounterRecord
  > | undefined;
  readonly field: OpensteerSchemaField;
  readonly path: string;
}): Promise<PersistedOpensteerExtractionNode> {
  if ("source" in options.field) {
    return {
      $source: "current_url",
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
    $path: compiledPath,
    ...(options.field.attribute === undefined ? {} : { attribute: options.field.attribute }),
  };
}

async function compileArraySchemaNode(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters: ReadonlyMap<
    number,
    CompiledOpensteerSnapshotCounterRecord
  > | undefined;
  readonly value: readonly unknown[];
  readonly path: string;
}): Promise<PersistedOpensteerExtractionArrayNode> {
  if (options.value.length === 0) {
    throw new Error(
      `Extraction array "${labelForPath(options.path)}" must include at least one representative item.`,
    );
  }

  const examples: Array<ArrayVariantExample> = [];
  for (let index = 0; index < options.value.length; index += 1) {
    const itemValue = options.value[index];
    if (!itemValue || typeof itemValue !== "object" || Array.isArray(itemValue)) {
      throw new Error(
        `Extraction array "${labelForPath(options.path)}" item ${String(index)} must be an object.`,
      );
    }

    const fields = await collectCompiledFields({
      dom: options.dom,
      pageRef: options.pageRef,
      latestSnapshotCounters: options.latestSnapshotCounters,
      value: itemValue as Record<string, unknown>,
      path: "",
    });
    const pathFields = fields.filter(
      (field): field is CompiledLeafField => field.kind === "path",
    );
    if (pathFields.length === 0) {
      throw new Error(
        `Extraction array "${labelForPath(options.path)}" item ${String(index)} must include at least one element- or selector-backed field.`,
      );
    }

    const itemPath = inferArrayItemPath(pathFields.map((field) => field.path), options.path, index);
    const relativeFields = fields.map<RelativeArrayField>((field) => {
      if (field.kind === "source") {
        return {
          key: field.key,
          kind: "source",
          source: "current_url",
        };
      }

      const relativePath = toRelativeArrayPath(itemPath, field.path, options.path, field.key);
      return {
        key: field.key,
        kind: "path",
        ...(relativePath === undefined ? {} : { path: relativePath }),
        ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
      };
    });

    examples.push({
      itemPath,
      fields: relativeFields,
    });
  }

  const variants = groupArrayExamples(examples).map((group) =>
    consolidateArrayVariant(group, options.path),
  );

  return {
    $array: {
      variants,
    },
  };
}

async function collectCompiledFields(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters: ReadonlyMap<
    number,
    CompiledOpensteerSnapshotCounterRecord
  > | undefined;
  readonly value: Record<string, unknown>;
  readonly path: string;
}): Promise<readonly CompiledField[]> {
  const fields: CompiledField[] = [];

  for (const [rawKey, childValue] of Object.entries(options.value)) {
    const key = normalizeKey(rawKey);
    if (!key) {
      continue;
    }

    const fieldPath = joinDataPath(options.path, key);
    const normalizedField = normalizeSchemaField(childValue);
    if (normalizedField !== null) {
      if ("source" in normalizedField) {
        fields.push({
          key: fieldPath,
          kind: "source",
          source: "current_url",
        });
        continue;
      }

      fields.push({
        key: fieldPath,
        kind: "path",
        path: await resolveFieldPath({
          dom: options.dom,
          pageRef: options.pageRef,
          latestSnapshotCounters: options.latestSnapshotCounters,
          field: normalizedField,
          path: fieldPath,
        }),
        ...(normalizedField.attribute === undefined
          ? {}
          : { attribute: normalizedField.attribute }),
      });
      continue;
    }

    if (Array.isArray(childValue)) {
      throw new Error(
        `Nested arrays are not supported in extraction schema at "${labelForPath(fieldPath)}".`,
      );
    }
    if (!childValue || typeof childValue !== "object") {
      throw new Error(
        `Invalid extraction schema value at "${labelForPath(fieldPath)}": expected an object or field descriptor.`,
      );
    }

    fields.push(
      ...(await collectCompiledFields({
        dom: options.dom,
        pageRef: options.pageRef,
        latestSnapshotCounters: options.latestSnapshotCounters,
        value: childValue as Record<string, unknown>,
        path: fieldPath,
      })),
    );
  }

  return fields;
}

async function resolveFieldPath(options: {
  readonly dom: DomRuntime;
  readonly pageRef: PageRef;
  readonly latestSnapshotCounters: ReadonlyMap<
    number,
    CompiledOpensteerSnapshotCounterRecord
  > | undefined;
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

function inferArrayItemPath(
  paths: readonly ElementPath[],
  arrayPath: string,
  itemIndex: number,
): ElementPath {
  if (paths.length === 0) {
    throw new Error(
      `Extraction array "${labelForPath(arrayPath)}" item ${String(itemIndex)} has no path-backed fields.`,
    );
  }

  const contextLength = sharedContextPrefixLength(paths);
  const nodeLength = sharedNodePrefixLength(paths);
  if (nodeLength === 0) {
    throw new Error(
      `Extraction array "${labelForPath(arrayPath)}" item ${String(itemIndex)} does not share a common DOM ancestor across its fields.`,
    );
  }

  return generalizePathCollection(
    paths.map((path) => ({
      resolution: "deterministic",
      context: path.context.slice(0, contextLength),
      nodes: path.nodes.slice(0, nodeLength),
    })),
    {
      preserveAncestorPositions: true,
      preserveLeafPosition: true,
    },
  );
}

function sharedContextPrefixLength(paths: readonly ElementPath[]): number {
  const first = paths[0];
  if (!first) {
    return 0;
  }

  for (let index = 0; index < first.context.length; index += 1) {
    const hop = first.context[index];
    if (!hop) {
      break;
    }
    const matchesAll = paths.every((path) =>
      isCompatibleContextHop(path.context[index], hop),
    );
    if (!matchesAll) {
      return index;
    }
  }

  return first.context.length;
}

function sharedNodePrefixLength(paths: readonly ElementPath[]): number {
  const first = paths[0];
  if (!first) {
    return 0;
  }

  for (let index = 0; index < first.nodes.length; index += 1) {
    const node = first.nodes[index];
    if (!node) {
      break;
    }
    const matchesAll = paths.every((path) => isCompatiblePathNode(path.nodes[index], node));
    if (!matchesAll) {
      return index;
    }
  }

  return first.nodes.length;
}

function toRelativeArrayPath(
  itemPath: ElementPath,
  fieldPath: ElementPath,
  arrayPath: string,
  fieldKey: string,
): ElementPath | undefined {
  if (!isContextPathPrefix(itemPath.context, fieldPath.context)) {
    throw new Error(
      `Extraction array "${labelForPath(arrayPath)}" field "${fieldKey}" crosses into a different DOM context and cannot be replayed as an array field.`,
    );
  }

  if (!isNodePathPrefix(itemPath.nodes, fieldPath.nodes)) {
    throw new Error(
      `Extraction array "${labelForPath(arrayPath)}" field "${fieldKey}" is not contained within its inferred item root.`,
    );
  }

  const relativeNodes = fieldPath.nodes.slice(itemPath.nodes.length).map(clonePathNode);
  if (relativeNodes.length === 0) {
    return undefined;
  }

  return sanitizeElementPath({
    resolution: "deterministic",
    context: [],
    nodes: relativeNodes,
  });
}

function groupArrayExamples(
  examples: readonly ArrayVariantExample[],
): readonly (readonly ArrayVariantExample[])[] {
  const groups = new Map<string, Array<ArrayVariantExample>>();

  for (const example of examples) {
    const signature = [
      stringifyContextStructure(example.itemPath.context),
      stringifyNodeTagStructure(example.itemPath.nodes),
      ...example.fields
        .map((field) =>
          field.kind === "source"
            ? `${field.key}:source`
            : `${field.key}:path:${stringifyNodeTagStructure(field.path?.nodes ?? [])}`,
        )
        .sort((left, right) => left.localeCompare(right)),
    ].join("|");

    const existing = groups.get(signature) ?? [];
    existing.push(example);
    groups.set(signature, existing);
  }

  return [...groups.values()];
}

function consolidateArrayVariant(
  group: readonly ArrayVariantExample[],
  arrayPath: string,
): PersistedOpensteerExtractionArrayVariantNode {
  const first = group[0];
  if (!first) {
    throw new Error(`Extraction array "${labelForPath(arrayPath)}" did not produce any variants.`);
  }

  const fieldMap = new Map<string, RelativeArrayField[]>();
  for (const example of group) {
    for (const field of example.fields) {
      const list = fieldMap.get(field.key) ?? [];
      list.push(field);
      fieldMap.set(field.key, list);
    }
  }

  const itemLeaves: RelativeArrayField[] = [];
  for (const [fieldKey, fields] of [...fieldMap.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    const sourceFields = fields.filter(
      (field): field is RelativeArraySourceField => field.kind === "source",
    );
    if (sourceFields.length > 0) {
      itemLeaves.push({
        key: fieldKey,
        kind: "source",
        source: "current_url",
      });
      continue;
    }

    const pathFields = fields.filter(
      (field): field is RelativeArrayPathField => field.kind === "path",
    );
    if (pathFields.length === 0) {
      continue;
    }

    const paths = pathFields
      .map((field) => field.path)
      .filter((path): path is ElementPath => path !== undefined);

    itemLeaves.push({
      key: fieldKey,
      kind: "path",
      ...(paths.length === 0
        ? {}
        : {
            path: generalizePathCollection(paths, {
              preserveAncestorPositions: true,
              preserveLeafPosition: false,
            }),
          }),
      ...(pathFields.find((field) => field.attribute !== undefined)?.attribute === undefined
        ? {}
        : {
            attribute: pathFields.find((field) => field.attribute !== undefined)!.attribute,
          }),
    });
  }

  return {
    itemParentPath: generalizePathCollection(
      group.map((example) => example.itemPath),
      {
        preserveAncestorPositions: true,
        preserveLeafPosition: false,
      },
    ),
    item: buildPersistedArrayItemNode(itemLeaves),
  };
}

function generalizePathCollection(
  paths: readonly ElementPath[],
  options: {
    readonly preserveAncestorPositions: boolean;
    readonly preserveLeafPosition: boolean;
  },
): ElementPath {
  const first = paths[0];
  if (!first) {
    return sanitizeElementPath({
      resolution: "deterministic",
      context: [],
      nodes: [],
    });
  }

  const context = first.context.map((_, index) =>
    generalizeContextHop(paths.map((path) => path.context[index]).filter(Boolean) as ElementPath["context"]),
  );
  const nodes = first.nodes.map((_, index) =>
    generalizePathNode(
      paths.map((path) => path.nodes[index]).filter(Boolean) as PathNode[],
      index === first.nodes.length - 1
        ? options.preserveLeafPosition
        : options.preserveAncestorPositions,
    ),
  );

  return sanitizeElementPath({
    resolution: "deterministic",
    context,
    nodes,
  });
}

function generalizeContextHop(hops: ElementPath["context"]): ElementPath["context"][number] {
  const first = hops[0];
  if (!first) {
    return {
      kind: "iframe",
      host: [],
    };
  }

  return {
    kind: first.kind,
    host: generalizePathCollection(
      hops.map((hop) => ({
        resolution: "deterministic",
        context: [],
        nodes: hop.host,
      })),
      {
        preserveAncestorPositions: true,
        preserveLeafPosition: true,
      },
    ).nodes,
  };
}

function generalizePathNode(nodes: readonly PathNode[], keepPosition: boolean): PathNode {
  const first = nodes[0];
  if (!first) {
    return {
      tag: "*",
      attrs: {},
      position: {
        nthChild: 1,
        nthOfType: 1,
      },
      match: [],
    };
  }

  const attrs = collectCommonPathAttributes(nodes);
  const keepNthChild =
    keepPosition && nodes.every((node) => node.position.nthChild === first.position.nthChild);
  const keepNthOfType =
    keepPosition && nodes.every((node) => node.position.nthOfType === first.position.nthOfType);
  const match: MatchClause[] = [];

  for (const [key, value] of Object.entries(attrs).sort((left, right) => left[0].localeCompare(right[0]))) {
    match.push({
      kind: "attr",
      key,
      op: "exact",
      value,
    });
  }
  if (keepNthOfType) {
    match.push({
      kind: "position",
      axis: "nthOfType",
    });
  }
  if (keepNthChild) {
    match.push({
      kind: "position",
      axis: "nthChild",
    });
  }

  return {
    tag: first.tag,
    attrs,
    position: {
      nthChild: keepNthChild ? first.position.nthChild : 1,
      nthOfType: keepNthOfType ? first.position.nthOfType : 1,
    },
    match,
  };
}

function collectCommonPathAttributes(nodes: readonly PathNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = new Set<string>();
  for (const node of nodes) {
    for (const key of Object.keys(node.attrs)) {
      if (ALLOWED_ARRAY_ATTR_KEYS.has(key)) {
        keys.add(key);
      }
    }
  }

  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    if (key === "class") {
      const commonClassValue = intersectClassValues(nodes.map((node) => node.attrs.class));
      if (commonClassValue) {
        out.class = commonClassValue;
      }
      continue;
    }

    const firstValue = firstDefined(nodes.map((node) => node.attrs[key]));
    if (
      firstValue !== undefined &&
      nodes.every((node) => node.attrs[key] === firstValue)
    ) {
      out[key] = firstValue;
    }
  }

  return out;
}

function intersectClassValues(values: readonly (string | undefined)[]): string | undefined {
  const tokenSets = values
    .map((value) =>
      new Set(
        String(value ?? "")
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(
            (token) =>
              token.length > 0 &&
              !VOLATILE_CLASS_TOKENS.has(token) &&
              !VOLATILE_LAZY_CLASS_TOKENS.has(token),
          ),
      ),
    )
    .filter((tokens) => tokens.size > 0);
  const first = tokenSets[0];
  if (!first) {
    return undefined;
  }

  const common = [...first].filter((token) => tokenSets.every((set) => set.has(token)));
  if (common.length === 0) {
    return undefined;
  }

  return common.sort((left, right) => left.localeCompare(right)).join(" ");
}

function buildPersistedArrayItemNode(
  fields: readonly RelativeArrayField[],
): PersistedOpensteerExtractionNode {
  const root: Record<string, PersistedOpensteerExtractionNode> = {};

  for (const field of fields) {
    insertPersistedNode(root, field.key, toPersistedLeafNode(field));
  }

  return root;
}

function toPersistedLeafNode(field: RelativeArrayField): PersistedOpensteerExtractionNode {
  if (field.kind === "source") {
    return {
      $source: "current_url",
    };
  }

  return field.path === undefined
    ? {
        $path: sanitizeElementPath({
          resolution: "deterministic",
          context: [],
          nodes: [],
        }),
        ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
      }
    : {
        $path: field.path,
        ...(field.attribute === undefined ? {} : { attribute: field.attribute }),
      };
}

function insertPersistedNode(
  root: Record<string, PersistedOpensteerExtractionNode>,
  path: string,
  value: PersistedOpensteerExtractionNode,
): void {
  const tokens = parseDataPath(path);
  if (!tokens) {
    throw new Error(`Invalid extraction data path "${path}".`);
  }
  if (tokens.length === 0) {
    throw new Error("Persisted extraction data paths must not be empty.");
  }

  let current = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.kind !== "prop") {
      throw new Error(`Extraction path "${path}" uses an unsupported array token outside array roots.`);
    }

    const isLast = index === tokens.length - 1;
    if (isLast) {
      current[token.key] = value;
      return;
    }

    const next = current[token.key];
    if (next && !isPersistedObjectNode(next)) {
      throw new Error(`Extraction path "${path}" collides with an existing leaf node.`);
    }

    if (!next) {
      current[token.key] = {};
    }
    current = current[token.key] as Record<string, PersistedOpensteerExtractionNode>;
  }
}

function isPersistedObjectNode(
  value: unknown,
): value is PersistedOpensteerExtractionObjectNode {
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
      .filter(
        (descriptor): descriptor is ArrayItemSourceDescriptor => descriptor.kind === "source",
      )
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
    throw new Error("Extraction field descriptors must specify exactly one of element, selector, or source.");
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
    throw new Error(`Extraction field element must be a positive integer, received ${String(raw.element)}.`);
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
            throw new Error(`Invalid persisted extraction array variant at "${label}[${String(index)}]".`);
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

    const versions = this.recordsByKey.get(key) ?? new Map<string, OpensteerExtractionDescriptorRecord>();
    versions.set(version, record);
    this.recordsByKey.set(key, versions);
    this.latestByKey.set(key, record);
    return record;
  }
}

function isContextHopEqual(
  left: ElementPath["context"][number] | undefined,
  right: ElementPath["context"][number] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.kind === right.kind && isNodePathEqual(left.host, right.host);
}

function isCompatibleContextHop(
  left: ElementPath["context"][number] | undefined,
  right: ElementPath["context"][number] | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.kind === right.kind && isCompatibleNodePath(left.host, right.host);
}

function isNodePathEqual(left: readonly PathNode[], right: readonly PathNode[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((node, index) => isPathNodeEqual(node, right[index]));
}

function isCompatibleNodePath(left: readonly PathNode[], right: readonly PathNode[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((node, index) => isCompatiblePathNode(node, right[index]));
}

function isPathNodeEqual(left: PathNode | undefined, right: PathNode | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return canonicalJsonString(left) === canonicalJsonString(right);
}

function isCompatiblePathNode(left: PathNode | undefined, right: PathNode | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.tag === right.tag;
}

function isContextPathPrefix(
  prefix: readonly ElementPath["context"][number][],
  value: readonly ElementPath["context"][number][],
): boolean {
  if (prefix.length > value.length) {
    return false;
  }

  return prefix.every((hop, index) => isPrefixContextHop(hop, value[index]));
}

function isNodePathPrefix(prefix: readonly PathNode[], value: readonly PathNode[]): boolean {
  if (prefix.length > value.length) {
    return false;
  }

  return prefix.every((node, index) => isPrefixPathNode(node, value[index]));
}

function isPrefixContextHop(
  prefix: ElementPath["context"][number] | undefined,
  value: ElementPath["context"][number] | undefined,
): boolean {
  if (prefix === undefined || value === undefined) {
    return prefix === value;
  }

  return prefix.kind === value.kind && isPrefixNodePath(prefix.host, value.host);
}

function isPrefixNodePath(prefix: readonly PathNode[], value: readonly PathNode[]): boolean {
  if (prefix.length !== value.length) {
    return false;
  }

  return prefix.every((node, index) => isPrefixPathNode(node, value[index]));
}

function isPrefixPathNode(prefix: PathNode | undefined, value: PathNode | undefined): boolean {
  if (prefix === undefined || value === undefined) {
    return prefix === value;
  }

  return (
    prefix.tag === value.tag &&
    prefix.position.nthChild === value.position.nthChild &&
    prefix.position.nthOfType === value.position.nthOfType &&
    Object.entries(prefix.attrs).every(([key, expected]) => value.attrs[key] === expected)
  );
}

function clonePathNode(node: PathNode): PathNode {
  return {
    tag: node.tag,
    attrs: { ...node.attrs },
    position: {
      nthChild: node.position.nthChild,
      nthOfType: node.position.nthOfType,
    },
    match: node.match.map((clause) =>
      clause.kind === "position"
        ? { kind: "position", axis: clause.axis }
        : {
            kind: "attr",
            key: clause.key,
            ...(clause.op === undefined ? {} : { op: clause.op }),
            ...(clause.value === undefined ? {} : { value: clause.value }),
          },
    ),
  };
}

function stringifyContextStructure(context: readonly ElementPath["context"][number][]): string {
  return context
    .map((hop) => `${hop.kind}:${stringifyNodeTagStructure(hop.host)}`)
    .join("/");
}

function stringifyNodeTagStructure(nodes: readonly PathNode[]): string {
  return nodes.map((node) => node.tag).join("/");
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
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

function joinDataPath(base: string, key: string): string {
  const normalizedBase = base.trim();
  const normalizedKey = key.trim();
  if (normalizedBase.length === 0) {
    return normalizedKey;
  }
  if (normalizedKey.length === 0) {
    return normalizedBase;
  }
  return `${normalizedBase}.${normalizedKey}`;
}

function parseDataPath(path: string): DataPathToken[] | null {
  const input = path.trim();
  if (input.length === 0) {
    return [];
  }
  if (input.includes("..") || input.startsWith(".") || input.endsWith(".")) {
    return null;
  }

  const tokens: DataPathToken[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === ".") {
      cursor += 1;
      continue;
    }

    if (char === "[") {
      const close = input.indexOf("]", cursor + 1);
      if (close === -1) {
        return null;
      }

      const rawIndex = input.slice(cursor + 1, close).trim();
      if (!/^\d+$/.test(rawIndex)) {
        return null;
      }

      tokens.push({
        kind: "index",
        index: Number.parseInt(rawIndex, 10),
      });
      cursor = close + 1;
      continue;
    }

    let end = cursor;
    while (end < input.length && input[end] !== "." && input[end] !== "[") {
      end += 1;
    }

    const key = input.slice(cursor, end).trim();
    if (key.length === 0) {
      return null;
    }

    tokens.push({
      kind: "prop",
      key,
    });
    cursor = end;
  }

  return tokens;
}

function inflateDataPathObject(flat: Readonly<Record<string, unknown>>): unknown {
  let root: unknown = {};
  let initialized = false;

  for (const [path, value] of Object.entries(flat)) {
    const tokens = parseDataPath(path);
    if (!tokens || tokens.length === 0) {
      continue;
    }

    if (!initialized) {
      root = tokens[0]?.kind === "index" ? [] : {};
      initialized = true;
    }

    assignDataPathValue(root, tokens, value);
  }

  return initialized ? root : {};
}

function assignDataPathValue(
  root: unknown,
  tokens: readonly DataPathToken[],
  value: unknown,
): void {
  let current: unknown = root;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const isLast = index === tokens.length - 1;
    if (!token) {
      return;
    }

    if (token.kind === "prop") {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return;
      }

      const objectRef = current as Record<string, unknown>;
      if (isLast) {
        objectRef[token.key] = value;
        return;
      }

      if (next?.kind === "index") {
        if (!Array.isArray(objectRef[token.key])) {
          objectRef[token.key] = [];
        }
      } else if (
        !objectRef[token.key] ||
        typeof objectRef[token.key] !== "object" ||
        Array.isArray(objectRef[token.key])
      ) {
        objectRef[token.key] = {};
      }

      current = objectRef[token.key];
      continue;
    }

    if (!Array.isArray(current)) {
      return;
    }
    if (isLast) {
      current[token.index] = value;
      return;
    }

    if (next?.kind === "index") {
      if (!Array.isArray(current[token.index])) {
        current[token.index] = [];
      }
    } else if (
      !current[token.index] ||
      typeof current[token.index] !== "object" ||
      Array.isArray(current[token.index])
    ) {
      current[token.index] = {};
    }

    current = current[token.index];
  }
}
