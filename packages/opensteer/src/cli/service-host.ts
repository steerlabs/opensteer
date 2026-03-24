import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import {
  OPENSTEER_PROTOCOL_NAME,
  OPENSTEER_PROTOCOL_VERSION,
  assertValidSemanticOperationInput,
  createErrorEnvelope,
  createOpensteerError,
  createSuccessEnvelope,
  httpStatusForOpensteerError,
  opensteerSemanticRestEndpoints,
  OpensteerProtocolError,
  unsupportedVersionError,
  type OpensteerRequestEnvelope,
  type OpensteerSemanticOperationName,
} from "@opensteer/protocol";

import { normalizeThrownOpensteerError } from "../internal/errors.js";
import {
  createOpensteerEngineFactory,
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import { OpensteerSessionRuntime } from "../sdk/runtime.js";
import {
  isProcessAlive,
  removeOpensteerServiceMetadata,
  writeOpensteerServiceMetadata,
} from "./service-metadata.js";
import { dispatchSemanticOperation } from "./dispatch.js";
import { assertExecutionModeSupportsEngine } from "../mode/config.js";

const PING_PATH = "/runtime/ping";

export async function runOpensteerServiceHost(options: {
  readonly name: string;
  readonly rootDir?: string;
  readonly engine?: OpensteerEngineName;
}): Promise<void> {
  const engine = options.engine ?? DEFAULT_OPENSTEER_ENGINE;
  const mode = "local";
  assertExecutionModeSupportsEngine(mode, engine);
  const runtime = new OpensteerSessionRuntime({
    name: options.name,
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    engineFactory: createOpensteerEngineFactory(engine),
  });
  const rootPath = runtime.rootPath;
  const token = randomBytes(24).toString("hex");
  const endpointByPath = new Map(
    opensteerSemanticRestEndpoints.map((endpoint) => [endpoint.path, endpoint]),
  );
  const scheduler = new ServiceOperationScheduler();
  let shuttingDown = false;

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === PING_PATH) {
      void handlePing(request, response, token, {
        name: runtime.name,
        rootPath,
      });
      return;
    }

    void handleRequest(request, response, {
      runtime,
      token,
      endpointByPath,
      rootPath,
      scheduler,
      onClosed: async () => {
        shuttingDown = true;
        await shutdown();
      },
    }).catch((error) => {
      const normalized = normalizeOpensteerError(error);
      if (response.destroyed) {
        return;
      }
      if (!response.headersSent) {
        writeJson(response, httpStatusForOpensteerError(normalized), {
          error: normalized,
        });
      } else {
        response.end();
      }
    });
  });

  const shutdown = async () => {
    if (!isProcessAlive(process.pid)) {
      return;
    }

    await removeOpensteerServiceMetadata(rootPath, runtime.name);
    server.close();
  };

  process.on("SIGINT", () => {
    shuttingDown = true;
    void shutdown();
  });
  process.on("SIGTERM", () => {
    shuttingDown = true;
    void shutdown();
  });
  process.on("exit", () => {
    void removeOpensteerServiceMetadata(rootPath, runtime.name);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start Opensteer service host");
  }

  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  await writeOpensteerServiceMetadata(rootPath, {
    mode,
    name: runtime.name,
    rootPath,
    pid: process.pid,
    port: address.port,
    token,
    startedAt: Date.now(),
    baseUrl,
    engine,
  });

  await once(server, "close");

  if (!shuttingDown) {
    await runtime.close().catch(() => {});
  }
}

