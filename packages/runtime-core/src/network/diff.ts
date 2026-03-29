import type {
  NetworkDiffField,
  OpensteerNetworkDiffInput,
  OpensteerNetworkDiffOutput,
  NetworkQueryRecord,
} from "@opensteer/protocol";

import { headerValue, normalizeHeaderName } from "../requests/shared.js";

export function diffNetworkRecords(
  left: NetworkQueryRecord,
  right: NetworkQueryRecord,
  input: OpensteerNetworkDiffInput,
): OpensteerNetworkDiffOutput {
  const requestDiffs: NetworkDiffField[] = [];
  const responseDiffs: NetworkDiffField[] = [];
  const scope = input.scope ?? "all";

  if (scope === "headers" || scope === "all") {
    diffHeaderList(
      "requestHeaders",
      left.record.requestHeaders,
      right.record.requestHeaders,
      input.includeUnchanged ?? false,
      requestDiffs,
    );
    diffHeaderList(
      "responseHeaders",
      left.record.responseHeaders,
      right.record.responseHeaders,
      input.includeUnchanged ?? false,
      responseDiffs,
    );
  }

  if (scope === "all") {
    diffStringMap(
      "requestQuery",
      searchParamsToMap(new URL(left.record.url)),
      searchParamsToMap(new URL(right.record.url)),
      input.includeUnchanged ?? false,
      requestDiffs,
    );
    diffScalarField(
      "responseStatus",
      left.record.status,
      right.record.status,
      input.includeUnchanged ?? false,
      responseDiffs,
    );
    diffScalarField(
      "responseStatusText",
      left.record.statusText,
      right.record.statusText,
      input.includeUnchanged ?? false,
      responseDiffs,
    );
  }

  if (scope === "body" || scope === "all") {
    diffBody(
      "body",
      left.record.requestBody,
      left.record.requestHeaders,
      right.record.requestBody,
      right.record.requestHeaders,
      input.includeUnchanged ?? false,
      requestDiffs,
    );
    diffBody(
      "responseBody",
      left.record.responseBody,
      left.record.responseHeaders,
      right.record.responseBody,
      right.record.responseHeaders,
      input.includeUnchanged ?? false,
      responseDiffs,
    );
  }

  const summary = summarizeDiffs([...requestDiffs, ...responseDiffs]);
  return {
    summary,
    requestDiffs,
    responseDiffs,
  };
}

function diffHeaderList(
  prefix: string,
  left: readonly { readonly name: string; readonly value: string }[],
  right: readonly { readonly name: string; readonly value: string }[],
  includeUnchanged: boolean,
  output: NetworkDiffField[],
): void {
  const leftMap = groupHeaderValues(left);
  const rightMap = groupHeaderValues(right);
  diffStringMap(prefix, leftMap, rightMap, includeUnchanged, output);
}

function groupHeaderValues(
  headers: readonly { readonly name: string; readonly value: string }[],
): Readonly<Record<string, string>> {
  const values = new Map<string, string[]>();
  for (const header of headers) {
    const normalized = normalizeHeaderName(header.name);
    values.set(normalized, [...(values.get(normalized) ?? []), header.value]);
  }
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entries]) => [name, entries.join(", ")]),
  );
}

function searchParamsToMap(url: URL): Readonly<Record<string, string>> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of url.searchParams.entries()) {
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entries]) => [name, entries.join(", ")]),
  );
}

function diffBody(
  prefix: string,
  leftBody:
    | NetworkQueryRecord["record"]["requestBody"]
    | NetworkQueryRecord["record"]["responseBody"],
  leftHeaders: readonly { readonly name: string; readonly value: string }[],
  rightBody:
    | NetworkQueryRecord["record"]["requestBody"]
    | NetworkQueryRecord["record"]["responseBody"],
  rightHeaders: readonly { readonly name: string; readonly value: string }[],
  includeUnchanged: boolean,
  output: NetworkDiffField[],
): void {
  const leftParsed = parseBodyValue(leftBody, leftHeaders);
  const rightParsed = parseBodyValue(rightBody, rightHeaders);

  if (leftParsed.kind === "json" && rightParsed.kind === "json") {
    diffJsonValue(prefix, leftParsed.value, rightParsed.value, includeUnchanged, output);
    return;
  }

  diffScalarField(
    prefix,
    leftParsed.kind === "missing" ? undefined : leftParsed.text,
    rightParsed.kind === "missing" ? undefined : rightParsed.text,
    includeUnchanged,
    output,
  );
}

