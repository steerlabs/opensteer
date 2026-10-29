// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/extract.ts (MIT).
import type { AdapterToolCatalog, AdapterToolDefinition } from "@opensteer/integration-core";
import { asRecord } from "../shared.js";
import type { OpenApiAdapterConfig, OpenApiToolTarget, OperationSelector } from "./config.js";
import { planLegacyOpenApiToolNames, planOpenApiToolNames } from "./definitions.js";
import type { OpenApiDocument } from "./parse.js";
import type {
  HttpMethod,
  OpenApiMediaBinding,
  OpenApiOperation,
  OpenApiParameter,
} from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;
const PARAMETER_LOCATIONS = new Set(["path", "query", "header", "cookie"]);

function pointerValue(document: OpenApiDocument, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let cursor: unknown = document;
  for (const encoded of pointer.slice(2).split("/")) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[encoded.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return cursor;
}

function resolveRecord(
  document: OpenApiDocument,
  value: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return typeof record.$ref === "string" ? asRecord(pointerValue(document, record.$ref)) : record;
}

function hoistSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hoistSchema);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string" && entry.startsWith("#/components/schemas/")
        ? entry.replace("#/components/schemas/", "#/$defs/")
        : hoistSchema(entry),
    ]),
  );
}

function sharedDefinitions(document: OpenApiDocument): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(asRecord(asRecord(document.components)?.schemas) ?? {}).flatMap(
      ([name, schema]) => {
        // A boolean schema keeps its meaning as the object form a definition must take.
        const hoisted =
          typeof schema === "boolean" ? (schema ? {} : { not: {} }) : hoistSchema(schema);
        const record = asRecord(hoisted);
        return record ? [[name, record] as const] : [];
      },
    ),
  );
}

function extractParameters(
  document: OpenApiDocument,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): OpenApiParameter[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const raw of [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]) {
    const parameter = resolveRecord(document, raw);
    if (!parameter || typeof parameter.name !== "string" || typeof parameter.in !== "string")
      continue;
    if (!PARAMETER_LOCATIONS.has(parameter.in)) continue;
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...merged.values()].map((parameter) => ({
    name: parameter.name as string,
    location: parameter.in as OpenApiParameter["location"],
    required: parameter.in === "path" || parameter.required === true,
    schema: parameter.schema ?? { type: "string" },
    ...(typeof parameter.style === "string" ? { style: parameter.style } : {}),
    ...(typeof parameter.explode === "boolean" ? { explode: parameter.explode } : {}),
    ...(typeof parameter.allowReserved === "boolean"
      ? { allowReserved: parameter.allowReserved }
      : {}),
    ...(typeof parameter.description === "string" ? { description: parameter.description } : {}),
  }));
}

function extractRequestBody(
  document: OpenApiDocument,
  operation: Record<string, unknown>,
): OpenApiOperation["requestBody"] {
  const body = resolveRecord(document, operation.requestBody);
  const content = asRecord(body?.content);
  if (!body || !content) return undefined;
  const contents: OpenApiMediaBinding[] = [];
  for (const [contentType, raw] of Object.entries(content)) {
    const media = asRecord(raw);
    if (!media) continue;
    contents.push({
      contentType,
      schema: media.schema ?? { type: "object" },
      ...(asRecord(media.encoding)
        ? {
            encoding: Object.fromEntries(
              Object.entries(asRecord(media.encoding)!).flatMap(([name, encoding]) => {
                const record = asRecord(encoding);
                return record ? [[name, record] as const] : [];
              }),
            ),
          }
        : {}),
    });
  }
  return contents.length ? { contents, required: body.required === true } : undefined;
}

function successOutputSchema(
  document: OpenApiDocument,
  operation: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const responses = asRecord(operation.responses);
  if (!responses) return undefined;
  const success = Object.entries(responses)
    .filter(([status]) => /^2(?:\d\d|xx)$/iu.test(status))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [, raw] of success) {
    const response = resolveRecord(document, raw);
    const content = asRecord(response?.content);
    if (!content) continue;
    const preferred =
      Object.entries(content).find(([type]) => type.includes("json")) ?? Object.entries(content)[0];
    const media = preferred ? asRecord(preferred[1]) : undefined;
    if (media?.schema === undefined) continue;
    const schema = asRecord(hoistSchema(media.schema));
    // In an OpenAPI document `#/$defs/` names the document's root, so a response schema's own
    // root `$defs` is reachable by no reference; dropping it leaves one meaning per reference.
    return schema && Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$defs"));
  }
  return undefined;
}

