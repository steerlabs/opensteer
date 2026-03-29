import { randomUUID } from "node:crypto";

import WebSocket from "ws";
import { OPENSTEER_RUNTIME_CORE_VERSION } from "@opensteer/runtime-core";

import {
  OPENSTEER_PROTOCOL_NAME,
  OPENSTEER_PROTOCOL_VERSION,
  createOpensteerError,
  type OpensteerAutomationClientMessage,
  type OpensteerAutomationInvokeMessage,
  type OpensteerAutomationServerMessage,
  type OpensteerAutomationOperationName,
  type OpensteerError,
  type OpensteerSessionGrant,
  type OpensteerSessionGrantKind,
  type OpensteerSessionInfo,
} from "@opensteer/protocol";

import type {
  OpensteerInterceptScriptOptions,
  OpensteerFetchedRouteResponse,
  OpensteerRouteRequest,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "../sdk/instrumentation.js";
import type { OpensteerCloudClient } from "./client.js";

interface PendingInvocation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface StoredRouteRegistration {
  readonly kind: "route" | "intercept-script";
  readonly routeId: string;
  readonly input: OpensteerRouteOptions | OpensteerInterceptScriptOptions;
}

export class OpensteerCloudAutomationError extends Error {
  readonly opensteerError: OpensteerError;

  constructor(error: OpensteerError) {
    super(error.message);
    this.name = "OpensteerCloudAutomationError";
    this.opensteerError = error;
  }
}

export class OpensteerCloudAutomationClient {
  private socket: WebSocket | undefined;
  private connectPromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly routes = new Map<string, StoredRouteRegistration>();
  private grant: OpensteerSessionGrant | undefined;

  constructor(
    private readonly cloud: OpensteerCloudClient,
    private readonly sessionId: string,
  ) {}

  async invoke<TInput, TOutput>(
    operation: OpensteerAutomationOperationName,
    input: TInput,
  ): Promise<TOutput> {
    await this.ensureConnected();
    const requestId = `automation:${randomUUID()}`;
    const message: OpensteerAutomationInvokeMessage = {
      protocol: OPENSTEER_PROTOCOL_NAME,
      version: OPENSTEER_PROTOCOL_VERSION,
      kind: "invoke",
      requestId,
      operation,
      sentAt: Date.now(),
      ...(input === undefined ? {} : { input }),
    };

    return new Promise<TOutput>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as TOutput),
        reject,
      });
      try {
        this.requireSocket().send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async getSessionInfo(): Promise<OpensteerSessionInfo> {
    const result = (await this.invoke("session.info", {})) as {
      readonly provider: OpensteerSessionInfo["provider"];
      readonly workspace?: string;
      readonly sessionId?: string;
      readonly activePageRef?: string;
      readonly reconnectable: boolean;
      readonly capabilities: OpensteerSessionInfo["capabilities"];
      readonly grants?: OpensteerSessionInfo["grants"];
      readonly runtime?: OpensteerSessionInfo["runtime"];
    };
    const sessionInfo = result as OpensteerSessionInfo;
    assertCompatibleRuntimeCoreVersion(sessionInfo);
    return sessionInfo;
  }

  async route(input: OpensteerRouteOptions): Promise<OpensteerRouteRegistration> {
    const routeId = `route:${randomUUID()}`;
    const registration = (await this.invoke("route.register", {
      routeId,
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      urlPattern: input.urlPattern,
      ...(input.resourceTypes === undefined
        ? {}
        : { resourceTypes: input.resourceTypes }),
      ...(input.times === undefined ? {} : { times: input.times }),
      includeOriginal: true,
    })) as OpensteerRouteRegistration;
    this.routes.set(routeId, {
      kind: "route",
      routeId,
      input,
    });
    return registration;
  }

  async interceptScript(
    input: OpensteerInterceptScriptOptions,
  ): Promise<OpensteerRouteRegistration> {
    const routeId = `route:${randomUUID()}`;
    const registration = (await this.invoke("route.register", {
      routeId,
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      urlPattern: input.urlPattern,
      resourceTypes: ["script"],
      ...(input.times === undefined ? {} : { times: input.times }),
      includeOriginal: true,
    })) as OpensteerRouteRegistration;
    this.routes.set(routeId, {
      kind: "intercept-script",
      routeId,
      input,
    });
    return registration;
  }

  async close(): Promise<void> {
    this.connectPromise = undefined;
    this.grant = undefined;
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = undefined;
    for (const [requestId, pending] of this.pending) {
      pending.reject(new Error(`automation connection closed before ${requestId} completed`));
    }
    this.pending.clear();
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    }).catch(() => undefined);
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connect(): Promise<void> {
    const grant = await this.issueGrant("automation");
    const wsUrl = new URL(grant.wsUrl);
    wsUrl.searchParams.set("token", grant.token);

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      this.handleMessage(data.toString());
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
    });
    socket.on("error", (error: Error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    this.send({
      protocol: OPENSTEER_PROTOCOL_NAME,
      version: OPENSTEER_PROTOCOL_VERSION,
      kind: "hello",
      sessionId: this.sessionId,
      grantKind: grant.kind,
    });
    await this.restoreRoutes();
  }

  private async restoreRoutes(): Promise<void> {
    const stored = [...this.routes.values()];
    this.routes.clear();

    for (const registration of stored) {
      if (registration.kind === "route") {
        await this.route(registration.input as OpensteerRouteOptions);
      } else {
        await this.interceptScript(
          registration.input as OpensteerInterceptScriptOptions,
        );
      }
    }
  }

  private handleMessage(json: string): void {
    const message = JSON.parse(json) as OpensteerAutomationServerMessage;
    if (message.protocol !== OPENSTEER_PROTOCOL_NAME) {
      return;
    }

    switch (message.kind) {
      case "result": {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(message.requestId);
        pending.resolve(message.data);
        return;
      }
      case "error": {
        if (!message.requestId) {
          return;
        }
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(message.requestId);
        pending.reject(new OpensteerCloudAutomationError(message.error));
        return;
      }
      case "event":
        void this.handleEvent(message.event, message.data);
        return;
      case "pong":
        return;
    }
  }

  private async handleEvent(event: string, payload: unknown): Promise<void> {
    if (event !== "route.request") {
      return;
    }

    const data = asRecord(payload);
    const request = asRecord(data.request);
    const original = asRecord(data.original);
    const routeId =
      typeof data.routeId === "string" ? data.routeId : "";
    const routeRequestId =
      typeof data.routeRequestId === "string" ? data.routeRequestId : "";
    if (!routeId || !routeRequestId) {
      return;
    }

    const registration = this.routes.get(routeId);
    if (!registration) {
      await this.invoke("route.resolve", {
        routeRequestId,
        decision: { kind: "continue" },
      }).catch(() => undefined);
      return;
    }

    try {
      const decision =
        registration.kind === "route"
          ? await (registration.input as OpensteerRouteOptions).handler({
              request: toRouteRequest(request),
              fetchOriginal: async () => toFetchedRouteResponse(original),
            })
          : {
              kind: "fulfill" as const,
              body: await (
                registration.input as OpensteerInterceptScriptOptions
              ).handler({
                url: typeof request.url === "string" ? request.url : "",
                content: typeof original.body === "string" ? original.body : "",
                headers: Array.isArray(original.headers)
                  ? original.headers.filter(isHeaderEntry)
                  : [],
                status:
                  typeof original.status === "number"
                    ? original.status
                    : 200,
              }),
              headers: Array.isArray(original.headers)
                ? original.headers.filter(isHeaderEntry)
                : [],
              status:
                typeof original.status === "number"
                  ? original.status
                  : 200,
              contentType:
                findHeaderValue(
                  Array.isArray(original.headers)
                    ? original.headers.filter(isHeaderEntry)
                    : [],
                  "content-type",
                ) ?? "application/javascript; charset=utf-8",
            };

      await this.invoke("route.resolve", {
        routeRequestId,
        decision: serializeRouteDecision(decision),
      }).catch(() => undefined);
    } catch {
      await this.invoke("route.resolve", {
        routeRequestId,
        decision: { kind: "continue" },
      }).catch(() => undefined);
    }
  }

  private async issueGrant(
    kind: OpensteerSessionGrantKind,
  ): Promise<OpensteerSessionGrant> {
    if (
      this.grant &&
      this.grant.kind === kind &&
      this.grant.expiresAt > Date.now() + 10_000
    ) {
      return this.grant;
    }

    const issued = await this.cloud.issueAccess(this.sessionId, [kind]);
    const grant = issued.grants[kind];
    if (!grant) {
      throw new OpensteerCloudAutomationError(
        createOpensteerError(
          "permission-denied",
          `cloud did not issue an ${kind} automation grant`,
        ),
      );
    }
    this.grant = grant;
    return grant;
  }

  private requireSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("cloud automation socket is not connected");
    }
    return this.socket;
  }

  private send(message: OpensteerAutomationClientMessage): void {
    this.requireSocket().send(JSON.stringify(message));
  }
}

