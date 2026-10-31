import { NotificationPreviewEnvelopeSchema, createId } from "@opensteer/core";
import { notificationMessage } from "./notification-message.js";

/** The wire schema's largest ciphertext, install id and routing fields. */
export function maximumPreviewMessage() {
  return notificationMessage({
    deploymentId: createId("deployment"),
    threadId: createId("thread"),
    messageId: createId("message"),
    requestId: createId("request"),
    kind: "request-opened",
    preview: {
      notificationId: createId("notification"),
      installationId: "i".repeat(128),
      expiresAt: new Date("2026-09-14T12:02:00.000Z"),
      envelope: NotificationPreviewEnvelopeSchema.parse({
        version: 1,
        keyId: Buffer.alloc(16).toString("base64url"),
        nonce: Buffer.alloc(12).toString("base64url"),
        ciphertext: Buffer.alloc(2064, 255).toString("base64url"),
      }),
    },
  });
}