async function handlePing(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  metadata: {
    readonly name: string;
    readonly rootPath: string;
  },
): Promise<void> {
  if (!isAuthorized(request, token)) {
    writeJson(response, 401, {
      error: "unauthorized",
    });
    return;
  }

  writeJson(response, 200, {
    ok: true,
    name: metadata.name,
    rootPath: metadata.rootPath,
    pid: process.pid,
    protocol: OPENSTEER_PROTOCOL_NAME,
    version: OPENSTEER_PROTOCOL_VERSION,
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly runtime: OpensteerSessionRuntime;
    readonly token: string;
    readonly endpointByPath: ReadonlyMap<string, (typeof opensteerSemanticRestEndpoints)[number]>;
    readonly rootPath: string;
    readonly scheduler: ServiceOperationScheduler;
    readonly onClosed: () => Promise<void>;
  },
): Promise<void> {
  if (!isAuthorized(request, options.token)) {
    writeJson(response, 401, {
      error: "unauthorized",
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method-not-allowed",
    });
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const endpoint = options.endpointByPath.get(url.pathname);
  if (!endpoint) {
    writeJson(response, 404, {
      error: "not-found",
    });
    return;
  }

  const envelope = parseRequestEnvelope(await readJsonBody(request));
  if (envelope.version !== OPENSTEER_PROTOCOL_VERSION) {
    writeProtocolError(response, envelope, unsupportedVersionError(envelope.version));
    return;
  }
  if (envelope.operation !== endpoint.name) {
    writeProtocolError(
      response,
      envelope,
      createOpensteerError(
        "invalid-request",
        `expected ${endpoint.name}, received ${envelope.operation}`,
      ),
    );
    return;
  }

  const abortController = new AbortController();
  const abort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(
        new Error("The client disconnected before the Opensteer operation completed."),
      );
    }
  };
  request.on("aborted", abort);
  request.on("close", abort);
  response.on("close", () => {
    if (!response.writableEnded) {
      abort();
    }
  });

  try {
    assertValidSemanticOperationInput(endpoint.name, envelope.input);
    const data = await options.scheduler.run({
      operation: endpoint.name,
      input: envelope.input,
      signal: abortController.signal,
      task: () =>
        dispatchSemanticOperation(options.runtime, endpoint.name, envelope.input, {
          signal: abortController.signal,
        }),
    });
    if (response.destroyed) {
      return;
    }
    if (endpoint.name === "session.close") {
      const result = createSuccessEnvelope(envelope, data);
      writeJson(response, 200, result, () => {
        void options.onClosed();
      });
      return;
    }

    const result = createSuccessEnvelope(envelope, data);
    writeJson(response, 200, result);
  } catch (error) {
    writeProtocolError(response, envelope, normalizeOpensteerError(error));
  }
}

export class ServiceOperationScheduler {
  private engineLane: Promise<void> = Promise.resolve();

  run<T>(options: {
    readonly operation: OpensteerSemanticOperationName;
    readonly input: unknown;
    readonly signal: AbortSignal;
    readonly task: () => Promise<T>;
  }): Promise<T> {
    if (!requiresEngineLane(options.operation, options.input)) {
      return options.task();
    }

    const runTask = async () => {
      options.signal.throwIfAborted?.();
      return options.task();
    };
    const scheduled = this.engineLane.then(runTask, runTask);
    this.engineLane = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }
}

function requiresEngineLane(operation: OpensteerSemanticOperationName, input: unknown): boolean {
  switch (operation) {
    case "request-plan.write":
    case "request-plan.get":
    case "request-plan.list":
    case "network.clear":
      return false;
    case "network.query":
      return (input as { readonly source?: string } | undefined)?.source !== "saved";
    default:
      return true;
  }
}

export function parseRequestEnvelope(value: unknown): OpensteerRequestEnvelope<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("request body must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  if (record.protocol !== OPENSTEER_PROTOCOL_NAME) {
    throw invalidRequest(`request protocol must be ${OPENSTEER_PROTOCOL_NAME}`);
  }
  if (typeof record.version !== "string") {
    throw invalidRequest("request version must be a string");
  }
  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    throw invalidRequest("requestId must be a non-empty string");
  }
  if (typeof record.operation !== "string" || record.operation.trim().length === 0) {
    throw invalidRequest("operation must be a non-empty string");
  }
  if (typeof record.sentAt !== "number" || !Number.isInteger(record.sentAt) || record.sentAt < 0) {
    throw invalidRequest("sentAt must be a non-negative integer");
  }

  return {
    protocol: OPENSTEER_PROTOCOL_NAME,
    version: record.version,
    requestId: record.requestId,
    operation: record.operation,
    sentAt: record.sentAt,
    input: record.input,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalidRequest("request body must contain valid JSON", error);
  }
}

function invalidRequest(message: string, cause?: unknown): OpensteerProtocolError {
  return new OpensteerProtocolError("invalid-request", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  return authorization === `Bearer ${token}`;
}

function writeProtocolError(
  response: ServerResponse,
  envelope: Pick<OpensteerRequestEnvelope<unknown>, "requestId" | "operation" | "version">,
  error: ReturnType<typeof normalizeOpensteerError>,
): void {
  writeJson(response, httpStatusForOpensteerError(error), createErrorEnvelope(envelope, error));
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  onFlushed?: () => void,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`, onFlushed);
}

function normalizeOpensteerError(error: unknown) {
  return normalizeThrownOpensteerError(error, "Unknown Opensteer service failure");
}
