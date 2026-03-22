import type {
  NetworkQueryRecord,
  OpensteerBodyCodecDescriptor,
  OpensteerChannelDescriptor,
  OpensteerExecutableResolverKind,
  OpensteerExecutableResolver,
  OpensteerReverseAdvisorySignals,
  OpensteerReverseAdvisoryTag,
  OpensteerReverseConstraintKind,
  OpensteerRequestInputClassification,
  OpensteerRequestInputDescriptor,
  OpensteerRequestInputExportPolicy,
  OpensteerRequestInputMaterializationPolicy,
  OpensteerRequestInputSource,
  OpensteerReverseAdvisoryTemplate,
  OpensteerReverseCandidateBoundary,
  OpensteerReverseGuardRecord,
  OpensteerReverseTargetHints,
  OpensteerStateSourceKind,
  TransportKind,
} from "@opensteer/protocol";

import { headerValue, normalizeHeaderName } from "../requests/shared.js";
import { isManagedRequestHeaderName } from "./materialization.js";

const TELEMETRY_HOST_PATTERNS = [
  "google-analytics",
  "doubleclick",
  "datadog",
  "newrelic",
  "sentry",
  "segment",
  "amplitude",
  "fullstory",
  "cookieinformation",
];

const TELEMETRY_PATH_PATTERNS = [
  "/telemetry",
  "/metrics",
  "/analytics",
  "/beacon",
  "/log",
  "/batch",
  "/events",
  "/collect",
  "/pixel",
  "/consent",
  "/cookie",
  "/cookies",
];

const DATA_PATH_PATTERNS = [
  "/api/",
  "/graphql",
  "/search",
  "/query",
  "/track",
  "/tracking",
  "/container",
  "/product",
  "/products",
  "/items",
  "/listing",
];

const FACET_PATH_PATTERNS = ["/facet", "/facets", "/filters", "/suggest"];
const SUBSCRIPTION_PATH_PATTERNS = ["/subscribe", "/subscription", "/stream", "/live"];
const LOW_SIGNAL_CONTENT_PATH_PATTERNS = [
  "/i18n/",
  "/translations/",
  "/translation/",
  "/locales/",
  "/content/",
  "/cms/",
  "/assets/",
];

const ANTI_BOT_NAME_PATTERNS = [
  "akamai",
  "datadome",
  "cf-",
  "turnstile",
  "captcha",
  "bm-",
  "bm_",
  "x-client-transaction-id",
];

const CONTEXTUAL_NAME_PATTERNS = [
  "authorization",
  "cookie",
  "csrf",
  "xsrf",
  "session",
  "token",
  "auth",
  "guest",
];

export interface ReverseAnalysisResult {
  readonly boundary: OpensteerReverseCandidateBoundary;
  readonly advisoryTags: readonly OpensteerReverseAdvisoryTag[];
  readonly constraints: readonly OpensteerReverseConstraintKind[];
  readonly signals: OpensteerReverseAdvisorySignals;
  readonly channel: OpensteerChannelDescriptor;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly summary: string;
  readonly matchedTargetHints: readonly string[];
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly advisoryTemplates: readonly OpensteerReverseAdvisoryTemplate[];
}

type ReverseCandidateRole =
  | "primary-data"
  | "facet-data"
  | "telemetry"
  | "subscription"
  | "navigation"
  | "unknown";

type ReverseCandidateDependencyClass =
  | "portable"
  | "browser-state"
  | "script-signed"
  | "behavior-gated"
  | "anti-bot"
  | "blocked";

const ROLE_PRIORITY: Readonly<Record<ReverseCandidateRole, number>> = {
  "primary-data": 5,
  "facet-data": 4,
  unknown: 3,
  subscription: 2,
  navigation: 1,
  telemetry: 0,
};

const BOUNDARY_PRIORITY: Readonly<Record<OpensteerReverseCandidateBoundary, number>> = {
  "first-party": 2,
  "same-site": 1,
  "third-party": 0,
};

interface RequestBodyFieldEntry {
  readonly name: string;
  readonly path: string;
  readonly value: string;
}

export function analyzeReverseCandidate(input: {
  readonly observationId: string;
  readonly record: NetworkQueryRecord;
  readonly observationUrl?: string;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards?: readonly OpensteerReverseGuardRecord[];
  readonly scriptArtifactIds?: readonly string[];
  readonly targetHints?: OpensteerReverseTargetHints;
}): ReverseAnalysisResult {
  const channel = buildChannelDescriptor(input.record);
  const bodyAnalysis = describeReverseBodyCodec(input.record);
  const inputs = buildInputDescriptors(
    input.record,
    input.observationId,
    input.guards ?? [],
    bodyAnalysis.fields,
  );
  const boundary = classifyBoundary(channel.url, input.observationUrl);
  const role = classifyRole(input.record, channel, bodyAnalysis.codec);
  const matchedTargetHints = matchReverseTargetHints(
    channel,
    bodyAnalysis.codec,
    input.targetHints,
  );
  const dependencyClass = classifyDependency(inputs, input.guards ?? [], bodyAnalysis.codec);
  const advisoryTags = buildAdvisoryTags({
    record: input.record,
    channel,
    role,
  });
  const constraints = buildConstraints({
    inputs,
    guards: input.guards ?? [],
    stateSource: input.stateSource,
    dependencyClass,
    codec: bodyAnalysis.codec,
  });
  const signals = buildRankingSignals(
    input.record,
    role,
    dependencyClass,
    boundary,
    bodyAnalysis.codec,
    matchedTargetHints,
    input.targetHints !== undefined,
    inputs,
    input.guards ?? [],
  );
  const resolvers = buildResolvers(
    inputs,
    input.guards ?? [],
    input.scriptArtifactIds ?? [],
    input.stateSource,
  );
  const advisoryTemplates = buildCandidateTemplates({
    observationId: input.observationId,
    channel,
    inputs,
    dependencyClass,
    stateSource: input.stateSource,
    guards: input.guards ?? [],
    resolvers,
    ...(input.observationUrl === undefined ? {} : { observationUrl: input.observationUrl }),
  });

  return {
    boundary,
    advisoryTags,
    constraints,
    signals,
    channel,
    bodyCodec: bodyAnalysis.codec,
    summary: buildSummary(channel, advisoryTags, constraints, bodyAnalysis.codec),
    matchedTargetHints,
    inputs,
    resolvers,
    advisoryTemplates,
  };
}

