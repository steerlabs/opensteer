import { ChannelDeliveryError } from "@opensteer/channel-core";
import { z } from "zod";

const slackApiOrigin = "https://slack.com/api";

/**
 * Slack answers every method with HTTP 200 and an `ok` flag, so the failure a
 * caller must classify is the `error` string, not the status. These are the
 * codes that will never succeed on a later attempt: the bot is not where it
 * was asked to post, or the installation itself is gone.
 */
const deadSlackErrorCodes = new Set([
  "account_inactive",
  "cannot_dm_bot",
  "channel_not_found",
  "ekm_access_denied",
  "invalid_auth",
  "invalid_arguments",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "is_archived",
  "markdown_text_conflict",
  "metadata_too_large",
  "missing_scope",
  "msg_blocks_too_long",
  "msg_too_long",
  "no_permission",
  "no_text",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "org_login_required",
  "restricted_action",
  "team_access_not_granted",
  "token_expired",
  "token_revoked",
  "user_not_found",
  "user_not_in_channel",
]);

const retryableSlackErrorCodes = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "rate_limited",
  "request_timeout",
  "service_unavailable",
]);

export function slackFailureKind(status: number, code: string): ChannelDeliveryError["kind"] {
  if (status === 429 || status >= 500 || retryableSlackErrorCodes.has(code)) return "retryable";
  if (deadSlackErrorCodes.has(code)) return "dead";
  // An unrecognised `ok: false` is a refusal, not a lost answer: Slack replied.
  return status >= 200 && status < 500 ? "dead" : "unknown";
}

export function slackRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export interface SlackApiCall {
  readonly fetch: typeof globalThis.fetch;
  readonly json?: Readonly<Record<string, unknown>>;
  readonly method: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly token: string;
}

/**
 * One Slack Web API call, parsed. Every failure — a refusal, an unreadable
 * body, a network error — leaves as a `ChannelDeliveryError` so the caller
 * decides once whether to retry, give up, or reconcile.
 */
export async function callSlackApi<Schema extends z.ZodType>(
  call: SlackApiCall,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const url = new URL(`${slackApiOrigin}/${call.method}`);
  for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await call.fetch(url, {
      ...(call.json ? { body: JSON.stringify(call.json) } : {}),
      headers: {
        authorization: `Bearer ${call.token}`,
        ...(call.json ? { "content-type": "application/json; charset=utf-8" } : {}),
      },
      method: "POST",
      ...(call.signal ? { signal: call.signal } : {}),
    });
  } catch (error) {
    throw new ChannelDeliveryError(`Slack could not be reached (${call.method})`, "unknown", {
      cause: error,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ChannelDeliveryError(
      `Slack returned an unreadable ${call.method} response`,
      "unknown",
      {
        cause: error,
      },
    );
  }
  const envelope = SlackResultEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new ChannelDeliveryError(`Slack returned an invalid ${call.method} response`, "unknown");
  }
  if (!response.ok || !envelope.data.ok) {
    const code = envelope.data.error ?? `http_${response.status}`;
    throw new ChannelDeliveryError(
      `Slack rejected ${call.method} (${code})`,
      slackFailureKind(response.status, code),
      { retryAfterSeconds: slackRetryAfterSeconds(response.headers.get("retry-after")) },
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ChannelDeliveryError(
      `Slack returned an unexpected ${call.method} result`,
      "unknown",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

const SlackResultEnvelopeSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
});

export const SlackAuthTestSchema = z.looseObject({
  bot_id: z.string().optional(),
  team: z.string().optional(),
  team_id: z.string().optional(),
  user: z.string().optional(),
  user_id: z.string().optional(),
});

export const SlackConnectionsOpenSchema = z.looseObject({ url: z.string().optional() });

export const SlackPostMessageSchema = z.looseObject({
  channel: z.string().optional(),
  ts: z.string().optional(),
});

export const SlackPostEphemeralSchema = z.looseObject({ message_ts: z.string().optional() });

export const SlackUserInfoSchema = z.looseObject({
  user: z
    .looseObject({
      id: z.string().optional(),
      name: z.string().optional(),
      profile: z
        .looseObject({
          display_name: z.string().optional(),
          real_name: z.string().optional(),
        })
        .optional(),
      real_name: z.string().optional(),
    })
    .optional(),
});

export const SlackConversationHistorySchema = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        app_id: z.string().optional(),
        bot_id: z.string().optional(),
        metadata: z
          .looseObject({
            event_payload: z.record(z.string(), z.unknown()).optional(),
            event_type: z.string().optional(),
          })
          .optional(),
        text: z.string().optional(),
        ts: z.string().optional(),
      }),
    )
    .default([]),
  response_metadata: z.looseObject({ next_cursor: z.string().optional() }).optional(),
});

