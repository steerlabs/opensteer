import { describe, expect, test } from "vitest";

import {
  createBodyPayload,
  createHeaderEntry,
  createNetworkRequestId,
  createPageRef,
  createSessionRef,
} from "../../packages/protocol/src/index.js";
import { finalizeMaterializedTransportRequest } from "../../packages/opensteer/src/reverse/materialization.js";
import {
  analyzeReverseCandidate,
  buildChannelDescriptor,
  compareReverseAnalysisResults,
  describeReverseBodyCodec,
} from "../../packages/opensteer/src/reverse/analysis.js";
import {
  buildReversePackageWorkflow,
  deriveReversePackageReadiness,
  deriveReversePackageUnresolvedRequirements,
} from "../../packages/opensteer/src/reverse/workflows.js";
import {
  buildReverseValidationRules,
  evaluateValidationRulesForObservedRecord,
} from "../../packages/opensteer/src/reverse/validation.js";
import { clusterReverseObservationRecords } from "../../packages/opensteer/src/reverse/discovery.js";

function createNetworkQueryRecord(input: {
  readonly id: string;
  readonly kind: "http" | "event-stream" | "websocket";
  readonly resourceType: "fetch" | "xhr" | "event-stream" | "websocket";
  readonly url: string;
  readonly method?: string;
  readonly status?: number;
  readonly requestHeaders?: readonly ReturnType<typeof createHeaderEntry>[];
  readonly requestBody?: ReturnType<typeof createBodyPayload>;
}) {
  return {
    recordId: input.id,
    source: "saved" as const,
    record: {
      kind: input.kind,
      requestId: createNetworkRequestId(input.id.replaceAll(":", "-")),
      sessionRef: createSessionRef("reverse-tests"),
      pageRef: createPageRef("reverse-tests"),
      method: input.method ?? "GET",
      url: input.url,
      requestHeaders: input.requestHeaders ?? [],
      responseHeaders: [createHeaderEntry("content-type", "application/json")],
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
      resourceType: input.resourceType,
      navigationRequest: false,
      captureState: "complete" as const,
      requestBodyState: input.requestBody === undefined ? ("skipped" as const) : ("complete" as const),
      responseBodyState: "complete" as const,
    },
  };
}