function stringArray(value: string | readonly string[] | undefined): readonly string[] | undefined {
  return value === undefined ? undefined : typeof value === "string" ? [value] : value;
}

function wildcardMatches(pattern: string, value: string): boolean {
  const expression = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${expression}$`, "u").test(value);
}

function selectorMatches(
  selector: OperationSelector,
  candidate: { method: HttpMethod; operationId: string; path: string; tags: readonly string[] },
): boolean {
  const operationIds = stringArray(selector.operationId);
  const paths = stringArray(selector.path);
  const tags = stringArray(selector.tag);
  const methods = stringArray(selector.method);
  return (
    (!operationIds ||
      operationIds.some((pattern) => wildcardMatches(pattern, candidate.operationId))) &&
    (!paths || paths.some((pattern) => wildcardMatches(pattern, candidate.path))) &&
    (!tags || tags.some((tag) => candidate.tags.includes(tag))) &&
    (!methods || methods.includes(candidate.method))
  );
}

function included(
  config: OpenApiAdapterConfig,
  candidate: Parameters<typeof selectorMatches>[1],
): boolean {
  const include = config.operationFilter?.include;
  const exclude = config.operationFilter?.exclude;
  return (
    (!include?.length || include.some((selector) => selectorMatches(selector, candidate))) &&
    !exclude?.some((selector) => selectorMatches(selector, candidate))
  );
}

function decodedPointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function referencedComponents(
  root: unknown,
  document: OpenApiDocument,
): Record<string, Record<string, unknown>> {
  const retained: Record<string, Record<string, unknown>> = {};
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const reference = typeof record.$ref === "string" ? record.$ref : undefined;
    if (reference?.startsWith("#/components/") && !seen.has(reference)) {
      seen.add(reference);
      const segments = reference.slice(2).split("/").map(decodedPointerSegment);
      const section = segments[1];
      const name = segments[2];
      const referenced = pointerValue(document, reference);
      if (section && name && referenced !== undefined) {
        (retained[section] ??= {})[name] = structuredClone(referenced);
        visit(referenced);
      }
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(root);
  return retained;
}

/**
 * Persist only operations admitted by the definition plus their transitive
 * component references. Invocation never needs an unrelated provider path.
 */
export function pruneOpenApiDocument(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
): OpenApiDocument {
  const retainedPaths: Record<string, Record<string, unknown>> = {};
  for (const { method, operation, path, pathItem } of indexOpenApiOperations(document, config)) {
    const retained = (retainedPaths[path] ??= Object.fromEntries(
      (["description", "parameters", "servers", "summary"] as const).flatMap((field) =>
        pathItem[field] === undefined ? [] : [[field, structuredClone(pathItem[field])] as const],
      ),
    ));
    retained[method] = structuredClone(operation);
  }
  const pruned: OpenApiDocument = {
    openapi: document.openapi,
    paths: retainedPaths,
  };
  for (const field of [
    "externalDocs",
    "info",
    "jsonSchemaDialect",
    "security",
    "servers",
    "tags",
  ] as const) {
    if (document[field] !== undefined) pruned[field] = structuredClone(document[field]);
  }
  const components = referencedComponents(pruned, document);
  return Object.keys(components).length ? { ...pruned, components } : pruned;
}

function serverUrls(...levels: unknown[]): string[] {
  for (const level of levels) {
    if (!Array.isArray(level)) continue;
    const servers = level.flatMap((raw) => {
      const server = asRecord(raw);
      return typeof server?.url === "string" ? [server.url] : [];
    });
    if (servers.length) return servers;
  }
  return [];
}

function operationIdOf(
  method: HttpMethod,
  path: string,
  operation: Record<string, unknown>,
): string {
  return typeof operation.operationId === "string" && operation.operationId.trim()
    ? operation.operationId
    : `${method}_${path.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")}`;
}

function operationTags(operation: Record<string, unknown>): readonly string[] {
  return Array.isArray(operation.tags)
    ? operation.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
}

interface OpenApiOperationEntry {
  readonly method: HttpMethod;
  readonly name: string;
  readonly operation: Record<string, unknown>;
  readonly operationId: string;
  readonly path: string;
  readonly pathItem: Record<string, unknown>;
}

type AdmittedOperation = Omit<OpenApiOperationEntry, "name"> & { readonly tag?: string };

function admittedOperations(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
): readonly AdmittedOperation[] {
  const paths = asRecord(document.paths);
  if (!paths) throw new TypeError("OpenAPI document has no paths defined");
  const admitted: AdmittedOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(paths).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const pathItem = resolveRecord(document, rawPathItem);
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = resolveRecord(document, pathItem[method]);
      if (!operation) continue;
      const operationId = operationIdOf(method, path, operation);
      const tags = operationTags(operation);
      if (!included(config, { method, operationId, path, tags })) continue;
      admitted.push({
        method,
        operation,
        operationId,
        path,
        pathItem,
        ...(tags[0] ? { tag: tags[0] } : {}),
      });
    }
  }
  return admitted;
}

