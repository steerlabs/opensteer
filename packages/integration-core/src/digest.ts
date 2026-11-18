import { createHash } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

/**
 * Increment when adapter materialization semantics change without changing a
 * declarative catalog definition. This makes existing built-in installations
 * reconcile instead of retaining stale generated tools forever.
 */
export const integrationDefinitionMaterializationVersion = 1;

export function integrationSchemaDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

/**
 * What identifies a stored tool's shape: its schemas and each shared definition they reach,
 * named with that definition's own digest. Hashing a definition once however
 * many tools reach it keeps the cost to the size of the catalog. A tool that
 * reaches none hashes exactly as `{inputSchema, outputSchema}` always has.
 */
export function integrationToolSchemaDigest(input: {
  /** Exactly the tool's definition closure, by name. */
  readonly definitionDigests: Readonly<Record<string, string>>;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}): string {
  const { definitionDigests, inputSchema, outputSchema } = input;
  return Object.keys(definitionDigests).length === 0
    ? integrationSchemaDigest({ inputSchema, outputSchema })
    : integrationSchemaDigest({ definitions: definitionDigests, inputSchema, outputSchema });
}

export function integrationDefinitionDigest(definition: unknown): string {
  return integrationSchemaDigest({
    definition,
    materializationVersion: integrationDefinitionMaterializationVersion,
  });
}

/**
 * What a Mac's approval of an MCP server pins: the exact launch it showed.
 * The Runner runs a launch only while its digest is the one approved there.
 */
export function localMcpLaunchDigest(launch: unknown): string {
  return integrationSchemaDigest({ launch, localMcpLaunch: 1 });
}
