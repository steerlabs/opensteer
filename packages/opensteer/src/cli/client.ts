import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createRequestEnvelope,
  isErrorEnvelope,
  opensteerSemanticRestEndpoints,
  type OpensteerError,
  type OpensteerRequestEnvelope,
  type OpensteerResponseEnvelope,
  type OpensteerSemanticOperationName,
} from "@opensteer/protocol";

import {
  getOpensteerServiceMetadataPath,
  isProcessAlive,
  readOpensteerServiceMetadata,
  removeOpensteerServiceMetadata,
  type OpensteerServiceMetadata,
} from "./service-metadata.js";

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

export interface OpensteerCliSessionOptions {
  readonly name?: string;
  readonly rootDir?: string;
}

export interface OpensteerServiceLaunchContext {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly scriptPath: string;
  readonly cwd?: string;
}

export class OpensteerCliServiceClient {
  constructor(private readonly metadata: OpensteerServiceMetadata) {}

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
    const response = await fetch(`${this.metadata.baseUrl}${endpoint.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.metadata.token}`,
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
  const name = normalizeName(options.name);
  const rootPath = resolveRootPath(options.rootDir);
  const metadata = await readOpensteerServiceMetadata(rootPath, name);
  if (!metadata) {
    return undefined;
  }

  const valid = await validateServiceMetadata(metadata);
  if (!valid) {
    await removeOpensteerServiceMetadata(rootPath, name);
    return undefined;
  }

  return new OpensteerCliServiceClient(metadata);
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
  const rootPath = resolveRootPath(options.rootDir);
  const serviceArgs = [
    ...options.launchContext.execArgv,
    options.launchContext.scriptPath,
    "service-host",
    "--name",
    name,
    ...(options.rootDir === undefined ? [] : ["--root-dir", options.rootDir]),
  ];
  const child = spawn(options.launchContext.execPath, serviceArgs, {
    cwd: options.launchContext.cwd ?? process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVICE_START_TIMEOUT_MS) {
    const metadata = await readOpensteerServiceMetadata(rootPath, name);
    if (metadata && (await validateServiceMetadata(metadata))) {
      return new OpensteerCliServiceClient(metadata);
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
  if (!isProcessAlive(metadata.pid)) {
    return false;
  }

  try {
    const response = await fetch(`${metadata.baseUrl}${PING_PATH}`, {
      headers: {
        authorization: `Bearer ${metadata.token}`,
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
