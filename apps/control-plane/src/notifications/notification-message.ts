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
 * Every word a phone shows comes from this table.
 *
 * Nothing the Host said reaches a lock screen, because the Host never said
 * anything: the publication carries identifiers only. Fixed phrases are
 * also the whole privacy argument — a notification cannot leak a prompt, a
 * Thread title or a person's name if there is no field it could arrive in.
 *
 * The last three rows are what Hosts before Host API epoch 30 publish. Their
 * people keep the words those Hosts were built with until the Host upgrades.
 */
const notificationPhrases: Readonly<Record<PublishedNotificationKind, NotificationPhrase>> = {
  "reply-published": { anchor: "message", body: "Opensteer replied", title: "Opensteer" },
  "request-opened": {
    anchor: "request",
    body: "Opensteer needs your approval",
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
      kind: input.kind,
      ...(messageId === null ? {} : { messageId }),
      ...(requestId === null ? {} : { requestId }),
      threadId,
    },
    title: phrase.title,
  };
}
