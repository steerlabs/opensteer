import {
  ControlPlaneErrorResponseSchema,
  ListNotificationDevicesResponseSchema,
  NotificationInstallationIdSchema,
  RegisterNotificationDeviceRequestSchema,
  RegisterNotificationDeviceResponseSchema,
  UnregisterNotificationDeviceResponseSchema,
  type NotificationDevice,
  type RegisterNotificationDeviceRequest,
} from "@opensteer/control-plane-protocol";
import { bareServiceOrigin } from "@opensteer/core";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import { AccountRequestError } from "./account-deployment-directory.js";
import type { AccountDeploymentDirectoryAuthorization } from "./account-deployment-directory.js";
import { ClientOperationError, clientTimeoutError, unrefTimer } from "./operation-error.js";

const devicesTimeoutMs = 15_000;
const maximumDevicesResponseBytes = 64 * 1_024;

/**
 * The Account service holds no APNs or FCM credentials, so there is no such
 * thing as a registration on it.
 *
 * It is its own error because it is not a failure to retry or to sign in
 * again: a phone pointed at a service that cannot send push is in a settled,
 * honest state, and the only correct thing to do is say so.
 */
export class PushNotConfiguredError extends ClientOperationError {
  readonly reason = "push-not-configured" as const;

  constructor() {
    super("This Opensteer Account service does not send notifications.", "blocked");
    this.name = "PushNotConfiguredError";
  }
}

/**
 * This Account already has as many phones registered as it may have.
 *
 * Like `PushNotConfiguredError` this is a settled answer rather than a failure
 * to retry: nothing this phone can do changes it, and the only repair is on
 * another device. It carries no message of its own because the surface that
 * shows it says what to do, and the Account's sentence is written for a
 * different vocabulary.
 */
export class DeviceLimitReachedError extends ClientOperationError {
  readonly reason = "device-limit" as const;

  constructor() {
    super("This Opensteer Account has no room for another device.", "blocked");
    this.name = "DeviceLimitReachedError";
  }
}

/**
 * The phone's own push registration, as the Account keeps it.
 *
 * Registration is refused to every credential but the mobile application's, so
 * this client exists for exactly one caller. `installationId` is the app's own
 * stable per-install identifier and is the row's key: rotating the provider
 * token updates the row this install already owns rather than leaving an
 * undeliverable one behind.
 */
export class AccountNotificationDevicesClient {
  readonly #accountOrigin: string | null;
  readonly #authorization: AccountDeploymentDirectoryAuthorization;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly accountOrigin: URL | string | null;
    readonly authorization: AccountDeploymentDirectoryAuthorization;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  }) {
    this.#accountOrigin =
      options.accountOrigin === null
        ? null
        : bareServiceOrigin(options.accountOrigin, "Opensteer Account origin");
    this.#authorization = options.authorization;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? devicesTimeoutMs;
  }

  async register(
    installationId: string,
    request: RegisterNotificationDeviceRequest,
  ): Promise<NotificationDevice> {
    const body = RegisterNotificationDeviceRequestSchema.parse(request);
    const decoded = await this.#json(
      this.#devicePath(installationId),
      "PUT",
      RegisterNotificationDeviceResponseSchema,
      body,
    );
    return decoded.device;
  }

  async unregister(installationId: string): Promise<void> {
    await this.#json(
      this.#devicePath(installationId),
      "DELETE",
      UnregisterNotificationDeviceResponseSchema,
    );
  }

  async list(): Promise<readonly NotificationDevice[]> {
    const decoded = await this.#json(
      "/v1/account/notification-devices",
      "GET",
      ListNotificationDevicesResponseSchema,
    );
    return decoded.devices;
  }

  #devicePath(installationId: string): string {
    const id = NotificationInstallationIdSchema.parse(installationId);
    return `/v1/account/notification-devices/${encodeURIComponent(id)}`;
  }

  async #json<T>(
    path: string,
    method: "DELETE" | "GET" | "PUT",
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const accountOrigin = this.#accountOrigin;
    if (accountOrigin === null) {
      throw new Error("Opensteer Account requests are disabled in this source build.");
    }
    const lease = await this.#authorization.accountAuthorizationLease();
    if (!lease || !/^Bearer [^\p{Control}\s]+$/u.test(lease.authorization)) {
      // Reported as an unauthorized Account request so a missing credential and
      // a rejected one are classified identically by every caller.
      throw new AccountRequestError({
        code: null,
        status: 401,
        message: "Sign in to your Opensteer Account to manage notifications.",
      });
    }
    if (lease.issuer !== accountOrigin) {
      throw new Error("The signed-in Account issuer does not match this service.");
    }
    const endpoint = new URL(path, accountOrigin).toString();
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(clientTimeoutError("The notification registration timed out.")),
      this.#timeoutMs,
    );
    unrefTimer(timeout);
    const relayAccountAbort = () => controller.abort(lease.signal.reason);
    if (lease.signal.aborted) relayAccountAbort();
    else lease.signal.addEventListener("abort", relayAccountAbort, { once: true });
    try {
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
      lease.signal.throwIfAborted();
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("Opensteer Account requests must not redirect.");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (!response.ok) throw await this.#rejection(response, contentType);
      if (contentType !== "application/json") {
        throw new Error("The Opensteer Account returned an invalid notification response.");
      }
      return schema.parse(JSON.parse(await this.#text(response)) as unknown);
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("The notification registration was cancelled.", { cause: error });
      }
      if (error instanceof SyntaxError) {
        throw new Error("The Opensteer Account returned an invalid notification response.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      lease.signal.removeEventListener("abort", relayAccountAbort);
    }
  }

  async #rejection(response: Response, contentType: string | undefined): Promise<Error> {
    if (contentType !== "application/json") {
      await response.body?.cancel();
      return new AccountRequestError({
        code: null,
        status: response.status,
        message: "The Opensteer Account rejected the notification registration.",
      });
    }
    const errorBody = ControlPlaneErrorResponseSchema.safeParse(
      JSON.parse(await this.#text(response)) as unknown,
    ).data;
    // The service says `not_found` with this reason when it holds no APNs or
    // FCM credentials at all, which is a permanent answer about the service
    // rather than anything about this device.
    if (errorBody?.error.reason === "push-not-configured") return new PushNotConfiguredError();
    // `conflict` with this reason means the Account is at its device limit. The
    // repair is on another phone, so the app must tell a person that rather
    // than retrying against a bound that will not move on its own.
    if (errorBody?.error.reason === "device-limit") return new DeviceLimitReachedError();
    return new AccountRequestError({
      code: errorBody?.error.code ?? null,
      reason: errorBody?.error.reason ?? null,
      status: response.status,
      message:
        errorBody?.error.message ?? "The Opensteer Account rejected the notification registration.",
    });
  }

  async #text(response: Response): Promise<string> {
    return readBoundedText(response, {
      maximumBytes: maximumDevicesResponseBytes,
      sizeError: () => new Error("The Opensteer Account notification response is too large."),
    });
  }
}