/**
 * Every admitted operation and its tool name, read without building a schema.
 * A name depends on which operations are admitted (colliding names gain their
 * method), so discovery and pruning read this one index; a call finds its
 * operation by the target its tool stored, never by a name.
 */
function indexOpenApiOperations(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
): readonly OpenApiOperationEntry[] {
  const admitted = admittedOperations(document, config);
  const names = planOpenApiToolNames(admitted);
  return admitted.map(({ method, operation, operationId, path, pathItem }, index) => ({
    method,
    name: names[index]!,
    operation,
    operationId,
    path,
    pathItem,
  }));
}

function bindOperation(document: OpenApiDocument, entry: OpenApiOperationEntry): OpenApiOperation {
  const requestBody = extractRequestBody(document, entry.operation);
  return {
    method: entry.method,
    name: entry.name,
    operationId: entry.operationId,
    parameters: extractParameters(document, entry.pathItem, entry.operation),
    path: entry.path,
    ...(requestBody ? { requestBody } : {}),
    servers: serverUrls(entry.operation.servers, entry.pathItem.servers, document.servers),
  };
}

/** The top-level arguments an operation's tool schema declares. */
/**
 * Whether a `contentType` argument picks the request body's media type. A
 * declared parameter of that name keeps it, and one media type needs no pick.
 */
export function selectsBodyMediaType(
  operation: Pick<OpenApiOperation, "parameters" | "requestBody">,
): boolean {
  return (
    (operation.requestBody?.contents.length ?? 0) > 1 &&
    !operation.parameters.some(({ name }) => name === "contentType")
  );
}

export function openApiArgumentNames(operation: OpenApiOperation): readonly string[] {
  return [
    ...new Set([
      ...operation.parameters.map(({ name }) => name),
      ...(operation.requestBody ? ["body"] : []),
      ...(selectsBodyMediaType(operation) ? ["contentType"] : []),
    ]),
  ];
}

function operationTool(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
  entry: OpenApiOperationEntry,
): AdapterToolDefinition {
  const { parameters, requestBody } = bindOperation(document, entry);
  const properties: Record<string, unknown> = Object.fromEntries(
    parameters.map((parameter) => [
      parameter.name,
      {
        ...asRecord(hoistSchema(parameter.schema)),
        ...(parameter.description ? { description: parameter.description } : {}),
      },
    ]),
  );
  const required = parameters
    .filter((parameter) => parameter.required)
    .map((parameter) => parameter.name);
  if (requestBody) {
    properties.body = hoistSchema(requestBody.contents[0]!.schema);
    if (requestBody.required) required.push("body");
    if (selectsBodyMediaType({ parameters, requestBody })) {
      properties.contentType = {
        default: requestBody.contents[0]!.contentType,
        enum: requestBody.contents.map((content) => content.contentType),
        type: "string",
      };
    }
  }
  const { method, operation, operationId, path } = entry;
  const outputSchema = successOutputSchema(document, operation);
  const readOnly =
    ["get", "head", "options", "trace"].includes(method) ||
    config.readOnlyOperationIds?.includes(operationId) === true;
  return {
    annotations: readOnly
      ? { destructiveHint: false, readOnlyHint: true }
      : { readOnlyHint: false },
    description:
      (typeof operation.description === "string" && operation.description) ||
      (typeof operation.summary === "string" && operation.summary) ||
      `${method.toUpperCase()} ${path}`,
    inputSchema: {
      type: "object",
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    },
    name: entry.name,
    ...(outputSchema ? { outputSchema } : {}),
    target: { method, path } satisfies OpenApiToolTarget,
  };
}

