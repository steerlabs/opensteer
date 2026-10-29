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
          .array(z.object({ errorCode: z.string().min(1).max(128) }).loose())
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
                // `collapse_key` only folds messages Google is still holding
                // for an offline phone; `tag` is what replaces a notification
                // already in the drawer, the way `apns-collapse-id` does on
                // iOS. Both name the Thread and kind, so each shows one alert.
                collapse_key: input.collapseKey,
                // Android takes sound and importance from the channel, not the
                // message, so the channel the app defines has to be named
                // here; without it the phone falls back to a channel of
                // `expo-notifications`' own making.
                notification: { channel_id: androidNotificationChannelId, tag: input.collapseKey },
                priority: "high",
                ttl: `${remainingSeconds}s`,
              },
              data: input.message.data,
              notification: { body: input.message.body, title: input.message.title },
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
    } catch (error) {
      return { outcome: fcmTransportOutcome(error), status: "retry" };
    }
    if (response.ok) {
      await response.body?.cancel();
      return { outcome: "accepted", status: "delivered" };
    }
    const reason = await fcmReason(response);
    if (reason === "UNREGISTERED" || reason === "NOT_FOUND" || reason === "INVALID_ARGUMENT") {
      // FCM answers INVALID_ARGUMENT for a malformed registration token as well
      // as for a malformed message; the message shape here is fixed, so the
      // token is what changed.
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
  return parsed.data.error.details?.[0]?.errorCode ?? parsed.data.error.status ?? "unknown";
}

function fcmTransportOutcome(error: unknown): string {
  return error instanceof Error ? `fcm:transport:${error.message.slice(0, 200)}` : "fcm:transport";
}
