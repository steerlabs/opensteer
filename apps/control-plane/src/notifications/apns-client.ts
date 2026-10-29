import { connect, constants, type ClientHttp2Session } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { NotificationMessage } from "./notification-message.js";
import type { PushDeliveryResult } from "./push-result.js";

/**
 * Apple refuses a provider token older than an hour and rate-limits minting
 * one more often than every twenty minutes, so the cached token is refreshed
 * comfortably inside both bounds.
 */
const providerTokenLifetimeMilliseconds = 50 * 60 * 1_000;
const maximumResponseBytes = 8 * 1_024;

const apnsOrigins = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
} as const;

const ApnsFailureSchema = z.object({ reason: z.string().min(1).max(128) }).loose();

export interface ApnsTransportResponse {
  readonly body: string;
  readonly status: number;
}

/** The HTTP/2 exchange, isolated so tests can drive the client without Apple. */
export type ApnsTransport = (request: {
  readonly body: string;
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly path: string;
}) => Promise<ApnsTransportResponse>;

export interface ApnsClientOptions {
  readonly keyId: string;
  readonly now?: () => Date;
  readonly privateKeyPem: string;
  readonly teamId: string;
  readonly topic: string;
  readonly transport?: ApnsTransport;
}

export class ApnsClient {
  readonly #keyId: string;
  readonly #now: () => Date;
  readonly #privateKeyPem: string;
  readonly #teamId: string;
  readonly #topic: string;
  readonly #transport: ApnsTransport;
  #providerToken: { readonly mintedAt: number; readonly token: string } | undefined;
  readonly #sessions = new Map<string, Http2Connection>();

  constructor(options: ApnsClientOptions) {
    this.#keyId = options.keyId;
    this.#now = options.now ?? (() => new Date());
    this.#privateKeyPem = options.privateKeyPem;
    this.#teamId = options.teamId;
    this.#topic = options.topic;
    if (options.transport) {
      this.#transport = options.transport;
    } else {
      this.#transport = (request) => {
        let session = this.#sessions.get(request.origin);
        if (!session) {
          session = new Http2Connection(request.origin);
          this.#sessions.set(request.origin, session);
        }
        return session.request(request);
      };
    }
  }

  close(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
  }

  async send(input: {
    readonly apsEnvironment: "development" | "production";
    readonly collapseKey: string;
    readonly expiresAt: Date;
    readonly message: NotificationMessage;
    readonly token: string;
  }): Promise<PushDeliveryResult> {
    let response: ApnsTransportResponse;
    try {
      response = await this.#transport({
        origin: apnsOrigins[input.apsEnvironment],
        body: JSON.stringify({
          ...input.message.data,
          aps: {
            alert: { body: input.message.body, title: input.message.title },
            sound: "default",
          },
        }),
        headers: {
          authorization: `bearer ${await this.#token()}`,
          "apns-collapse-id": input.collapseKey.slice(0, 64),
          "apns-expiration": String(Math.floor(input.expiresAt.getTime() / 1_000)),
          "apns-priority": "10",
          "apns-push-type": "alert",
          "apns-topic": this.#topic,
          "content-type": "application/json",
        },
        path: `/3/device/${encodeURIComponent(input.token)}`,
      });
    } catch (error) {
      return { outcome: apnsOutcome(error), status: "retry" };
    }
    if (response.status === 200) return { outcome: "accepted", status: "delivered" };
    const reason = apnsReason(response.body);
    if (
      response.status === 410 ||
      reason === "BadDeviceToken" ||
      reason === "Unregistered" ||
      reason === "DeviceTokenNotForTopic"
    ) {
      return { outcome: `apns:${reason}`, status: "unregistered" };
    }
    // 429 and 5xx are Apple asking for the same message again later.
    if (response.status === 429 || response.status >= 500) {
      return { outcome: `apns:${response.status}:${reason}`, status: "retry" };
    }
    return { outcome: `apns:${response.status}:${reason}`, status: "rejected" };
  }

  async #token(): Promise<string> {
    const now = this.#now().getTime();
    const cached = this.#providerToken;
    if (cached && now - cached.mintedAt < providerTokenLifetimeMilliseconds) return cached.token;
    const key = await importPKCS8(this.#privateKeyPem, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.#keyId })
      .setIssuedAt(Math.floor(now / 1_000))
      .setIssuer(this.#teamId)
      .sign(key);
    this.#providerToken = { mintedAt: now, token };
    return token;
  }
}

function apnsReason(body: string): string {
  if (!body) return "unknown";
  try {
    const parsed = ApnsFailureSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.reason : "unknown";
  } catch {
    return "unknown";
  }
}

function apnsOutcome(error: unknown): string {
  return error instanceof Error
    ? `apns:transport:${error.message.slice(0, 200)}`
    : "apns:transport";
}

/**
 * One long-lived HTTP/2 session to Apple. APNs expects a connection to be
 * reused across messages and treats a new connection per push as abuse, so the
 * session is kept and only replaced once it is actually gone.
 */
class Http2Connection {
  readonly #origin: string;
  #session: ClientHttp2Session | undefined;

  constructor(origin: string) {
    this.#origin = origin;
  }

  close(): void {
    this.#session?.close();
    this.#session = undefined;
  }

  request(input: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly path: string;
  }): Promise<ApnsTransportResponse> {
    const session = this.#connect();
    return new Promise<ApnsTransportResponse>((resolve, reject) => {
      const stream = session.request({
        ...input.headers,
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: input.path,
      });
      let status = 0;
      let body = "";
      let bytes = 0;
      stream.setTimeout(15_000, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error("timed out"));
      });
      stream.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maximumResponseBytes) {
          stream.close(constants.NGHTTP2_CANCEL);
          reject(new Error("response exceeded its size limit"));
          return;
        }
        body += chunk.toString("utf8");
      });
      stream.on("error", reject);
      stream.on("end", () => resolve({ body, status }));
      stream.end(input.body);
    });
  }

  #connect(): ClientHttp2Session {
    const existing = this.#session;
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.#origin);
    session.on("error", () => {
      if (this.#session === session) this.#session = undefined;
    });
    session.on("close", () => {
      if (this.#session === session) this.#session = undefined;
    });
    session.unref();
    this.#session = session;
    return session;
  }
}
