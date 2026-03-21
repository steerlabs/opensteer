import type {
  NetworkQueryRecord,
  OpensteerBodyCodecDescriptor,
  OpensteerChannelDescriptor,
  OpensteerExecutableResolver,
  OpensteerReplayStrategy,
  OpensteerRequestInputClassification,
  OpensteerRequestInputDescriptor,
  OpensteerRequestInputExportPolicy,
  OpensteerRequestInputMaterializationPolicy,
  OpensteerRequestInputSource,
  OpensteerReverseCandidateBoundary,
  OpensteerReverseCandidateDependencyClass,
  OpensteerReverseCandidateRole,
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
  readonly role: OpensteerReverseCandidateRole;
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly score: number;
  readonly channel: OpensteerChannelDescriptor;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly summary: string;
  readonly matchedTargetHints: readonly string[];
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly replayStrategies: readonly OpensteerReplayStrategy[];
}

const ROLE_PRIORITY: Readonly<Record<OpensteerReverseCandidateRole, number>> = {
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
  const score = scoreCandidate(
    input.record,
    role,
    dependencyClass,
    boundary,
    bodyAnalysis.codec,
    matchedTargetHints,
    input.targetHints !== undefined,
  );
  const resolvers = buildResolvers(
    inputs,
    input.guards ?? [],
    input.scriptArtifactIds ?? [],
    input.stateSource,
  );
  const replayStrategies = buildReplayStrategies({
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
    role,
    dependencyClass,
    score,
    channel,
    bodyCodec: bodyAnalysis.codec,
    summary: buildSummary(channel, role, dependencyClass, bodyAnalysis.codec),
    matchedTargetHints,
    inputs,
    resolvers,
    replayStrategies,
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
): OpensteerReverseCandidateRole {
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

function scoreCandidate(
  record: NetworkQueryRecord,
  role: OpensteerReverseCandidateRole,
  dependencyClass: OpensteerReverseCandidateDependencyClass,
  boundary: OpensteerReverseCandidateBoundary,
  codec: OpensteerBodyCodecDescriptor,
  matchedTargetHints: readonly string[],
  hasTargetHints: boolean,
): number {
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
  return Math.max(0, Math.min(100, score));
}

export function compareReverseAnalysisResults(
  left: Pick<ReverseAnalysisResult, "score" | "matchedTargetHints" | "boundary" | "role">,
  right: Pick<ReverseAnalysisResult, "score" | "matchedTargetHints" | "boundary" | "role">,
): number {
  return (
    right.score - left.score ||
    right.matchedTargetHints.length - left.matchedTargetHints.length ||
    BOUNDARY_PRIORITY[right.boundary] - BOUNDARY_PRIORITY[left.boundary] ||
    ROLE_PRIORITY[right.role] - ROLE_PRIORITY[left.role]
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
): OpensteerReverseCandidateDependencyClass {
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
    const status =
      runtimeManaged || cookieBacked
        ? "ready"
        : scriptBacked
          ? scriptArtifactIds.length > 0
            ? "ready"
            : "missing"
          : guardBacked
            ? input.unlockedByGuardIds!.some((id) => guards.some((guard) => guard.id === id))
              ? "ready"
              : "missing"
            : stateSource === "attach-live" || input.classification === "contextual"
              ? "ready"
              : "missing";

    resolvers.push({
      id: `resolver:${input.location}:${input.name}`,
      kind: runtimeManaged
        ? "runtime-managed"
        : cookieBacked
          ? "cookie"
          : scriptBacked
            ? "script-sandbox"
            : guardBacked
              ? "guard-output"
              : input.classification === "contextual"
                ? "page-eval"
                : "literal",
      label: `Resolve ${input.location} ${input.name}`,
      status,
      requiresBrowser:
        !runtimeManaged &&
        !cookieBacked &&
        (guardBacked || scriptBacked || input.classification === "contextual"),
      requiresLiveState:
        guardBacked ||
        stateSource === "attach-live" ||
        (scriptBacked && scriptArtifactIds.length === 0),
      inputNames: [input.name],
      description: runtimeManaged
        ? "Generated by the request materializer."
        : guardBacked
          ? "Derived from a recorded unlock interaction."
          : scriptBacked
            ? "Derived from a captured script or signer."
            : input.classification === "contextual"
              ? "Resolved from live browser state at replay time."
              : "Resolved directly from the captured value.",
      ...(input.unlockedByGuardIds?.[0] === undefined
        ? {}
        : { guardId: input.unlockedByGuardIds[0] }),
      ...(scriptBacked && scriptArtifactIds[0] !== undefined
        ? { scriptArtifactId: scriptArtifactIds[0] }
        : {}),
      ...(scriptBacked || input.classification === "contextual"
        ? input.provenance?.sourcePointer === undefined
          ? {}
          : { expression: input.provenance.sourcePointer }
        : {}),
    });
  }
  return dedupeResolvers(resolvers);
}

function buildReplayStrategies(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReplayStrategy[] {
  switch (input.channel.kind) {
    case "http":
      return buildHttpReplayStrategies(input);
    case "event-stream":
      return buildEventStreamReplayStrategies(input);
    case "websocket":
      return buildWebSocketReplayStrategies(input);
  }
}

function buildHttpReplayStrategies(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReplayStrategy[] {
  switch (input.dependencyClass) {
    case "portable":
      return [
        createReplayStrategy("direct", "direct-http", input.stateSource, true, input),
        createReplayStrategy("page", "page-http", input.stateSource, true, input),
      ];
    case "browser-state":
      return withObservationReplayStrategy(
        [
          createReplayStrategy("page", "page-http", "snapshot-authenticated", true, input),
          createReplayStrategy("session", "session-http", "snapshot-authenticated", true, input),
          createReplayStrategy("attach", "page-http", "attach-live", true, input),
        ],
        input,
      );
    case "behavior-gated":
      return withObservationReplayStrategy(
        [
          createReplayStrategy("guarded-page", "page-http", "attach-live", true, input),
          createReplayStrategy("guarded-session", "session-http", "attach-live", true, input),
        ],
        input,
      );
    case "script-signed":
      return withObservationReplayStrategy(
        [
          createReplayStrategy(
            "page-signed",
            "page-http",
            "attach-live",
            false,
            input,
            "script-derived inputs require a replay-time resolver",
          ),
        ],
        input,
      );
    case "anti-bot":
      return withObservationReplayStrategy(
        [
          createReplayStrategy(
            "anti-bot-browser",
            "page-http",
            "attach-live",
            false,
            input,
            "volatile anti-bot input must be resolved from live browser state",
          ),
        ],
        input,
      );
    case "blocked":
      return [
        createReplayStrategy(
          "blocked",
          "session-http",
          input.stateSource,
          false,
          input,
          "candidate is not exportable as a replayable HTTP request",
        ),
      ];
  }
}

function buildEventStreamReplayStrategies(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReplayStrategy[] {
  switch (input.dependencyClass) {
    case "portable":
      return [
        createReplayStrategy("stream-direct", "direct-http", input.stateSource, true, input),
        createReplayStrategy("stream-page", "page-http", input.stateSource, true, input),
      ];
    case "browser-state":
      return withObservationReplayStrategy(
        [
          createReplayStrategy("stream-page", "page-http", "snapshot-authenticated", true, input),
          createReplayStrategy("stream-attach", "page-http", "attach-live", true, input),
        ],
        input,
      );
    case "behavior-gated":
      return withObservationReplayStrategy(
        [createReplayStrategy("stream-guarded", "page-http", "attach-live", true, input)],
        input,
      );
    case "script-signed":
      return withObservationReplayStrategy(
        [
          createReplayStrategy(
            "stream-script",
            "page-http",
            "attach-live",
            false,
            input,
            "script-derived inputs require a replay-time resolver",
          ),
        ],
        input,
      );
    case "anti-bot":
      return withObservationReplayStrategy(
        [
          createReplayStrategy(
            "stream-anti-bot",
            "page-http",
            "attach-live",
            false,
            input,
            "volatile anti-bot input must be resolved from live browser state",
          ),
        ],
        input,
      );
    case "blocked":
      return [
        createReplayStrategy(
          "stream-blocked",
          "page-http",
          input.stateSource,
          false,
          input,
          "candidate is not exportable as a replayable event stream",
        ),
      ];
  }
}

function buildWebSocketReplayStrategies(input: {
  readonly channel: OpensteerChannelDescriptor;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly stateSource: OpensteerStateSourceKind;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
}): readonly OpensteerReplayStrategy[] {
  const unsupportedHeader = findUnsupportedBrowserWebSocketHeader(input.inputs);
  const headerFailureReason =
    unsupportedHeader === undefined
      ? undefined
      : `browser websocket replay cannot set captured header ${unsupportedHeader}`;
  const supported = headerFailureReason === undefined;

  switch (input.dependencyClass) {
    case "portable":
      return [
        createReplayStrategy(
          "socket-page",
          "page-http",
          input.stateSource,
          supported,
          input,
          headerFailureReason,
        ),
      ];
    case "browser-state":
      return [
        createReplayStrategy(
          "socket-page",
          "page-http",
          "snapshot-authenticated",
          supported,
          input,
          headerFailureReason,
        ),
        createReplayStrategy(
          "socket-attach",
          "page-http",
          "attach-live",
          supported,
          input,
          headerFailureReason,
        ),
      ];
    case "behavior-gated":
      return [
        createReplayStrategy(
          "socket-guarded",
          "page-http",
          "attach-live",
          supported,
          input,
          headerFailureReason,
        ),
      ];
    case "script-signed":
      return [
        createReplayStrategy(
          "socket-script",
          "page-http",
          "attach-live",
          false,
          input,
          headerFailureReason ?? "script-derived inputs require a replay-time resolver",
        ),
      ];
    case "anti-bot":
      return [
        createReplayStrategy(
          "socket-anti-bot",
          "page-http",
          "attach-live",
          false,
          input,
          headerFailureReason ?? "volatile anti-bot input must be resolved from live browser state",
        ),
      ];
    case "blocked":
      return [
        createReplayStrategy(
          "socket-blocked",
          "page-http",
          input.stateSource,
          false,
          input,
          headerFailureReason ?? "candidate is not exportable as a replayable websocket workflow",
        ),
      ];
  }
}

function createReplayStrategy(
  slug: string,
  transport: TransportKind,
  stateSource: OpensteerStateSourceKind,
  supported: boolean,
  input: {
    readonly channel: OpensteerChannelDescriptor;
    readonly guards: readonly OpensteerReverseGuardRecord[];
    readonly resolvers: readonly OpensteerExecutableResolver[];
  },
  failureReason?: string,
): OpensteerReplayStrategy {
  return {
    id: `strategy:${slug}:${transport}`,
    label: `${transport} via ${stateSource}`,
    channel: input.channel.kind,
    execution: "transport",
    stateSource,
    transport,
    supported,
    guardIds: input.guards.map((guard) => guard.id),
    resolverIds: input.resolvers.map((resolver) => resolver.id),
    requiresBrowser: transport !== "direct-http",
    requiresLiveState: stateSource === "attach-live",
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

function createPageObservationReplayStrategy(input: {
  readonly observationId: string;
  readonly observationUrl?: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly stateSource: OpensteerStateSourceKind;
}): OpensteerReplayStrategy | undefined {
  if (
    input.observationUrl === undefined ||
    input.observationUrl.length === 0 ||
    input.observationUrl === input.channel.url
  ) {
    return undefined;
  }
  return {
    id: `strategy:page-observation:${input.observationId}`,
    label: `page observation via ${input.stateSource}`,
    channel: input.channel.kind,
    execution: "page-observation",
    stateSource: input.stateSource,
    observationId: input.observationId,
    supported: true,
    guardIds: input.guards.map((guard) => guard.id),
    resolverIds: input.resolvers.map((resolver) => resolver.id),
    requiresBrowser: true,
    requiresLiveState: input.stateSource === "attach-live",
  };
}

function withObservationReplayStrategy(
  strategies: readonly OpensteerReplayStrategy[],
  input: {
    readonly observationId: string;
    readonly observationUrl?: string;
    readonly channel: OpensteerChannelDescriptor;
    readonly guards: readonly OpensteerReverseGuardRecord[];
    readonly resolvers: readonly OpensteerExecutableResolver[];
    readonly stateSource: OpensteerStateSourceKind;
  },
): readonly OpensteerReplayStrategy[] {
  const observationStrategy = createPageObservationReplayStrategy(input);
  return observationStrategy === undefined ? strategies : [observationStrategy, ...strategies];
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

function buildSummary(
  channel: OpensteerChannelDescriptor,
  role: OpensteerReverseCandidateRole,
  dependencyClass: OpensteerReverseCandidateDependencyClass,
  codec: OpensteerBodyCodecDescriptor,
): string {
  return `${channel.kind} ${codec.kind} ${role} candidate classified as ${dependencyClass}`;
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
