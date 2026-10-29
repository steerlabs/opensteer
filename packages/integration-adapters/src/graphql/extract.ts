// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/graphql/src/sdk/extract.ts (MIT).
import type { AdapterToolCatalog, AdapterToolDefinition } from "@opensteer/integration-core";
import type { GraphqlAdapterConfig } from "./config.js";
import type {
  IntrospectionField,
  IntrospectionInputValue,
  IntrospectionResult,
  IntrospectionType,
  IntrospectionTypeRef,
} from "./introspection.js";

/** One admitted root field, as calling it needs it. */
export interface GraphqlOperation {
  readonly field: IntrospectionField;
  readonly kind: "mutation" | "query";
}

function typeName(ref: IntrospectionTypeRef): string {
  return ref.name ?? (ref.ofType ? typeName(ref.ofType) : "Unknown");
}

function formatType(ref: IntrospectionTypeRef): string {
  if (ref.kind === "NON_NULL") return `${ref.ofType ? formatType(ref.ofType) : "Unknown"}!`;
  if (ref.kind === "LIST") return `[${ref.ofType ? formatType(ref.ofType) : "Unknown"}]`;
  return ref.name ?? "Unknown";
}

function scalarSchema(name: string): Record<string, unknown> {
  if (name === "Int") return { type: "integer" };
  if (name === "Float") return { type: "number" };
  if (name === "Boolean") return { type: "boolean" };
  if (["ID", "String"].includes(name)) return { type: "string" };
  return { type: "string", description: `Custom scalar: ${name}` };
}

function refSchema(ref: IntrospectionTypeRef): Record<string, unknown> {
  if (ref.kind === "NON_NULL") return ref.ofType ? refSchema(ref.ofType) : {};
  if (ref.kind === "LIST") return { type: "array", items: ref.ofType ? refSchema(ref.ofType) : {} };
  if (ref.kind === "SCALAR") return scalarSchema(ref.name ?? "String");
  if (["ENUM", "INPUT_OBJECT"].includes(ref.kind) && ref.name)
    return { $ref: `#/$defs/${ref.name}` };
  return { type: "object" };
}

function definitions(
  types: ReadonlyMap<string, IntrospectionType>,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, type] of types) {
    if (name.startsWith("__")) continue;
    if (type.kind === "ENUM" && type.enumValues) {
      result[name] = { type: "string", enum: type.enumValues.map((entry) => entry.name) };
    }
    if (type.kind === "INPUT_OBJECT" && type.inputFields) {
      const properties = Object.fromEntries(
        type.inputFields.map((field) => [
          field.name,
          {
            ...refSchema(field.type),
            ...(field.description ? { description: field.description } : {}),
          },
        ]),
      );
      const required = type.inputFields
        .filter((field) => field.type.kind === "NON_NULL")
        .map((field) => field.name);
      result[name] = {
        type: "object",
        properties,
        additionalProperties: false,
        ...(required.length ? { required } : {}),
      };
    }
  }
  return result;
}

function inputSchema(args: readonly IntrospectionInputValue[]): Record<string, unknown> {
  const properties: Record<string, unknown> = Object.fromEntries(
    args.map((argument) => [
      argument.name,
      {
        ...refSchema(argument.type),
        ...(argument.description ? { description: argument.description } : {}),
      },
    ]),
  );
  if (!Object.hasOwn(properties, "select")) {
    properties.select = {
      type: "string",
      description: "Optional GraphQL selection set for the returned object.",
    };
  }
  const required = args
    .filter((argument) => argument.type.kind === "NON_NULL" && argument.defaultValue === null)
    .map((argument) => argument.name);
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };
}

function operationIncluded(config: GraphqlAdapterConfig, name: string, fieldName: string): boolean {
  const include = config.operationFilter?.include;
  return !include || include.includes(name) || include.includes(fieldName);
}

function isComposite(
  ref: IntrospectionTypeRef,
  types: ReadonlyMap<string, IntrospectionType>,
): boolean {
  return ["INTERFACE", "OBJECT", "UNION"].includes(types.get(typeName(ref))?.kind ?? "");
}

function defaultSelection(
  ref: IntrospectionTypeRef,
  types: ReadonlyMap<string, IntrospectionType>,
): string {
  const type = types.get(typeName(ref));
  if (!type?.fields || !isComposite(ref, types)) return "";
  const leaves = type.fields
    .filter(
      (field) =>
        !field.name.startsWith("__") &&
        !field.args.some(
          (argument) => argument.type.kind === "NON_NULL" && argument.defaultValue === null,
        ) &&
        !isComposite(field.type, types),
    )
    .map((field) => field.name);
  return `{ ${leaves.length ? leaves.join(" ") : "__typename"} }`;
}

