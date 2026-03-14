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
import { OpensteerSessionRuntime } from "../sdk/runtime.js";
import {
  isProcessAlive,
  removeOpensteerServiceMetadata,
  writeOpensteerServiceMetadata,
} from "./service-metadata.js";

const PING_PATH = "/runtime/ping";

export async function runOpensteerServiceHost(options: {
  readonly name: string;
  readonly rootDir?: string;
}): Promise<void> {
  const runtime = new OpensteerSessionRuntime({
    name: options.name,
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
  });
  const rootPath = runtime.rootPath;
  const token = randomBytes(24).toString("hex");
  const endpointByPath = new Map(opensteerSemanticRestEndpoints.map((endpoint) => [endpoint.path, endpoint]));
  let shuttingDown = false;
  let requestQueue = Promise.resolve();

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === PING_PATH) {
      void handlePing(request, response, token, {
        name: runtime.name,
        rootPath,
      });
      return;
    }

    requestQueue = requestQueue
      .then(async () => {
        await handleRequest(request, response, {
          runtime,
          token,
          endpointByPath,
          rootPath,
          onClosed: async () => {
            shuttingDown = true;
            await shutdown();
          },
        });
      })
      .catch((error) => {
        const normalized = normalizeOpensteerError(error);
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
    name: runtime.name,
    rootPath,
    pid: process.pid,
    port: address.port,
    token,
    startedAt: Date.now(),
    baseUrl,
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
      createOpensteerError("invalid-request", `expected ${endpoint.name}, received ${envelope.operation}`),
    );
    return;
  }

  try {
    assertValidSemanticOperationInput(endpoint.name, envelope.input);
    const data = await dispatchOperation(options.runtime, endpoint.name, envelope.input);
    const result = createSuccessEnvelope(envelope, data);
    writeJson(response, 200, result);

    if (endpoint.name === "session.close") {
      setImmediate(() => {
        void options.onClosed();
      });
    }
  } catch (error) {
    writeProtocolError(response, envelope, normalizeOpensteerError(error));
  }
}

async function dispatchOperation(
  runtime: OpensteerSessionRuntime,
  operation: OpensteerSemanticOperationName,
  input: unknown,
): Promise<unknown> {
  switch (operation) {
    case "session.open":
      return runtime.open((input ?? {}) as Parameters<OpensteerSessionRuntime["open"]>[0]);
    case "page.goto":
      return runtime.goto(input as Parameters<OpensteerSessionRuntime["goto"]>[0]);
    case "page.snapshot":
      return runtime.snapshot((input ?? {}) as Parameters<OpensteerSessionRuntime["snapshot"]>[0]);
    case "dom.click":
      return runtime.click(input as Parameters<OpensteerSessionRuntime["click"]>[0]);
    case "dom.hover":
      return runtime.hover(input as Parameters<OpensteerSessionRuntime["hover"]>[0]);
    case "dom.input":
      return runtime.input(input as Parameters<OpensteerSessionRuntime["input"]>[0]);
    case "dom.scroll":
      return runtime.scroll(input as Parameters<OpensteerSessionRuntime["scroll"]>[0]);
    case "dom.extract":
      return runtime.extract(input as Parameters<OpensteerSessionRuntime["extract"]>[0]);
    case "session.close":
      return runtime.close();
  }
}

function parseRequestEnvelope(value: unknown): OpensteerRequestEnvelope<unknown> {
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

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function normalizeOpensteerError(error: unknown) {
  return normalizeThrownOpensteerError(error, "Unknown Opensteer service failure");
}
