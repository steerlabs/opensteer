import { randomUUID } from "node:crypto";

import {
  createRequestEnvelope,
  isErrorEnvelope,
  opensteerSemanticRestEndpoints,
  type OpensteerError,
  type OpensteerResponseEnvelope,
  type OpensteerSemanticOperationName,
  type OpensteerSessionCloseOutput,
} from "@opensteer/protocol";

import { OpensteerCloudClient } from "../cloud/client.js";
import { resolveCloudConfig } from "../cloud/config.js";
import { type OpensteerEngineName } from "../internal/engine-selection.js";
import {
  getOpensteerServiceMetadataPath,
  isLocalOpensteerServiceMetadata,
  isProcessAlive,
  normalizeOpensteerSessionName,
  parseOpensteerServiceMetadata,
  readOpensteerServiceMetadata,
  removeOpensteerServiceMetadata,
  resolveOpensteerSessionRootPath,
  writeOpensteerServiceMetadata,
  type OpensteerCloudServiceMetadata,
  type OpensteerServiceMetadata,
  type ParsedOpensteerServiceMetadata,
} from "./metadata.js";

const PING_PATH = "/runtime/ping";
const SERVICE_PING_TIMEOUT_MS = 1_000;

export class OpensteerCliServiceError extends Error {
  readonly opensteerError: OpensteerError;
  readonly statusCode: number;

  constructor(error: OpensteerError, statusCode: number) {
    super(error.message);
    this.name = "OpensteerCliServiceError";
    this.opensteerError = error;
    this.statusCode = statusCode;
  }
}

export interface OpensteerServiceConnection {
  readonly baseUrl: string;
  readonly getAuthorizationHeader: () => Promise<string>;
}

export interface OpensteerCliSessionOptions {
  readonly name?: string;
  readonly rootDir?: string;
  readonly engine?: OpensteerEngineName;
}

export class OpensteerSessionServiceClient {
  constructor(private readonly connection: OpensteerServiceConnection) {}

  static fromConnection(connection: OpensteerServiceConnection): OpensteerSessionServiceClient {
    return new OpensteerSessionServiceClient(connection);
  }

  static fromMetadata(metadata: OpensteerServiceMetadata): OpensteerSessionServiceClient {
    return new OpensteerSessionServiceClient(createConnectionFromMetadata(metadata));
  }

