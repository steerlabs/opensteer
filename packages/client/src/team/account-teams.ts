import { ControlPlaneErrorResponseSchema } from "@opensteer/control-plane-protocol";
import {
  CreateHostedTeamRequestSchema,
  HostedTeamAvailabilityResponseSchema,
  HostedTeamResponseSchema,
  ListHostedTeamsResponseSchema,
  accountHostedTeamAvailabilityPath,
  accountHostedTeamPath,
  accountHostedTeamRetryPath,
  accountHostedTeamsPath,
  type CreateHostedTeamRequest,
  type HostedTeamAvailability,
  type HostedTeamId,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import { bareServiceOrigin } from "@opensteer/core";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import type { z } from "zod";
import {
  AccountRequestError,
  type AccountDeploymentDirectoryAuthorization,
} from "../connections/account-deployment-directory.js";
import { clientTimeoutError, unrefTimer } from "../connections/operation-error.js";

/**
 * Account's team calls, made with the person's Account session and parsed with the
 * control-plane-protocol schemas. A refusal throws carrying its `ControlPlaneErrorReason`.
 */
export interface AccountTeamsClient {
  hostedTeamAvailability(slug: string, signal?: AbortSignal): Promise<HostedTeamAvailability>;
  createHostedTeam(request: CreateHostedTeamRequest): Promise<HostedTeamView>;
  listHostedTeams(signal?: AbortSignal): Promise<readonly HostedTeamView[]>;
  /** Null once the team is gone. */
  hostedTeam(id: HostedTeamId, signal?: AbortSignal): Promise<HostedTeamView | null>;
  retryHostedTeam(id: HostedTeamId): Promise<HostedTeamView>;
  /** Cancels a team still being set up, or deletes one (owners only). Null when already gone. */
  deleteHostedTeam(id: HostedTeamId): Promise<HostedTeamView | null>;
}

const timeoutMs = 15_000;
const maximumResponseBytes = 256 * 1_024;

/** `AccountTeamsClient` over HTTP, for whichever process holds the Account session. */
export class HttpAccountTeamsClient implements AccountTeamsClient {
  readonly #origin: string;
  readonly #authorization: AccountDeploymentDirectoryAuthorization;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: {
    readonly accountOrigin: URL | string;
    readonly authorization: AccountDeploymentDirectoryAuthorization;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#origin = bareServiceOrigin(options.accountOrigin, "Opensteer Account origin");
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  hostedTeamAvailability(slug: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ slug });
    return this.#json(
      `${accountHostedTeamAvailabilityPath}?${query}`,
      "GET",
      HostedTeamAvailabilityResponseSchema,
      undefined,
      signal,
    );
  }

  createHostedTeam(request: CreateHostedTeamRequest) {
    return this.#json(
      accountHostedTeamsPath,
      "POST",
      HostedTeamResponseSchema,
      CreateHostedTeamRequestSchema.parse(request),
    );
  }

  async listHostedTeams(signal?: AbortSignal) {
    return (
      await this.#json(
        accountHostedTeamsPath,
        "GET",
        ListHostedTeamsResponseSchema,
        undefined,
        signal,
      )
    ).teams;
  }

  hostedTeam(id: HostedTeamId, signal?: AbortSignal) {
    return this.#gone(
      this.#json(accountHostedTeamPath(id), "GET", HostedTeamResponseSchema, undefined, signal),
    );
  }

  retryHostedTeam(id: HostedTeamId) {
    return this.#json(accountHostedTeamRetryPath(id), "POST", HostedTeamResponseSchema, {});
  }

  deleteHostedTeam(id: HostedTeamId) {
    return this.#gone(this.#json(accountHostedTeamPath(id), "DELETE", HostedTeamResponseSchema));
  }

  async #gone(request: Promise<HostedTeamView>): Promise<HostedTeamView | null> {
    try {
      return await request;
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 404) return null;
      throw error;
    }
  }

  async #json<T>(
    path: string,
    method: "DELETE" | "GET" | "POST",
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.#authorization.accountAuthorizationLease();
    if (!lease || !/^Bearer [^\p{Control}\s]+$/u.test(lease.authorization))
      throw new AccountRequestError({
        code: null,
        status: 401,
        message: "Sign in to your Opensteer Account first.",
      });
    if (lease.issuer !== this.#origin)
      throw new Error("The signed-in Account issuer does not match this service.");
    const endpoint = new URL(path, this.#origin).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("Opensteer Account didn’t answer in time.")),
      timeoutMs,
    );
    unrefTimer(timeout);
    const relay = (source: AbortSignal) => () => controller.abort(source.reason);
    const relayLease = relay(lease.signal);
    const relayCaller = signal ? relay(signal) : null;
    lease.signal.addEventListener("abort", relayLease, { once: true });
    if (signal && relayCaller) signal.addEventListener("abort", relayCaller, { once: true });
    if (lease.signal.aborted) relayLease();
    if (signal?.aborted) relayCaller?.();
    try {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      const response = await this.#fetch(endpoint, {
        ...(serialized === undefined ? {} : { body: serialized }),
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: "application/json",
          authorization: lease.authorization,
          ...(serialized === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const text = await readBoundedText(response, {
        maximumBytes: maximumResponseBytes,
        sizeError: () => new Error("The Opensteer Account response is too large."),
      });
      if (!response.ok) {
        const parsed = ControlPlaneErrorResponseSchema.safeParse(safeJson(text)).data;
        throw new AccountRequestError({
          code: parsed?.error.code ?? null,
          reason: parsed?.error.reason ?? null,
          status: response.status,
          message: parsed?.error.message ?? "Opensteer Account refused the request.",
        });
      }
      return schema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error)
        throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      lease.signal.removeEventListener("abort", relayLease);
      if (signal && relayCaller) signal.removeEventListener("abort", relayCaller);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
