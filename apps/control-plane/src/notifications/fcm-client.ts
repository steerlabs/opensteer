import { androidNotificationChannelId } from "@opensteer/core";
import { importPKCS8, SignJWT } from "jose";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import type { NotificationMessage } from "./notification-message.js";
import type { PushDeliveryResult } from "./push-result.js";

const accessTokenScope = "https://www.googleapis.com/auth/firebase.messaging";
const maximumResponseBytes = 32 * 1_024;
/** Google issues an hour; refreshing at fifty minutes keeps a margin. */
const accessTokenLifetimeMilliseconds = 50 * 60 * 1_000;

const AccessTokenSchema = z
  .object({ access_token: z.string().min(1).max(8_192), expires_in: z.number().int().positive() })
  .loose();

const FcmFailureSchema = z
  .object({
    error: z
      .object({
        details: z
          .array(
            z
              .object({
                "@type": z.string().optional(),
                errorCode: z.string().min(1).max(128).optional(),
              })
              .loose(),
          )
          .max(16)
          .optional(),
        message: z.string().max(512).optional(),
        status: z.string().min(1).max(128).optional(),
      })
      .loose(),
  })
  .loose();

export interface FcmClientOptions {
  readonly clientEmail: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly privateKeyPem: string;
  readonly projectId: string;
  readonly tokenUri: string;
}

export class FcmClient {
  readonly #clientEmail: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #privateKeyPem: string;
  readonly #projectId: string;
  readonly #tokenUri: string;
  #accessToken: { readonly expiresAt: number; readonly token: string } | undefined;

  constructor(options: FcmClientOptions) {
    this.#clientEmail = options.clientEmail;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#privateKeyPem = options.privateKeyPem;
    this.#projectId = options.projectId;
    this.#tokenUri = options.tokenUri;
  }

  async send(input: {
    readonly collapseKey: string;
    readonly expiresAt: Date;
    readonly message: NotificationMessage;
    readonly token: string;
  }): Promise<PushDeliveryResult> {
    const remainingSeconds = Math.max(
      0,
      Math.floor((input.expiresAt.getTime() - this.#now().getTime()) / 1_000),
    );
    let response: Response;
    try {
      response = await this.#fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.#projectId)}/messages:send`,
        {
          body: JSON.stringify({
            message: {
              android: {
                ...(input.message.data.preview
                  ? {}
                  : {
                      notification: {
                        channel_id: androidNotificationChannelId,
                        tag: input.collapseKey,
                      },
                    }),
                priority: "high",
                ttl: `${remainingSeconds}s`,
              },
              data: input.message.data,
              ...(input.message.data.preview
                ? {}
                : { notification: { body: input.message.body, title: input.message.title } }),
              token: input.token,
            },
          }),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${await this.#token()}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      return { outcome: "fcm:transport", status: "retry" };
    }
    if (response.ok) {
      await response.body?.cancel();
      return { outcome: "accepted", status: "delivered" };
    }
    const reason = await fcmReason(response);
    if (reason === "UNREGISTERED") {
      return { outcome: `fcm:${reason}`, status: "unregistered" };
    }
    if (response.status === 429 || response.status >= 500) {
      return { outcome: `fcm:${response.status}:${reason}`, status: "retry" };
    }
    return { outcome: `fcm:${response.status}:${reason}`, status: "rejected" };
  }

  async #token(): Promise<string> {
    const now = this.#now().getTime();
    const cached = this.#accessToken;
    if (cached && cached.expiresAt > now) return cached.token;
    const key = await importPKCS8(this.#privateKeyPem, "RS256");
    const assertion = await new SignJWT({ scope: accessTokenScope })
      .setProtectedHeader({ alg: "RS256" })
      .setAudience(this.#tokenUri)
      .setExpirationTime(Math.floor(now / 1_000) + 3_600)
      .setIssuedAt(Math.floor(now / 1_000))
      .setIssuer(this.#clientEmail)
      .setSubject(this.#clientEmail)
      .sign(key);
    const response = await this.#fetch(this.#tokenUri, {
      body: new URLSearchParams({
        assertion,
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`FCM access token request returned HTTP ${response.status}`);
    }
    const issued = AccessTokenSchema.parse(
      await readBoundedJson(response, {
        emptyError: () => new Error("FCM access token response was empty"),
        invalidJsonError: (cause: unknown) =>
          new Error("FCM access token response was invalid JSON", { cause }),
        maximumBytes: maximumResponseBytes,
        sizeError: () => new Error("FCM access token response exceeded its size limit"),
      }),
    );
    const expiresAt = now + Math.min(accessTokenLifetimeMilliseconds, issued.expires_in * 1_000);
    this.#accessToken = { expiresAt, token: issued.access_token };
    return issued.access_token;
  }
}

async function fcmReason(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await readBoundedJson(response, {
      emptyError: () => new Error("empty"),
      invalidJsonError: () => new Error("invalid"),
      maximumBytes: maximumResponseBytes,
      sizeError: () => new Error("oversized"),
    });
  } catch {
    return "unknown";
  }
  const parsed = FcmFailureSchema.safeParse(body);
  if (!parsed.success) return "unknown";
  if (
    parsed.data.error.details?.some(
      (detail) =>
        detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
        detail.errorCode === "UNREGISTERED",
    )
  )
    return "UNREGISTERED";
  const status = parsed.data.error.status;
  return status && fcmReasons.has(status) ? status : "unknown";
}

const fcmReasons = new Set([
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "UNAVAILABLE",
  "INTERNAL",
  "RESOURCE_EXHAUSTED",
  "QUOTA_EXCEEDED",
  "SENDER_ID_MISMATCH",
  "THIRD_PARTY_AUTH_ERROR",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
]);