/**
 * The installation behind a bot token: who the bot is, which workspace it is
 * installed in, and which scopes that install actually granted (Slack reports
 * them on a response header, never in the body).
 */
export async function inspectSlackConnection(
  botToken: string,
  fetch_: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<{
  readonly botDisplayName: string;
  readonly botId: string;
  readonly botHandle: string | null;
  readonly botUserId: string;
  readonly grantedScopes: readonly string[];
  readonly teamId: string;
  readonly teamName: string;
}> {
  const url = new URL(`${slackApiOrigin}/auth.test`);
  let response: Response;
  try {
    response = await fetch_(url, {
      headers: { authorization: `Bearer ${botToken}` },
      method: "POST",
      signal,
    });
  } catch (error) {
    throw new ChannelDeliveryError("Slack could not be reached (auth.test)", "unknown", {
      cause: error,
    });
  }
  const payload: unknown = await response.json().catch(() => null);
  const envelope = SlackResultEnvelopeSchema.safeParse(payload);
  if (!envelope.success || !response.ok || !envelope.data.ok) {
    const detail = envelope.success
      ? (envelope.data.error ?? `http_${response.status}`)
      : "invalid_response";
    throw new ChannelDeliveryError(
      `Slack could not verify this bot token (${detail})`,
      envelope.success ? slackFailureKind(response.status, detail) : "unknown",
    );
  }
  const parsed = SlackAuthTestSchema.parse(payload);
  if (!parsed.team_id || !parsed.team || !parsed.user_id || !parsed.bot_id) {
    throw new ChannelDeliveryError("Slack did not return the bot installation identity", "dead");
  }
  const handle = parsed.user?.replace(/^@/u, "").trim() || null;
  return {
    botDisplayName: handle ?? "Opensteer",
    botId: parsed.bot_id,
    botHandle: handle ? `@${handle}` : null,
    botUserId: parsed.user_id,
    grantedScopes: parseSlackScopes(response.headers.get("x-oauth-scopes")),
    teamId: parsed.team_id,
    teamName: parsed.team,
  };
}

/** Resolve the app behind the bot token without interpreting opaque token bytes. */
export async function slackBotAppId(
  botToken: string,
  botId: string,
  fetch_: typeof fetch,
): Promise<string> {
  const result = await callSlackApi(
    {
      fetch: fetch_,
      method: "bots.info",
      query: { bot: botId },
      signal: AbortSignal.timeout(10_000),
      token: botToken,
    },
    z.object({ bot: z.object({ app_id: z.string().min(1) }) }),
  );
  return result.bot.app_id;
}

/** Ask Slack for one Socket Mode endpoint. Each call opens a new connection. */
export async function openSlackSocket(
  appToken: string,
  fetch_: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<URL> {
  const result = await callSlackApi(
    { fetch: fetch_, method: "apps.connections.open", signal, token: appToken },
    SlackConnectionsOpenSchema,
  );
  if (!result.url) {
    throw new ChannelDeliveryError("Slack did not return a Socket Mode endpoint", "unknown");
  }
  const url = new URL(result.url);
  if (url.protocol !== "wss:") {
    throw new ChannelDeliveryError("Slack returned an unsafe Socket Mode URL", "dead");
  }
  return url;
}

export function parseSlackScopes(value: string | null): readonly string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Display names for the people a conversation names, cached per adapter
 * instance: a busy channel would otherwise spend one `users.info` call per
 * message on the same handful of people.
 */
export class SlackUserDirectory {
  readonly #entries = new Map<
    string,
    { readonly displayName: string; readonly expiresAt: number }
  >();
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: {
    readonly fetch: typeof globalThis.fetch;
    readonly now?: () => number;
    readonly ttlMs?: number;
  }) {
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1_000;
  }

  async displayName(botToken: string, externalUserId: string): Promise<string> {
    const cached = this.#entries.get(externalUserId);
    if (cached && cached.expiresAt > this.#now()) return cached.displayName;
    const displayName = await this.#lookup(botToken, externalUserId);
    this.#entries.set(externalUserId, {
      displayName,
      expiresAt: this.#now() + this.#ttlMs,
    });
    return displayName;
  }

  async #lookup(botToken: string, externalUserId: string): Promise<string> {
    try {
      const result = await callSlackApi(
        {
          fetch: this.#fetch,
          method: "users.info",
          query: { user: externalUserId },
          signal: AbortSignal.timeout(10_000),
          token: botToken,
        },
        SlackUserInfoSchema,
      );
      const profile = result.user?.profile;
      const name =
        profile?.display_name?.trim() ||
        profile?.real_name?.trim() ||
        result.user?.real_name?.trim() ||
        result.user?.name?.trim();
      return name && name.length > 0 ? name.slice(0, 160) : externalUserId;
    } catch {
      // A name is a nicety; the event still identifies the person by id.
      return externalUserId;
    }
  }
}
