import {
  DeploymentIdSchema,
  EventIdSchema,
  HostInstanceIdSchema,
  maximumNotificationDevicesPerAccount,
  maximumNotificationRecipients,
  MessageIdSchema,
  NotificationIdSchema,
  NotificationInstallationIdSchema,
  NotificationPreviewEnvelopeSchema,
  NotificationKindSchema,
  RequestIdSchema,
  RunIdSchema,
  SequenceSchema,
  ThreadIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
  TeamOriginSchema,
  teamPageAppLink,
} from "@opensteer/core";
import { z } from "zod";
import { ControlPlaneAccountIdSchema } from "./account-id.js";

const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Kinds that Hosts before Host API epoch 30 still publish. A self-hosted Host
 * upgrades on its own schedule, so the Account keeps accepting and phrasing
 * them long after current Hosts stopped sending them.
 */
export const LegacyNotificationKindSchema = z.enum([
  "report-published",
  "run-completed",
  "run-interrupted",
]);

/** Every kind the Account accepts from a Host: today's kinds and the legacy ones. */
export const PublishedNotificationKindSchema = z.enum([
  ...NotificationKindSchema.options,
  ...LegacyNotificationKindSchema.options,
  "team-message",
  "team-agent-needs-you",
  "team-agent-completed",
  "team-notice",
]);
export type PublishedNotificationKind = z.infer<typeof PublishedNotificationKindSchema>;

/** What Account delivers: every kind a Host publishes, and the ones Account sends itself. */
export const AccountNotificationKindSchema = z.enum([
  ...PublishedNotificationKindSchema.options,
  /** A hosted team this Account created finished setting up. */
  "team-ready",
]);
export type AccountNotificationKind = z.infer<typeof AccountNotificationKindSchema>;

/**
 * What a Host tells the Account when a person should hear from Opensteer.
 * Identifiers, bounded delivery metadata and optional per-installation sealed
 * previews only. The Account cannot decrypt titles or excerpts; it retains
 * ciphertext only until delivery settles or expires. Generic phrases serve
 * phones without a registered preview key.
 *
 * `recipientAccountIds` is the Host's authorization answer — it alone knows who
 * may see the Thread — and the Account intersects it with the Accounts that
 * currently reach this Deployment, so a compromised Host cannot address
 * somebody else's phone.
 */
export const HostNotificationPublicationSchema = z
  .strictObject({
    deploymentId: DeploymentIdSchema,
    eventId: EventIdSchema,
    expiresAt: IsoDateTimeSchema,
    hostInstanceId: HostInstanceIdSchema,
    kind: PublishedNotificationKindSchema,
    messageId: MessageIdSchema.nullable().optional(),
    notificationId: NotificationIdSchema,
    occurredAt: IsoDateTimeSchema,
    previews: z
      .array(
        z.strictObject({
          accountId: ControlPlaneAccountIdSchema,
          installationId: NotificationInstallationIdSchema,
          preview: NotificationPreviewEnvelopeSchema,
        }),
      )
      .max(16)
      .optional(),
    recipientAccountIds: z
      .array(ControlPlaneAccountIdSchema)
      .min(1)
      .max(maximumNotificationRecipients),
    requestId: RequestIdSchema.nullable(),
    runId: RunIdSchema.nullable(),
    schemaVersion: z.literal(1),
    sequence: SequenceSchema,
    threadId: ThreadIdSchema.nullable(),
    teamTarget: z.lazy(() => TeamNotificationTargetSchema).optional(),
  })
  .superRefine((publication, context) => {
    const teamKind = publication.kind.startsWith("team-");
    if (
      teamKind !== (publication.teamTarget !== undefined) ||
      (teamKind &&
        (publication.threadId !== null ||
          publication.requestId !== null ||
          publication.runId !== null ||
          publication.messageId != null ||
          publication.teamTarget?.teamId !== publication.deploymentId ||
          (publication.kind === "team-notice") !==
            (publication.teamTarget?.kind === "team-notice") ||
          publication.teamTarget?.kind === "team-ready")) ||
      (!teamKind &&
        publication.threadId === null &&
        (publication.kind !== "request-opened" ||
          publication.requestId !== null ||
          publication.runId !== null ||
          publication.messageId != null))
    )
      context.addIssue({ code: "custom", message: "Notification target does not match its kind" });
    const seen = new Set<string>();
    for (const preview of publication.previews ?? []) {
      const target = JSON.stringify([preview.accountId, preview.installationId]);
      if (seen.has(target) || !publication.recipientAccountIds.includes(preview.accountId)) {
        context.addIssue({ code: "custom", message: "Invalid notification preview audience" });
      }
      seen.add(target);
    }
    if (
      publication.previews?.length &&
      (!Number.isFinite(Date.parse(publication.expiresAt)) ||
        new Date(publication.expiresAt).toISOString() !== publication.expiresAt)
    ) {
      context.addIssue({ code: "custom", message: "Preview expiry must be canonical UTC" });
    }
  });
