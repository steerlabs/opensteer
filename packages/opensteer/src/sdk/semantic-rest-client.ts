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

export interface OpensteerSemanticRestConnection {
  readonly baseUrl: string;
  readonly getAuthorizationHeader: () => Promise<string>;
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

export class OpensteerSemanticRestClient {
  constructor(private readonly connection: OpensteerSemanticRestConnection) {}

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
        throw new OpensteerSemanticRestError(envelope.error, response.status);
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

function isFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TypeError" || /fetch failed/i.test(error.message);
}
