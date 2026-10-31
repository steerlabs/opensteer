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
  WorkspaceIdSchema,
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
]);
export type PublishedNotificationKind = z.infer<typeof PublishedNotificationKindSchema>;

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
    threadId: ThreadIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .superRefine((publication, context) => {
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
