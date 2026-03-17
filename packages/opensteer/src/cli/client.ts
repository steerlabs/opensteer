import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createRequestEnvelope,
  isErrorEnvelope,
  opensteerSemanticRestEndpoints,
  type OpensteerError,
  type OpensteerResponseEnvelope,
  type OpensteerSemanticOperationName,
} from "@opensteer/protocol";

import {
  getOpensteerServiceMetadataPath,
  isCloudOpensteerServiceMetadata,
  isLocalOpensteerServiceMetadata,
  isProcessAlive,
  parseOpensteerServiceMetadata,
  readOpensteerServiceMetadata,
  removeOpensteerServiceMetadata,
  writeOpensteerServiceMetadata,
  type OpensteerCloudServiceMetadata,
  type OpensteerLocalServiceMetadata,
  type OpensteerServiceMetadata,
} from "./service-metadata.js";
import { type OpensteerEngineName } from "../internal/engine-selection.js";
import { OpensteerCloudClient } from "../cloud/client.js";
import { resolveCloudConfig } from "../cloud/config.js";

const PING_PATH = "/runtime/ping";
const SERVICE_START_TIMEOUT_MS = 10_000;
const SERVICE_PING_TIMEOUT_MS = 1_000;
const SERVICE_POLL_INTERVAL_MS = 100;

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

export interface OpensteerConnectSessionOptions {
  readonly url: string;
}

export interface OpensteerCliSessionOptions {
  readonly name?: string;
  readonly rootDir?: string;
  readonly engine?: OpensteerEngineName;
  readonly connect?: OpensteerConnectSessionOptions;
}

export interface OpensteerServiceLaunchContext {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly scriptPath: string;
  readonly cwd?: string;
}

export class OpensteerCliServiceClient {
  constructor(private readonly connection: OpensteerServiceConnection) {}

  static fromConnection(connection: OpensteerServiceConnection): OpensteerCliServiceClient {
    return new OpensteerCliServiceClient(connection);
  }

  static fromMetadata(metadata: OpensteerServiceMetadata): OpensteerCliServiceClient {
    return new OpensteerCliServiceClient(createConnectionFromMetadata(metadata));
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
    const response = await fetch(`${this.connection.baseUrl}${endpoint.path}`, {
      method: "POST",
      headers: {
        authorization: await this.connection.getAuthorizationHeader(),
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });

    const envelope = (await response.json()) as OpensteerResponseEnvelope<TOutput>;
    if (isErrorEnvelope(envelope)) {
      throw new OpensteerCliServiceError(envelope.error, response.status);
    }

    return envelope.data;
  }
}

export async function connectOpensteerService(
  options: OpensteerCliSessionOptions = {},
): Promise<OpensteerCliServiceClient | undefined> {
  const metadata = await resolveLiveOpensteerServiceMetadata(options);
  if (!metadata) {
    return undefined;
  }

  return OpensteerCliServiceClient.fromMetadata(metadata);
}

export async function ensureOpensteerService(
  options: OpensteerCliSessionOptions & {
    readonly launchContext: OpensteerServiceLaunchContext;
  },
): Promise<OpensteerCliServiceClient> {
  const existing = await connectOpensteerService(options);
  if (existing) {
    return existing;
  }

  const name = normalizeName(options.name);
  const serviceArgs = [
    ...options.launchContext.execArgv,
    options.launchContext.scriptPath,
    "service-host",
    "--name",
    name,
    ...(options.rootDir === undefined ? [] : ["--root-dir", options.rootDir]),
    ...(options.engine === undefined ? [] : ["--engine", options.engine]),
    ...(options.connect === undefined ? [] : ["--connect", options.connect.url]),
  ];
  const child = spawn(options.launchContext.execPath, serviceArgs, {
    cwd: options.launchContext.cwd ?? process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVICE_START_TIMEOUT_MS) {
    const metadata = await resolveLiveOpensteerServiceMetadata(options);
    if (metadata) {
      return OpensteerCliServiceClient.fromMetadata(metadata);
    }

    await wait(SERVICE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Opensteer service for "${name}" did not become ready within ${String(SERVICE_START_TIMEOUT_MS)}ms.`,
  );
}

export async function requireOpensteerService(
  options: OpensteerCliSessionOptions = {},
): Promise<OpensteerCliServiceClient> {
  const client = await connectOpensteerService(options);
  if (!client) {
    const rootPath = resolveRootPath(options.rootDir);
    throw new Error(
      `Opensteer session "${normalizeName(options.name)}" is not running. Expected metadata at ${getOpensteerServiceMetadataPath(rootPath, normalizeName(options.name))}. Run "opensteer open" first.`,
    );
  }

  return client;
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

async function loadOpensteerServiceMetadata(options: OpensteerCliSessionOptions): Promise<
  | {
      readonly metadata: OpensteerServiceMetadata;
      readonly needsRewrite: boolean;
    }
  | undefined
> {
  const name = normalizeName(options.name);
  const rootPath = resolveRootPath(options.rootDir);
  const metadataPath = getOpensteerServiceMetadataPath(rootPath, name);
  const rawMetadata = await readOpensteerServiceMetadata(rootPath, name);
  if (!rawMetadata) {
    return undefined;
  }

  return parseOpensteerServiceMetadata(rawMetadata, metadataPath);
}

async function resolveLiveOpensteerServiceMetadata(
  options: OpensteerCliSessionOptions,
): Promise<OpensteerServiceMetadata | undefined> {
  const name = normalizeName(options.name);
  const rootPath = resolveRootPath(options.rootDir);
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

  if (isLocalOpensteerServiceMetadata(metadata) && options.engine !== undefined && metadata.engine !== options.engine) {
    throw new Error(
      `Opensteer session "${name}" is already running with engine "${metadata.engine}". Run "opensteer close --name ${name}" before reopening it with engine "${options.engine}".`,
    );
  }

  if (isLocalOpensteerServiceMetadata(metadata)) {
    const expectedMode = options.connect === undefined ? "local" : "connect";
    if (metadata.mode !== expectedMode) {
      throw new Error(
        `Opensteer session "${name}" is already running in ${metadata.mode} mode. Close it before reopening in ${expectedMode} mode.`,
      );
    }
    if (options.connect && metadata.connectUrl !== options.connect.url) {
      throw new Error(
        `Opensteer session "${name}" is already connected to ${metadata.connectUrl}. Close it before reopening with ${options.connect.url}.`,
      );
    }
  }

  return metadata;
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

function resolveRootPath(rootDir: string | undefined): string {
  return path.resolve(rootDir ?? process.cwd(), ".opensteer");
}

function normalizeName(name: string | undefined): string {
  const normalized = String(name ?? "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
