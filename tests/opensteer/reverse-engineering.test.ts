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
  readonly resourceType: "fetch" | "xhr" | "event-stream" | "websocket" | "preflight";
  readonly url: string;
  readonly method?: string;
  readonly status?: number;
  readonly requestHeaders?: readonly ReturnType<typeof createHeaderEntry>[];
  readonly responseHeaders?: readonly ReturnType<typeof createHeaderEntry>[];
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
      responseHeaders: input.responseHeaders ?? [
        createHeaderEntry("content-type", "application/json"),
      ],
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.requestBody === undefined ? {} : { requestBody: input.requestBody }),
      resourceType: input.resourceType,
      navigationRequest: false,
      captureState: "complete" as const,
      requestBodyState:
        input.requestBody === undefined ? ("skipped" as const) : ("complete" as const),
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

    expect(finalized.headers).toEqual([{ name: "x-client-version", value: "web-2026.03" }]);
  });

  test("event-stream candidates expose ready advisory templates instead of solver-owned replay strategies", () => {
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

    expect(candidate.constraints).not.toContain("unsupported");
    expect(candidate.advisoryTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "event-stream",
          execution: "transport",
          transport: "direct-http",
          viability: "ready",
        }),
        expect.objectContaining({
          channel: "event-stream",
          execution: "transport",
          transport: "page-http",
          viability: "ready",
        }),
      ]),
    );
  });

  test("websocket candidates expose draft browser templates when captured headers cannot be reproduced", () => {
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

    expect(candidate.constraints).toEqual(expect.arrayContaining(["requires-browser"]));
    expect(candidate.advisoryTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "websocket",
          execution: "transport",
          transport: "page-http",
          stateSource: "snapshot-authenticated",
          viability: "draft",
          notes: "browser websocket replay cannot set captured header authorization",
        }),
        expect.objectContaining({
          channel: "websocket",
          execution: "transport",
          transport: "page-http",
          stateSource: "attach-live",
          viability: "draft",
          notes: "browser websocket replay cannot set captured header authorization",
        }),
      ]),
    );
  });

  test("anti-bot http candidates expose observation and browser templates without auto-choosing either", () => {
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

    expect(candidate.constraints).toEqual(
      expect.arrayContaining(["requires-browser", "requires-live-state"]),
    );
    expect(candidate.advisoryTemplates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution: "page-observation",
          observationId: "observation:maersk",
          viability: "draft",
          requiresBrowser: true,
          requiresLiveState: false,
        }),
        expect.objectContaining({
          execution: "transport",
          transport: "page-http",
          stateSource: "attach-live",
          viability: "draft",
        }),
      ]),
    );
  });

  test("neutral package drafts stay draft when multiple advisory templates exist and none is selected", () => {
    const candidate = analyzeReverseCandidate({
      observationId: "observation:portable",
      observationUrl: "https://example.com/app",
      stateSource: "managed",
      record: createNetworkQueryRecord({
        id: "record:portable",
        kind: "http",
        resourceType: "fetch",
        url: "https://example.com/api/items",
        status: 200,
      }),
    });

    expect(candidate.advisoryTemplates.length).toBeGreaterThan(1);

    const workflow = buildReversePackageWorkflow({
      candidate,
      guards: [],
      validators: [],
    });
    const unresolvedRequirements = deriveReversePackageUnresolvedRequirements({
      candidate,
      workflow,
      resolvers: candidate.resolvers,
      guards: [],
      stateSource: "managed",
    });

    expect(workflow).toEqual([]);
    expect(unresolvedRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `requirement:workflow:${candidate.id}`,
          kind: "workflow-step",
          blocking: true,
        }),
      ]),
    );
    expect(unresolvedRequirements).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `requirement:template:${candidate.id}`,
        }),
      ]),
    );
    expect(
      deriveReversePackageReadiness({
        kind: "portable-http",
        unresolvedRequirements,
      }),
    ).toBe("draft");
  });

  test("page-observation packages stay runnable when built from an explicit observation template", () => {
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
    const template = candidate.advisoryTemplates.find(
      (entry) => entry.execution === "page-observation",
    );
    expect(template).toBeDefined();
    if (template === undefined) {
      throw new Error("expected page-observation template");
    }

    const validators = buildReverseValidationRules({
      record: createNetworkQueryRecord({
        id: "record:maersk",
        kind: "http",
        resourceType: "fetch",
        url: "https://api.maersk.com/synergy/tracking/MRSU6648297?operator=MAEU",
        status: 200,
      }),
      channel: candidate.channel,
    });
    const workflow = buildReversePackageWorkflow({
      candidate,
      template,
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
      validators,
    });
    const unresolvedRequirements = deriveReversePackageUnresolvedRequirements({
      candidate,
      template,
      workflow,
      resolvers: candidate.resolvers,
      guards: [],
      stateSource: "snapshot-authenticated",
    });

    expect(unresolvedRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `requirement:template:${template.id}`,
          kind: "workflow-step",
          status: "recommended",
          blocking: false,
        }),
      ]),
    );
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

  test("ranking signals keep user-intent APIs above cookie-consent traffic", () => {
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

    expect(consentCandidate.advisoryTags).toContain("telemetry");
    expect(trackingCandidate.matchedTargetHints).toEqual(
      expect.arrayContaining(["host:api.maersk.com", "path:/synergy/tracking"]),
    );
    expect(compareReverseAnalysisResults(trackingCandidate, consentCandidate)).toBeLessThan(0);
    expect(trackingCandidate.signals.advisoryRank).toBeGreaterThan(
      consentCandidate.signals.advisoryRank,
    );
  });

  test("cluster discovery preserves all retry members and labels their relationship", () => {
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
    const preflight = createNetworkQueryRecord({
      id: "record:retry-preflight",
      kind: "http",
      resourceType: "preflight",
      method: "OPTIONS",
      url: "https://example.com/api/search?q=chair",
      status: 204,
    });
    const failedCodec = describeReverseBodyCodec(failed).codec;
    const succeededCodec = describeReverseBodyCodec(succeeded).codec;
    const preflightCodec = describeReverseBodyCodec(preflight).codec;
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
        {
          record: preflight,
          observedAt: 50,
          channel: buildChannelDescriptor(preflight),
          bodyCodec: preflightCodec,
          matchedTargetHints: [],
        },
      ],
    });

    expect(clusters).toEqual([
      expect.objectContaining({
        method: "OPTIONS",
        members: [
          expect.objectContaining({
            recordId: "record:retry-preflight",
            relation: "seed",
          }),
        ],
      }),
      expect.objectContaining({
        method: "POST",
        members: [
          expect.objectContaining({
            recordId: "record:retry-failed",
            relation: "seed",
          }),
          expect.objectContaining({
            recordId: "record:retry-success",
            relation: "retry",
            relatedRecordId: "record:retry-failed",
          }),
        ],
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
