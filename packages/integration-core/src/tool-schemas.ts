import { integrationSchemaDigest, integrationToolSchemaDigest } from "./digest.js";
import type { IntegrationToolCatalog, IntegrationToolMaterial } from "./models.js";

type JsonSchemaObject = Readonly<Record<string, unknown>>;
type Definitions = Readonly<Record<string, JsonSchemaObject>>;

const definitionReferencePrefix = "#/$defs/";
const maximumToolTitleLength = 160;
const maximumToolDescriptionLength = 16_384;

/** The shared definition a `$ref` names, including a reference into one of its parts. */
function referencedDefinition(reference: string): string | undefined {
  if (!reference.startsWith(definitionReferencePrefix)) return undefined;
  const segment = reference.slice(definitionReferencePrefix.length).split("/", 1)[0];
  return segment?.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Every definition `roots` reach through `#/$defs/` references, transitively,
 * sorted. Names a catalog does not define are skipped: a dangling reference is
 * the provider's to fix and must not stop the tools that resolve.
 */
export function definitionClosure(
  roots: readonly unknown[],
  definitions: Definitions,
): readonly string[] {
  const reached = new Set<string>();
  // Iterative, because a provider's schema nesting is not bounded by our stack;
  // entries are queued one by one, because an enum can outnumber the arguments
  // one call may spread.
  const pending: unknown[] = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const name = typeof record.$ref === "string" ? referencedDefinition(record.$ref) : undefined;
      if (name !== undefined && !reached.has(name) && Object.hasOwn(definitions, name)) {
        reached.add(name);
        pending.push(definitions[name]);
      }
    }
    for (const entry of Object.values(value)) pending.push(entry);
  }
  return [...reached].sort();
}

export interface MaterializedIntegrationTool extends IntegrationToolMaterial {
  /** The shared definitions this tool's schemas reach. */
  readonly definitionNames: readonly string[];
  readonly schemaDigest: string;
}

/**
 * What the store persists for one scope: each tool with its definition closure
 * and digest, and only the definitions some tool reaches.
 */
export function materializeToolCatalog(catalog: IntegrationToolCatalog): {
  readonly definitions: Definitions;
  readonly tools: readonly MaterializedIntegrationTool[];
} {
  const shares = Object.keys(catalog.definitions).length > 0;
  const definitionDigests = new Map<string, string>();
  const digestOf = (name: string): string => {
    let digest = definitionDigests.get(name);
    if (digest === undefined) {
      digest = integrationSchemaDigest(catalog.definitions[name]);
      definitionDigests.set(name, digest);
    }
    return digest;
  };
  const reachable = new Set<string>();
  const tools = catalog.tools.map((tool): MaterializedIntegrationTool => {
    if (
      shares &&
      (Object.hasOwn(tool.inputSchema, "$defs") ||
        (tool.outputSchema !== null && Object.hasOwn(tool.outputSchema, "$defs")))
    ) {
      // Two places a `#/$defs/` reference could resolve make every reference ambiguous.
      throw new TypeError(`Tool ${tool.name} carries its own $defs in a catalog that shares them`);
    }
    const definitionNames = shares
      ? definitionClosure([tool.inputSchema, tool.outputSchema], catalog.definitions)
      : [];
    for (const name of definitionNames) reachable.add(name);
    return {
      ...tool,
      definitionNames,
      schemaDigest: integrationToolSchemaDigest({
        definitionDigests: Object.fromEntries(
          definitionNames.map((name) => [name, digestOf(name)] as const),
        ),
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }),
    };
  });
  return {
    definitions: Object.fromEntries(
      [...reachable].sort().map((name) => [name, catalog.definitions[name]!] as const),
    ),
    tools,
  };
}

/**
 * The digest of a stored tool, from its schemas and exactly the definitions its
 * closure names. Describe recomputes it so what it returns is provably what the
 * toolRef pinned.
 */
export function storedToolSchemaDigest(input: {
  readonly definitions: Definitions;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: JsonSchemaObject | null;
}): string {
  return integrationToolSchemaDigest({
    definitionDigests: Object.fromEntries(
      Object.keys(input.definitions).map(
        (name) => [name, integrationSchemaDigest(input.definitions[name])] as const,
      ),
    ),
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
  });
}

/**
 * One schema as a standalone JSON Schema: the shared definitions it reaches
 * attached under `$defs`, so each `$ref` resolves within the schema holding it,
 * just as in a schema an MCP server lists. `$defs` comes last so a reader
 * paging through the JSON meets the properties first.
 */
export function standaloneToolSchema(
  schema: JsonSchemaObject,
  definitions: Definitions,
): JsonSchemaObject {
  const names = definitionClosure([schema], definitions);
  if (names.length === 0) return schema;
  return {
    ...schema,
    $defs: Object.fromEntries(names.map((name) => [name, definitions[name]!] as const)),
  };
}

/** A provider's title, fit to what a tool row can be read back with. */
export function boundedToolTitle(title: string | undefined, name: string): string {
  const fitted = (title ?? "").trim().slice(0, maximumToolTitleLength).trim();
  return fitted || name.trim().slice(0, maximumToolTitleLength).trim() || "Tool";
}

/** A provider's description, fit to what a tool row can be read back with. */
export function boundedToolDescription(description: string | undefined): string {
  return (description ?? "").slice(0, maximumToolDescriptionLength);
}