function assertCompatibleRuntimeCoreVersion(sessionInfo: OpensteerSessionInfo): void {
  const runtimeCoreVersion = sessionInfo.runtime?.runtimeCoreVersion;
  if (runtimeCoreVersion === undefined) {
    return;
  }

  const expectedMajor = parseMajorVersion(OPENSTEER_RUNTIME_CORE_VERSION);
  const actualMajor = parseMajorVersion(runtimeCoreVersion);
  if (expectedMajor === null || actualMajor === null || expectedMajor === actualMajor) {
    return;
  }

  throw new Error(
    `cloud runtime-core major version ${runtimeCoreVersion} is incompatible with local SDK runtime-core ${OPENSTEER_RUNTIME_CORE_VERSION}`,
  );
}

function parseMajorVersion(version: string): number | null {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

function serializeRouteDecision(
  decision:
    | { readonly kind: "continue" }
    | { readonly kind: "abort"; readonly errorCode?: string }
    | {
        readonly kind: "fulfill";
        readonly status?: number;
        readonly headers?: readonly { readonly name: string; readonly value: string }[];
        readonly body?: string | Uint8Array;
        readonly contentType?: string;
      },
): Record<string, unknown> {
  if (decision.kind === "continue") {
    return { kind: "continue" };
  }

  if (decision.kind === "abort") {
    return {
      kind: "abort",
      ...(decision.errorCode === undefined ? {} : { errorCode: decision.errorCode }),
    };
  }

  return {
    kind: "fulfill",
    ...(decision.status === undefined ? {} : { status: decision.status }),
    ...(decision.headers === undefined ? {} : { headers: decision.headers }),
    ...(decision.body === undefined
      ? {}
      : typeof decision.body === "string"
        ? { body: decision.body }
        : { bodyBase64: Buffer.from(decision.body).toString("base64") }),
    ...(decision.contentType === undefined
      ? {}
      : { contentType: decision.contentType }),
  };
}

function toRouteRequest(record: Record<string, unknown>): OpensteerRouteRequest {
  const pageRef =
    typeof record.pageRef === "string"
      ? (record.pageRef as OpensteerRouteRequest["pageRef"])
      : undefined;
  return {
    url: typeof record.url === "string" ? record.url : "",
    method: typeof record.method === "string" ? record.method : "GET",
    headers: Array.isArray(record.headers) ? record.headers.filter(isHeaderEntry) : [],
    resourceType:
      typeof record.resourceType === "string"
        ? (record.resourceType as OpensteerRouteRequest["resourceType"])
        : "other",
    ...(pageRef === undefined ? {} : { pageRef }),
    ...(typeof record.postData === "string"
      ? {
          postData: {
            bytes: Uint8Array.from(Buffer.from(record.postData)),
            encoding: "identity",
            truncated: false,
            capturedByteLength: Buffer.byteLength(record.postData),
          },
        }
      : {}),
  };
}

function toFetchedRouteResponse(
  record: Record<string, unknown>,
): OpensteerFetchedRouteResponse {
  return {
    url: typeof record.url === "string" ? record.url : "",
    status: typeof record.status === "number" ? record.status : 200,
    statusText:
      typeof record.statusText === "string" ? record.statusText : "OK",
    headers: Array.isArray(record.headers) ? record.headers.filter(isHeaderEntry) : [],
    ...(typeof record.body === "string"
      ? {
          body: {
            bytes: Uint8Array.from(Buffer.from(record.body)),
            encoding: "identity",
            truncated: false,
            capturedByteLength: Buffer.byteLength(record.body),
          },
        }
      : {}),
    redirected: Boolean(record.redirected),
  };
}

function findHeaderValue(
  headers: readonly { readonly name: string; readonly value: string }[],
  name: string,
): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name)?.value;
}

function isHeaderEntry(
  value: unknown,
): value is { readonly name: string; readonly value: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { value?: unknown }).value === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
