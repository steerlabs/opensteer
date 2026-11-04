import { readBoundedText } from "@opensteer/shared/boundedJson";
import { DeploymentIdSchema, bareServiceOrigin, type DeploymentId } from "@opensteer/core";
import {
  ConnectCredentialResponseSchema,
  ControlPlaneErrorResponseSchema,
  ProvisionConnectRequestSchema,
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
  RotateConnectCredentialRequestSchema,
  type ConnectCredentialResponse,
  type ProvisionConnectRequest,
  type RevokeConnectRequest,
  type RevokeConnectResponse,
  type RotateConnectCredentialRequest,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { clientTimeoutError, unrefTimer } from "./operation-error.js";

const defaultRequestTimeoutMs = 30_000;
const maximumResponseBytes = 128 * 1_024;

export class AccountReauthorizationRequiredError extends Error {
  readonly code = "recent_sign_in_required" as const;

  constructor() {
    super("Verify your Opensteer Account again, then repeat this action.");
    this.name = "AccountReauthorizationRequiredError";
  }
}

export interface AccountConnectAuthorization {
  accountAuthorizationHeader(): Promise<string | null>;
}

export interface PersonalHostConnectControlPlane {
  provision(
    deploymentId: DeploymentId,
    request: ProvisionConnectRequest,
  ): Promise<ConnectCredentialResponse>;
  revoke(deploymentId: DeploymentId, request: RevokeConnectRequest): Promise<RevokeConnectResponse>;
  rotate(
    deploymentId: DeploymentId,
    request: RotateConnectCredentialRequest,
  ): Promise<ConnectCredentialResponse>;
}

/** Account-authenticated Connect API; the bearer token exists only per call. */
export class AccountConnectClient implements PersonalHostConnectControlPlane {
  readonly #accountOrigin: string;
  readonly #authorization: AccountConnectAuthorization;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly accountOrigin: URL | string;
    readonly authorization: AccountConnectAuthorization;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  }) {
    this.#accountOrigin = bareServiceOrigin(options.accountOrigin, "Opensteer Account origin");
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? defaultRequestTimeoutMs);
  }

  provision(
    deploymentId: DeploymentId,
    request: ProvisionConnectRequest,
  ): Promise<ConnectCredentialResponse> {
    return this.#request(
      deploymentId,
      "/connect",
      "PUT",
      ProvisionConnectRequestSchema.parse(request),
      ConnectCredentialResponseSchema,
    );
  }

  rotate(
    deploymentId: DeploymentId,
    request: RotateConnectCredentialRequest,
  ): Promise<ConnectCredentialResponse> {
    return this.#request(
      deploymentId,
      "/connect/credential/rotate",
      "POST",
      RotateConnectCredentialRequestSchema.parse(request),
      ConnectCredentialResponseSchema,
    );
  }

  revoke(
    deploymentId: DeploymentId,
    request: RevokeConnectRequest,
  ): Promise<RevokeConnectResponse> {
    return this.#request(
      deploymentId,
      "/connect",
      "DELETE",
      RevokeConnectRequestSchema.parse(request),
      RevokeConnectResponseSchema,
    );
  }

  async #request<T>(
    deploymentId: DeploymentId,
    suffix: string,
    method: "DELETE" | "POST" | "PUT",
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const id = DeploymentIdSchema.parse(deploymentId);
    const authorization = await this.#authorization.accountAuthorizationHeader();
    if (!authorization || !/^Bearer [^\p{Control}\s]+$/u.test(authorization)) {
      throw new Error("Sign in to your Opensteer Account to manage Connect.");
    }
    const endpoint = new URL(endpointPath(id, suffix), this.#accountOrigin).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("Opensteer Connect request timed out.")),
      this.#timeoutMs,
    );
    unrefTimer(timeout);
    try {
      const response = await this.#fetch(endpoint, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: "application/json",
          authorization,
          "content-type": "application/json",
        },
        method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("Opensteer Connect requests must not redirect.");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
          await response.body?.cancel();
          throw new Error("The Opensteer Account returned an invalid Connect response.");
        }
        if (Number(contentLength) > maximumResponseBytes) {
          await response.body?.cancel();
          throw new Error("The Opensteer Account Connect response is too large.");
        }
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (!response.ok) {
        if (contentType === "application/json") {
          const errorBody = await readControlPlaneError(response, controller.signal);
          if (errorBody?.error.code === "recent_sign_in_required") {
            throw new AccountReauthorizationRequiredError();
          }
        } else {
          await response.body?.cancel();
        }
        throw new Error("The Opensteer Account rejected the Connect request.");
      }
      if (contentType !== "application/json") {
        throw new Error("The Opensteer Account returned an invalid Connect response.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          await readBoundedText(response, {
            abortError: () => new Error("Opensteer Connect request ended."),
            maximumBytes: maximumResponseBytes,
            signal: controller.signal,
            sizeError: () => new Error("The Opensteer Account Connect response is too large."),
          }),
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error("The Opensteer Account returned an invalid Connect response.");
        }
        throw error;
      }
      return schema.parse(decoded);
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("Opensteer Connect request was cancelled.", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function endpointPath(deploymentId: string, suffix: string): string {
  return `/v1/account/deployments/${encodeURIComponent(deploymentId)}${suffix}`;
}

async function readControlPlaneError(response: Response, signal: AbortSignal) {
  try {
    return ControlPlaneErrorResponseSchema.safeParse(
      JSON.parse(
        await readBoundedText(response, {
          abortError: () => new Error("Opensteer Connect request ended."),
          maximumBytes: maximumResponseBytes,
          signal,
          sizeError: () => new Error("The Opensteer Account Connect response is too large."),
        }),
      ),
    ).data;
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5 * 60_000) {
    throw new TypeError("Opensteer Connect timeout must be a positive bounded integer.");
  }
  return value;
}