/**
 * Every admitted operation as a tool. Tool schemas name component schemas as
 * `#/$defs/<name>`; the components themselves are returned once, as the
 * catalog's definitions.
 */
export function extractOpenApiTools(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
): AdapterToolCatalog {
  return {
    definitions: sharedDefinitions(document),
    tools: indexOpenApiOperations(document, config).map((entry) =>
      operationTool(document, config, entry),
    ),
  };
}

/** The admitted operation `matches` selects, bound without building any tool schema. */
export function findOpenApiOperation(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
  matches: (operation: {
    readonly method: HttpMethod;
    readonly name: string;
    readonly operationId: string;
    readonly path: string;
  }) => boolean,
): OpenApiOperation | undefined {
  const entry = indexOpenApiOperations(document, config).find(matches);
  return entry && bindOperation(document, entry);
}

/**
 * The operation each name 0.1.131 gave a tool runs, for binding tools stored
 * under those names. A name it gave two operations names neither.
 */
export function legacyOpenApiToolTargets(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
): ReadonlyMap<string, OpenApiToolTarget> {
  const admitted = admittedOperations(document, config);
  const names = planLegacyOpenApiToolNames(admitted);
  const targets = new Map<string, OpenApiToolTarget | null>();
  names.forEach((name, index) => {
    const { method, path } = admitted[index]!;
    targets.set(name, targets.has(name) ? null : { method, path });
  });
  return new Map(
    [...targets].flatMap(([name, target]) => (target === null ? [] : [[name, target] as const])),
  );
}

/** Credential routing uses exactly the operations admitted for invocation. */
export function openApiOperations(document: OpenApiDocument, config: OpenApiAdapterConfig) {
  return indexOpenApiOperations(document, config).map((entry) => bindOperation(document, entry));
}

/** Proposal checks are authenticated, bounded reads; catalog checks remain unrestricted. */
export function validateProposedOpenApiCheck(
  document: OpenApiDocument,
  config: OpenApiAdapterConfig,
  check: {
    readonly operationId: string;
    readonly args?: Readonly<Record<string, unknown>> | undefined;
  },
  credentialScheme: string,
): void {
  const entries = indexOpenApiOperations(document, config).filter(
    ({ operationId }) => operationId === check.operationId,
  );
  if (entries.length !== 1 || entries[0]?.operation.operationId !== check.operationId)
    throw new Error("Check must name exactly one document operation");
  const entry = entries[0]!;
  const operation = bindOperation(document, entry);
  if (!["get", "head"].includes(operation.method) || entry.operation.requestBody !== undefined) {
    throw new Error("A proposal check must use GET or HEAD without a request body");
  }
  const security =
    entry.operation.security === undefined ? document.security : entry.operation.security;
  if (
    !Array.isArray(security) ||
    security.length === 0 ||
    security.some((alternative) => {
      const requirement = asRecord(alternative);
      return (
        !requirement ||
        Object.keys(requirement).length !== 1 ||
        !Array.isArray(requirement[credentialScheme]) ||
        requirement[credentialScheme].length !== 0
      );
    })
  ) {
    throw new Error(
      "A proposal check must require the proposal credential in every security alternative",
    );
  }
  const args = check.args ?? {};
  if (new TextEncoder().encode(JSON.stringify(args)).byteLength > 4_096)
    throw new Error("Check arguments must not exceed 4096 bytes");
  const parameters = operation.parameters.filter(
    ({ location }) => location === "path" || location === "query",
  );
  for (const [name, value] of Object.entries(args)) {
    if (
      !parameters.some((parameter) => parameter.name === name) ||
      operation.parameters.some(
        (parameter) => parameter.name === name && !parameters.includes(parameter),
      )
    )
      throw new Error("Check arguments must bind exclusively to query or path parameters");
    if (!(Array.isArray(value) ? value.every(isJsonScalar) : isJsonScalar(value)))
      throw new Error("Check arguments must be JSON scalars or arrays of scalars");
  }
  for (const parameter of operation.parameters) {
    if (
      parameter.required &&
      (!Object.hasOwn(args, parameter.name) || !parameters.includes(parameter))
    )
      throw new Error(
        "Every required check parameter must be supplied as a query or path argument",
      );
  }
}

function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
