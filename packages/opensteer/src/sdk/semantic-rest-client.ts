import { randomUUID } from "node:crypto";

import {
  createRequestEnvelope,
  isErrorEnvelope,
  opensteerSemanticRestEndpoints,
  type OpensteerError,
  type OpensteerSemanticOperationName,
  type OpensteerResponseEnvelope,
  type OpensteerSessionCloseOutput,
} from "@opensteer/protocol";

export interface OpensteerSemanticRestConnection {
  readonly getBaseUrl: () => Promise<string>;
  readonly getAuthorizationHeader: () => Promise<string>;
  readonly handleError?: (
    error: unknown,
    input: {
      readonly operation: OpensteerSemanticOperationName;
    },
  ) => Promise<boolean>;
}

export class OpensteerSemanticRestError extends Error {
  readonly opensteerError: OpensteerError;
  readonly statusCode: number;

  constructor(error: OpensteerError, statusCode: number) {
    super(error.message);
    this.name = "OpensteerSemanticRestError";
    this.opensteerError = error;
    this.statusCode = statusCode;
  }
}

export interface OpensteerSemanticRestInvokeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export class OpensteerSemanticRestClient {
  constructor(private readonly connection: OpensteerSemanticRestConnection) {}

  async invoke<TInput, TOutput>(
    operation: OpensteerSemanticOperationName,
    input: TInput,
    options: OpensteerSemanticRestInvokeOptions = {},
  ): Promise<TOutput> {
    return this.invokeInternal(operation, input, false, options);
  }

  private async invokeInternal<TInput, TOutput>(
    operation: OpensteerSemanticOperationName,
    input: TInput,
    hasRetried: boolean,
    options: OpensteerSemanticRestInvokeOptions,
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
      response = await fetch(`${await this.connection.getBaseUrl()}${endpoint.path}`, {
        method: "POST",
        headers: {
          authorization: await this.connection.getAuthorizationHeader(),
          "content-type": "application/json; charset=utf-8",
          ...(options.timeoutMs === undefined
            ? {}
            : { "x-opensteer-timeout-ms": String(options.timeoutMs) }),
        },
        body: JSON.stringify(request),
        signal: createRequestSignal(options),
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
        throw new OpensteerSemanticRestError(envelope.error, response.status);
      }
      return envelope.data;
    } catch (error) {
      if (
        !hasRetried &&
        this.connection.handleError &&
        (await this.connection.handleError(error, { operation }))
      ) {
        return this.invokeInternal(operation, input, true, options);
      }
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

function createRequestSignal(options: OpensteerSemanticRestInvokeOptions): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  if (options.signal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([options.signal, timeoutSignal]);
}

function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TypeError" || /fetch failed/i.test(error.message);
}