describe("reverse-engineering architecture", () => {
  test("materialization strips managed and browser-owned headers at the root", () => {
    const finalized = finalizeMaterializedTransportRequest(
      {
        method: "POST",
        url: "https://example.com/api/items",
        headers: [
          createHeaderEntry(":authority", "example.com"),
          createHeaderEntry("host", "example.com"),
          createHeaderEntry("content-length", "123"),
          createHeaderEntry("sec-fetch-mode", "cors"),
          createHeaderEntry("x-client-version", "web-2026.03"),
        ],
      },
      "page-http",
    );

    expect(finalized.headers).toEqual([
      { name: "x-client-version", value: "web-2026.03" },
    ]);
  });

  test("event-stream candidates produce replayable stream strategies instead of being blocked", () => {
    const candidate = analyzeReverseCandidate({
      observationId: "observation:event-stream",
      observationUrl: "https://example.com/app",
      stateSource: "managed",
      record: createNetworkQueryRecord({
        id: "record:event-stream",
        kind: "event-stream",
        resourceType: "event-stream",
        url: "https://example.com/api/stream",
        status: 200,
      }),
    });

    expect(candidate.dependencyClass).toBe("portable");
    expect(candidate.replayStrategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "event-stream",
          transport: "direct-http",
          supported: true,
        }),
        expect.objectContaining({
          channel: "event-stream",
          transport: "page-http",
          supported: true,
        }),
      ]),
    );
  });

  test("websocket candidates are marked non-replayable when captured custom headers cannot be reproduced in-browser", () => {
    const candidate = analyzeReverseCandidate({
      observationId: "observation:websocket",
      observationUrl: "https://example.com/app",
      stateSource: "snapshot-authenticated",
      record: createNetworkQueryRecord({
        id: "record:websocket",
        kind: "websocket",
        resourceType: "websocket",
        url: "wss://example.com/socket",
        requestHeaders: [
          createHeaderEntry("authorization", "Bearer token"),
          createHeaderEntry("sec-websocket-protocol", "graphql-ws"),
        ],
      }),
    });

    expect(candidate.replayStrategies).toEqual([
      expect.objectContaining({
        channel: "websocket",
        transport: "page-http",
        supported: false,
        failureReason: "browser websocket replay cannot set captured header authorization",
      }),
      expect.objectContaining({
        channel: "websocket",
        transport: "page-http",
        supported: false,
        failureReason: "browser websocket replay cannot set captured header authorization",
      }),
    ]);
  });

  test("anti-bot http candidates gain a supported page-observation replay strategy when the observation URL can reacquire them", () => {
    const candidate = analyzeReverseCandidate({
      observationId: "observation:maersk",
      observationUrl: "https://www.maersk.com/tracking/MRSU6648297",
      stateSource: "snapshot-authenticated",
      record: createNetworkQueryRecord({
        id: "record:maersk",
        kind: "http",
        resourceType: "fetch",
        url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
        status: 200,
        requestHeaders: [
          createHeaderEntry("akamai-bm-telemetry", "volatile"),
          createHeaderEntry("consumer-key", "key"),
          createHeaderEntry("accept", "application/json"),
        ],
      }),
    });

    expect(candidate.dependencyClass).toBe("anti-bot");
    expect(candidate.replayStrategies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution: "page-observation",
          observationId: "observation:maersk",
          supported: true,
          requiresBrowser: true,
          requiresLiveState: false,
        }),
        expect.objectContaining({
          execution: "transport",
          transport: "page-http",
          supported: false,
        }),
      ]),
    );
  });

  test("page-observation packages stay runnable when they do not reference direct-request resolvers", () => {
    const candidate = analyzeReverseCandidate({
      observationId: "observation:maersk",
      observationUrl: "https://www.maersk.com/tracking/MRSU6648297",
      stateSource: "snapshot-authenticated",
      record: createNetworkQueryRecord({
        id: "record:maersk",
        kind: "http",
        resourceType: "fetch",
        url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
        status: 200,
        requestHeaders: [
          createHeaderEntry("akamai-bm-telemetry", "volatile"),
          createHeaderEntry("consumer-key", "key"),
          createHeaderEntry("accept", "application/json"),
        ],
      }),
    });
    const strategy = candidate.replayStrategies.find(
      (entry) => entry.execution === "page-observation" && entry.supported,
    );
    expect(strategy).toBeDefined();
    if (strategy === undefined) {
      throw new Error("expected page-observation strategy");
    }

    const workflow = buildReversePackageWorkflow({
      candidate,
      strategy,
      observation: {
        id: candidate.observationId,
        createdAt: Date.now(),
        pageRef: createPageRef("reverse-tests"),
        sessionRef: createSessionRef("reverse-tests"),
        url: "https://www.maersk.com/tracking/MRSU6648297",
        title: "Maersk Tracking",
        networkRecordIds: [candidate.recordId],
        scriptArtifactIds: [],
        interactionTraceIds: [],
      },
      guards: [],
      validators: [],
    });
    const unresolvedRequirements = deriveReversePackageUnresolvedRequirements({
      candidate,
      strategy,
      workflow,
      resolvers: candidate.resolvers,
      guards: [],
      stateSource: "snapshot-authenticated",
    });

    expect(unresolvedRequirements).toEqual([]);
    expect(
      deriveReversePackageReadiness({
        kind: "browser-workflow",
        unresolvedRequirements,
      }),
    ).toBe("runnable");
  });

  test("graphql candidates expose codec and target-hint matches", () => {
    const candidate = analyzeReverseCandidate({
      observationId: "observation:graphql",
      observationUrl: "https://example.com/app",
      stateSource: "managed",
      targetHints: {
        paths: ["/graphql"],
        operationNames: ["SearchUsers"],
      },
      record: createNetworkQueryRecord({
        id: "record:graphql",
        kind: "http",
        resourceType: "fetch",
        method: "POST",
        url: "https://example.com/graphql",
        status: 200,
        requestHeaders: [createHeaderEntry("content-type", "application/json")],
        requestBody: createBodyPayload(
          Buffer.from(
            JSON.stringify({
              operationName: "SearchUsers",
              query: "query SearchUsers($q: String!) { users(q: $q) { id } }",
              variables: { q: "tim" },
            }),
            "utf8",
          ).toString("base64"),
          {
            mimeType: "application/json",
            charset: "utf-8",
          },
        ),
      }),
    });

    expect(candidate.bodyCodec.kind).toBe("graphql");
    expect(candidate.bodyCodec.operationName).toBe("SearchUsers");
    expect(candidate.matchedTargetHints).toEqual(
      expect.arrayContaining(["operation:SearchUsers", "path:/graphql"]),
    );
  });

  test("target hints and consent demotion keep user-intent APIs above cookie-consent traffic", () => {
    const targetHints = {
      hosts: ["api.maersk.com"],
      paths: ["/synergy/tracking"],
    } as const;

    const consentCandidate = analyzeReverseCandidate({
      observationId: "observation:consent",
      observationUrl: "https://www.maersk.com/tracking/",
      stateSource: "snapshot-authenticated",
      targetHints,
      record: createNetworkQueryRecord({
        id: "record:consent",
        kind: "http",
        resourceType: "xhr",
        method: "POST",
        url: "https://consent.app.cookieinformation.com/api/consent?v=1.1.0",
        status: 200,
        requestHeaders: [createHeaderEntry("content-type", "application/json")],
        requestBody: createBodyPayload(
          Buffer.from(
            JSON.stringify({
              website_uuid: "5bd95c7e-c32e-4a33-bdb6-a640b99797ca",
            }),
            "utf8",
          ).toString("base64"),
          {
            mimeType: "application/json",
            charset: "utf-8",
          },
        ),
      }),
    });

    const trackingCandidate = analyzeReverseCandidate({
      observationId: "observation:tracking",
      observationUrl: "https://www.maersk.com/tracking/MRSU6648297",
      stateSource: "snapshot-authenticated",
      targetHints,
      record: createNetworkQueryRecord({
        id: "record:tracking",
        kind: "http",
        resourceType: "fetch",
        url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
        status: 200,
        requestHeaders: [
          createHeaderEntry("akamai-bm-telemetry", "volatile"),
          createHeaderEntry("consumer-key", "key"),
          createHeaderEntry("accept", "application/json"),
        ],
      }),
    });

    expect(consentCandidate.role).toBe("telemetry");
    expect(trackingCandidate.matchedTargetHints).toEqual(
      expect.arrayContaining(["host:api.maersk.com", "path:/synergy/tracking"]),
    );
    expect(compareReverseAnalysisResults(trackingCandidate, consentCandidate)).toBeLessThan(0);
    expect(trackingCandidate.score).toBeGreaterThan(consentCandidate.score);
  });

  test("cluster discovery suppresses duplicate retries behind a primary candidate", () => {
    const failed = createNetworkQueryRecord({
      id: "record:retry-failed",
      kind: "http",
      resourceType: "fetch",
      method: "POST",
      url: "https://example.com/api/search?q=chair",
      status: 500,
    });
    const succeeded = createNetworkQueryRecord({
      id: "record:retry-success",
      kind: "http",
      resourceType: "fetch",
      method: "POST",
      url: "https://example.com/api/search?q=chair",
      status: 200,
    });
    const failedCodec = describeReverseBodyCodec(failed).codec;
    const succeededCodec = describeReverseBodyCodec(succeeded).codec;
    const clusters = clusterReverseObservationRecords({
      observationId: "observation:retry",
      records: [
        {
          record: failed,
          observedAt: 100,
          channel: buildChannelDescriptor(failed),
          bodyCodec: failedCodec,
          matchedTargetHints: [],
        },
        {
          record: succeeded,
          observedAt: 200,
          channel: buildChannelDescriptor(succeeded),
          bodyCodec: succeededCodec,
          matchedTargetHints: [],
        },
      ],
    });

    expect(clusters).toEqual([
      expect.objectContaining({
        primaryRecordId: "record:retry-success",
        suppressedRecordIds: ["record:retry-failed"],
        suppressionReasons: ["retry"],
      }),
    ]);
  });

  test("observed replay validation tolerates missing JSON bodies when the browser request matched and CDP body capture failed", () => {
    const record = createNetworkQueryRecord({
      id: "record:observed-json-failed",
      kind: "http",
      resourceType: "fetch",
      url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
      status: 200,
    });
    const observedRecord = {
      ...record,
      record: {
        ...record.record,
        responseHeaders: [createHeaderEntry("content-type", "application/json")],
        responseBodyState: "failed" as const,
      },
    };

    const evaluation = evaluateValidationRulesForObservedRecord(observedRecord, [
      {
        id: "validator:status",
        kind: "status",
        label: "Status matches captured success",
        required: true,
        expectedStatus: 200,
      },
      {
        id: "validator:json-structure",
        kind: "json-structure",
        label: "JSON structure matches captured response",
        required: true,
        structureHash: "expected-structure",
      },
    ]);

    expect(evaluation.success).toBe(true);
    expect(evaluation.validation).toEqual({
      statusMatches: true,
      structureMatches: true,
    });
  });

  test("validation rules skip status assertions when the captured response status is unknown", () => {
    const rules = buildReverseValidationRules({
      record: createNetworkQueryRecord({
        id: "record:missing-status",
        kind: "http",
        resourceType: "fetch",
        url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
      }),
      channel: {
        kind: "http",
        recordKind: "http",
        method: "GET",
        url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
      },
    });

    expect(rules.find((rule) => rule.kind === "status")).toBeUndefined();
  });
});
