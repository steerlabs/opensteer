import {
  createBodyPayload,
  type BodyPayload,
  type HeaderEntry,
} from "@opensteer/browser-core";
import type {
  MinimizationFieldResult,
  NetworkQueryRecord,
} from "@opensteer/protocol";

import { headerValue, normalizeHeaderName } from "../requests/shared.js";

type MinimizationLocation = MinimizationFieldResult["location"];

interface NamedValueEntry {
  readonly name: string;
  readonly value: string;
}

interface MinimizationCandidate {
  readonly key: string;
  readonly name: string;
  readonly location: MinimizationLocation;
  readonly originalValue?: string;
  readonly preserved: boolean;
}

interface KeepState {
  readonly headers: Set<string>;
  readonly cookies: Set<string>;
  readonly query: Set<string>;
  readonly bodyFields: Set<string>;
}

export interface PreparedMinimizationRequest {
  readonly recordId: string;
  readonly method: string;
  readonly url: URL;
  readonly headers: readonly HeaderEntry[];
  readonly headerGroups: readonly NamedValueEntry[];
  readonly cookies: readonly NamedValueEntry[];
  readonly queryEntries: readonly NamedValueEntry[];
  readonly body?: BodyPayload;
  readonly bodyJsonEntries: readonly [string, unknown][];
  readonly bodyContentType?: string;
  readonly bodyEncoding?: BodyPayload["encoding"];
  readonly bodyCharset?: string;
  readonly bodyOriginalByteLength?: number;
}

export interface MaterializedMinimizationRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BodyPayload;
}

export interface PreparedRequestMinimizationResult {
  readonly totalTrials: number;
  readonly fields: readonly MinimizationFieldResult[];
  readonly minimizedRequest: MaterializedMinimizationRequest;
  readonly kept: {
    readonly headers: readonly string[];
    readonly cookies: readonly string[];
    readonly query: readonly string[];
    readonly bodyFields: readonly string[];
  };
}

