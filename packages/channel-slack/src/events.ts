import type { NormalizedChannelEvent } from "@opensteer/channel-core";
import { z } from "zod";

/**
 * A Socket Mode envelope. `type` is deliberately an open string: Slack adds
 * envelope kinds over time, and an unknown one must be acknowledged and
 * ignored rather than killing the socket.
 */
export const SlackSocketEnvelopeSchema = z.looseObject({
  accepts_response_payload: z.boolean().optional(),
  connection_info: z.object({ app_id: z.string().min(1) }).optional(),
  envelope_id: z.string().min(1).max(512).optional(),
  payload: z.unknown().optional(),
  reason: z.string().max(500).optional(),
  // Undocumented but present on redeliveries.
  retry_attempt: z.number().int().nonnegative().optional(),
  retry_reason: z.string().max(200).optional(),
  type: z.string().min(1).max(64),
});
export type SlackSocketEnvelope = z.infer<typeof SlackSocketEnvelopeSchema>;

export const SlackEventsApiPayloadSchema = z.looseObject({
  api_app_id: z.string().optional(),
  event: z
    .looseObject({
      bot_id: z.string().optional(),
      channel: z.string().optional(),
      channel_type: z.string().optional(),
      event_ts: z.string().optional(),
      hidden: z.boolean().optional(),
      subtype: z.string().optional(),
      text: z.string().optional(),
      thread_ts: z.string().optional(),
      ts: z.string().optional(),
      type: z.string(),
      user: z.string().optional(),
    })
    .optional(),
  event_id: z.string().optional(),
  event_time: z.number().optional(),
  team_id: z.string().optional(),
  type: z.string(),
});

/**
 * Slack ids for people are `U…` in an ordinary workspace and `W…` on
 * Enterprise Grid; a mention is written either bare or with the display
 * handle after a pipe.
 */
const slackMentionPattern = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/gu;

/**
 * The message subtypes that still carry a person's message. Everything else —
 * joins, edits (`message_changed` fires spuriously when Slack detects the
 * language of a message), deletions, channel chores — is not a new thing said.
 * `thread_broadcast` is an ordinary threaded reply that is also shown at the
 * top level, so it normalizes like any other reply.
 */
const acceptedMessageSubtypes = new Set(["file_share", "thread_broadcast"]);

export interface SlackNormalizationContext {
  readonly botUserId: string;
  readonly displayName: (externalUserId: string) => Promise<string>;
  readonly receivedAt: Date;
}

/**
 * One provider message becomes at most one normalized event. The bot's own
 * mention is detected here rather than subscribed to as `app_mention`, so a
 * mention inside a channel arrives exactly once.
 */
export async function normalizeSlackEvent(
  payload: unknown,
  context: SlackNormalizationContext,
): Promise<NormalizedChannelEvent | null> {
  const parsed = SlackEventsApiPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { data } = parsed;
  if (data.type !== "event_callback" || !data.event || !data.event_id || !data.team_id) return null;
  const event = data.event;
  if (event.type !== "message") return null;
  if (event.subtype !== undefined && !acceptedMessageSubtypes.has(event.subtype)) return null;
  if (event.hidden === true) return null;
  // `bot_id` is present on every message an app posted, ours included.
  if (event.bot_id || !event.user || event.user === context.botUserId) return null;
  if (!event.channel || !event.ts) return null;

  const type = slackConversationType(event.channel_type);
  const text = event.text ?? "";
  const mentionsBot = mentionedUserIds(text).includes(context.botUserId);
  const trigger = slackTrigger({ mentionsBot, threaded: Boolean(event.thread_ts), type });
  if (!trigger) return null;

  return {
    accountExternalId: data.team_id,
    actor: {
      displayName: await context.displayName(event.user),
      externalUserId: event.user,
    },
    content: [{ text: strippedText(text, context.botUserId), type: "text" }],
    conversation: {
      displayName: null,
      externalConversationId: event.channel,
      externalScopeId: data.team_id,
      // A Slack thread is named by its parent message. In a channel every
      // message can become one, so a top-level message names itself; a direct
      // message conversation is already the thread until someone opens one.
      externalThreadId: type === "dm" ? (event.thread_ts ?? null) : (event.thread_ts ?? event.ts),
      type,
    },
    eventId: data.event_id,
    occurredAt: slackTimestamp(
      event.event_ts ?? event.ts,
      data.event_time,
      context.receivedAt,
    ).toISOString(),
    provider: "slack",
    providerMessageId: event.ts,
    trigger,
  } satisfies NormalizedChannelEvent;
}

export function mentionedUserIds(text: string): readonly string[] {
  return [...text.matchAll(slackMentionPattern)].flatMap((match) => match[1] ?? []);
}

/**
 * `message.groups` (a private channel) and `message.mpim` (a group direct
 * message) both carry `G…` ids, so `channel_type` is the only thing that
 * tells them apart.
 */
export function slackConversationType(
  value: string | undefined,
): NormalizedChannelEvent["conversation"]["type"] {
  if (value === "im") return "dm";
  if (value === "mpim") return "group";
  return "channel";
}

function slackTrigger(input: {
  readonly mentionsBot: boolean;
  readonly threaded: boolean;
  readonly type: NormalizedChannelEvent["conversation"]["type"];
}): NormalizedChannelEvent["trigger"] | null {
  if (input.type === "dm") return "direct-message";
  // A mention inside an existing thread starts new work there, so it outranks
  // the follow-up reading.
  if (input.mentionsBot) return "mention";
  if (input.threaded) return "conversation-followup";
  // Ordinary channel chatter is not addressed to anyone.
  return null;
}

function strippedText(text: string, botUserId: string): string {
  const withoutBot = text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "gu"), " ")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  return withoutBot.length > 0 ? withoutBot : "(No text content)";
}

/** A Slack `ts` is an opaque id; only its seconds prefix is a real timestamp. */
function slackTimestamp(
  value: string | undefined,
  fallback: number | undefined,
  receivedAt: Date,
): Date {
  const seconds = value ? Number(value) : fallback;
  if (seconds !== undefined && Number.isFinite(seconds)) return new Date(seconds * 1_000);
  return receivedAt;
}