function parseBodyValue(
  body:
    | NetworkQueryRecord["record"]["requestBody"]
    | NetworkQueryRecord["record"]["responseBody"]
    | undefined,
  headers: readonly { readonly name: string; readonly value: string }[],
):
  | { readonly kind: "missing" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "json"; readonly text: string; readonly value: unknown } {
  if (body === undefined) {
    return { kind: "missing" };
  }

  const text = Buffer.from(body.data, "base64").toString(resolveBodyEncoding(body.charset));
  const contentType = headerValue(headers, "content-type") ?? body.mimeType;
  const normalizedContentType = contentType?.toLowerCase();
  const shouldParseJson =
    normalizedContentType?.includes("application/json") === true ||
    normalizedContentType?.includes("+json") === true ||
    looksLikeJson(text);
  if (!shouldParseJson) {
    return { kind: "text", text };
  }

  try {
    return {
      kind: "json",
      text,
      value: JSON.parse(text) as unknown,
    };
  } catch {
    return { kind: "text", text };
  }
}

function diffJsonValue(
  prefix: string,
  left: unknown,
  right: unknown,
  includeUnchanged: boolean,
  output: NetworkDiffField[],
): void {
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      diffJsonValue(`${prefix}.${key}`, left[key], right[key], includeUnchanged, output);
    }
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const maxLength = Math.max(left.length, right.length);
    for (let index = 0; index < maxLength; index += 1) {
      diffJsonValue(
        `${prefix}[${String(index)}]`,
        left[index],
        right[index],
        includeUnchanged,
        output,
      );
    }
    return;
  }

  diffScalarField(prefix, left, right, includeUnchanged, output);
}

function diffStringMap(
  prefix: string,
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
  includeUnchanged: boolean,
  output: NetworkDiffField[],
): void {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    diffScalarField(`${prefix}.${key}`, left[key], right[key], includeUnchanged, output);
  }
}

function diffScalarField(
  path: string,
  left: unknown,
  right: unknown,
  includeUnchanged: boolean,
  output: NetworkDiffField[],
): void {
  const leftValue = stringifyFieldValue(left);
  const rightValue = stringifyFieldValue(right);
  const kind =
    leftValue === undefined
      ? rightValue === undefined
        ? "unchanged"
        : "added"
      : rightValue === undefined
        ? "removed"
        : leftValue === rightValue
          ? "unchanged"
          : "changed";
  if (kind === "unchanged" && !includeUnchanged) {
    return;
  }

  output.push({
    path,
    kind,
    ...(leftValue === undefined ? {} : { leftValue }),
    ...(rightValue === undefined ? {} : { rightValue }),
    ...(leftValue === undefined && rightValue === undefined
      ? {}
      : {
          entropy: buildEntropy(leftValue, rightValue),
        }),
  });
}

function summarizeDiffs(
  fields: readonly NetworkDiffField[],
): OpensteerNetworkDiffOutput["summary"] {
  return fields.reduce<OpensteerNetworkDiffOutput["summary"]>(
    (summary, field) => ({
      added: summary.added + Number(field.kind === "added"),
      removed: summary.removed + Number(field.kind === "removed"),
      changed: summary.changed + Number(field.kind === "changed"),
      unchanged: summary.unchanged + Number(field.kind === "unchanged"),
      likelyEncryptedFields:
        summary.likelyEncryptedFields + Number(field.entropy?.likelyEncrypted === true),
    }),
    {
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
      likelyEncryptedFields: 0,
    },
  );
}

function stringifyFieldValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildEntropy(
  left: string | undefined,
  right: string | undefined,
): NonNullable<NetworkDiffField["entropy"]> {
  const leftEntropy = left === undefined ? undefined : shannonEntropy(left);
  const rightEntropy = right === undefined ? undefined : shannonEntropy(right);
  const likelyEncrypted =
    (leftEntropy !== undefined && leftEntropy >= 4.5) ||
    (rightEntropy !== undefined && rightEntropy >= 4.5) ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.length >= 16 &&
      looksOpaque(left) &&
      looksOpaque(right));

  return {
    ...(leftEntropy === undefined ? {} : { left: leftEntropy }),
    ...(rightEntropy === undefined ? {} : { right: rightEntropy }),
    likelyEncrypted,
  };
}

function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const bytes = Buffer.from(value, "utf8");
  const counts = new Map<number, number>();
  for (const byte of bytes) {
    counts.set(byte, (counts.get(byte) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / bytes.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function looksOpaque(value: string): boolean {
  return /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function resolveBodyEncoding(charset: string | undefined): BufferEncoding {
  switch (charset?.trim().toLowerCase()) {
    case "ascii":
    case "latin1":
    case "utf16le":
    case "utf-16le":
      return charset.replace("-", "").toLowerCase() as BufferEncoding;
    case "utf8":
    case "utf-8":
    default:
      return "utf8";
  }
}
