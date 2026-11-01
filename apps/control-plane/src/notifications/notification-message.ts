import { createHash } from "node:crypto";
import type { NotificationPreviewEnvelope } from "@opensteer/core";
import type { PublishedNotificationKind } from "@opensteer/control-plane-protocol";
import {
  buildMobileThreadDeepLink,
  DeploymentIdSchema,
  MessageIdSchema,
  RequestIdSchema,
  ThreadIdSchema,
} from "@opensteer/core";

interface NotificationPhrase {
  readonly body: string;
  /**
   * Which identifier the tap lands on. Kinds that point at nothing more exact
   * than their Thread drop whatever the Host sent beside it, so a stray
   * identifier can neither move the anchor nor make the link unbuildable.
   */
  readonly anchor: "message" | "request" | "thread";
  readonly title: string;
}

/**
 * Generic text for phones without a preview key and for iOS when its extension
 * cannot run. Private previews are authenticated ciphertext: the Account never
 * sees their words and the native phone alone replaces this text.
 *
 * The last three rows are what Hosts before Host API epoch 30 publish. Their
 * people keep the words those Hosts were built with until the Host upgrades.
 */
const notificationPhrases: Readonly<Record<PublishedNotificationKind, NotificationPhrase>> = {
  "reply-published": { anchor: "message", body: "Opensteer replied", title: "Opensteer" },
  "request-opened": {
    anchor: "request",
    body: "Opensteer needs you",
    title: "Opensteer",
  },
  "run-failed": { anchor: "thread", body: "Opensteer couldn't finish", title: "Opensteer" },
  "report-published": {
    anchor: "message",
    body: "An agent shared an update",
    title: "Opensteer",
  },
  "run-completed": { anchor: "thread", body: "A run finished", title: "Opensteer" },
  "run-interrupted": { anchor: "thread", body: "A run was stopped", title: "Opensteer" },
};

export interface NotificationMessage {
  readonly body: string;
  readonly data: {
    readonly deepLink: string;
    readonly notificationId?: string;
    readonly installationId?: string;
    readonly expiresAt?: string;
    readonly preview?: string;
    readonly deploymentId: string;
    readonly kind: PublishedNotificationKind;
    readonly messageId?: string;
    readonly requestId?: string;
    readonly threadId: string;
  };
  readonly title: string;
}

export function notificationMessage(input: {
  readonly deploymentId: string;
  readonly preview?: {
    readonly envelope: NotificationPreviewEnvelope;
    readonly notificationId: string;
    readonly installationId: string;
    readonly expiresAt: Date;
  };
  readonly kind: PublishedNotificationKind;
  readonly messageId?: string | null;
  readonly requestId: string | null;
  readonly threadId: string;
}): NotificationMessage {
  const phrase = notificationPhrases[input.kind];
  const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
  const threadId = ThreadIdSchema.parse(input.threadId);
  const requestId =
    phrase.anchor !== "request" || input.requestId === null
      ? null
      : RequestIdSchema.parse(input.requestId);
  const messageId =
    phrase.anchor !== "message" || input.messageId == null
      ? null
      : MessageIdSchema.parse(input.messageId);
  return {
    body: phrase.body,
    data: {
      deepLink: buildMobileThreadDeepLink({ deploymentId, messageId, requestId, threadId }),
      deploymentId,
      ...(input.preview
        ? {
            notificationId: input.preview.notificationId,
            installationId: input.preview.installationId,
            expiresAt: input.preview.expiresAt.toISOString(),
            preview: JSON.stringify({
              version: 1,
              keyId: input.preview.envelope.keyId,
              nonce: input.preview.envelope.nonce,
              ciphertext: input.preview.envelope.ciphertext,
            }),
          }
        : {}),
      kind: input.kind,
      ...(messageId === null ? {} : { messageId }),
      ...(requestId === null ? {} : { requestId }),
      threadId,
    },
    title: phrase.title,
  };
}

export function notificationCollapseId(input: {
  readonly deploymentId: string;
  readonly kind: PublishedNotificationKind;
  readonly requestId: string | null;
  readonly notificationId: string;
  readonly threadId: string;
}): string {
  return (
    "osn1_" +
    createHash("sha256")
      .update(
        JSON.stringify([
          input.deploymentId,
          input.kind,
          input.kind === "request-opened"
            ? (input.requestId ?? input.notificationId)
            : input.threadId,
        ]),
        "utf8",
      )
      .digest("base64url")
  );
}