function operationString(
  kind: "mutation" | "query",
  field: IntrospectionField,
  types: ReadonlyMap<string, IntrospectionType>,
  customSelection?: string,
): string {
  const name = `${field.name[0]?.toUpperCase() ?? ""}${field.name.slice(1)}`;
  const variables = field.args.map((argument) => `$${argument.name}: ${formatType(argument.type)}`);
  const passes = field.args.map((argument) => `${argument.name}: $${argument.name}`);
  // The newline ends a `#` comment the selection may close with, so the braces after it count.
  const selection = customSelection?.trim()
    ? `{ ${customSelection.trim()}\n}`
    : defaultSelection(field.type, types);
  return `${kind} ${name}${variables.length ? `(${variables.join(", ")})` : ""} { ${field.name}${passes.length ? `(${passes.join(", ")})` : ""}${selection ? ` ${selection}` : ""} }`;
}

function typesByName(introspection: IntrospectionResult): Map<string, IntrospectionType> {
  return new Map(introspection.__schema.types.map((type) => [type.name, type]));
}

/**
 * Every admitted root field as a tool. Tool schemas name input objects and
 * enums as `#/$defs/<name>`; those types are returned once, as the catalog's
 * definitions.
 */
export function extractGraphqlTools(
  introspection: IntrospectionResult,
  config: GraphqlAdapterConfig,
): AdapterToolCatalog {
  const types = typesByName(introspection);
  const tools: AdapterToolDefinition[] = [];
  for (const kind of ["query", "mutation"] as const) {
    const rootName =
      kind === "query"
        ? introspection.__schema.queryType?.name
        : introspection.__schema.mutationType?.name;
    const root = rootName ? types.get(rootName) : undefined;
    for (const field of root?.fields ?? []) {
      if (field.name.startsWith("__")) continue;
      const name = `${kind}.${field.name}`;
      if (!operationIncluded(config, name, field.name)) continue;
      tools.push({
        annotations:
          kind === "mutation"
            ? { readOnlyHint: false }
            : { destructiveHint: false, readOnlyHint: true },
        description: field.description ?? `GraphQL ${kind} ${field.name}`,
        inputSchema: inputSchema(field.args),
        name,
      });
    }
  }
  return { definitions: definitions(types), tools };
}

/** The admitted root field a tool name (`query.<field>` or `mutation.<field>`) names. */
export function findGraphqlOperation(
  introspection: IntrospectionResult,
  config: GraphqlAdapterConfig,
  toolName: string,
): GraphqlOperation | undefined {
  const separator = toolName.indexOf(".");
  const kind = toolName.slice(0, Math.max(separator, 0));
  const fieldName = toolName.slice(separator + 1);
  if (kind !== "query" && kind !== "mutation") return undefined;
  if (fieldName.startsWith("__") || !operationIncluded(config, toolName, fieldName)) {
    return undefined;
  }
  const rootName =
    kind === "query"
      ? introspection.__schema.queryType?.name
      : introspection.__schema.mutationType?.name;
  const field = introspection.__schema.types
    .find((type) => type.name === rootName)
    ?.fields?.find((candidate) => candidate.name === fieldName);
  return field && { field, kind };
}

/** Retain only admitted root operations and the types reachable from them. */
export function pruneGraphqlIntrospection(
  introspection: IntrospectionResult,
  config: GraphqlAdapterConfig,
): IntrospectionResult {
  const types = typesByName(introspection);
  const queryRoot = introspection.__schema.queryType?.name ?? null;
  const mutationRoot = introspection.__schema.mutationType?.name ?? null;
  const rootNames = new Set([queryRoot, mutationRoot].filter((name): name is string => !!name));
  const retainedNames = new Set(rootNames);
  const retainedRootFields = new Map<string, readonly IntrospectionField[]>();
  const visitRef = (reference: IntrospectionTypeRef): void => {
    if (reference.name) visitType(reference.name);
    if (reference.ofType) visitRef(reference.ofType);
  };
  const visitField = (field: IntrospectionField): void => {
    visitRef(field.type);
    for (const argument of field.args) visitRef(argument.type);
  };
  const visitType = (name: string): void => {
    if (retainedNames.has(name)) return;
    retainedNames.add(name);
    const type = types.get(name);
    if (!type) return;
    for (const field of type.fields ?? []) visitField(field);
    for (const input of type.inputFields ?? []) visitRef(input.type);
  };
  for (const [kind, rootName] of [
    ["query", queryRoot],
    ["mutation", mutationRoot],
  ] as const) {
    if (!rootName) continue;
    const fields = (types.get(rootName)?.fields ?? []).filter((field) =>
      operationIncluded(config, `${kind}.${field.name}`, field.name),
    );
    retainedRootFields.set(rootName, fields);
    for (const field of fields) visitField(field);
  }
  return {
    __schema: {
      mutationType: introspection.__schema.mutationType,
      queryType: introspection.__schema.queryType,
      types: introspection.__schema.types.flatMap((type) => {
        if (!retainedNames.has(type.name)) return [];
        return rootNames.has(type.name)
          ? [{ ...type, fields: retainedRootFields.get(type.name) ?? [] }]
          : [type];
      }),
    },
  };
}

export function graphqlOperationText(
  operation: GraphqlOperation,
  introspection: IntrospectionResult,
  select: string | undefined,
): string {
  return operationString(operation.kind, operation.field, typesByName(introspection), select);
}
