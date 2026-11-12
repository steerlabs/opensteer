import {
  EventIdSchema,
  type DeploymentId,
  type HostInstanceId,
  type UserId,
} from "@opensteer/core";
import {
  HostNotificationPublicationSchema,
  HostNotificationPublicationResponseSchema,
  teamNotificationDeepLink,
  type TeamNotificationTarget,
} from "@opensteer/control-plane-protocol";
import type { TeamPushDelivery } from "@opensteer/database/team-outbox";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { sealNotificationPreview } from "../notifications/notification-preview.js";

export function createTeamPushPublisher(options: {
  teamId: DeploymentId;
  hostInstanceId: HostInstanceId;
  origin: string;
  target: () => Promise<{ controlApiOrigin: URL; hostCredential: string }>;
  keys: (
    userId: UserId,
    accountIds: readonly string[],
  ) => Promise<
    readonly { accountId: string; installationId: string; keyId: string; key: string }[]
  >;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}) {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (delivery: TeamPushDelivery) => {
    const target = await options.target();
    const teamTarget: TeamNotificationTarget = delivery.noticeId
      ? {
          kind: "team-notice",
          teamId: options.teamId,
          origin: options.origin,
          noticeId: delivery.noticeId,
        }
      : {
          kind: "team-message",
          teamId: options.teamId,
          origin: options.origin,
          channelId: delivery.channelId!,
          messageId: delivery.messageId!,
        };
    const expiresAt = new Date(delivery.occurredAt.getTime() + 15 * 60000).toISOString();
    const previews = (await options.keys(delivery.userId, [delivery.accountId])).map((key) => ({
      accountId: key.accountId,
      installationId: key.installationId,
      preview: sealNotificationPreview({
        key: key.key,
        plaintext: { version: 1, title: delivery.title, body: delivery.body },
        context: {
          deploymentId: options.teamId,
          notificationId: delivery.notificationId,
          installationId: key.installationId,
          keyId: key.keyId,
          kind: delivery.kind,
          deepLink: teamNotificationDeepLink(teamTarget),
          expiresAt,
        },
      }),
    }));
    const publication = HostNotificationPublicationSchema.parse({
      schemaVersion: 1,
      deploymentId: options.teamId,
      hostInstanceId: options.hostInstanceId,
      eventId: EventIdSchema.parse(delivery.notificationId.replace(/^ntf_/, "evt_")),
      notificationId: delivery.notificationId,
      kind: delivery.kind,
      occurredAt: delivery.occurredAt.toISOString(),
      expiresAt,
      previews,
      recipientAccountIds: [delivery.accountId],
      threadId: null,
      runId: null,
      requestId: null,
      sequence: delivery.messageId ?? "0",
      teamTarget,
    });
    const timeout = AbortSignal.timeout(10000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(new URL("/v1/host/notifications", target.controlApiOrigin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal,
      headers: {
        authorization: `Bearer ${target.hostCredential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(publication),
    });
    if (!response.ok) throw new Error("Team push publication failed");
    HostNotificationPublicationResponseSchema.parse(
      await readBoundedJson(response, { maximumBytes: 4096 }),
    );
  };
}