export type HostNotificationPublication = z.infer<typeof HostNotificationPublicationSchema>;

/**
 * The Account's answers to a Host and to a phone. Both peers upgrade on their
 * own schedule — a self-hosted Host and an installed app — so a response
 * tolerates fields a newer Account adds, while the request shapes above, which
 * the Account parses as input, stay strict.
 */
export const HostNotificationPublicationResponseSchema = z.object({
  accepted: z.literal(true),
  /** How many device deliveries the publication became. Zero is a success. */
  deliveries: z
    .number()
    .int()
    .min(0)
    .max(maximumNotificationRecipients * maximumNotificationDevicesPerAccount),
  notificationId: NotificationIdSchema,
});
export type HostNotificationPublicationResponse = z.infer<
  typeof HostNotificationPublicationResponseSchema
>;

export const NotificationDevicePlatformSchema = z.enum(["android", "ios"]);
export type NotificationDevicePlatform = z.infer<typeof NotificationDevicePlatformSchema>;

/**
 * A stable identifier the application generates once per install. It is the
 * registration's key, so rotating the provider token updates the row this
 * install already owns instead of leaving an undeliverable one behind.
 */
export { NotificationInstallationIdSchema } from "@opensteer/core";

/**
 * The provider's own device token. The character class is the intersection of
 * what APNs (lowercase hex) and FCM (an opaque token containing `:`, `-`, `_`
 * and `.`) mint; it is a shape check, never proof the token is live.
 */
export const NotificationDeviceTokenSchema = z
  .string()
  .min(32)
  .max(4_096)
  .regex(/^[A-Za-z0-9:_.-]+$/u);

const notificationDeviceRegistrationFields = {
  approvalsEnabled: z.boolean(),
  runOutcomesEnabled: z.boolean(),
  token: NotificationDeviceTokenSchema,
};

export const RegisterNotificationDeviceRequestSchema = z.discriminatedUnion("platform", [
  z.strictObject({
    ...notificationDeviceRegistrationFields,
    platform: z.literal("ios"),
    apsEnvironment: z.enum(["development", "production"]),
  }),
  z.strictObject({ ...notificationDeviceRegistrationFields, platform: z.literal("android") }),
]);
export type RegisterNotificationDeviceRequest = z.infer<
  typeof RegisterNotificationDeviceRequestSchema
>;

/** The registration as its owner sees it. The provider token never comes back. */
export const NotificationDeviceSchema = z.object({
  approvalsEnabled: z.boolean(),
  installationId: NotificationInstallationIdSchema,
  lastSeenAt: IsoDateTimeSchema,
  platform: NotificationDevicePlatformSchema,
  registeredAt: IsoDateTimeSchema,
  runOutcomesEnabled: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type NotificationDevice = z.infer<typeof NotificationDeviceSchema>;

export const RegisterNotificationDeviceResponseSchema = z.object({
  device: NotificationDeviceSchema,
});

export const ListNotificationDevicesResponseSchema = z.object({
  devices: z.array(NotificationDeviceSchema).max(maximumNotificationDevicesPerAccount),
});

export const UnregisterNotificationDeviceResponseSchema = z.object({
  installationId: NotificationInstallationIdSchema,
  unregistered: z.literal(true),
});

export const TeamNotificationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("team-message"),
    origin: TeamOriginSchema,
    teamId: DeploymentIdSchema,
    channelId: TeamChannelIdSchema,
    messageId: TeamMessageIdSchema,
  }),
  z.strictObject({
    kind: z.literal("team-notice"),
    origin: TeamOriginSchema,
    teamId: DeploymentIdSchema,
    noticeId: TeamNoticeIdSchema,
  }),
  /** Account's own: the team's #general, where its new owner lands. */
  z.strictObject({
    kind: z.literal("team-ready"),
    origin: TeamOriginSchema,
    teamId: DeploymentIdSchema,
    channelId: TeamChannelIdSchema,
  }),
]);
export type TeamNotificationTarget = z.infer<typeof TeamNotificationTargetSchema>;

export function teamNotificationDeepLink(targetInput: TeamNotificationTarget): string {
  const target = TeamNotificationTargetSchema.parse(targetInput);
  if (target.kind === "team-ready")
    return teamPageAppLink(
      { origin: target.origin, target: { kind: "channel", channelId: target.channelId } },
      "mobile",
    );
  if (target.kind === "team-message")
    return teamPageAppLink(
      {
        origin: target.origin,
        target: { kind: "message", channelId: target.channelId, messageId: target.messageId },
      },
      "mobile",
    );
  return `com.opensteer.mobile:/team-notice?${new URLSearchParams({ origin: target.origin, teamId: target.teamId, noticeId: target.noticeId })}`;
}