export function prepareMinimizationRequest(
  record: NetworkQueryRecord,
  preserve: readonly string[] = [],
): PreparedMinimizationRequest {
  const requestUrl = new URL(record.record.url);
  const preservedNames = new Set(preserve.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  const headerGroups = groupNamedEntries(
    record.record.requestHeaders.filter((header) => normalizeHeaderName(header.name) !== "cookie"),
  );
  const cookies = parseCookieHeader(headerValue(record.record.requestHeaders, "cookie"));
  const queryEntries = groupNamedEntries(Array.from(requestUrl.searchParams.entries()).map(([name, value]) => ({
    name,
    value,
  })));
  const body = record.record.requestBody === undefined
    ? undefined
    : createBodyPayload(new Uint8Array(Buffer.from(record.record.requestBody.data, "base64")), {
        encoding: record.record.requestBody.encoding,
        ...(record.record.requestBody.mimeType === undefined
          ? {}
          : { mimeType: record.record.requestBody.mimeType }),
        ...(record.record.requestBody.charset === undefined
          ? {}
          : { charset: record.record.requestBody.charset }),
        truncated: record.record.requestBody.truncated,
        ...(record.record.requestBody.originalByteLength === undefined
          ? {}
          : { originalByteLength: record.record.requestBody.originalByteLength }),
      });
  const bodyContentType =
    headerValue(record.record.requestHeaders, "content-type") ?? record.record.requestBody?.mimeType;
  const bodyJsonEntries = parseJsonBodyEntries(body, bodyContentType);

  const initialKeepState: KeepState = {
    headers: new Set(headerGroups.map((header) => normalizeCandidateKey("header", header.name))),
    cookies: new Set(cookies.map((cookie) => normalizeCandidateKey("cookie", cookie.name))),
    query: new Set(queryEntries.map((entry) => normalizeCandidateKey("query", entry.name))),
    bodyFields: new Set(bodyJsonEntries.map(([name]) => normalizeCandidateKey("body-field", name))),
  };

  for (const name of preservedNames) {
    const headerKey = normalizeCandidateKey("header", name);
    if (initialKeepState.headers.has(headerKey)) {
      continue;
    }
    const cookieKey = normalizeCandidateKey("cookie", name);
    if (initialKeepState.cookies.has(cookieKey)) {
      continue;
    }
  }

  return {
    recordId: record.recordId,
    method: record.record.method,
    url: requestUrl,
    headers: record.record.requestHeaders,
    headerGroups,
    cookies,
    queryEntries,
    ...(body === undefined ? {} : { body }),
    bodyJsonEntries,
    ...(bodyContentType === undefined ? {} : { bodyContentType }),
    ...(body?.encoding === undefined ? {} : { bodyEncoding: body.encoding }),
    ...(body?.charset === undefined ? {} : { bodyCharset: body.charset }),
    ...(body?.originalByteLength === undefined
      ? {}
      : { bodyOriginalByteLength: body.originalByteLength }),
  };
}

export function materializePreparedMinimizationRequest(
  prepared: PreparedMinimizationRequest,
  keep: KeepState,
): MaterializedMinimizationRequest {
  const url = new URL(prepared.url.toString());
  url.search = "";
  for (const entry of prepared.queryEntries) {
    if (!keep.query.has(normalizeCandidateKey("query", entry.name))) {
      continue;
    }
    url.searchParams.append(entry.name, entry.value);
  }

  const headers = prepared.headerGroups
    .filter((header) => keep.headers.has(normalizeCandidateKey("header", header.name)))
    .map((header) => ({ name: header.name, value: header.value }));
  const cookieHeaderValue = buildCookieHeader(
    prepared.cookies.filter((cookie) => keep.cookies.has(normalizeCandidateKey("cookie", cookie.name))),
  );
  if (cookieHeaderValue !== undefined) {
    headers.push({
      name: "cookie",
      value: cookieHeaderValue,
    });
  }

  const body = buildMinimizedBody(prepared, keep);
  return {
    method: prepared.method,
    url: url.toString(),
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

export async function minimizePreparedRequest(input: {
  readonly prepared: PreparedMinimizationRequest;
  readonly preserve?: readonly string[];
  readonly maxTrials: number;
  readonly test: (request: MaterializedMinimizationRequest) => Promise<boolean>;
}): Promise<PreparedRequestMinimizationResult> {
  const preservedNames = new Set(
    (input.preserve ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  const keep: KeepState = {
    headers: new Set(input.prepared.headerGroups.map((header) => normalizeCandidateKey("header", header.name))),
    cookies: new Set(input.prepared.cookies.map((cookie) => normalizeCandidateKey("cookie", cookie.name))),
    query: new Set(input.prepared.queryEntries.map((entry) => normalizeCandidateKey("query", entry.name))),
    bodyFields: new Set(input.prepared.bodyJsonEntries.map(([name]) => normalizeCandidateKey("body-field", name))),
  };
  const candidates = collectCandidates(input.prepared, preservedNames);
  const results = new Map<string, MinimizationFieldResult>(
    candidates.map((candidate) => [
      candidate.key,
      {
        name: candidate.name,
        location: candidate.location,
        classification: candidate.preserved ? "untested" : "required",
        ...(candidate.originalValue === undefined ? {} : { originalValue: candidate.originalValue }),
      } satisfies MinimizationFieldResult,
    ]),
  );

  let totalTrials = 0;
  const remainingTrials = () => input.maxTrials - totalTrials;
  const runTrial = async (trialKeep: KeepState): Promise<boolean> => {
    totalTrials += 1;
    return input.test(materializePreparedMinimizationRequest(input.prepared, trialKeep));
  };

  for (const location of ["header", "cookie", "query", "body-field"] as const) {
    const locationCandidates = candidates.filter(
      (candidate) => candidate.location === location && !candidate.preserved,
    );
    await classifyCandidatesByLocation({
      location,
      candidates: locationCandidates,
      keep,
      results,
      remainingTrials,
      runTrial,
    });
  }

  for (const candidate of candidates) {
    if (candidate.preserved) {
      continue;
    }
    const result = results.get(candidate.key);
    if (result?.classification !== "required" || remainingTrials() <= 0) {
      continue;
    }
    const trialKeep = cloneKeepState(keep);
    deleteCandidateFromKeepState(trialKeep, candidate);
    if (await runTrial(trialKeep)) {
      applyCandidateClassification(keep, results, candidate, "optional");
    }
  }

  if (remainingTrials() <= 0) {
    for (const candidate of candidates) {
      const result = results.get(candidate.key);
      if (result !== undefined && result.classification === "required") {
        continue;
      }
      if (result !== undefined && result.classification === "optional") {
        continue;
      }
      results.set(candidate.key, {
        ...result!,
        classification: "untested",
      });
    }
  }

  const fields = candidates
    .map((candidate) => results.get(candidate.key)!)
    .sort((left, right) =>
      left.location === right.location
        ? left.name.localeCompare(right.name)
        : left.location.localeCompare(right.location),
    );

  return {
    totalTrials,
    fields,
    minimizedRequest: materializePreparedMinimizationRequest(input.prepared, keep),
    kept: {
      headers: input.prepared.headerGroups
        .map((header) => header.name)
        .filter((name) => keep.headers.has(normalizeCandidateKey("header", name))),
      cookies: input.prepared.cookies
        .map((cookie) => cookie.name)
        .filter((name) => keep.cookies.has(normalizeCandidateKey("cookie", name))),
      query: input.prepared.queryEntries
        .map((entry) => entry.name)
        .filter((name) => keep.query.has(normalizeCandidateKey("query", name))),
      bodyFields: input.prepared.bodyJsonEntries
        .map(([name]) => name)
        .filter((name) => keep.bodyFields.has(normalizeCandidateKey("body-field", name))),
    },
  };
}

async function classifyCandidatesByLocation(input: {
  readonly location: MinimizationLocation;
  readonly candidates: readonly MinimizationCandidate[];
  readonly keep: KeepState;
  readonly results: Map<string, MinimizationFieldResult>;
  readonly remainingTrials: () => number;
  readonly runTrial: (trialKeep: KeepState) => Promise<boolean>;
}): Promise<void> {
  const recurse = async (group: readonly MinimizationCandidate[]): Promise<void> => {
    if (group.length === 0) {
      return;
    }
    if (input.remainingTrials() <= 0) {
      for (const candidate of group) {
        input.results.set(candidate.key, {
          ...input.results.get(candidate.key)!,
          classification: "untested",
        });
      }
      return;
    }

    const trialKeep = cloneKeepState(input.keep);
    for (const candidate of group) {
      deleteCandidateFromKeepState(trialKeep, candidate);
    }
    if (await input.runTrial(trialKeep)) {
      for (const candidate of group) {
        applyCandidateClassification(input.keep, input.results, candidate, "optional");
      }
      return;
    }

    if (group.length === 1) {
      const candidate = group[0]!;
      input.results.set(candidate.key, {
        ...input.results.get(candidate.key)!,
        classification: "required",
      });
      return;
    }

    const midpoint = Math.ceil(group.length / 2);
    await recurse(group.slice(0, midpoint));
    await recurse(group.slice(midpoint));
  };

  await recurse(input.candidates);
}

function collectCandidates(
  prepared: PreparedMinimizationRequest,
  preservedNames: ReadonlySet<string>,
): readonly MinimizationCandidate[] {
  const candidates: MinimizationCandidate[] = [];

  for (const header of prepared.headerGroups) {
    candidates.push({
      key: normalizeCandidateKey("header", header.name),
      name: header.name,
      location: "header",
      originalValue: header.value,
      preserved: preservedNames.has(header.name.trim().toLowerCase()),
    });
  }
  for (const cookie of prepared.cookies) {
    candidates.push({
      key: normalizeCandidateKey("cookie", cookie.name),
      name: cookie.name,
      location: "cookie",
      originalValue: cookie.value,
      preserved: preservedNames.has(cookie.name.trim().toLowerCase()),
    });
  }
  for (const entry of prepared.queryEntries) {
    candidates.push({
      key: normalizeCandidateKey("query", entry.name),
      name: entry.name,
      location: "query",
      originalValue: entry.value,
      preserved: false,
    });
  }
  for (const [name, value] of prepared.bodyJsonEntries) {
    candidates.push({
      key: normalizeCandidateKey("body-field", name),
      name,
      location: "body-field",
      originalValue: stringifyBodyFieldValue(value),
      preserved: false,
    });
  }

  return candidates;
}

function applyCandidateClassification(
  keep: KeepState,
  results: Map<string, MinimizationFieldResult>,
  candidate: MinimizationCandidate,
  classification: MinimizationFieldResult["classification"],
): void {
  if (classification === "optional") {
    deleteCandidateFromKeepState(keep, candidate);
  }
  results.set(candidate.key, {
    ...results.get(candidate.key)!,
    classification,
  });
}

function deleteCandidateFromKeepState(keep: KeepState, candidate: MinimizationCandidate): void {
  switch (candidate.location) {
    case "header":
      keep.headers.delete(candidate.key);
      return;
    case "cookie":
      keep.cookies.delete(candidate.key);
      return;
    case "query":
      keep.query.delete(candidate.key);
      return;
    case "body-field":
      keep.bodyFields.delete(candidate.key);
      return;
  }
}

function cloneKeepState(keep: KeepState): KeepState {
  return {
    headers: new Set(keep.headers),
    cookies: new Set(keep.cookies),
    query: new Set(keep.query),
    bodyFields: new Set(keep.bodyFields),
  };
}

function groupNamedEntries(
  entries: readonly { readonly name: string; readonly value: string }[],
): readonly NamedValueEntry[] {
  const grouped = new Map<string, { readonly name: string; values: string[] }>();
  for (const entry of entries) {
    const key = normalizeHeaderName(entry.name);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, {
        name: entry.name,
        values: [entry.value],
      });
      continue;
    }
    current.values.push(entry.value);
  }
  return [...grouped.values()].map((entry) => ({
    name: entry.name,
    value: entry.values.join(", "),
  }));
}

function parseCookieHeader(value: string | undefined): readonly NamedValueEntry[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  const cookies = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const cookieValue = trimmed.slice(separator + 1).trim();
    cookies.set(name, [...(cookies.get(name) ?? []), cookieValue]);
  }
  return [...cookies.entries()].map(([name, values]) => ({
    name,
    value: values.join(", "),
  }));
}

function buildCookieHeader(cookies: readonly NamedValueEntry[]): string | undefined {
  if (cookies.length === 0) {
    return undefined;
  }
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function parseJsonBodyEntries(
  body: BodyPayload | undefined,
  contentType: string | undefined,
): readonly [string, unknown][] {
  if (body === undefined) {
    return [];
  }
  const decoded = Buffer.from(body.bytes).toString(resolveBodyEncoding(body.charset));
  const shouldParseJson =
    contentType?.toLowerCase().includes("json") === true ||
    looksLikeJson(decoded);
  if (!shouldParseJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(decoded) as unknown;
    if (!isPlainObject(parsed)) {
      return [];
    }
    return Object.entries(parsed);
  } catch {
    return [];
  }
}

function buildMinimizedBody(
  prepared: PreparedMinimizationRequest,
  keep: KeepState,
): BodyPayload | undefined {
  if (prepared.bodyJsonEntries.length === 0) {
    return prepared.body;
  }

  const entries = prepared.bodyJsonEntries.filter(([name]) =>
    keep.bodyFields.has(normalizeCandidateKey("body-field", name)),
  );
  if (entries.length === 0) {
    return undefined;
  }
  const json = JSON.stringify(Object.fromEntries(entries));
  return createBodyPayload(new TextEncoder().encode(json), {
    encoding: prepared.bodyEncoding ?? "identity",
    mimeType: prepared.bodyContentType?.split(";")[0]?.trim() || "application/json",
    charset: prepared.bodyCharset ?? "utf-8",
    ...(prepared.bodyOriginalByteLength === undefined
      ? {}
      : { originalByteLength: prepared.bodyOriginalByteLength }),
  });
}

function stringifyBodyFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function normalizeCandidateKey(location: MinimizationLocation, name: string): string {
  if (location === "header" || location === "cookie") {
    return `${location}:${name.trim().toLowerCase()}`;
  }
  return `${location}:${name}`;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