  async invoke<TInput, TOutput>(
    operation: OpensteerSemanticOperationName,
    input: TInput,
  ): Promise<TOutput> {
    const endpoint = opensteerSemanticRestEndpoints.find((entry) => entry.name === operation);
    if (!endpoint) {
      throw new Error(`unsupported semantic operation ${operation}`);
    }

    const request = createRequestEnvelope(operation, input, {
      requestId: `req:${randomUUID()}`,
    });

    let response: Response;
    try {
      response = await fetch(`${this.connection.baseUrl}${endpoint.path}`, {
        method: "POST",
        headers: {
          authorization: await this.connection.getAuthorizationHeader(),
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (operation === "session.close" && isFetchFailure(error)) {
        return { closed: true } as TOutput;
      }
      throw error;
    }

    try {
      const envelope = (await response.json()) as OpensteerResponseEnvelope<TOutput>;
      if (isErrorEnvelope(envelope)) {
        throw new OpensteerCliServiceError(envelope.error, response.status);
      }

      return envelope.data;
    } catch (error) {
      if (operation === "session.close" && isFetchFailure(error)) {
        return { closed: true } as TOutput;
      }
      throw error;
    }
  }

  async closeSession(): Promise<OpensteerSessionCloseOutput> {
    return this.invoke("session.close", {});
  }
}

export { OpensteerSessionServiceClient as OpensteerCliServiceClient };

export async function connectOpensteerService(
  options: OpensteerCliSessionOptions = {},
): Promise<OpensteerSessionServiceClient | undefined> {
  const metadata = await resolveLiveOpensteerServiceMetadata(options);
  if (!metadata) {
    return undefined;
  }

  return OpensteerSessionServiceClient.fromMetadata(metadata);
}

export async function requireOpensteerService(
  options: OpensteerCliSessionOptions = {},
): Promise<OpensteerSessionServiceClient> {
  const client = await connectOpensteerService(options);
  if (!client) {
    const rootPath = resolveOpensteerSessionRootPath(options.rootDir);
    throw new Error(
      `Opensteer session "${normalizeOpensteerSessionName(options.name)}" is not running. Expected metadata at ${getOpensteerServiceMetadataPath(rootPath, normalizeOpensteerSessionName(options.name))}. Run "opensteer open" first.`,
    );
  }

  return client;
}

export async function requireAttachedLocalOpensteerService(
  options: OpensteerCliSessionOptions = {},
): Promise<OpensteerSessionServiceClient> {
  const metadata = await resolveLiveOpensteerServiceMetadata(options);
  if (!metadata) {
    const rootPath = resolveOpensteerSessionRootPath(options.rootDir);
    throw new Error(
      `Opensteer session "${normalizeOpensteerSessionName(options.name)}" is not running. Expected metadata at ${getOpensteerServiceMetadataPath(rootPath, normalizeOpensteerSessionName(options.name))}. Open the session first before attaching.`,
    );
  }

  if (!isLocalOpensteerServiceMetadata(metadata)) {
    throw new Error(
      `Opensteer.attach only supports local sessions in this release. Session "${metadata.name}" is running in cloud mode.`,
    );
  }

  return OpensteerSessionServiceClient.fromMetadata(metadata);
}

export async function loadOpensteerServiceMetadata(
  options: OpensteerCliSessionOptions,
): Promise<ParsedOpensteerServiceMetadata | undefined> {
  const name = normalizeOpensteerSessionName(options.name);
  const rootPath = resolveOpensteerSessionRootPath(options.rootDir);
  const metadataPath = getOpensteerServiceMetadataPath(rootPath, name);
  const rawMetadata = await readOpensteerServiceMetadata(rootPath, name);
  if (!rawMetadata) {
    return undefined;
  }

  return parseOpensteerServiceMetadata(rawMetadata, metadataPath);
}

export async function resolveLiveOpensteerServiceMetadata(
  options: OpensteerCliSessionOptions,
): Promise<OpensteerServiceMetadata | undefined> {
  const name = normalizeOpensteerSessionName(options.name);
  const rootPath = resolveOpensteerSessionRootPath(options.rootDir);
  const parsed = await loadOpensteerServiceMetadata(options);
  if (!parsed) {
    return undefined;
  }

  const { metadata } = parsed;
  if (!(await validateServiceMetadata(metadata))) {
    await removeOpensteerServiceMetadata(rootPath, name);
    return undefined;
  }

  if (parsed.needsRewrite) {
    await writeOpensteerServiceMetadata(rootPath, metadata);
  }

  if (
    isLocalOpensteerServiceMetadata(metadata)
    && options.engine !== undefined
    && metadata.engine !== options.engine
  ) {
    throw new Error(
      `Opensteer session "${name}" is already running with engine "${metadata.engine}". Run "opensteer close --name ${name}" before reopening it with engine "${options.engine}".`,
    );
  }

  return metadata;
}

async function validateServiceMetadata(metadata: OpensteerServiceMetadata): Promise<boolean> {
  if (isLocalOpensteerServiceMetadata(metadata) && !isProcessAlive(metadata.pid)) {
    return false;
  }

  try {
    const response = await fetch(`${metadata.baseUrl}${PING_PATH}`, {
      headers: {
        authorization: await createConnectionFromMetadata(metadata).getAuthorizationHeader(),
      },
      signal: AbortSignal.timeout(SERVICE_PING_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as { readonly ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function createConnectionFromMetadata(metadata: OpensteerServiceMetadata): OpensteerServiceConnection {
  if (isLocalOpensteerServiceMetadata(metadata)) {
    return {
      baseUrl: metadata.baseUrl,
      getAuthorizationHeader: async () => `Bearer ${metadata.token}`,
    };
  }

  return createCloudConnection(metadata);
}

function createCloudConnection(metadata: OpensteerCloudServiceMetadata): OpensteerServiceConnection {
  const config = resolveCloudConfig({
    enabled: true,
  });
  if (!config) {
    throw new Error(`Cloud credentials for session "${metadata.name}" are unavailable.`);
  }
  const cloud = new OpensteerCloudClient(config);
  return {
    baseUrl: metadata.baseUrl,
    getAuthorizationHeader: async () => cloud.buildAuthorizationHeader(),
  };
}

function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TypeError" || /fetch failed/i.test(error.message);
}