export function buildChannelDescriptor(record: NetworkQueryRecord): OpensteerChannelDescriptor {
  const subprotocol = headerValue(record.record.requestHeaders, "sec-websocket-protocol");
  return {
    kind:
      record.record.kind === "http"
        ? "http"
        : record.record.kind === "event-stream"
          ? "event-stream"
          : "websocket",
    recordKind: record.record.kind,
    method: record.record.method,
    url: record.record.url,
    ...(subprotocol === undefined ? {} : { subprotocol }),
  };
}

export function describeReverseBodyCodec(record: NetworkQueryRecord): {
  readonly codec: OpensteerBodyCodecDescriptor;
  readonly fields: readonly RequestBodyFieldEntry[];
} {
  const requestContentType = normalizeContentType(
    headerValue(record.record.requestHeaders, "content-type"),
  );
  const channel = record.record.kind;
  if (channel === "event-stream") {
    return {
      codec: {
        kind: "sse",
        ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
        fieldPaths: [],
      },
      fields: [],
    };
  }
  if (channel === "websocket") {
    return {
      codec: {
        kind: inferWebSocketCodec(record),
        fieldPaths: [],
      },
      fields: [],
    };
  }

  const bodyText = decodeBodyText(record.record.requestBody);
  if (bodyText === undefined || bodyText.length === 0) {
    return {
      codec: {
        kind:
          requestContentType === undefined ? "unknown" : inferCodecWithoutBody(requestContentType),
        ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
        fieldPaths: [],
      },
      fields: [],
    };
  }

  if (requestContentType?.includes("application/json") === true || looksLikeJson(bodyText)) {
    const json = safeJsonParse(bodyText);
    if (json !== undefined) {
      const operationName =
        typeof (json as { operationName?: unknown }).operationName === "string"
          ? (json as { operationName: string }).operationName
          : undefined;
      const graphQuery =
        typeof (json as { query?: unknown }).query === "string"
          ? (json as { query: string }).query
          : undefined;
      const persistedQuery =
        json !== null &&
        typeof json === "object" &&
        !Array.isArray(json) &&
        "extensions" in (json as Record<string, unknown>) &&
        isPersistedGraphqlExtensions((json as Record<string, unknown>).extensions);
      const fields = flattenBodyEntries(json, "body");
      return {
        codec: {
          kind:
            graphQuery !== undefined ? (persistedQuery ? "persisted-graphql" : "graphql") : "json",
          ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
          ...(operationName === undefined ? {} : { operationName }),
          fieldPaths: fields.map((field) => field.path),
        },
        fields,
      };
    }
  }

  if (requestContentType?.includes("application/x-www-form-urlencoded") === true) {
    const params = new URLSearchParams(bodyText);
    const fields = [...params.entries()].map(([name, value]) => ({
      name,
      path: `body.${name}`,
      value,
    }));
    return {
      codec: {
        kind: "form-urlencoded",
        contentType: requestContentType,
        fieldPaths: fields.map((field) => field.path),
      },
      fields,
    };
  }

  if (requestContentType?.includes("multipart/form-data") === true) {
    const fields = parseMultipartFields(bodyText);
    return {
      codec: {
        kind: "multipart",
        contentType: requestContentType,
        fieldPaths: fields.map((field) => field.path),
      },
      fields,
    };
  }

  if (isOpaqueBinaryContentType(requestContentType)) {
    return {
      codec: {
        kind: "opaque-binary",
        ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
        fieldPaths: [],
      },
      fields: [],
    };
  }

  return {
    codec: {
      kind: "text",
      ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
      fieldPaths: [],
    },
    fields: [],
  };
}

function classifyBoundary(
  candidateUrl: string,
  observationUrl: string | undefined,
): OpensteerReverseCandidateBoundary {
  if (observationUrl === undefined) {
    return "third-party";
  }
  const candidateHost = new URL(candidateUrl).hostname;
  const observationHost = new URL(observationUrl).hostname;
  if (candidateHost === observationHost) {
    return "first-party";
  }
  if (registrableDomain(candidateHost) === registrableDomain(observationHost)) {
    return "same-site";
  }
  return "third-party";
}

