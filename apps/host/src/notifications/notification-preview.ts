import { createCipheriv, randomBytes } from "node:crypto";
import {
  NotificationPreviewKeySchema,
  NotificationPreviewEnvelopeSchema,
  NotificationPreviewPlaintextSchema,
  type NotificationPreviewEnvelope,
  type NotificationPreviewPlaintext,
} from "@opensteer/core";

export interface NotificationPreviewContext {
  readonly deploymentId: string;
  readonly notificationId: string;
  readonly installationId: string;
  readonly keyId: string;
  readonly kind: string;
  readonly deepLink: string;
  readonly expiresAt: string;
}

export function notificationPreviewAad(context: NotificationPreviewContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      "opensteer-notification-preview-v1",
      context.deploymentId,
      context.notificationId,
      context.installationId,
      context.keyId,
      context.kind,
      context.deepLink,
      context.expiresAt,
    ]),
    "utf8",
  );
}

export function sealNotificationPreview(input: {
  readonly context: NotificationPreviewContext;
  readonly key: string;
  readonly plaintext: NotificationPreviewPlaintext;
  /** Fixed only by crypto-vector tests. Production always uses a fresh random nonce. */
  readonly nonce?: Uint8Array;
}): NotificationPreviewEnvelope {
  const keyResult = NotificationPreviewKeySchema.safeParse(input.key);
  const value = NotificationPreviewPlaintextSchema.safeParse(input.plaintext);
  if (!keyResult.success || !value.success) throw new Error("Invalid notification preview input");
  const plaintext = Buffer.from(
    JSON.stringify({ version: 1, title: value.data.title, body: value.data.body }),
    "utf8",
  );
  const key = Buffer.from(keyResult.data, "base64url");
  const nonce = input.nonce ?? randomBytes(12);
  try {
    if (nonce.byteLength !== 12 || plaintext.byteLength > 2048)
      throw new Error("Invalid notification preview input");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(notificationPreviewAad(input.context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const result = NotificationPreviewEnvelopeSchema.safeParse({
      version: 1,
      keyId: input.context.keyId,
      nonce: Buffer.from(nonce).toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    });
    if (!result.success) throw new Error("Invalid notification preview envelope");
    return result.data;
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}
