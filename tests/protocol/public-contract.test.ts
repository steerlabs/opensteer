import { describe, expect, test } from "vitest";

import {
  OPENSTEER_PROTOCOL_NAME,
  OPENSTEER_PROTOCOL_VERSION,
  createDocumentEpoch,
  createErrorEnvelope,
  createNodeRef,
  createPageRef,
  createOpensteerError,
  createRequestEnvelope,
  createSessionRef,
  createSuccessEnvelope,
  hasCapability,
  httpStatusForOpensteerError,
  isErrorEnvelope,
  nextDocumentEpoch,
  opensteerArtifactSchema,
  opensteerCapabilities,
  opensteerCapabilityDescriptors,
  opensteerEventSchema,
  opensteerMcpTools,
  opensteerOperationSpecificationMap,
  opensteerOperationSpecifications,
  opensteerRestEndpoints,
  parseOpensteerRef,
  unsupportedCapabilityError,
} from "../../packages/protocol/src/index.js";

describe("protocol refs and epochs", () => {
  test("normalizes public refs without importing browser-core brands", () => {
    const sessionRef = createSessionRef("session-a");
    const pageRef = createPageRef("page:already-prefixed");
    const nodeRef = createNodeRef("node-a");

    expect(sessionRef).toBe("session:session-a");
    expect(pageRef).toBe("page:already-prefixed");
    expect(nodeRef).toBe("node:node-a");
    expect(parseOpensteerRef(sessionRef)).toEqual({
      kind: "session",
      value: "session-a",
    });
  });

  test("enforces monotonic document epochs", () => {
    const epoch = createDocumentEpoch(2);

    expect(nextDocumentEpoch(epoch)).toBe(3);
    expect(() => createDocumentEpoch(-1)).toThrow(/non-negative integer/i);
  });
});

describe("protocol envelopes", () => {
  test("builds versioned request and success envelopes", () => {
    const request = createRequestEnvelope(
      "page.navigate",
      {
        pageRef: "page:main",
        url: "https://example.com",
      },
      {
        requestId: "req-1",
        sentAt: 100,
      },
    );
    const response = createSuccessEnvelope(
      request,
      {
        ok: true,
      },
      {
        receivedAt: 125,
      },
    );

    expect(request).toEqual({
      protocol: OPENSTEER_PROTOCOL_NAME,
      version: OPENSTEER_PROTOCOL_VERSION,
      requestId: "req-1",
      operation: "page.navigate",
      sentAt: 100,
      input: {
        pageRef: "page:main",
        url: "https://example.com",
      },
    });
    expect(response.status).toBe("ok");
    expect(response.operation).toBe("page.navigate");
    expect(response.data).toEqual({ ok: true });
    expect(isErrorEnvelope(response)).toBe(false);
  });

  test("builds error envelopes and maps normalized errors to transport status", () => {
    const request = createRequestEnvelope(
      "inspect.getDomSnapshot",
      {
        documentRef: "document:missing",
      },
      {
        requestId: "req-2",
        sentAt: 200,
      },
    );
    const error = createOpensteerError("not-found", "document not found", {
      details: { documentRef: "document:missing" },
    });
    const envelope = createErrorEnvelope(request, error, {
      receivedAt: 210,
    });

    expect(isErrorEnvelope(envelope)).toBe(true);
    expect(envelope.error.code).toBe("not-found");
    expect(httpStatusForOpensteerError(envelope.error)).toBe(404);
  });
});

describe("protocol capabilities and errors", () => {
  test("preserves the public capability catalog and supports direct membership checks", () => {
    const capabilitySet = [...new Set(["inspect.html", "inspect.html", "surface.rest"])] as const;

    expect(capabilitySet).toEqual(["inspect.html", "surface.rest"]);
    expect(opensteerCapabilityDescriptors).toHaveLength(opensteerCapabilities.length);
    expect(hasCapability(capabilitySet, "surface.rest")).toBe(true);
  });

  test("creates capability-aware protocol errors", () => {
    const error = unsupportedCapabilityError("events.dialog");

    expect(error).toEqual({
      code: "unsupported-capability",
      message: "capability events.dialog is not supported by this surface",
      retriable: false,
      capability: "events.dialog",
      details: {
        capability: "events.dialog",
      },
    });
    expect(httpStatusForOpensteerError(error)).toBe(501);
  });
});

describe("protocol surface descriptors", () => {
  test("keeps operation, REST, and MCP descriptors in lockstep", () => {
    const operationNames = opensteerOperationSpecifications.map((spec) => spec.name);
    const restNames = opensteerRestEndpoints.map((endpoint) => endpoint.name);
    const mcpNames = opensteerMcpTools.map((tool) => tool.operation);
    const uniqueRestPaths = new Set(opensteerRestEndpoints.map((endpoint) => endpoint.path));
    const uniqueToolNames = new Set(opensteerMcpTools.map((tool) => tool.name));

    expect(restNames).toEqual(operationNames);
    expect(mcpNames).toEqual(operationNames);
    expect(uniqueRestPaths.size).toBe(opensteerRestEndpoints.length);
    expect(uniqueToolNames.size).toBe(opensteerMcpTools.length);
    expect(opensteerOperationSpecificationMap["page.navigate"]?.requiredCapabilities).toEqual([
      "pages.navigate",
    ]);
  });

  test("uses versioned request envelopes for REST and raw operation schemas for MCP", () => {
    const restNavigate = opensteerRestEndpoints.find(
      (endpoint) => endpoint.name === "page.navigate",
    );
    const mcpNavigate = opensteerMcpTools.find((tool) => tool.operation === "page.navigate");

    const restVersion = restNavigate?.requestSchema.properties?.version;
    const restOperation = restNavigate?.requestSchema.properties?.operation;

    expect(restNavigate?.method).toBe("POST");
    expect(restVersion).toMatchObject({
      const: OPENSTEER_PROTOCOL_VERSION,
    });
    expect(restOperation).toMatchObject({
      type: "string",
    });
    expect(mcpNavigate?.name).toBe("opensteer_page_navigate");
    expect(mcpNavigate?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });
});

describe("protocol trace and artifact schemas", () => {
  test("exports discriminated unions for public events and artifacts", () => {
    expect(opensteerEventSchema.oneOf).toHaveLength(18);
    expect(opensteerArtifactSchema.oneOf).toHaveLength(6);
  });
});