function registrableDomain(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

function classifyRole(
  record: NetworkQueryRecord,
  channel: OpensteerChannelDescriptor,
  codec: OpensteerBodyCodecDescriptor,
): ReverseCandidateRole {
  const url = channel.url.toLowerCase();
  const hostname = new URL(channel.url).hostname.toLowerCase();
  if (
    TELEMETRY_HOST_PATTERNS.some((pattern) => hostname.includes(pattern)) ||
    TELEMETRY_PATH_PATTERNS.some((pattern) => url.includes(pattern))
  ) {
    return "telemetry";
  }
  if (LOW_SIGNAL_CONTENT_PATH_PATTERNS.some((pattern) => url.includes(pattern))) {
    return "unknown";
  }
  if (
    channel.kind !== "http" ||
    SUBSCRIPTION_PATH_PATTERNS.some((pattern) => url.includes(pattern)) ||
    codec.kind === "sse"
  ) {
    return "subscription";
  }
  if (FACET_PATH_PATTERNS.some((pattern) => url.includes(pattern))) {
    return "facet-data";
  }
  if (record.record.resourceType === "document") {
    return "navigation";
  }
  return "primary-data";
}

function buildAdvisoryTags(input: {
  readonly record: NetworkQueryRecord;
  readonly channel: OpensteerChannelDescriptor;
  readonly role: ReverseCandidateRole;
}): readonly OpensteerReverseAdvisoryTag[] {
  const tags = new Set<OpensteerReverseAdvisoryTag>();
  switch (input.role) {
    case "primary-data":
      tags.add("data");
      break;
    case "facet-data":
      tags.add("facet");
      break;
    case "telemetry":
      tags.add("telemetry");
      break;
    case "subscription":
      tags.add("subscription");
      break;
    case "navigation":
      tags.add("navigation");
      break;
    default:
      tags.add("unknown");
      break;
  }
  if (input.record.record.resourceType === "document") {
    tags.add("document");
  }
  const url = input.channel.url.toLowerCase();
  if (url.includes("/search") || url.includes("query=") || url.includes("&q=")) {
    tags.add("search");
  }
  if (url.includes("/tracking") || url.includes("/track")) {
    tags.add("tracking");
  }
  if (input.record.record.resourceType === "document" || url.includes("_rsc=")) {
    tags.add("route-data");
  }
  return [...tags].sort((left, right) => left.localeCompare(right));
}

export function matchReverseTargetHints(
  channel: OpensteerChannelDescriptor,
  codec: OpensteerBodyCodecDescriptor,
  targetHints: OpensteerReverseTargetHints | undefined,
): readonly string[] {
  if (targetHints === undefined) {
    return [];
  }
  const matches = new Set<string>();
  const url = new URL(channel.url);
  for (const host of targetHints.hosts ?? []) {
    if (url.hostname === host || url.hostname.endsWith(`.${host}`)) {
      matches.add(`host:${host}`);
    }
  }
  for (const path of targetHints.paths ?? []) {
    if (url.pathname.includes(path)) {
      matches.add(`path:${path}`);
    }
  }
  for (const operationName of targetHints.operationNames ?? []) {
    if (codec.operationName === operationName) {
      matches.add(`operation:${operationName}`);
    }
  }
  for (const channelKind of targetHints.channels ?? []) {
    if (channel.kind === channelKind) {
      matches.add(`channel:${channelKind}`);
    }
  }
  return [...matches].sort((left, right) => left.localeCompare(right));
}

function buildRankingSignals(
  record: NetworkQueryRecord,
  role: ReverseCandidateRole,
  dependencyClass: ReverseCandidateDependencyClass,
  boundary: OpensteerReverseCandidateBoundary,
  codec: OpensteerBodyCodecDescriptor,
  matchedTargetHints: readonly string[],
  hasTargetHints: boolean,
  inputs: readonly OpensteerRequestInputDescriptor[],
  guards: readonly OpensteerReverseGuardRecord[],
): OpensteerReverseAdvisorySignals {
  let score = 0;
  if (
    record.record.status !== undefined &&
    record.record.status >= 200 &&
    record.record.status < 400
  ) {
    score += 25;
  }
  if (record.record.resourceType === "fetch" || record.record.resourceType === "xhr") {
    score += 20;
  } else if (
    record.record.resourceType === "event-stream" ||
    record.record.resourceType === "websocket"
  ) {
    score += 14;
  }
  if (DATA_PATH_PATTERNS.some((pattern) => record.record.url.toLowerCase().includes(pattern))) {
    score += 16;
  }
  if (matchedTargetHints.length > 0) {
    score += Math.min(32, matchedTargetHints.length * 12);
  } else if (hasTargetHints) {
    score -= 18;
  }
  if (codec.kind === "graphql" || codec.kind === "persisted-graphql") {
    score += 10;
  } else if (
    codec.kind === "json" ||
    codec.kind === "form-urlencoded" ||
    codec.kind === "multipart"
  ) {
    score += 7;
  }
  if (record.record.responseBody !== undefined) {
    score += 8;
  }
  if (headerValue(record.record.responseHeaders, "content-type")?.toLowerCase().includes("json")) {
    score += 8;
  }
  if (boundary !== "third-party") {
    score += 5;
  }
  if (role === "primary-data") {
    score += 8;
  }
  if (role === "telemetry") {
    score -= 85;
  }
  if (role === "facet-data") {
    score -= 12;
  }
  if (role === "unknown") {
    score -= 18;
  }
  if (role === "navigation") {
    score -= 30;
  }
  if (
    LOW_SIGNAL_CONTENT_PATH_PATTERNS.some((pattern) =>
      record.record.url.toLowerCase().includes(pattern),
    )
  ) {
    score -= 20;
  }
  if (dependencyClass === "portable") {
    score += 14;
  }
  if (dependencyClass === "blocked") {
    score -= 50;
  }
  return {
    advisoryRank: Math.max(0, Math.min(100, score)),
    targetHintMatches: matchedTargetHints.length,
    responseRichness: computeResponseRichness(record, codec),
    portabilityWeight: portabilityWeight(dependencyClass),
    boundaryWeight: BOUNDARY_PRIORITY[boundary],
    successfulStatus:
      record.record.status !== undefined &&
      record.record.status >= 200 &&
      record.record.status < 400,
    fetchLike: record.record.resourceType === "fetch" || record.record.resourceType === "xhr",
    hasResponseBody: record.record.responseBody !== undefined,
    dataPathMatch: DATA_PATH_PATTERNS.some((pattern) =>
      record.record.url.toLowerCase().includes(pattern),
    ),
    cookieInputCount: inputs.filter((input) => input.location === "cookie").length,
    storageInputCount: inputs.filter((input) => input.source === "storage").length,
    volatileInputCount: inputs.filter((input) => input.classification === "volatile").length,
    guardCount: guards.length,
  };
}

export function compareReverseAnalysisResults(
  left: Pick<
    ReverseAnalysisResult,
    "signals" | "matchedTargetHints" | "boundary" | "advisoryTags"
  >,
  right: Pick<
    ReverseAnalysisResult,
    "signals" | "matchedTargetHints" | "boundary" | "advisoryTags"
  >,
): number {
  return (
    right.signals.advisoryRank - left.signals.advisoryRank ||
    right.signals.targetHintMatches - left.signals.targetHintMatches ||
    right.signals.portabilityWeight - left.signals.portabilityWeight ||
    right.signals.responseRichness - left.signals.responseRichness ||
    BOUNDARY_PRIORITY[right.boundary] - BOUNDARY_PRIORITY[left.boundary] ||
    advisoryTagPriority(right.advisoryTags) - advisoryTagPriority(left.advisoryTags)
  );
}

function buildInputDescriptors(
  record: NetworkQueryRecord,
  observationId: string,
  guards: readonly OpensteerReverseGuardRecord[],
  bodyFields: readonly RequestBodyFieldEntry[],
): OpensteerRequestInputDescriptor[] {
  const url = new URL(record.record.url);
  const inputs: OpensteerRequestInputDescriptor[] = [];
  const guardIds = guards.map((guard) => guard.id);

  for (const [name, value] of url.searchParams.entries()) {
    inputs.push(
      createInputDescriptor({
        name,
        location: "query",
        originalValue: value,
        observationId,
        sourcePointer: `query.${name}`,
        guardIds,
      }),
    );
  }

  for (const header of record.record.requestHeaders) {
    if (normalizeHeaderName(header.name) === "cookie") {
      for (const cookie of parseCookieHeader(header.value)) {
        inputs.push(
          createInputDescriptor({
            name: cookie.name,
            location: "cookie",
            originalValue: cookie.value,
            observationId,
            sourcePointer: `cookie.${cookie.name}`,
            guardIds,
          }),
        );
      }
      continue;
    }

    inputs.push(
      createInputDescriptor({
        name: header.name,
        location: "header",
        originalValue: header.value,
        observationId,
        sourcePointer: `header.${header.name}`,
        guardIds,
      }),
    );
  }

  for (const field of bodyFields) {
    inputs.push(
      createInputDescriptor({
        name: field.name,
        location: "body-field",
        path: field.path,
        originalValue: field.value,
        observationId,
        sourcePointer: field.path,
        guardIds,
      }),
    );
  }

  return dedupeInputs(inputs);
}

function createInputDescriptor(input: {
  readonly name: string;
  readonly location: OpensteerRequestInputDescriptor["location"];
  readonly path?: string;
  readonly originalValue?: string;
  readonly observationId: string;
  readonly sourcePointer: string;
  readonly guardIds: readonly string[];
}): OpensteerRequestInputDescriptor {
  const normalizedName = normalizeHeaderName(input.name);
  const classification = classifyInput(normalizedName, input.originalValue, input.location);
  const source = classifyInputSource(normalizedName, classification, input.location);
  const materializationPolicy = classifyMaterializationPolicy(
    normalizedName,
    classification,
    input.location,
  );
  const exportPolicy = classifyExportPolicy(classification, input.location);

  return {
    name: input.name,
    location: input.location,
    ...(input.path === undefined ? {} : { path: input.path }),
    requiredness:
      classification === "managed"
        ? "optional"
        : input.location === "body-field"
          ? "unknown"
          : "required",
    classification,
    source,
    materializationPolicy,
    exportPolicy,
    ...(input.originalValue === undefined ? {} : { originalValue: input.originalValue }),
    provenance: {
      observationId: input.observationId,
      sourcePointer: input.sourcePointer,
    },
    ...(input.guardIds.length === 0 ? {} : { unlockedByGuardIds: input.guardIds }),
  };
}

function classifyInput(
  normalizedName: string,
  value: string | undefined,
  location: OpensteerRequestInputDescriptor["location"],
): OpensteerRequestInputClassification {
  if (location === "header" && isManagedRequestHeaderName(normalizedName, "page-http")) {
    return "managed";
  }
  if (
    ANTI_BOT_NAME_PATTERNS.some((pattern) => normalizedName.includes(pattern)) ||
    looksHighEntropy(value)
  ) {
    return "volatile";
  }
  if (
    location === "cookie" ||
    CONTEXTUAL_NAME_PATTERNS.some((pattern) => normalizedName.includes(pattern))
  ) {
    return "contextual";
  }
  return "static";
}

function classifyInputSource(
  normalizedName: string,
  classification: OpensteerRequestInputClassification,
  location: OpensteerRequestInputDescriptor["location"],
): OpensteerRequestInputSource {
  if (classification === "managed") {
    return "runtime-managed";
  }
  if (location === "cookie") {
    return "cookie";
  }
  if (classification === "contextual") {
    return "page";
  }
  if (classification === "volatile") {
    return normalizedName.includes("token") || normalizedName.includes("transaction")
      ? "script"
      : "unknown";
  }
  return "literal";
}

function classifyMaterializationPolicy(
  normalizedName: string,
  classification: OpensteerRequestInputClassification,
  location: OpensteerRequestInputDescriptor["location"],
): OpensteerRequestInputMaterializationPolicy {
  if (classification === "managed") {
    return normalizedName === "content-length" ? "recompute" : "omit";
  }
  if (classification === "volatile") {
    return "resolve";
  }
  if (location === "cookie" || classification === "contextual") {
    return "resolve";
  }
  return "copy";
}

function classifyExportPolicy(
  classification: OpensteerRequestInputClassification,
  location: OpensteerRequestInputDescriptor["location"],
): OpensteerRequestInputExportPolicy {
  if (classification === "volatile") {
    return "blocked";
  }
  if (classification === "contextual" || location === "cookie") {
    return "browser-bound";
  }
  return "portable";
}

function classifyDependency(
  inputs: readonly OpensteerRequestInputDescriptor[],
  guards: readonly OpensteerReverseGuardRecord[],
  codec: OpensteerBodyCodecDescriptor,
): ReverseCandidateDependencyClass {
  if (codec.kind === "opaque-binary") {
    return "blocked";
  }
  if (guards.length > 0) {
    return "behavior-gated";
  }
  if (inputs.some((input) => input.classification === "volatile")) {
    return inputs.some((input) => input.source === "script") ? "script-signed" : "anti-bot";
  }
  if (
    inputs.some((input) => input.classification === "contextual" || input.location === "cookie")
  ) {
    return "browser-state";
  }
  return "portable";
}

function buildConstraints(input: {
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateSource: OpensteerStateSourceKind;
  readonly dependencyClass: ReverseCandidateDependencyClass;
  readonly codec: OpensteerBodyCodecDescriptor;
}): readonly OpensteerReverseConstraintKind[] {
  const constraints = new Set<OpensteerReverseConstraintKind>();
  if (input.codec.kind === "opaque-binary") {
    constraints.add("opaque-body");
    constraints.add("unsupported");
  }
  if (input.guards.length > 0) {
    constraints.add("requires-guard");
    constraints.add("requires-browser");
  }
  if (input.inputs.some((entry) => entry.location === "cookie")) {
    constraints.add("requires-cookie");
    constraints.add("requires-browser");
  }
  if (
    input.inputs.some(
      (entry) => entry.classification === "contextual" || entry.source === "storage",
    )
  ) {
    constraints.add("requires-storage");
    constraints.add("requires-browser");
  }
  if (input.inputs.some((entry) => entry.source === "script")) {
    constraints.add("requires-script");
    constraints.add("requires-browser");
  }
  if (input.inputs.some((entry) => entry.classification === "volatile")) {
    constraints.add("requires-browser");
  }
  if (input.stateSource === "attach-live") {
    constraints.add("requires-live-state");
  }
  if (
    input.dependencyClass === "anti-bot" ||
    input.dependencyClass === "behavior-gated" ||
    input.dependencyClass === "script-signed"
  ) {
    constraints.add("requires-live-state");
  }
  if (input.dependencyClass === "blocked") {
    constraints.add("unsupported");
  }
  return [...constraints].sort((left, right) => left.localeCompare(right));
}

function buildResolvers(
  inputs: readonly OpensteerRequestInputDescriptor[],
  guards: readonly OpensteerReverseGuardRecord[],
  scriptArtifactIds: readonly string[],
  stateSource: OpensteerStateSourceKind,
): OpensteerExecutableResolver[] {
  const resolvers: OpensteerExecutableResolver[] = [];
  for (const input of inputs) {
    if (input.materializationPolicy !== "resolve") {
      continue;
    }

    const scriptBacked = input.source === "script";
    const guardBacked =
      input.unlockedByGuardIds !== undefined && input.unlockedByGuardIds.length > 0;
    const cookieBacked = input.location === "cookie";
    const runtimeManaged = input.source === "runtime-managed";
    const resolverKind: OpensteerExecutableResolverKind = runtimeManaged
      ? "runtime-managed"
      : cookieBacked
        ? "cookie"
        : scriptBacked
          ? scriptArtifactIds[0] === undefined
            ? "manual"
            : "artifact"
          : guardBacked
            ? "manual"
            : input.classification === "contextual"
              ? "storage"
              : "literal";
    const status = classifyResolverStatus({
      resolverKind,
      guardBacked,
      scriptBacked,
      guards,
      stateSource,
      hasScriptArtifact: scriptArtifactIds[0] !== undefined,
    });

    resolvers.push({
      id: `resolver:${input.location}:${input.name}`,
      kind: resolverKind,
      label: `Resolve ${input.location} ${input.name}`,
      status,
      requiresBrowser:
        resolverKind === "storage" ||
        resolverKind === "artifact" ||
        guardBacked ||
        stateSource === "attach-live",
      requiresLiveState:
        guardBacked || stateSource === "attach-live",
      inputNames: [input.name],
      description: resolverKind === "runtime-managed"
        ? "Generated by the request materializer."
        : guardBacked
          ? "Derived from a recorded unlock interaction."
          : scriptBacked
            ? "Derived from a captured script or signer."
            : resolverKind === "storage"
              ? "Resolved from live browser state at replay time."
              : "Resolved directly from the captured value.",
      ...(input.unlockedByGuardIds?.[0] === undefined
        ? {}
        : { guardId: input.unlockedByGuardIds[0] }),
      valueRef:
        resolverKind === "runtime-managed"
          ? {
              kind: "manual",
              placeholder: "materialized by runtime",
            }
          : resolverKind === "cookie"
            ? {
                kind: "state-snapshot",
                ...(input.provenance?.sourcePointer === undefined
                  ? {}
                  : { pointer: input.provenance.sourcePointer }),
              }
            : resolverKind === "storage"
              ? {
                  kind: "state-snapshot",
                  ...(input.provenance?.sourcePointer === undefined
                    ? {}
                    : { pointer: input.provenance.sourcePointer }),
                }
              : resolverKind === "artifact" && scriptArtifactIds[0] !== undefined
                ? {
                    kind: "artifact",
                    artifactId: scriptArtifactIds[0],
                    ...(input.provenance?.sourcePointer === undefined
                      ? {}
                      : { pointer: input.provenance.sourcePointer }),
                  }
                : guardBacked
                  ? {
                      kind: "manual",
                      placeholder: `satisfy guard ${input.unlockedByGuardIds?.[0] ?? input.name}`,
                    }
                  : {
                      kind: "literal",
                      ...(input.originalValue === undefined ? {} : { value: input.originalValue }),
                    },
    });
  }
  return dedupeResolvers(resolvers);
}

function buildCandidateTemplates(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: ReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReverseAdvisoryTemplate[] {
  switch (input.channel.kind) {
    case "http":
      return buildHttpTemplates(input);
    case "event-stream":
      return buildEventStreamTemplates(input);
    case "websocket":
      return buildWebSocketTemplates(input);
  }
}

function buildHttpTemplates(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: ReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReverseAdvisoryTemplate[] {
  switch (input.dependencyClass) {
    case "portable":
      return [
        createCandidateTemplate("direct", "direct-http", input.stateSource, "ready", input),
        createCandidateTemplate("page", "page-http", input.stateSource, "ready", input),
      ];
    case "browser-state":
      return withObservationTemplate(
        [
          createCandidateTemplate("page", "page-http", "snapshot-authenticated", "ready", input),
          createCandidateTemplate("session", "session-http", "snapshot-authenticated", "ready", input),
          createCandidateTemplate("attach", "page-http", "attach-live", "ready", input),
        ],
        input,
      );
    case "behavior-gated":
      return withObservationTemplate(
        [
          createCandidateTemplate("guarded-page", "page-http", "attach-live", "draft", input),
          createCandidateTemplate("guarded-session", "session-http", "attach-live", "draft", input),
        ],
        input,
      );
    case "script-signed":
      return withObservationTemplate(
        [
          createCandidateTemplate(
            "page-signed",
            "page-http",
            "attach-live",
            "draft",
            input,
            "script-derived inputs require a replay-time resolver",
          ),
        ],
        input,
      );
    case "anti-bot":
      return withObservationTemplate(
        [
          createCandidateTemplate(
            "anti-bot-browser",
            "page-http",
            "attach-live",
            "draft",
            input,
            "volatile anti-bot input must be resolved from live browser state",
          ),
        ],
        input,
      );
    case "blocked":
      return [
        createCandidateTemplate(
          "blocked",
          "session-http",
          input.stateSource,
          "unsupported",
          input,
          "candidate is not exportable as a replayable HTTP request",
        ),
      ];
  }
}

function buildEventStreamTemplates(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: ReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReverseAdvisoryTemplate[] {
  switch (input.dependencyClass) {
    case "portable":
      return [
        createCandidateTemplate("stream-direct", "direct-http", input.stateSource, "ready", input),
        createCandidateTemplate("stream-page", "page-http", input.stateSource, "ready", input),
      ];
    case "browser-state":
      return withObservationTemplate(
        [
          createCandidateTemplate("stream-page", "page-http", "snapshot-authenticated", "ready", input),
          createCandidateTemplate("stream-attach", "page-http", "attach-live", "ready", input),
        ],
        input,
      );
    case "behavior-gated":
      return withObservationTemplate(
        [createCandidateTemplate("stream-guarded", "page-http", "attach-live", "draft", input)],
        input,
      );
    case "script-signed":
      return withObservationTemplate(
        [
          createCandidateTemplate(
            "stream-script",
            "page-http",
            "attach-live",
            "draft",
            input,
            "script-derived inputs require a replay-time resolver",
          ),
        ],
        input,
      );
    case "anti-bot":
      return withObservationTemplate(
        [
          createCandidateTemplate(
            "stream-anti-bot",
            "page-http",
            "attach-live",
            "draft",
            input,
            "volatile anti-bot input must be resolved from live browser state",
          ),
        ],
        input,
      );
    case "blocked":
      return [
        createCandidateTemplate(
          "stream-blocked",
          "page-http",
          input.stateSource,
          "unsupported",
          input,
          "candidate is not exportable as a replayable event stream",
        ),
      ];
  }
}

function buildWebSocketTemplates(input: {
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: ReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReverseAdvisoryTemplate[] {
  const unsupportedHeader = findUnsupportedBrowserWebSocketHeader(input.inputs);
  const headerFailureReason =
    unsupportedHeader === undefined
      ? undefined
      : `browser websocket replay cannot set captured header ${unsupportedHeader}`;
  const viability = headerFailureReason === undefined ? "ready" : "draft";

  switch (input.dependencyClass) {
    case "portable":
      return [
        createCandidateTemplate(
          "socket-page",
          "page-http",
          input.stateSource,
          viability,
          input,
          headerFailureReason,
        ),
      ];
    case "browser-state":
      return [
        createCandidateTemplate(
          "socket-page",
          "page-http",
          "snapshot-authenticated",
          viability,
          input,
          headerFailureReason,
        ),
        createCandidateTemplate(
          "socket-attach",
          "page-http",
          "attach-live",
          viability,
          input,
          headerFailureReason,
        ),
      ];
    case "behavior-gated":
      return [
        createCandidateTemplate(
          "socket-guarded",
          "page-http",
          "attach-live",
          headerFailureReason === undefined ? "draft" : "unsupported",
          input,
          headerFailureReason,
        ),
      ];
    case "script-signed":
      return [
        createCandidateTemplate(
          "socket-script",
          "page-http",
          "attach-live",
          "draft",
          input,
          headerFailureReason ?? "script-derived inputs require a replay-time resolver",
        ),
      ];
    case "anti-bot":
      return [
        createCandidateTemplate(
          "socket-anti-bot",
          "page-http",
          "attach-live",
          "draft",
          input,
          headerFailureReason ?? "volatile anti-bot input must be resolved from live browser state",
        ),
      ];
    case "blocked":
      return [
        createCandidateTemplate(
          "socket-blocked",
          "page-http",
          input.stateSource,
          "unsupported",
          input,
          headerFailureReason ?? "candidate is not exportable as a replayable websocket workflow",
        ),
      ];
  }
}

function createCandidateTemplate(
  slug: string,
  transport: TransportKind,
  stateSource: OpensteerStateSourceKind,
  viability: OpensteerReverseAdvisoryTemplate["viability"],
  input: {
    readonly channel: OpensteerChannelDescriptor;
    readonly guards: readonly OpensteerReverseGuardRecord[];
    readonly resolvers: readonly OpensteerExecutableResolver[];
  },
  notes?: string,
): OpensteerReverseAdvisoryTemplate {
  return {
    id: `template:${slug}:${transport}`,
    label: `${transport} via ${stateSource}`,
    channel: input.channel.kind,
    execution: "transport",
    stateSource,
    transport,
    guardIds: input.guards.map((guard) => guard.id),
    resolverIds: input.resolvers.map((resolver) => resolver.id),
    requiresBrowser: transport !== "direct-http",
    requiresLiveState: stateSource === "attach-live",
    viability,
    ...(notes === undefined ? {} : { notes }),
  };
}

function createObservationTemplate(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly stateSource: OpensteerStateSourceKind;
  readonly viability: OpensteerReverseAdvisoryTemplate["viability"];
}): OpensteerReverseAdvisoryTemplate | undefined {
  if (
    input.observationUrl === undefined ||
    input.observationUrl.length === 0 ||
    input.observationUrl === input.channel.url
  ) {
    return undefined;
  }
  return {
    id: `template:page-observation:${input.observationId}`,
    label: `page observation via ${input.stateSource}`,
    channel: input.channel.kind,
    execution: "page-observation",
    stateSource: input.stateSource,
    observationId: input.observationId,
    guardIds: input.guards.map((guard) => guard.id),
    resolverIds: [],
    requiresBrowser: true,
    requiresLiveState: input.stateSource === "attach-live",
    viability: input.viability,
  };
}

function withObservationTemplate(
  strategies: readonly OpensteerReverseAdvisoryTemplate[],
  input: {
    readonly observationId: string;
    readonly observationUrl?: string;
    readonly channel: OpensteerChannelDescriptor;
    readonly guards: readonly OpensteerReverseGuardRecord[];
    readonly resolvers: readonly OpensteerExecutableResolver[];
    readonly stateSource: OpensteerStateSourceKind;
    readonly dependencyClass: ReverseCandidateDependencyClass;
  },
): readonly OpensteerReverseAdvisoryTemplate[] {
  const observationTemplate = createObservationTemplate({
    ...input,
    viability:
      input.dependencyClass === "blocked"
        ? "unsupported"
        : input.dependencyClass === "portable" || input.dependencyClass === "browser-state"
          ? "ready"
          : "draft",
  });
  return observationTemplate === undefined ? strategies : [observationTemplate, ...strategies];
}

function findUnsupportedBrowserWebSocketHeader(
  inputs: readonly OpensteerRequestInputDescriptor[],
): string | undefined {
  for (const input of inputs) {
    if (input.location !== "header") {
      continue;
    }
    const normalizedName = normalizeHeaderName(input.name);
    if (normalizedName === "sec-websocket-protocol") {
      continue;
    }
    if (isManagedRequestHeaderName(normalizedName, "page-http")) {
      continue;
    }
    return input.name;
  }
  return undefined;
}

function portabilityWeight(
  dependencyClass: ReverseCandidateDependencyClass,
): number {
  switch (dependencyClass) {
    case "portable":
      return 5;
    case "browser-state":
      return 4;
    case "behavior-gated":
      return 3;
    case "script-signed":
      return 2;
    case "anti-bot":
      return 1;
    case "blocked":
      return 0;
  }
}

function advisoryTagPriority(tags: readonly OpensteerReverseAdvisoryTag[]): number {
  if (tags.includes("data") || tags.includes("search") || tags.includes("tracking")) {
    return 3;
  }
  if (tags.includes("facet") || tags.includes("route-data") || tags.includes("document")) {
    return 2;
  }
  if (tags.includes("subscription")) {
    return 1;
  }
  if (tags.includes("telemetry")) {
    return -1;
  }
  return 0;
}

function computeResponseRichness(
  record: NetworkQueryRecord,
  codec: OpensteerBodyCodecDescriptor,
): number {
  let richness = 0;
  if (record.record.responseBody !== undefined) {
    richness += 2;
  }
  if (record.record.status !== undefined) {
    richness += 1;
  }
  if (codec.fieldPaths.length > 0) {
    richness += Math.min(6, codec.fieldPaths.length);
  }
  if (codec.kind === "graphql" || codec.kind === "persisted-graphql") {
    richness += 3;
  }
  return richness;
}

function classifyResolverStatus(input: {
  readonly resolverKind: OpensteerExecutableResolverKind;
  readonly guardBacked: boolean;
  readonly scriptBacked: boolean;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateSource: OpensteerStateSourceKind;
  readonly hasScriptArtifact: boolean;
}): OpensteerExecutableResolver["status"] {
  switch (input.resolverKind) {
    case "candidate":
    case "case":
    case "runtime-managed":
    case "cookie":
    case "literal":
    case "state-snapshot":
      return "ready";
    case "storage":
      return input.stateSource === "attach-live" ? "ready" : "missing";
    case "artifact":
      return input.hasScriptArtifact ? "ready" : "missing";
    case "binding":
      return "missing";
    case "prior-record":
      return "ready";
    case "manual":
      if (!input.guardBacked && !input.scriptBacked) {
        return "missing";
      }
      return input.guardBacked &&
        input.guards.some((guard) => guard.status === "satisfied" && guard.interactionTraceId)
        ? "ready"
        : "missing";
  }
}

function buildSummary(
  channel: OpensteerChannelDescriptor,
  advisoryTags: readonly OpensteerReverseAdvisoryTag[],
  constraints: readonly OpensteerReverseConstraintKind[],
  codec: OpensteerBodyCodecDescriptor,
): string {
  const tag = advisoryTags[0] ?? "unknown";
  const constraint = constraints[0] ?? "portable";
  return `${channel.kind} ${codec.kind} ${tag} candidate with ${constraint}`;
}

function parseCookieHeader(header: string): readonly { name: string; value: string }[] {
  return header
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("="))
    .map((entry) => {
      const separator = entry.indexOf("=");
      return {
        name: entry.slice(0, separator).trim(),
        value: entry.slice(separator + 1).trim(),
      };
    });
}

function flattenBodyEntries(value: unknown, basePath: string): RequestBodyFieldEntry[] {
  const entries: RequestBodyFieldEntry[] = [];
  flattenBodyEntriesInto(value, basePath, entries, 0);
  return entries;
}

function flattenBodyEntriesInto(
  value: unknown,
  basePath: string,
  entries: RequestBodyFieldEntry[],
  depth: number,
): void {
  if (depth > 2) {
    return;
  }
  if (Array.isArray(value)) {
    entries.push({
      name: basePath.split(".").at(-1) ?? basePath,
      path: basePath,
      value: JSON.stringify(value),
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [name, entryValue] of Object.entries(value)) {
      const nextPath = `${basePath}.${name}`;
      if (entryValue !== null && typeof entryValue === "object" && !Array.isArray(entryValue)) {
        flattenBodyEntriesInto(entryValue, nextPath, entries, depth + 1);
        continue;
      }
      entries.push({
        name,
        path: nextPath,
        value: stringifyInputValue(entryValue),
      });
    }
    return;
  }
  entries.push({
    name: basePath.split(".").at(-1) ?? basePath,
    path: basePath,
    value: stringifyInputValue(value),
  });
}

function parseMultipartFields(bodyText: string): RequestBodyFieldEntry[] {
  const matches = [...bodyText.matchAll(/name="([^"]+)"/g)];
  return matches.map((match) => ({
    name: match[1] ?? "field",
    path: `body.${match[1] ?? "field"}`,
    value: "",
  }));
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(";")[0]?.trim().toLowerCase() || undefined;
}

function inferWebSocketCodec(record: NetworkQueryRecord): OpensteerBodyCodecDescriptor["kind"] {
  const subprotocol = headerValue(
    record.record.requestHeaders,
    "sec-websocket-protocol",
  )?.toLowerCase();
  if (subprotocol?.includes("json") === true || subprotocol?.includes("graphql") === true) {
    return "websocket-json";
  }
  return "websocket-text";
}

function inferCodecWithoutBody(contentType: string): OpensteerBodyCodecDescriptor["kind"] {
  if (contentType.includes("json")) {
    return "json";
  }
  if (contentType.includes("graphql")) {
    return "graphql";
  }
  if (contentType.includes("x-www-form-urlencoded")) {
    return "form-urlencoded";
  }
  if (contentType.includes("multipart/form-data")) {
    return "multipart";
  }
  if (isOpaqueBinaryContentType(contentType)) {
    return "opaque-binary";
  }
  return "unknown";
}

function isOpaqueBinaryContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  return (
    contentType.includes("octet-stream") ||
    contentType.includes("protobuf") ||
    contentType.includes("msgpack") ||
    contentType.includes("grpc")
  );
}

function decodeBodyText(
  body: NetworkQueryRecord["record"]["requestBody"] | undefined,
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  try {
    return Buffer.from(body.data, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isPersistedGraphqlExtensions(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "persistedQuery" in (value as Record<string, unknown>)
  );
}

function stringifyInputValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function dedupeInputs(
  inputs: readonly OpensteerRequestInputDescriptor[],
): OpensteerRequestInputDescriptor[] {
  const seen = new Map<string, OpensteerRequestInputDescriptor>();
  for (const input of inputs) {
    const key = `${input.location}:${input.name}:${input.path ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, input);
    }
  }
  return [...seen.values()];
}

function dedupeResolvers(
  resolvers: readonly OpensteerExecutableResolver[],
): OpensteerExecutableResolver[] {
  const seen = new Map<string, OpensteerExecutableResolver>();
  for (const resolver of resolvers) {
    if (!seen.has(resolver.id)) {
      seen.set(resolver.id, resolver);
    }
  }
  return [...seen.values()];
}

function looksHighEntropy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length < 24) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (/^https?:\/\//.test(normalized) || normalized.startsWith("mozilla/") || /\s/.test(trimmed)) {
    return false;
  }
  if (!/^[A-Za-z0-9._~+/-=]+$/.test(trimmed)) {
    return false;
  }
  const uniqueCharacters = new Set(trimmed).size;
  return uniqueCharacters >= Math.min(20, Math.floor(trimmed.length * 0.6));
}
