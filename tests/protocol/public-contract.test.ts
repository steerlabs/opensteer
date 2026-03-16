import { describe, expect, test } from "vitest";

import {
  OPENSTEER_PROTOCOL_COMPATIBILITY_REVISION,
  OPENSTEER_PROTOCOL_NAME,
  OPENSTEER_PROTOCOL_REST_BASE_PATH,
  OPENSTEER_PROTOCOL_VERSION,
  OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL,
  OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL,
  type ComputerUseBridge,
  type DomActionBridge,
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
  domSnapshotNodeSchema,
  domSnapshotSchema,
  opensteerArtifactSchema,
  opensteerCapabilities,
  opensteerCapabilityDescriptors,
  opensteerEventSchema,
  opensteerMcpTools,
  opensteerOperationSpecificationMap,
  opensteerOperationSpecifications,
  opensteerProtocolDescriptor,
  opensteerRequestPlanPayloadSchema,
  opensteerRequestPlanRecordSchema,
  opensteerRestEndpoints,
  opensteerSemanticOperationSpecificationMap,
  opensteerSemanticOperationSpecifications,
  opensteerSemanticRestEndpoints,
  assertValidSemanticOperationInput,
  parseOpensteerRef,
  resolveComputerUseBridge,
  resolveDomActionBridge,
  resolveRequiredCapabilities,
  resolveSemanticRequiredCapabilities,
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

describe("computer-use bridge contract", () => {
  test("resolves shared bridge providers through the canonical symbol", () => {
    const bridge: ComputerUseBridge = {
      async execute() {
        throw new Error("not called");
      },
    };
    const provider = {
      [OPENSTEER_COMPUTER_USE_BRIDGE_SYMBOL]() {
        return bridge;
      },
    };

    expect(resolveComputerUseBridge(provider)).toBe(bridge);
  });
});

describe("DOM action bridge contract", () => {
  test("resolves shared DOM action bridge providers through the canonical symbol", () => {
    const bridge: DomActionBridge = {
      async inspectActionTarget() {
        throw new Error("not called");
      },
      async scrollNodeIntoView() {
        throw new Error("not called");
      },
      async focusNode() {
        throw new Error("not called");
      },
      async finalizeDomAction() {
        throw new Error("not called");
      },
    };
    const provider = {
      [OPENSTEER_DOM_ACTION_BRIDGE_SYMBOL]() {
        return bridge;
      },
    };

    expect(resolveDomActionBridge(provider)).toBe(bridge);
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
      "inspect.get-dom-snapshot",
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

describe("protocol descriptor", () => {
  test("keeps the public compatibility revision, semver, REST base path, and media type aligned", () => {
    expect(OPENSTEER_PROTOCOL_VERSION).toBe(
      `0.${String(OPENSTEER_PROTOCOL_COMPATIBILITY_REVISION)}.0`,
    );
    expect(OPENSTEER_PROTOCOL_REST_BASE_PATH).toBe(
      `/api/v${String(OPENSTEER_PROTOCOL_COMPATIBILITY_REVISION)}`,
    );
    expect(opensteerProtocolDescriptor).toMatchObject({
      protocol: OPENSTEER_PROTOCOL_NAME,
      version: OPENSTEER_PROTOCOL_VERSION,
      restBasePath: OPENSTEER_PROTOCOL_REST_BASE_PATH,
      mediaType: expect.stringContaining(`version=${OPENSTEER_PROTOCOL_VERSION}`),
    });
  });
});

describe("protocol capabilities and errors", () => {
  test("preserves the public capability catalog and supports direct membership checks", () => {
    const capabilitySet = ["inspect.html", "surface.rest"] as const;

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

  test("requires keyboard capability for clicks that press modifiers", () => {
    const mouseClickSpec = opensteerOperationSpecificationMap["input.mouse-click"];
    const semanticComputerSpec = opensteerSemanticOperationSpecificationMap["computer.execute"];

    expect(
      resolveRequiredCapabilities(mouseClickSpec, {
        pageRef: createPageRef("page-main"),
        point: { x: 10, y: 20 },
        coordinateSpace: "layout-viewport-css",
        modifiers: ["Shift"],
      }),
    ).toEqual(["input.pointer", "input.keyboard"]);

    expect(
      resolveSemanticRequiredCapabilities(semanticComputerSpec, {
        action: {
          type: "click",
          x: 10,
          y: 20,
          modifiers: ["Shift"],
        },
      }),
    ).toEqual([
      "input.pointer",
      "input.keyboard",
      "artifacts.screenshot",
      "inspect.viewportMetrics",
    ]);
  });

  test("validates inspect.get-network-records filters through the public schema", () => {
    const inspectNetworkSpec = opensteerOperationSpecificationMap["inspect.get-network-records"];
    expect(inspectNetworkSpec?.inputSchema).toMatchObject({
      properties: expect.objectContaining({
        url: expect.any(Object),
        hostname: expect.any(Object),
        path: expect.any(Object),
        method: expect.any(Object),
        status: expect.any(Object),
        resourceType: expect.any(Object),
      }),
    });
  });
});

describe("protocol surface descriptors", () => {
  test("keeps operation, REST, and MCP descriptors in lockstep", () => {
    const operationNames = opensteerSemanticOperationSpecifications.map((spec) => spec.name);
    const restNames = opensteerSemanticRestEndpoints.map((endpoint) => endpoint.name);
    const mcpNames = opensteerMcpTools.map((tool) => tool.operation);
    const uniqueRestPaths = new Set(
      opensteerSemanticRestEndpoints.map((endpoint) => endpoint.path),
    );
    const uniqueToolNames = new Set(opensteerMcpTools.map((tool) => tool.name));

    expect(restNames).toEqual(operationNames);
    expect(mcpNames).toEqual(operationNames);
    expect(uniqueRestPaths.size).toBe(opensteerSemanticRestEndpoints.length);
    expect(uniqueToolNames.size).toBe(opensteerMcpTools.length);
    expect(opensteerOperationSpecificationMap["page.navigate"]?.requiredCapabilities).toEqual([
      "pages.navigate",
    ]);
  });

  test("uses versioned request envelopes for REST and raw operation schemas for MCP", () => {
    const restGoto = opensteerSemanticRestEndpoints.find(
      (endpoint) => endpoint.name === "page.goto",
    );
    const mcpGoto = opensteerMcpTools.find((tool) => tool.operation === "page.goto");

    const restVersion = restGoto?.requestSchema.properties?.version;
    const restOperation = restGoto?.requestSchema.properties?.operation;
    const restResponseOperations = restGoto?.responseSchema.oneOf?.map(
      (schema) => schema.properties?.operation,
    );

    expect(restGoto?.method).toBe("POST");
    expect(restGoto?.path).toBe(
      `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/page/goto`,
    );
    expect(restVersion).toMatchObject({
      const: OPENSTEER_PROTOCOL_VERSION,
    });
    expect(restOperation).toMatchObject({
      const: "page.goto",
    });
    expect(restResponseOperations).toEqual([
      expect.objectContaining({ const: "page.goto" }),
      expect.objectContaining({ const: "page.goto" }),
    ]);
    expect(mcpGoto?.name).toBe("opensteer_page_goto");
    expect(mcpGoto?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });

  test("normalizes public operation names into readable MCP titles", () => {
    const tool = opensteerMcpTools.find((entry) => entry.operation === "dom.extract");

    expect(tool?.name).toBe("opensteer_dom_extract");
    expect(tool?.title).toBe("DOM Extract");
  });

  test("models exclusive targets and input-aware capability requirements", () => {
    const domSnapshotSpec = opensteerOperationSpecificationMap["inspect.get-dom-snapshot"];
    const executionStateSpec = opensteerOperationSpecificationMap["execution.set-state"];
    const networkRecordsSpec = opensteerOperationSpecificationMap["inspect.get-network-records"];
    const storageSnapshotSpec = opensteerOperationSpecificationMap["inspect.get-storage-snapshot"];

    expect(domSnapshotSpec?.inputSchema.oneOf?.map((branch) => branch.required)).toEqual([
      ["frameRef"],
      ["documentRef"],
    ]);
    expect(
      resolveRequiredCapabilities(executionStateSpec!, {
        pageRef: "page:main",
        paused: false,
      }),
    ).toEqual(["execution.resume"]);
    expect(
      resolveRequiredCapabilities(executionStateSpec!, {
        pageRef: "page:main",
        frozen: false,
      }),
    ).toEqual(["execution.freeze"]);
    expect(
      resolveRequiredCapabilities(networkRecordsSpec!, {
        sessionRef: "session:main",
        includeBodies: true,
      }),
    ).toEqual(["inspect.network", "inspect.networkBodies"]);
    expect(
      resolveRequiredCapabilities(storageSnapshotSpec!, {
        sessionRef: "session:main",
      }),
    ).toEqual(["inspect.localStorage", "inspect.sessionStorage", "inspect.indexedDb"]);
    expect(
      resolveRequiredCapabilities(storageSnapshotSpec!, {
        sessionRef: "session:main",
        includeSessionStorage: false,
        includeIndexedDb: false,
      }),
    ).toEqual(["inspect.localStorage"]);
  });
});

describe("semantic protocol descriptors", () => {
  test("keeps semantic operation and REST catalogs aligned", () => {
    const operationNames = opensteerSemanticOperationSpecifications.map((spec) => spec.name);
    const restNames = opensteerSemanticRestEndpoints.map((endpoint) => endpoint.name);
    const uniquePaths = new Set(opensteerSemanticRestEndpoints.map((endpoint) => endpoint.path));

    expect(restNames).toEqual(operationNames);
    expect(uniquePaths.size).toBe(opensteerSemanticRestEndpoints.length);
    expect(
      opensteerSemanticOperationSpecificationMap["session.open"]?.requiredCapabilities,
    ).toEqual(["sessions.manage", "pages.manage"]);
    expect(
      opensteerSemanticOperationSpecificationMap["computer.execute"]?.requiredCapabilities,
    ).toEqual(["artifacts.screenshot", "inspect.viewportMetrics"]);
    expect(
      opensteerSemanticOperationSpecificationMap["request.execute"]?.requiredCapabilities,
    ).toEqual(["transport.sessionHttp"]);
  });

  test("uses the dedicated semantic REST namespace and capability resolution rules", () => {
    const openEndpoint = opensteerSemanticRestEndpoints.find(
      (endpoint) => endpoint.name === "session.open",
    );
    const extractEndpoint = opensteerSemanticRestEndpoints.find(
      (endpoint) => endpoint.name === "dom.extract",
    );
    const computerEndpoint = opensteerSemanticRestEndpoints.find(
      (endpoint) => endpoint.name === "computer.execute",
    );
    const requestEndpoint = opensteerSemanticRestEndpoints.find(
      (endpoint) => endpoint.name === "request.execute",
    );

    expect(openEndpoint?.path).toBe(
      `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/session/open`,
    );
    expect(extractEndpoint?.path).toBe(
      `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/dom/extract`,
    );
    expect(computerEndpoint?.path).toBe(
      `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/computer/execute`,
    );
    expect(requestEndpoint?.path).toBe(
      `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/semantic/operations/request/execute`,
    );
    expect(
      resolveSemanticRequiredCapabilities(
        opensteerSemanticOperationSpecificationMap["session.open"]!,
        {
          url: "https://example.com",
        },
      ),
    ).toEqual(["sessions.manage", "pages.manage", "pages.navigate"]);
    expect(
      resolveSemanticRequiredCapabilities(
        opensteerSemanticOperationSpecificationMap["dom.extract"]!,
        {
          description: "product cards",
        },
      ),
    ).toEqual(["inspect.domSnapshot", "inspect.text", "inspect.attributes"]);
    expect(
      resolveSemanticRequiredCapabilities(
        opensteerSemanticOperationSpecificationMap["computer.execute"]!,
        {
          action: {
            type: "drag",
            start: { x: 10, y: 20 },
            end: { x: 50, y: 60 },
          },
        },
      ),
    ).toEqual(["input.pointer", "artifacts.screenshot", "inspect.viewportMetrics"]);
    expect(
      resolveSemanticRequiredCapabilities(
        opensteerSemanticOperationSpecificationMap["computer.execute"]!,
        {
          action: {
            type: "key",
            key: "Enter",
          },
        },
      ),
    ).toEqual(["input.keyboard", "artifacts.screenshot", "inspect.viewportMetrics"]);
  });

  test("validates the computer.execute action union at the semantic boundary", () => {
    expect(() =>
      assertValidSemanticOperationInput("computer.execute", {
        action: {
          type: "click",
          x: 10,
          y: 20,
          clickCount: 2,
        },
        screenshot: {
          disableAnnotations: ["clickable", "grid"],
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertValidSemanticOperationInput("computer.execute", {
        action: {
          type: "wait",
          durationMs: -1,
        },
      }),
    ).toThrow(/invalid computer\.execute input/i);

    const computerOutputSchema =
      opensteerSemanticOperationSpecificationMap["computer.execute"]?.outputSchema;
    expect(computerOutputSchema?.required).toContain("displayViewport");
    expect(computerOutputSchema?.required).toContain("nativeViewport");
    expect(computerOutputSchema?.required).toContain("displayScale");
    expect(
      computerOutputSchema?.properties?.screenshot?.properties?.coordinateSpace?.enum,
    ).toContain("computer-display-css");
    expect(
      computerOutputSchema?.properties?.screenshot?.properties?.payload?.properties?.delivery?.enum,
    ).toContain("external");
    expect(
      computerOutputSchema?.properties?.screenshot?.properties?.payload?.properties,
    ).not.toHaveProperty("data");
  });

  test("validates request workflow shapes at the semantic boundary", () => {
    expect(() =>
      assertValidSemanticOperationInput("request-plan.write", {
        key: "get-user",
        version: "1.0.0",
        payload: {
          transport: {
            kind: "session-http",
            requiresBrowser: true,
          },
          endpoint: {
            method: "GET",
            urlTemplate: "https://example.com/users/{userId}",
          },
          parameters: [
            {
              name: "userId",
              in: "path",
            },
          ],
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertValidSemanticOperationInput("request.execute", {
        key: "get-user",
        params: {
          userId: "abc",
        },
        headers: {
          csrf: "token",
        },
      }),
    ).not.toThrow();
  });
});

describe("protocol trace and artifact schemas", () => {
  test("exports discriminated unions for public events and artifacts", () => {
    expect(opensteerEventSchema.oneOf).toHaveLength(18);
    expect(opensteerArtifactSchema.oneOf).toHaveLength(5);
  });

  test("preserves shadow and iframe metadata in the public DOM snapshot schema", () => {
    expect(domSnapshotNodeSchema.properties?.shadowRootType).toMatchObject({
      enum: ["open", "closed", "user-agent"],
    });
    expect(domSnapshotNodeSchema.properties?.shadowHostNodeRef).toBeDefined();
    expect(domSnapshotNodeSchema.properties?.contentDocumentRef).toBeDefined();
    expect(domSnapshotSchema.properties?.shadowDomMode).toMatchObject({
      enum: ["flattened", "preserved", "unsupported"],
    });
  });

  test("exports request plan schemas for public request workflow records", () => {
    expect(opensteerRequestPlanPayloadSchema.properties?.transport).toBeDefined();
    expect(opensteerRequestPlanRecordSchema.properties?.payload).toBeDefined();
  });
});
