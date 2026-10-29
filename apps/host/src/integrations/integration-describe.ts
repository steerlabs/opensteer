import { standaloneToolSchema } from "@opensteer/integration-core/tool-schemas";

/**
 * Every integration_describe answer fits this many UTF-8 bytes: an engine
 * truncates a long tool result, and a cut schema reads as a complete one.
 */
export const maximumDescribeBytes = 32_000;

const maximumOperationDescriptionBytes = 8_000;
const maximumIntegrationDescriptionBytes = 2_000;
const maximumLabelBytes = 1_024;
const maximumAnnotationBytes = 2_000;
const hintAnnotations = new Set([
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
]);

type JsonObject = Readonly<Record<string, unknown>>;

/** Who and what one toolRef names, as the first page shows it. */
export interface DescribedOperation {
  readonly account: {
    readonly alias: string;
    readonly connectionId: string | null;
    readonly isDefault: boolean;
  };
  readonly integration: {
    readonly description: string;
    readonly name: string;
    readonly title: string;
    readonly trust: string;
  };
  readonly operation: {
    readonly annotations: JsonObject;
    readonly description: string;
    readonly name: string;
    readonly title: string;
  };
  readonly toolRef: string;
}

/** A stored tool's schemas in reference form and exactly the definitions they reach. */
export interface DescribedSchemas {
  readonly definitions: Readonly<Record<string, JsonObject>>;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject | null;
}

/**
 * One integration_describe answer: a JSON header line, then bytes `cursor` to
 * `nextCursor` (the end when null) of the compact JSON at `path` in
 * `{inputSchema, outputSchema}`, each schema standalone. Pages are cut on UTF-8
 * boundaries, so the bodies of every page of one path concatenate to exactly
 * that JSON. Only the first page of the whole document names the operation.
 */
export function renderIntegrationDescribe(input: {
  readonly cursor: number;
  readonly described: DescribedOperation;
  readonly path: string | undefined;
  readonly schemas: DescribedSchemas;
}): string {
  const { definitions, inputSchema, outputSchema } = input.schemas;
  const tokens = pointerTokens(input.path ?? "");
  const path = tokens.map((token) => `/${escapePointerToken(token)}`).join("");
  const selected = resolvePointer(
    {
      inputSchema: standaloneToolSchema(inputSchema, definitions),
      outputSchema: outputSchema === null ? null : standaloneToolSchema(outputSchema, definitions),
    },
    tokens,
    path,
  );
  const bytes = Buffer.from(JSON.stringify(selected), "utf8");
  const { cursor } = input;
  if (cursor > 0 && cursor >= bytes.length) {
    throw new Error(
      `cursor ${cursor} is past the end of the ${bytes.length}-byte JSON at path "${path}"; start again at 0`,
    );
  }
  if (isContinuationByte(bytes[cursor])) {
    throw new Error(
      `cursor ${cursor} is not a page boundary; pass a nextCursor this tool returned`,
    );
  }
  const operation = path === "" && cursor === 0 ? fittedOperation(input.described) : {};
  const narrower = narrowerPaths(selected, path);
  const header = (nextCursor: number | null) =>
    JSON.stringify({
      toolRef: input.described.toolRef,
      ...operation,
      path,
      schemaBytes: bytes.length,
      cursor,
      nextCursor,
      ...(nextCursor === null
        ? {}
        : {
            next: `This page is bytes ${cursor} to ${nextCursor}. Call integration_describe with this toolRef and path and cursor ${nextCursor} for the next page${
              narrower.length === 0
                ? ""
                : `, or read one part with a narrower path such as ${narrower.join(" or ")}`
            }.`,
          }),
    });
  // Sized for the longest header this page can carry: no next cursor reaches
  // the length, and the last page's header drops its sentence.
  const pageBytes = maximumDescribeBytes - Buffer.byteLength(header(bytes.length), "utf8") - 1;
  let end = Math.min(cursor + pageBytes, bytes.length);
  while (end < bytes.length && isContinuationByte(bytes[end])) end -= 1;
  if (end <= cursor) throw new Error("This operation's description leaves no room for its schema");
  return `${header(end === bytes.length ? null : end)}\n${bytes.subarray(cursor, end).toString("utf8")}`;
}

/** RFC 6901, accepting the `#` a `$ref` starts with, so a ref's own pointer works. */
function pointerTokens(path: string): readonly string[] {
  const pointer = path.startsWith("#") ? path.slice(1) : path;
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(
      `path "${path}" is not a JSON Pointer; start it with "/", as in "/inputSchema/properties"`,
    );
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?![01])/u.test(token)) {
        throw new Error(`path "${path}" has a "~" that is neither "~0" nor "~1"`);
      }
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function resolvePointer(document: unknown, tokens: readonly string[], path: string): unknown {
  let value = document;
  let reached = "";
  for (const token of tokens) {
    const next = Array.isArray(value)
      ? /^(?:0|[1-9][0-9]*)$/u.test(token)
        ? (value as readonly unknown[])[Number(token)]
        : undefined
      : typeof value === "object" && value !== null && Object.hasOwn(value, token)
        ? (value as JsonObject)[token]
        : undefined;
    if (next === undefined) {
      throw new Error(
        `path "${path}" is not in this operation's schemas: "${reached}" has no "${token}"`,
      );
    }
    value = next;
    reached = `${reached}/${escapePointerToken(token)}`;
  }
  return value;
}

/** Where to look instead of paging through a part: its properties, a definition, its items. */
function narrowerPaths(value: unknown, path: string): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as JsonObject;
  const definitions = record.$defs;
  const firstDefinition =
    typeof definitions === "object" && definitions !== null
      ? Object.keys(definitions)[0]
      : undefined;
  const preferred = [
    ...(Object.hasOwn(record, "properties") ? ["properties"] : []),
    ...(firstDefinition === undefined ? [] : [`$defs/${escapePointerToken(firstDefinition)}`]),
    ...(Object.hasOwn(record, "items") ? ["items"] : []),
  ];
  const chosen =
    preferred.length > 0 ? preferred : Object.keys(record).slice(0, 2).map(escapePointerToken);
  return chosen.slice(0, 2).map((suffix) => JSON.stringify(`${path}/${suffix}`));
}

/** The first page's account, integration and operation, bounded so a page always follows. */
function fittedOperation(described: DescribedOperation) {
  const { account, integration, operation } = described;
  return {
    account: {
      alias: fitted(account.alias, maximumLabelBytes),
      connectionId: account.connectionId,
      isDefault: account.isDefault,
    },
    integration: {
      description: fitted(integration.description, maximumIntegrationDescriptionBytes),
      name: fitted(integration.name, maximumLabelBytes),
      title: fitted(integration.title, maximumLabelBytes),
      trust: fitted(integration.trust, maximumLabelBytes),
    },
    operation: {
      annotations:
        jsonBytes(operation.annotations) <= maximumAnnotationBytes
          ? operation.annotations
          : Object.fromEntries(
              Object.entries(operation.annotations).filter(
                ([name, value]) => hintAnnotations.has(name) && typeof value === "boolean",
              ),
            ),
      description: fitted(operation.description, maximumOperationDescriptionBytes),
      name: fitted(operation.name, maximumLabelBytes),
      title: fitted(operation.title, maximumLabelBytes),
    },
  };
}

/** `text`, cut so its JSON string literal takes at most `maximumBytes`. */
function fitted(text: string, maximumBytes: number): string {
  if (jsonBytes(text) <= maximumBytes) return text;
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(`${characters.slice(0, middle).join("")}…`) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}…`;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
