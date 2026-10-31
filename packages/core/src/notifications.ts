import { z } from "zod";
import {
  MessageIdSchema,
  NotificationIdSchema,
  RequestIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  WorkspaceIdSchema,
} from "./ids.js";
import { IsoDateTimeSchema } from "./models.js";

export const PersonNotifyMessageSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => s.isWellFormed(), "Message must be valid Unicode")
  .refine((s) => s.trim().length > 0, "Message must contain visible text")
  .refine((s) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s), "Message must be one line");

/**
 * What a person is told about: Opensteer replied to them, Opensteer needs their
 * answer, or work they were waiting on failed. A reply is a Run's final
 * message wherever the Run answers a person directly — not a task's reply,
 * which returns to the agent that assigned it, and not a channel Run's, which
 * answers in Slack or iMessage. Nothing else alerts: a report is context for
 * an agent's next turn, never a message to the person.
 *
 * Muting a Workspace silences its replies and failures, while Requests still
 * alert because they wait for a person's response.
 */
export const NotificationKindSchema = z.enum(["reply-published", "request-opened", "run-failed"]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** The longest publication window the Account accepts, including previous-release Hosts. */
export const notificationExpiryMilliseconds = 24 * 60 * 60 * 1_000;

/** Fresh events may alert for fifteen minutes; older work remains in its Thread. */
export const notificationPushWindowMilliseconds = 15 * 60_000;

/** The heading of a notification a person's own client shows. */
export const notificationTitleMaxCharacters = 120;

/** The excerpt a person's own client shows. It never leaves their Deployment. */
export const notificationBodyMaxCharacters = 180;

/**
 * One notification as the recipient's own clients receive it. Title and body
 * are drawn from the person's Deployment for the person's own screens; the
 * Account, which relays push, receives identifiers only.
 */
export const NotificationViewSchema = z.object({
  body: z.string().min(1).max(notificationBodyMaxCharacters),
  id: NotificationIdSchema,
  kind: NotificationKindSchema,
  messageId: MessageIdSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
  requestId: RequestIdSchema.nullable(),
  runId: RunIdSchema.nullable(),
  threadId: ThreadIdSchema,
  title: z.string().min(1).max(notificationTitleMaxCharacters),
  workspaceId: WorkspaceIdSchema,
});
export type NotificationView = z.infer<typeof NotificationViewSchema>;

/**
 * How many Accounts one publication may name. Together with the per-Account
 * device limit the Account enforces at registration, this is the arithmetic
 * bound on a single alert's fan-out — nothing downstream re-bounds it by
 * truncating a query.
 */
export const maximumNotificationRecipients = 256;

/**
 * How many devices one Account may have registered for push at once. The
 * seventeenth registration is refused with a reason the app can show, because
 * a limit nobody is told about is indistinguishable from a notification that
 * never arrives.
 */
export const maximumNotificationDevicesPerAccount = 16;

/**
 * The Android notification channel every Opensteer alert is delivered on.
 *
 * Android decides sound, importance and the entry a person sees in the system
 * settings from the channel, not from the message, so the channel has to exist
 * on the phone *and* be named on the wire: `expo-notifications` reads this id
 * from the FCM message and falls back to a channel of its own — called
 * "Miscellaneous" — when it finds none. One channel is the whole vocabulary:
 * the fixed phrases are all the same kind of interruption, and a person who
 * wants fewer of them turns one of the two switches off in the app.
 */
export const androidNotificationChannelId = "default";
